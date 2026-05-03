/**
 * Trade Executor — orchestre real trading vs paper trading
 *
 * Logique de routage :
 *   REAL_TRADING_ENABLED=true  → placeOrder() sur le CLOB Polymarket
 *   REAL_TRADING_ENABLED=false → savePaperTrade() (comportement actuel)
 *
 * Garanties :
 *   - Paper trading reste 100% fonctionnel en cas d'échec real
 *   - Toute erreur real est loggée et ne bloque pas le scan
 *   - Le flag is_real est toujours renseigné en DB
 *   - Gas fees inclus dans le P&L des trades réels
 *
 * SQL à exécuter une fois dans Supabase pour ajouter le flag :
 *   ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS is_real BOOLEAN DEFAULT false;
 *   ALTER TABLE positions    ADD COLUMN IF NOT EXISTS is_real BOOLEAN DEFAULT false;
 */

import {
  savePaperTrade,
  type PaperTradeRow,
}                                    from "@/lib/db/supabase";
import {
  openPosition,
  updatePosition,
  executeSell as paperExecuteSell,
  markPaperTradeSold,
  type OpenPositionInput,
}                                    from "@/lib/db/positions";
import type { Position }             from "@/lib/positions/position-manager";
import {
  getClobMarket,
  placeOrder,
  cancelOrder,
  getAccountBalance,
  getTokenBalance,
  OrderbookEmptyError,
  type PlacedOrder,
}                                    from "@/lib/polymarket/clob-api";
import {
  sendDiscordAlert,
  sendRealTradeBuy,
}                                    from "@/lib/utils/discord";

// ---------------------------------------------------------------------------
// Sentinel error — skip without Discord
// ---------------------------------------------------------------------------

/**
 * Thrown when a real order should be silently skipped (market not in CLOB,
 * market inactive, etc.). The catch block checks for this type and omits
 * the Discord error alert to avoid spam.
 */
class ClobSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClobSkipError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lit REAL_TRADING_ENABLED à chaque appel (runtime, pas build-time). */
export function isRealTradingEnabled(): boolean {
  return process.env.REAL_TRADING_ENABLED === "true";
}

/** Réinitialise le cache d'allowance (no-op, conservé pour compatibilité). */
export function resetAllowanceCache(): void {
  // Allowance check supprimé — Polymarket valide côté CLOB
}

function logRealError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[trade-executor] ❌ REAL: ${context}: ${msg}`);

  // Notification Discord — fire-and-forget, ne bloque pas
  sendDiscordAlert(`🚨 **Real trade error** — ${context}\n\`${msg}\``).catch(() => {});
}

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

/** Résultat de executeBuy() — identique que ce soit real ou paper. */
export interface ExecuteBuyResult {
  paperTradeId: string;
  positionId:   string;
  isReal:       boolean;
  orderId?:     string;   // CLOB order ID si real trade
  gasFeeUsdc?:  number;
  realError?:   string;   // Message d'erreur si real trade a échoué (isReal=false en real mode)
}

/** Input minimal pour executeBuy — correspond aux champs d'une Opportunity. */
export interface BuyInput {
  marketId:             string;
  question:             string;
  city?:                string | null;
  ticker?:              string | null;
  agent:                "weather" | "finance" | "crypto";
  outcome:              string;
  marketPrice:          number;
  estimatedProbability: number;
  edge:                 number;
  suggestedBet:         number;
  confidence?:          string | null;
  targetDate?:          string;          // YYYY-MM-DD
  targetDateTime?:      string;          // ISO
  marketContext?:       Record<string, unknown> | null;
  potentialPnl:         number;
}

// ---------------------------------------------------------------------------
// executeBuy
// ---------------------------------------------------------------------------

/**
 * Place un achat (real ou paper) selon REAL_TRADING_ENABLED.
 *
 * Le chemin REAL essaie de placer un ordre CLOB, puis fait le fallback paper
 * en cas d'échec — avec log Discord de l'erreur.
 * Le chemin PAPER est exactement le même qu'avant.
 */
