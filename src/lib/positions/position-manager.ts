/**
 * Position Manager — évaluation des positions ouvertes (5-layer exit system)
 *
 * Ce module est purement fonctionnel (pas d'I/O).
 * Il expose evaluatePosition() qui détermine si une position doit être vendue.
 *
 * 2 layers d'exit (+ grace period) :
 *   Layer 1  — Grace period < 5 min → HOLD toujours
 *   Layer 2  — Hard stop-loss à −50% P&L → SELL critique
 *   Layer 3  — Stop-loss à −25% après 15 min → SELL
 *   Layer 4  — SUPPRIMÉ (profit target — inutile, resolvePosition() ferme à $1.00)
 *   Layer 5  — SUPPRIMÉ (trailing stop — contre-productif sur marchés binaires météo)
 *   Layer 6  — SUPPRIMÉ (time decay — risque de vendre des gagnants sur du bruit)
 *
 * Colonnes DB optionnelles (amélioration trailing stop) :
 *   ALTER TABLE positions ADD COLUMN IF NOT EXISTS peak_pnl_percent DECIMAL;
 */

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface Position {
  id:                 string;
  paperTradeId:       string;
  marketId:           string;
  question:           string;
  city:               string | null;
  ticker:             string | null;
  agent:              "weather" | "finance" | "crypto";
  outcome:            string;
  entryPrice:         number;
  entryProbability:   number;
  currentPrice:       number | null;
  currentProbability: number | null;
  suggestedBet:       number;
  status:             "open" | "hold" | "sell_signal" | "sold" | "resolved" | "sell_failed";
  sellReason:         string | null;
  openedAt:           Date;
  resolutionDate:     Date | null;
  /** Peak P&L % observed since entry — for trailing stop (Layer 5). Null if not tracked. */
  peakPnlPercent?:    number | null;
  /** true si placée en réel sur le CLOB Polymarket. */
  isReal?:            boolean | null;
  /** CLOB order ID pour annulation lors du sell réel. */
  clobOrderId?:       string | null;
  /** Nombre réel de shares détenus on-chain (lu depuis ERC-1155 après le BUY). */
  sharesFilled?:      number | null;
  /** Nombre de tentatives de sell échouées (pour retry logic). */
  syncAttempts?:      number | null;
}

/** Snapshot des prix actuels d'un marché Polymarket. */
export interface MarketSnapshot {
  marketId:      string;
  outcomes:      string[];
  outcomePrices: number[];
}

export interface SellSignal {
  positionId:      string;
  reason:          string;
  suggestedAction: "SELL";
  entryPrice:      number;
  currentPrice:    number;
  entryProb:       number;
  currentProb:     number;
  /** P&L si on vend maintenant. */
  potentialPnl:    number;
  /** P&L estimé à résolution. */
  projectedPnl:    number;
  /** Layer ayant déclenché le signal (1–6). */
  layer:           number;
  /** Urgence du signal. */
  urgency:         "critical" | "high" | "medium" | "low";
}

// ---------------------------------------------------------------------------
// evaluatePosition — 5-layer exit system
// ---------------------------------------------------------------------------

/**
 * Évalue une position ouverte et retourne un SellSignal si un exit est justifié,
 * null pour HOLD.
 *
 * @param position  Position avec currentPrice/currentProbability à jour.
 * @param snapshot  Données de marché en temps réel.
 */
export function evaluatePosition(
  position: Position,
  snapshot: MarketSnapshot
): SellSignal | null {
  // Résoudre le prix courant depuis le snapshot
  const outcomeIdx   = snapshot.outcomes.findIndex(
    (o) => o.toLowerCase() === position.outcome.toLowerCase()
  );
  const currentPrice = outcomeIdx >= 0
    ? snapshot.outcomePrices[outcomeIdx]
    : (position.currentPrice ?? position.entryPrice);
  const currentProb  = currentPrice;

  const entryPrice   = position.entryPrice;
  const ageMinutes   = (Date.now() - new Date(position.openedAt).getTime()) / (1000 * 60);
  const pnlPercent   = (currentPrice - entryPrice) / entryPrice;

  const hoursToResolution = position.resolutionDate
    ? (new Date(position.resolutionDate).getTime() - Date.now()) / (1000 * 60 * 60)
    : Infinity;

  // P&L si on vend maintenant
  // shares = nombre réel de tokens détenus (sharesFilled si disponible, sinon calculé depuis entry_price)
  const shares = (position.sharesFilled != null && position.sharesFilled > 0)
    ? position.sharesFilled
    : position.suggestedBet / entryPrice;
  const potentialPnl = Math.round((currentPrice - entryPrice) * shares * 100) / 100;

  // P&L projeté si on garde jusqu'à résolution
  const projectedPnl = Math.round(
    (currentProb >= 0.5
      ? (1 / currentPrice - 1) * position.suggestedBet
      : -position.suggestedBet) * 100
  ) / 100;

  function sell(reason: string, layer: number, urgency: SellSignal["urgency"]): SellSignal {
    return {
      positionId:      position.id,
      reason,
      suggestedAction: "SELL",
      entryPrice,
      currentPrice,
      entryProb:       position.entryProbability,
      currentProb,
      potentialPnl,
      projectedPnl,
      layer,
      urgency,
    };
  }

  // ── Layer 1 : Grace period (5 min) ──────────────────────────────────────
  if (ageMinutes < 5) {
    return null; // HOLD — trop tôt
  }

  // ── Layer 2 : Hard stop-loss à −50% ─────────────────────────────────────
  if (pnlPercent <= -0.50) {
    return sell(
      `HARD STOP LOSS : P&L = ${(pnlPercent * 100).toFixed(1)}% (≤ −50%)`,
      2, "critical"
    );
  }

  // ── Layer 3 : Stop-loss à −25% après 15 min ─────────────────────────────
  if (pnlPercent <= -0.25 && ageMinutes >= 15) {
    return sell(
      `Stop-loss : P&L = ${(pnlPercent * 100).toFixed(1)}% (≤ −25%, age=${Math.round(ageMinutes)}min)`,
      3, "high"
    );
  }

  return null; // HOLD
}
