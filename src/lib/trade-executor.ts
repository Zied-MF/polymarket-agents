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
  type PlacedOrder,
}                                    from "@/lib/polymarket/clob-api";
import {
  sendDiscordAlert,
  sendRealTradeBuy,
}                                    from "@/lib/utils/discord";

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
  let isReal = false;

  if (real) {
    console.log(
      `[trade-executor] DEBUG executeBuy: isReal=${real} ` +
      `REAL_TRADING_ENABLED=${process.env.REAL_TRADING_ENABLED} ` +
      `market=${input.marketId} outcome=${input.outcome} bet=${input.suggestedBet}`
    );
    try {
      // 0. Récupérer les données du marché (nécessaire pour negRisk + token IDs)
      const clobMarket = await getClobMarket(input.marketId);
      if (!clobMarket) throw new Error(`Marché introuvable dans CLOB: ${input.marketId}`);
      if (!clobMarket.active) throw new Error(`Marché CLOB inactif: ${input.marketId}`);

      // ── Guard 1 : Allowance — déléguée à Polymarket ──────────────────────
      // L'utilisateur a tradé manuellement sans approve explicite (1 seul popup
      // "Sign message"). Polymarket gère les approves en interne via son système
      // de relay. Notre check on-chain vérifie la mauvaise adresse/architecture.
      // On laisse Polymarket rejeter l'ordre si l'allowance est vraiment absente.
      console.log("[trade-executor] ℹ️ Allowance check skipped — relying on Polymarket validation");
      sendDiscordAlert(
        `ℹ️ **Allowance check skipped** — relying on Polymarket validation\n` +
        `Marché: ${input.question.slice(0, 80)} (negRisk=${clobMarket.negRisk})`
      ).catch(() => {});

      // ── Guard 2 : Balance USDC suffisante ─────────────────────────────────
      // getAccountBalance() retourne null si tous les RPCs échouent.
      // Dans ce cas on avertit Discord et on continue — Polymarket rejettera
      // l'ordre côté CLOB si la balance est réellement insuffisante.
      const balance    = await getAccountBalance();
      const minBalance = input.suggestedBet * 1.05;

      if (balance === null) {
        console.warn(
          `[trade-executor] ⚠ Balance check skipped (all RPCs failed) — ` +
          `proceeding, Polymarket will reject if insufficient`
        );
        sendDiscordAlert(
          `⚠️ **Balance check skipped** — tous les RPCs Polygon ont échoué\n` +
          `L'ordre sera soumis quand même. Polymarket rejettera si balance insuffisante.\n` +
          `Marché: ${input.question.slice(0, 80)}`
        ).catch(() => {});
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
      if (!token) throw new Error(`Token introuvable pour outcome "${input.outcome}"`);

      // 1. Placer l'ordre limit GTC
      const placed: PlacedOrder = await placeOrder({
        tokenId:    token.tokenId,
        side:       "BUY",
        amountUsdc: input.suggestedBet,
        price:      input.marketPrice,
        negRisk:    clobMarket.negRisk,
        dryRun:     false,
      });

      orderId    = placed.orderId;
      gasFeeUsdc = placed.gasFeeUsdc;
      isReal     = true;

      console.log(
        `[trade-executor] ✅ REAL BUY placed: ${input.marketId}/${input.outcome} ` +
        `orderId=${placed.orderId} bet=${input.suggestedBet}$ fee=${placed.gasFeeUsdc}$`
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
      logRealError(`executeBuy(${input.marketId}/${input.outcome})`, err);
      // Fallback : le paper trade a déjà été créé ci-dessus, on continue
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
  // Ces deux champs DOIVENT être persistés ensemble : clob_order_id est
  // indispensable pour que cancelOrder() fonctionne lors du sell réel.
  if (isReal && orderId) {
    await patchRealPosition(position.id, orderId).catch((err) => {
      // Erreur critique : sans clob_order_id, le sell réel ne pourra pas
      // annuler l'ordre. On log en erreur (pas warn) et on alerte Discord.
      logRealError(`patchRealPosition(${position.id})`, err);
    });
  }

  return {
    paperTradeId: paperTrade.id,
    positionId:   position.id,
    isReal,
    orderId,
    gasFeeUsdc,
  };
}

// ---------------------------------------------------------------------------
// executeSell
// ---------------------------------------------------------------------------

/**
 * Vend une position (real ou paper) selon position.isReal.
 *
 * Le chemin REAL annule l'ordre CLOB ouvert et calcule le P&L réel.
 * Le chemin PAPER utilise la simulation existante.
 * En cas d'échec real, fallback sur paper avec log Discord.
 */
export async function executeSell(
  position:   Position,
  sellPrice:  number,
  reason:     string
): Promise<number> {

  if (position.isReal) {
    try {
      // 1. Annuler l'ordre CLOB si encore ouvert.
      // Guard explicite : si clob_order_id est null sur une position is_real,
      // c'est un bug de persistance — on alerte plutôt que de silencer.
      if (position.clobOrderId) {
        await cancelOrder(position.clobOrderId).catch((err) => {
          console.warn(`[trade-executor] cancelOrder non-bloquant: ${err instanceof Error ? err.message : err}`);
        });
      } else {
        console.error(
          `[trade-executor] ⚠ REAL position ${position.id} n'a pas de clob_order_id — ` +
          `cancelOrder ignoré (bug de persistance lors du buy ?)`
        );
        sendDiscordAlert(
          `⚠️ **clob_order_id manquant** — position \`${position.id}\` (real=true)\n` +
          `L'ordre CLOB n'a pas pu être annulé. Vérifier manuellement sur Polymarket.`
        ).catch(() => {});
      }

      // 2. Calculer le P&L réel (même formule que paper + gas fee)
      const GAS_FEE = 0.01; // 2 transactions (buy + sell)
      const rawPnl  = Math.round(
        ((sellPrice - position.entryPrice) / position.entryPrice) * position.suggestedBet * 100
      ) / 100;
      const sellPnl = Math.round((rawPnl - GAS_FEE) * 100) / 100;
      const now     = new Date().toISOString();

      // 3. Mettre à jour la position en DB (même effet que paperExecuteSell)
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
        `[trade-executor] ✅ REAL SELL: ${position.marketId}/${position.outcome} ` +
        `entry=${position.entryPrice} sell=${sellPrice} pnl=${sellPnl}$ (gas=-${GAS_FEE}$)`
      );

      return sellPnl;
    } catch (err) {
      logRealError(`executeSell(${position.id})`, err);
      // Fallback paper
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
