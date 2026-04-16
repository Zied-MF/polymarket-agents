/**
 * Finance Agent — détection d'opportunités sur les marchés stocks Polymarket
 *
 * Scoring basé sur les données Finnhub /quote :
 *
 *   changePercent ≥ 2%   → +25 UP   | ≤ -2%  → +25 DOWN
 *   changePercent ≥ 1%   → +15 UP   | ≤ -1%  → +15 DOWN
 *   changePercent ≥ 0.5% → +10 UP   | ≤ -0.5%→ +10 DOWN
 *   Position dans range  → +10 UP (> 70%) ou DOWN (< 30%)
 *
 *   Score ≥ 15 → bet, probabilité estimée = 0.5 + (upScore - downScore) / 100
 *   Clampée entre 0.55 et 0.85.
 *   Edge = estimatedProbability - marketPrice ≥ 7.98% pour valider.
 */

import type { StockMarket }                          from "@/lib/polymarket/gamma-api";
import type { StockData, PreMarketData, Technicals } from "@/lib/data-sources/finance-sources";
import type { Outcome }                              from "@/types";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MIN_EDGE        = 0.0798;
const MIN_SCORE       = 10;
const PROB_BASE       = 0.5;
const PROB_MIN        = 0.55;
const PROB_MAX        = 0.85;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoreBreakdown {
  upScore:   number;
  downScore: number;
  signals:   string[];
}

function computeScore(data: StockData): ScoreBreakdown {
  let upScore   = 0;
  let downScore = 0;
  const signals: string[] = [];

  // --- Variation journalière ---
  const cp = data.changePercent;
  if (cp >= 2) {
    upScore += 25;
    signals.push(`changePercent=+${cp.toFixed(2)}% → UP +25`);
  } else if (cp >= 1) {
    upScore += 15;
    signals.push(`changePercent=+${cp.toFixed(2)}% → UP +15`);
  } else if (cp >= 0.5) {
    upScore += 10;
    signals.push(`changePercent=+${cp.toFixed(2)}% → UP +10`);
  } else if (cp <= -2) {
    downScore += 25;
    signals.push(`changePercent=${cp.toFixed(2)}% → DOWN +25`);
  } else if (cp <= -1) {
    downScore += 15;
    signals.push(`changePercent=${cp.toFixed(2)}% → DOWN +15`);
  } else if (cp <= -0.5) {
    downScore += 10;
    signals.push(`changePercent=${cp.toFixed(2)}% → DOWN +10`);
  } else {
    signals.push(`changePercent=${cp.toFixed(2)}% → neutral`);
  }

  // --- Position dans le range du jour ---
  if (data.high > data.low) {
    const position = (data.currentPrice - data.low) / (data.high - data.low);
    if (position > 0.7) {
      upScore += 10;
      signals.push(`range position=${(position * 100).toFixed(0)}% (haut) → UP +10`);
    } else if (position < 0.3) {
      downScore += 10;
      signals.push(`range position=${(position * 100).toFixed(0)}% (bas) → DOWN +10`);
    } else {
      signals.push(`range position=${(position * 100).toFixed(0)}% (neutre)`);
    }
  } else {
    signals.push("range=N/A (high = low)");
  }

  return { upScore, downScore, signals };
}

// ---------------------------------------------------------------------------
// Probabilité estimée
// ---------------------------------------------------------------------------

function estimateProbability(upScore: number, downScore: number): number {
  const raw = PROB_BASE + (upScore - downScore) / 100;
  return Math.min(PROB_MAX, Math.max(PROB_MIN, raw));
}

// ---------------------------------------------------------------------------
// Mean-reversion — pénalité si Polymarket a déjà pricé le momentum
// ---------------------------------------------------------------------------

/**
 * Polymarket tend vers le mean-reversion : si un titre a bougé de +3%
 * et que le marché price déjà > 75 % dans cette direction, le signal a
 * probablement déjà été intégré. Divise le score par 2 dans ce cas.
 *
 * @param rawScore     Score brut (upScore ou downScore selon la direction dominante)
 * @param changePercent Variation % de la journée (positive = hausse)
 * @param marketPrice   Prix Polymarket de l'outcome dans la direction dominante [0,1]
 */
function adjustForMeanReversion(
  rawScore:      number,
  changePercent: number,
  marketPrice:   number
): number {
  if (changePercent > 2 && marketPrice > 0.75) {
    console.log(
      `[finance-agent] Mean-reversion penalty: market already prices ${(marketPrice * 100).toFixed(0)}% UP`
    );
    return rawScore * 0.5;
  }
  if (changePercent < -2 && marketPrice < 0.25) {
    console.log(
      `[finance-agent] Mean-reversion penalty: market already prices ${((1 - marketPrice) * 100).toFixed(0)}% DOWN`
    );
    return rawScore * 0.5;
  }
  return rawScore;
}

// ---------------------------------------------------------------------------
// Résolution de la direction d'un outcome
// ---------------------------------------------------------------------------

