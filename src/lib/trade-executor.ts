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
  type PlacedOrder,
}                                    from "@/lib/polymarket/clob-api";
import { sendDiscordAlert }          from "@/lib/utils/discord";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lit REAL_TRADING_ENABLED à chaque appel (runtime, pas build-time). */
export function isRealTradingEnabled(): boolean {
  return process.env.REAL_TRADING_ENABLED === "true";
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
    try {
      // 1. Récupérer les token IDs depuis le CLOB
      const clobMarket = await getClobMarket(input.marketId);
      if (!clobMarket) throw new Error(`Marché introuvable dans CLOB: ${input.marketId}`);
      if (!clobMarket.active) throw new Error(`Marché CLOB inactif: ${input.marketId}`);

      const token = clobMarket.tokens.find(
        (t) => t.outcome.toLowerCase() === input.outcome.toLowerCase()
      );
      if (!token) throw new Error(`Token introuvable pour outcome "${input.outcome}"`);

      // 2. Placer l'ordre limit GTC
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

  // Marquer is_real sur la position si real trade réussi
  if (isReal) {
    await patchIsReal("positions", position.id).catch(() => {});
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
      // 1. Annuler l'ordre CLOB si encore ouvert
      if (position.clobOrderId) {
        await cancelOrder(position.clobOrderId).catch((err) => {
          console.warn(`[trade-executor] cancelOrder non-bloquant: ${err instanceof Error ? err.message : err}`);
        });
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
  // Import dynamique pour éviter la dépendance circulaire
  const { getClient } = await import("@/lib/db/supabase");
  const db = getClient();
  const { error } = await db.from(table).update({ is_real: true }).eq("id", id);
  if (error) console.warn(`[trade-executor] patchIsReal(${table}/${id}): ${error.message}`);
}
