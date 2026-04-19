/**
 * Position Manager — évaluation des positions ouvertes (5-layer exit system)
 *
 * Ce module est purement fonctionnel (pas d'I/O).
 * Il expose evaluatePosition() qui détermine si une position doit être vendue.
 *
 * 5 layers d'exit (+ grace period) :
 *   Layer 1  — Grace period < 5 min → HOLD toujours
 *   Layer 2  — Hard stop-loss à −50% P&L → SELL critique
 *   Layer 3  — Stop-loss à −25% après 15 min → SELL
 *   Layer 4  — Profit target : 80% edge capturé à < 2h résolution → SELL
 *   Layer 5  — Trailing stop : si peak ≥ +30% et redescend à +15% → SELL
 *   Layer 6  — Time decay : < 1h résolution et P&L < −10% → SELL
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
  status:             "open" | "hold" | "sell_signal" | "sold" | "resolved";
  sellReason:         string | null;
  openedAt:           Date;
  resolutionDate:     Date | null;
  /** Peak P&L % observed since entry — for trailing stop (Layer 5). Null if not tracked. */
  peakPnlPercent?:    number | null;
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
  const potentialPnl = Math.round((currentPrice - entryPrice) * position.suggestedBet * 100) / 100;

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

  // ── Layer 4 : Profit target — 80% edge capturé proche de résolution ─────
  // "80% edge capturé" ≈ currentPrice ≥ entryPrice + 0.8 × (1 - entryPrice)
  const profitTarget = entryPrice + 0.80 * (1 - entryPrice);
  if (hoursToResolution < 2 && currentPrice >= profitTarget) {
    return sell(
      `Profit target : prix=${currentPrice.toFixed(3)} ≥ ${profitTarget.toFixed(3)} (80% edge), résolution dans ${hoursToResolution.toFixed(1)}h`,
      4, "medium"
    );
  }

  // ── Layer 5 : Trailing stop ─────────────────────────────────────────────
  const peakPnl = position.peakPnlPercent ?? null;
  if (peakPnl !== null && peakPnl >= 0.30) {
    const dropFromPeak = peakPnl - pnlPercent;
    if (dropFromPeak >= 0.15 && ageMinutes >= 15) {
      return sell(
        `Trailing stop : peak=${(peakPnl * 100).toFixed(1)}%, now=${(pnlPercent * 100).toFixed(1)}%, drop=${(dropFromPeak * 100).toFixed(1)}%`,
        5, "medium"
      );
    }
  }

  // ── Layer 6 : Time decay — proche de résolution avec position perdante ──
  if (hoursToResolution < 1 && pnlPercent < -0.10) {
    return sell(
      `Time decay : résolution dans ${(hoursToResolution * 60).toFixed(0)}min, P&L = ${(pnlPercent * 100).toFixed(1)}%`,
      6, "high"
    );
  }

  return null; // HOLD
}