function resolveOutcomeDirection(
  outcomeLabel:    string,
  marketDirection: "up" | "down" | "unknown"
): "up" | "down" | "unknown" {
  const o = outcomeLabel.toLowerCase().trim();

  if (/^yes$|higher|above|gain|up|rise/.test(o)) return "up";
  if (/^no$|lower|below|drop|down|fall/.test(o))  return "down";

  if (marketDirection !== "unknown") return marketDirection;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

export function analyzeStockMarket(
  market:      StockMarket,
  stockData:   StockData,
  _preMarket:  PreMarketData,
  _technicals: Technicals
): Outcome[] {
  // Scoring inline — changePercent lu directement depuis Finnhub /quote
  let upScore   = 0;
  let downScore = 0;
  const signals: string[] = [];

  const change = stockData.changePercent || 0;

  if (change >= 2) {
    upScore = 25;
    signals.push(`change=+${change.toFixed(2)}% → UP +25`);
  } else if (change >= 1) {
    upScore = 15;
    signals.push(`change=+${change.toFixed(2)}% → UP +15`);
  } else if (change >= 0.5) {
    upScore = 10;
    signals.push(`change=+${change.toFixed(2)}% → UP +10`);
  } else if (change <= -2) {
    downScore = 25;
    signals.push(`change=${change.toFixed(2)}% → DOWN +25`);
  } else if (change <= -1) {
    downScore = 15;
    signals.push(`change=${change.toFixed(2)}% → DOWN +15`);
  } else if (change <= -0.5) {
    downScore = 10;
    signals.push(`change=${change.toFixed(2)}% → DOWN +10`);
  } else {
    signals.push(`change=${change.toFixed(2)}% → neutral`);
  }

  // Position dans le range du jour
  if (stockData.high > stockData.low) {
    const position = (stockData.currentPrice - stockData.low) / (stockData.high - stockData.low);
    if (position > 0.7) {
      upScore += 10;
      signals.push(`range position=${(position * 100).toFixed(0)}% (haut) → UP +10`);
    } else if (position < 0.3) {
      downScore += 10;
      signals.push(`range position=${(position * 100).toFixed(0)}% (bas) → DOWN +10`);
    } else {
      signals.push(`range position=${(position * 100).toFixed(0)}% (neutre)`);
    }
  }

  console.log(`[finance-agent] ${market.ticker}: change=${change}%, upScore=${upScore}, downScore=${downScore}`);

  const dominantDirection = upScore >= downScore ? "up" : "down";

  // Trouver le prix du marché pour l'outcome dominant (pour mean-reversion)
  const dominantMarketPrice = market.outcomePrices.find((_, i) =>
    resolveOutcomeDirection(market.outcomes[i], market.direction) === dominantDirection
  ) ?? 0.5;

  // Appliquer la pénalité mean-reversion avant de calculer la probabilité
  const rawDominantScore = Math.max(upScore, downScore);
  const dominantScore    = adjustForMeanReversion(rawDominantScore, change, dominantMarketPrice);

  if (dominantScore < MIN_SCORE) {
    console.log(`[finance-agent] ${market.ticker}: score=${dominantScore.toFixed(1)} < ${MIN_SCORE} — skip`);
    return [];
  }

  const estimatedProbability = estimateProbability(
    dominantDirection === "up" ? dominantScore : 0,
    dominantDirection === "up" ? 0 : dominantScore
  );

  console.log(
    `[finance-agent] ${market.ticker}: dominantScore=${dominantScore} → ${dominantDirection.toUpperCase()}, estimatedP=${estimatedProbability.toFixed(3)}`
  );
  for (const s of signals) {
    console.log(`[finance-agent]   ${s}`);
  }

  const results: Outcome[] = [];

  for (let i = 0; i < market.outcomes.length; i++) {
    const label       = market.outcomes[i];
    const marketPrice = market.outcomePrices[i];

    if (marketPrice < 0.01 || marketPrice > 0.99) {
      console.log(`[finance-agent] ${market.ticker}: prix invalide ${marketPrice} — "${label}" ignoré`);
      continue;
    }

    const outcomeDir = resolveOutcomeDirection(label, market.direction);
    if (outcomeDir !== dominantDirection) continue;

    const edge = estimatedProbability - marketPrice;

    if (edge > 0.50) {
      console.warn(
        `[finance-agent] ${market.ticker}: edge suspect (${(edge * 100).toFixed(1)}% > 50%) pour "${label}" — ignoré`
      );
      continue;
    }

    if (edge < MIN_EDGE) {
      console.log(
        `[finance-agent] ${market.ticker}: outcome="${label}" — edge=${(edge * 100).toFixed(2)}% < ${(MIN_EDGE * 100).toFixed(2)}% ` +
        `(estimé=${(estimatedProbability * 100).toFixed(1)}%, marché=${(marketPrice * 100).toFixed(1)}%) — skip`
      );
      continue;
    }

    console.log(
      `[finance-agent] ${market.ticker}: outcome="${label}" — edge=+${(edge * 100).toFixed(2)}% ✅`
    );

    results.push({
      market,
      outcome:              label,
      marketPrice,
      estimatedProbability,
      edge,
      multiplier:           marketPrice > 0 ? 1 / marketPrice : Infinity,
    });
  }

  return results.sort((a, b) => b.edge - a.edge);
}
