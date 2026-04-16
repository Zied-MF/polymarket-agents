/**
 * Position Manager — évaluation des positions ouvertes
 *
 * Ce module est purement fonctionnel (pas d'I/O).
 * Il expose les types partagés et la fonction evaluatePosition() qui détermine
 * si une position doit être vendue ou conservée.
 *
 * Règles de sell signal :
 *   SELL  si currentProbability < entryProbability - 0.25 (chute de 25+ pts)
 *   SELL  si currentPrice < entryPrice × 0.5 (prix divisé par 2+)
 *   HOLD  sinon
 */

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface Position {
  id: string;
  paperTradeId: string;
  marketId: string;
  question: string;
  city: string | null;
  ticker: string | null;
  agent: "weather" | "finance" | "crypto";
  outcome: string;
  entryPrice: number;
  entryProbability: number;
  currentPrice: number | null;
  currentProbability: number | null;
  suggestedBet: number;
  status: "open" | "hold" | "sell_signal" | "sold" | "resolved";
  sellReason: string | null;
  openedAt: Date;
  resolutionDate: Date | null;
}

/** Snapshot des prix actuels d'un marché Polymarket. */
export interface MarketSnapshot {
  marketId: string;
  /** Labels des outcomes dans le même ordre que outcomePrices. */
  outcomes: string[];
  /** Prix actuels [0, 1] pour chaque outcome. */
  outcomePrices: number[];
}

export interface SellSignal {
  positionId: string;
  reason: string;
  suggestedAction: "SELL";
  entryPrice: number;
  currentPrice: number;
  entryProb: number;
  currentProb: number;
  /** P&L si on vend au prix actuel (currentPrice - entryPrice) × bet. */
  potentialPnl: number;
  /** P&L estimé si on garde jusqu'à résolution (probabilité actuelle). */
  projectedPnl: number;
}

// ---------------------------------------------------------------------------
// evaluatePosition
// ---------------------------------------------------------------------------

/**
 * Évalue une position ouverte par rapport au snapshot de marché actuel.
 *
 * @param position     Position à évaluer (avec currentPrice/currentProbability mis à jour).
 * @param snapshot     Données de marché en temps réel (tous les outcomes).
 * @returns SellSignal si une action est recommandée, null pour HOLD.
 */
export function evaluatePosition(
  position: Position,
  snapshot: MarketSnapshot
): SellSignal | null {
  // Trouver le prix actuel de l'outcome de la position
  const outcomeIdx = snapshot.outcomes.findIndex(
    (o) => o.toLowerCase() === position.outcome.toLowerCase()
  );

  const currentPrice =
    outcomeIdx >= 0 ? snapshot.outcomePrices[outcomeIdx] : position.currentPrice ?? position.entryPrice;
  const currentProb  = currentPrice; // sur Polymarket, prix = probabilité implicite

  const probDrop  = position.entryProbability - currentProb;
  const priceRatio = currentPrice / position.entryPrice;

  // P&L si on vend maintenant (gain/perte sur la position)
  const potentialPnl = Math.round(
    (currentPrice - position.entryPrice) * position.suggestedBet * 100
  ) / 100;

  // P&L projeté si on garde (basé sur la probabilité actuelle)
  const projectedPnl = Math.round(
    currentProb >= 0.5
      ? (1 / currentPrice - 1) * position.suggestedBet
      : -position.suggestedBet
  * 100) / 100;

  // ── Règle 1 : chute de probabilité ≥ 25 pts ─────────────────────────────
  if (probDrop >= 0.25) {
    return {
      positionId:      position.id,
      reason:          `Probabilité en baisse : ${(position.entryProbability * 100).toFixed(0)}% → ${(currentProb * 100).toFixed(0)}% (−${(probDrop * 100).toFixed(0)} pts)`,
      suggestedAction: "SELL",
      entryPrice:      position.entryPrice,
      currentPrice,
      entryProb:       position.entryProbability,
      currentProb,
      potentialPnl,
      projectedPnl,
    };
  }

  // ── Règle 2 : prix divisé par 2 ou plus ─────────────────────────────────
  if (priceRatio < 0.5) {
    return {
      positionId:      position.id,
      reason:          `Prix en chute : ${position.entryPrice.toFixed(3)} → ${currentPrice.toFixed(3)} (−${((1 - priceRatio) * 100).toFixed(0)}%)`,
      suggestedAction: "SELL",
      entryPrice:      position.entryPrice,
      currentPrice,
      entryProb:       position.entryProbability,
      currentProb,
      potentialPnl,
      projectedPnl,
    };
  }

  return null; // HOLD
}