export async function executeBuy(input: BuyInput): Promise<ExecuteBuyResult> {
  const real = isRealTradingEnabled();

  // ----- Toujours créer le paper_trade (tracking + post-mortem) -----
  const paperTrade = await savePaperTrade({
    market_id:             input.marketId,
    question:              input.question,
    city:                  input.city       ?? null,
    ticker:                input.ticker     ?? null,
    agent:                 input.agent,
    outcome:               input.outcome,
    market_price:          input.marketPrice,
    estimated_probability: input.estimatedProbability,
    edge:                  input.edge,
    suggested_bet:         input.suggestedBet,
    confidence:            input.confidence ?? null,
    resolution_date:       input.targetDate ?? null,
    potential_pnl:         input.potentialPnl,
    market_context:        input.marketContext ?? null,
    expected_resolution:   input.targetDateTime ?? null,
    // is_real patchée juste après si real trade réussi
  });

  // ----- Chemin REAL -----
  let orderId:    string | undefined;
  let gasFeeUsdc: number | undefined;
  let isReal     = false;
  let realError: string | undefined;

  // Variables pour stocker les vrais fill amounts (lus depuis ERC-1155 après le BUY)
  let actualSharesFilled: number | undefined;
  let actualEntryPrice:   number | undefined;

  if (real) {
    // ── Diagnostic : est-ce un conditionId (0x…) ou un integer Gamma ID ? ──
    const isConditionId = input.marketId.startsWith("0x") && input.marketId.length > 20;
    console.log(
      `[EXEC-BUY] ▶ REAL trade attempt` +
      ` | market="${input.marketId}" (${isConditionId ? "✅ conditionId hex" : "⚠️ integer Gamma ID — CLOB lookup will fail"})` +
      ` | outcome=${input.outcome} | bet=$${input.suggestedBet} | REAL_TRADING_ENABLED=${process.env.REAL_TRADING_ENABLED}`
    );
    try {
      // 0. Récupérer les données du marché (nécessaire pour negRisk + token IDs)
      console.log(`[EXEC-BUY] getClobMarket("${input.marketId}")…`);
      const clobMarket = await getClobMarket(input.marketId);
      if (!clobMarket) {
        console.log(
          `[EXEC-BUY] ❌ getClobMarket returned null — market not found in CLOB.\n` +
          `  marketId="${input.marketId}" isConditionId=${isConditionId}\n` +
          `  → Si integer Gamma ID : le champ conditionId est absent de la réponse Gamma\n` +
          `  → Si conditionId hex : le marché n'est pas sur le CLOB Polymarket`
        );
        throw new ClobSkipError(`Market not found in CLOB: ${input.marketId}`);
      }
      if (!clobMarket.active) {
        console.log(`[EXEC-BUY] ❌ Market inactive in CLOB: ${input.marketId}`);
        throw new ClobSkipError(`Market inactive in CLOB: ${input.marketId}`);
      }
      console.log(
        `[EXEC-BUY] ✅ getClobMarket OK — negRisk=${clobMarket.negRisk}` +
        ` tokens=${clobMarket.tokens.map((t) => `${t.outcome}:${t.tokenId.slice(0, 8)}`).join(", ")}`
      );

      // ── Guard 1 : Allowance — déléguée à Polymarket ──────────────────────
      console.log("[EXEC-BUY] Allowance check skipped — relying on Polymarket validation");

      // ── Guard 2 : Balance USDC suffisante ─────────────────────────────────
      console.log("[EXEC-BUY] Checking pUSD balance…");
      const balance    = await getAccountBalance();
      const minBalance = input.suggestedBet * 1.05;
      console.log(`[EXEC-BUY] Balance: ${balance === null ? "null (RPC failed)" : `$${balance.toFixed(2)}`} | required: $${minBalance.toFixed(2)}`);

      if (balance === null) {
        console.warn(
          `[EXEC-BUY] ⚠ Balance check skipped (all RPCs failed) — ` +
          `proceeding, Polymarket will reject if insufficient`
        );
      } else if (balance < minBalance) {
        const msg =
          `Insufficient balance: ${balance.toFixed(2)}$ dispo, ` +
          `${minBalance.toFixed(2)}$ requis (bet=${input.suggestedBet.toFixed(2)}$ + 5% marge)`;
        sendDiscordAlert(
          `⚠️ **Real trade skipped: insufficient balance**\n` +
          `Balance: \`${balance.toFixed(2)} USDC\` — ` +
          `requis: \`${minBalance.toFixed(2)} USDC\`\n` +
          `Marché: ${input.question.slice(0, 80)}`
        ).catch(() => {});
        throw new Error(msg);
      }

      const token = clobMarket.tokens.find(
        (t) => t.outcome.toLowerCase() === input.outcome.toLowerCase()
      );
      if (!token) {
        const available = clobMarket.tokens.map((t) => t.outcome).join(", ");
        throw new ClobSkipError(
          `Token not found for outcome "${input.outcome}". Available: ${available}`
        );
      }
      console.log(
        `[EXEC-BUY] Token: ${token.outcome} tokenId=${token.tokenId.slice(0, 16)}… ` +
        `clobPrice=${token.price} (input.marketPrice=${input.marketPrice})`
      );

      // Vérification de cohérence : l'outcome demandé correspond-il au token trouvé ?
      if (token.outcome.toLowerCase() !== input.outcome.toLowerCase()) {
        throw new ClobSkipError(
          `Token mismatch: wanted "${input.outcome}" but found "${token.outcome}"`
        );
      }

      // 1. Placer l'ordre FAK
      // Utiliser token.price (prix CLOB du token exact) comme référence, pas
      // input.marketPrice (qui peut être le prix YES même quand outcome=No).
      console.log(`[EXEC-BUY] Calling placeOrder FAK BUY $${input.suggestedBet} @ token.price=${token.price}…`);
      const placed: PlacedOrder = await placeOrder({
        tokenId:    token.tokenId,
        side:       "BUY",
        amountUsdc: input.suggestedBet,
        price:      token.price,   // ← prix du bon token (NO price si outcome="No")
        negRisk:    clobMarket.negRisk,
        dryRun:     false,
      });

      orderId    = placed.orderId;
      gasFeeUsdc = placed.gasFeeUsdc;
      isReal     = true;

      // Lire le solde ERC-1155 réel après le fill pour stocker shares_filled
      // et entry_price exact (= USDC dépensé / shares reçues)
      const funderAddr = process.env.POLYMARKET_FUNDER_ADDRESS;
      if (funderAddr) {
        try {
          const realShares = await getTokenBalance(funderAddr, token.tokenId);
          if (realShares > 0) {
            actualSharesFilled = realShares;
            actualEntryPrice   = Math.round(input.suggestedBet / realShares * 10000) / 10000;
            console.log(
              `[EXEC-BUY] ✅ ERC-1155 balance: ${realShares.toFixed(4)} shares ` +
              `→ actualEntryPrice=${actualEntryPrice} (vs midPrice=${input.marketPrice})`
            );
          }
        } catch (balErr) {
          console.warn(`[EXEC-BUY] ⚠ getTokenBalance post-buy échoué (non-bloquant): ${balErr instanceof Error ? balErr.message : balErr}`);
        }
      }

      console.log(
        `[trade-executor] ✅ [REAL] BUY placed: orderId=${placed.orderId} ` +
        `market=${input.marketId} outcome=${input.outcome} ` +
        `bet=${input.suggestedBet}$ price=${input.marketPrice} fee=${placed.gasFeeUsdc}$`
      );

      // Notification Discord — trade réel exécuté avec succès (fire-and-forget)
      sendRealTradeBuy(
        {
          question:    input.question,
          outcome:     input.outcome,
          agent:       input.agent,
          marketPrice: input.marketPrice,
          amountUsdc:  input.suggestedBet,
          orderId:     placed.orderId,
          gasFeeUsdc:  placed.gasFeeUsdc,
        },
        new Date()
      ).catch(() => {});

      // Marquer is_real=true dans paper_trade (best-effort)
      await patchIsReal("paper_trades", paperTrade.id).catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      realError = errMsg;
      if (err instanceof ClobSkipError || err instanceof OrderbookEmptyError) {
        // Marché non disponible ou orderbook vide — skip silencieux, pas de Discord.
        const tag = err instanceof OrderbookEmptyError ? "ORDERBOOK EMPTY" : "CLOB SKIP";
        console.log(`[EXEC-BUY] ⏭ ${tag} (no Discord): ${errMsg}`);
      } else {
        // Vraie erreur (réseau, signature, FAK 0-filled, balance…) — alerte Discord.
        console.error(
          `[EXEC-BUY] ❌ REAL BUY FAILED: market=${input.marketId} ` +
          `outcome=${input.outcome} bet=$${input.suggestedBet} — ${errMsg}`
        );
        if (err instanceof Error && err.stack) {
          console.error(`[EXEC-BUY] Stack:\n${err.stack}`);
        }
        sendDiscordAlert(
          `❌ **REAL TRADE FAILED** — ${input.question.slice(0, 80)}\n` +
          `Outcome: \`${input.outcome}\` · Mise: \`${input.suggestedBet.toFixed(2)}$\`\n` +
          `Erreur: \`${errMsg.slice(0, 200)}\``
        ).catch(() => {});
      }
      // Annuler le paper_trade créé en amont : won=false, potential_pnl=0.
      // Sans ça, anti-churn verrait won=null + potential_pnl>0 et bloquerait
      // la ville/date pour les 24h suivantes, empêchant toute nouvelle tentative.
      await cancelPaperTrade(paperTrade.id, errMsg).catch(() => {});
    }
  }

  // ----- Créer la position en DB -----
  const positionInput: OpenPositionInput = {
    paperTradeId:     paperTrade.id,
    marketId:         input.marketId,
    question:         input.question,
    city:             input.city     ?? null,
    ticker:           input.ticker   ?? null,
    agent:            input.agent,
    outcome:          input.outcome,
    entryPrice:       input.marketPrice,
    entryProbability: input.estimatedProbability,
    suggestedBet:     input.suggestedBet,
    resolutionDate:   input.targetDate ?? null,
  };

  const position = await openPosition(positionInput);

  // Marquer is_real + clob_order_id sur la position si real trade réussi.
  if (isReal && orderId) {
    await patchRealPosition(position.id, orderId).catch((err) => {
      logRealError(`patchRealPosition(${position.id})`, err);
    });
  }

  // Mettre à jour shares_filled et entry_price réels si lus depuis ERC-1155
  if (isReal && actualSharesFilled !== undefined && actualSharesFilled > 0) {
    await updatePosition(position.id, {
      sharesFilled: actualSharesFilled,
      ...(actualEntryPrice !== undefined ? { entryPrice: actualEntryPrice } : {}),
    }).catch((err) =>
      console.warn(`[EXEC-BUY] ⚠ updatePosition shares_filled: ${err instanceof Error ? err.message : err}`)
    );
  }

  return {
    paperTradeId: paperTrade.id,
    positionId:   position.id,
    isReal,
    orderId,
    gasFeeUsdc,
    realError,
  };
}

// ---------------------------------------------------------------------------
// executeSell
// ---------------------------------------------------------------------------

/**
 * Vend une position (real ou paper) selon position.isReal.
 *
 * Chemin REAL :
 *   1. Tente cancelOrder() — couvre le cas où le BUY n'a pas encore été rempli.
 *      (Non bloquant : échoue silencieusement si l'ordre est déjà FILLED.)
 *   2. Place un ordre SELL limit GTC pour les tokens acquis lors du BUY.
 *      (Couvre le cas normal : AMM remplit le BUY instantanément, tokens dans wallet.)
 *      Calcul : shares = suggestedBet / entryPrice → amountUsdc = shares × sellPrice
 *   3. Calcule le P&L (prix Gamma + gas fees).
 *   4. Met à jour la DB.
 *   En cas d'échec critique : fallback paper + alerte Discord.
 *
 * Chemin PAPER : simulation existante inchangée.
 */
export async function executeSell(
  position:   Position,
  sellPrice:  number,
  reason:     string
): Promise<number> {

  if (position.isReal) {
    const GAS_FEE = 0.01;

    // ── Étape 1 : tenter d'annuler l'ordre BUY si encore ouvert (non-bloquant) ─
    if (position.clobOrderId) {
      await cancelOrder(position.clobOrderId).catch((err) =>
        console.log(`[trade-executor] cancelOrder non-bloquant: ${err instanceof Error ? err.message : err}`)
      );
    }

    // ── Étape 2 : lire le solde ERC-1155 RÉEL sur la blockchain ───────────────
    // Évite de tenter de vendre plus de shares qu'on en possède (erreur "balance
    // insuffisante" systématique quand entry_price DB ≠ prix de fill réel).
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
    if (!funder) {
      logRealError("executeSell", new Error("POLYMARKET_FUNDER_ADDRESS non défini"));
      return paperExecuteSell(position.id, sellPrice, position.entryPrice, position.suggestedBet, reason);
    }

    let realShares: number | null = null;
    let sellOrderId: string | undefined;
    let sellSucceeded = false;

    try {
      const clobMarket = await getClobMarket(position.marketId);
      const token      = clobMarket?.tokens.find(
        (t) => t.outcome.toLowerCase() === position.outcome.toLowerCase()
      );

      if (!clobMarket || !token) {
        console.warn(
          `[trade-executor] ⚠ Marché/token introuvable dans CLOB pour SELL ` +
          `(market=${position.marketId} outcome=${position.outcome})`
        );
      } else {
        // Lire le solde réel on-chain
        try {
          realShares = await getTokenBalance(funder, token.tokenId);
        } catch (balErr) {
          console.warn(`[trade-executor] ⚠ getTokenBalance échoué: ${balErr instanceof Error ? balErr.message : balErr}`);
        }

        const sharesDB = position.sharesFilled ?? (position.suggestedBet / position.entryPrice);
        console.log(
          `[trade-executor] SELL pre-flight: outcome=${position.outcome} ` +
          `realShares=${realShares?.toFixed(4) ?? "unknown"} ` +
          `sharesDB=${sharesDB.toFixed(4)} ` +
          `tokenId=${token.tokenId.slice(0, 12)}…`
        );

        // Shares à vendre : balance réelle (si connue) ou fallback DB
        const sharesToSell = realShares !== null ? realShares : sharesDB;

        if (sharesToSell < 0.001) {
          // 0 shares on-chain — soit marché fermé, soit déjà vendu manuellement
          console.warn(
            `[trade-executor] ⚠ 0 shares on-chain pour position ${position.id.slice(0, 8)} ` +
            `— skip SELL on-chain (marché fermé ou vendu manuellement)`
          );
          sendDiscordAlert(
            `⚠️ **REAL SELL skipped** — 0 shares on-chain\n` +
            `Position: \`${position.id.slice(0, 8)}\` ${position.question.slice(0, 60)}\n` +
            `realShares=${realShares?.toFixed(4) ?? "unknown"} — marché fermé ou déjà vendu`
          ).catch(() => {});
          sellSucceeded = true; // marquer comme vendu (position vide de toute façon)
        } else {
          const sellAmountUsdc = Math.round(sharesToSell * sellPrice * 100) / 100;
          console.log(
            `[trade-executor] SELL: ${sharesToSell.toFixed(4)} shares @ ${sellPrice} ≈ $${sellAmountUsdc.toFixed(2)}`
          );

          try {
            const placed = await placeOrder({
              tokenId:     token.tokenId,
              side:        "SELL",
              amountUsdc:  sellAmountUsdc,
              sharesCount: sharesToSell,
              price:       token.price,
              negRisk:     clobMarket.negRisk,
              dryRun:      false,
            });
            sellOrderId    = placed.orderId;
            sellSucceeded  = true;
            console.log(
              `[trade-executor] ✅ REAL SELL placed: orderId=${placed.orderId} ` +
              `shares=${sharesToSell.toFixed(4)} worstPrice=${placed.price} status=${placed.status}`
            );
          } catch (sellErr) {
            const msg = sellErr instanceof Error ? sellErr.message : String(sellErr);
            if (sellErr instanceof OrderbookEmptyError) {
              console.warn(`[trade-executor] ⚠ SELL orderbook vide: ${msg}`);
              // Pas de buyers — position marquée sell_failed pour retry
            } else {
              console.error(`[trade-executor] ❌ SELL on-chain échoué: ${msg}`);
              sendDiscordAlert(
                `❌ **REAL SELL échoué** — position \`${position.id.slice(0, 8)}\`\n` +
                `${position.question.slice(0, 80)}\n` +
                `Erreur: \`${msg.slice(0, 200)}\`\n` +
                `_Réessai au prochain monitor-positions._`
              ).catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      logRealError(`executeSell pre-flight(${position.id})`, err);
    }

    const now    = new Date().toISOString();
    const rawPnl = Math.round(
      ((sellPrice - position.entryPrice) / position.entryPrice) * position.suggestedBet * 100
    ) / 100;
    const sellPnl = Math.round((rawPnl - GAS_FEE) * 100) / 100;

    if (sellSucceeded) {
      // ── Étape 3 : mise à jour DB → vendu ──────────────────────────────────
      const { getClient: getPosClient } = await import("@/lib/db/supabase");
      const posDb = getPosClient();
      const { error: posErr } = await posDb
        .from("positions")
        .update({
          status:              "sold",
          sell_reason:         reason,
          sell_signal_at:      now,
          sold_at:             now,
          sell_price:          sellPrice,
          sell_pnl:            sellPnl,
          current_price:       sellPrice,
          current_probability: sellPrice,
        })
        .eq("id", position.id);
      if (posErr) console.warn(`[trade-executor] updatePositionSold: ${posErr.message}`);

      console.log(
        `[trade-executor] ✅ REAL SELL done: entry=${position.entryPrice} sell=${sellPrice} ` +
        `pnl=${sellPnl}$ (gas=-${GAS_FEE}$)` + (sellOrderId ? ` orderId=${sellOrderId}` : " [0-share skip]")
      );
      return sellPnl;
    } else {
      // ── SELL échoué : marquer sell_failed pour retry ────────────────────────
      const attempts = (position.syncAttempts ?? 0) + 1;
      await updatePosition(position.id, {
        status:       "sell_failed",
        sellReason:   `sell_failed attempt ${attempts}: ${reason}`,
        syncAttempts: attempts,
        ...(realShares !== null ? { sharesFilled: realShares } : {}),
      }).catch((e) => console.warn(`[trade-executor] updatePosition sell_failed: ${e instanceof Error ? e.message : e}`));

      console.warn(
        `[trade-executor] ⚠ SELL on-chain non confirmé — position marquée sell_failed ` +
        `(attempt ${attempts}), sera retentée au prochain monitor-positions`
      );
      // Retourner 0 pour indiquer que le P&L n'est pas réalisé
      return 0;
    }
  }

  // ----- Chemin PAPER (comportement original) -----
  return paperExecuteSell(
    position.id,
    sellPrice,
    position.entryPrice,
    position.suggestedBet,
    reason
  );
}

// ---------------------------------------------------------------------------
// Helper interne — patch is_real en DB
// ---------------------------------------------------------------------------

/** Met à jour is_real=true pour une ligne donnée (best-effort, ne throw pas). */
async function patchIsReal(
  table: "paper_trades" | "positions",
  id:   string
): Promise<void> {
  const { getClient } = await import("@/lib/db/supabase");
  const db = getClient();
  const { error } = await db.from(table).update({ is_real: true }).eq("id", id);
  if (error) console.warn(`[trade-executor] patchIsReal(${table}/${id}): ${error.message}`);
}

/**
 * Patch atomique sur une position réelle :
 *   is_real = true
 *   clob_order_id = orderId
 *
 * Ces deux champs sont mis à jour ensemble pour garantir la cohérence.
 * Si clob_order_id n'est pas persisté, cancelOrder() sera inopérant au sell.
 */
async function patchRealPosition(positionId: string, orderId: string): Promise<void> {
  const { getClient } = await import("@/lib/db/supabase");
  const db = getClient();
  const { error } = await db
    .from("positions")
    .update({ is_real: true, clob_order_id: orderId })
    .eq("id", positionId);

  if (error) {
    throw new Error(`patchRealPosition(${positionId}): ${error.message}`);
  }

  console.log(`[trade-executor] 📝 Position ${positionId.slice(0, 8)} — is_real=true, clob_order_id=${orderId}`);
}

/**
 * Annule un paper_trade qui n'a jamais produit d'ordre réel.
 *
 * Marque won=false + potential_pnl=0 → le filtre anti-churn
 * (.or("won.is.null,...,and(won.eq.false,potential_pnl.neq.0)"))
 * l'exclura, permettant une nouvelle tentative sur la même ville/date.
 *
 * Appelé quand le real order échoue en real mode, pour que le paper_trade
 * créé en amont ne bloque pas les scans suivants.
 */
async function cancelPaperTrade(id: string, reason: string): Promise<void> {
  const { getClient } = await import("@/lib/db/supabase");
  const db = getClient();
  const { error } = await db
    .from("paper_trades")
    .update({ won: false, potential_pnl: 0 })
    .eq("id", id);
  if (error) {
    console.warn(`[trade-executor] cancelPaperTrade(${id}): ${error.message}`);
  } else {
    console.log(`[EXEC-BUY] ℹ Paper trade ${id.slice(0, 8)} marqué annulé (won=false, pnl=0) — "${reason.slice(0, 80)}"`);
  }
}
