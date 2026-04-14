/**
 * Finance Agent — détection d'opportunités sur les marchés stocks Polymarket
 *
 * Analyse chaque marché de type "Will AAPL close higher on April 15?"
 * via un système de scoring à points :
 *
 *   Pré-marché > +1%      → +20 pts UP   | < -1% → +20 pts DOWN
 *   RSI < 30 (survendu)   → +15 pts UP   | RSI > 70 → +15 pts DOWN
 *   Prix > SMA20 (bullish)→ +10 pts UP   | Prix < SMA20 → +10 pts DOWN
 *   Volume > avg × 1.5   → +5 pts (confirme la tendance dominante)
 *
 *   Score > 30  → HIGH,   estimatedProbability = 0.70
 *   Score 20-30 → MEDIUM, estimatedProbability = 0.62
 *   Score < 20  → skip
 *
 * Retourne les Outcome[] dont l'edge >= MIN_EDGE (7.98%), triés par edge desc.
 */

import type { StockMarket }                         from "@/lib/polymarket/gamma-api";
import type { StockData, PreMarketData, Technicals } from "@/lib/data-sources/finance-sources";
import type { Outcome }                              from "@/types";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MIN_EDGE = 0.0798;

/** Seuil de score pour chaque niveau de confiance. */
const SCORE_HIGH   = 30;
const SCORE_MEDIUM = 20;

/** Probabilité estimée associée à chaque niveau de confiance. */
const PROB_HIGH   = 0.70;
const PROB_MEDIUM = 0.62;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoreBreakdown {
  upScore: number;
  downScore: number;
  details: string[];
}

function computeScore(
  stockData:  StockData,
  preMarket:  PreMarketData,
  technicals: Technicals
): ScoreBreakdown {
  let upScore   = 0;
  let downScore = 0;
  const details: string[] = [];

  // --- Pré-marché ---
  const pmPct = preMarket.preMarketChangePercent;
  if (pmPct !== null) {
    if (pmPct > 1) {
      upScore += 20;
      details.push(`preMarket=+${pmPct.toFixed(2)}% → +20 UP`);
    } else if (pmPct < -1) {
      downScore += 20;
      details.push(`preMarket=${pmPct.toFixed(2)}% → +20 DOWN`);
    } else {
      details.push(`preMarket=${pmPct.toFixed(2)}% (neutre)`);
    }
  } else {
    details.push("preMarket=N/A");
  }

  // --- RSI ---
  const rsi = technicals.rsi;
  if (rsi !== null) {
    if (rsi < 30) {
      upScore += 15;
      details.push(`RSI=${rsi.toFixed(0)} (survendu) → +15 UP`);
    } else if (rsi > 70) {
      downScore += 15;
      details.push(`RSI=${rsi.toFixed(0)} (suracheté) → +15 DOWN`);
    } else {
      details.push(`RSI=${rsi.toFixed(0)} (neutre)`);
    }
  } else {
    details.push("RSI=N/A (historique insuffisant)");
  }

  // --- SMA20 ---
  if (technicals.trend === "bullish") {
    upScore += 10;
    details.push(`trend=bullish (prix > SMA20) → +10 UP`);
  } else if (technicals.trend === "bearish") {
    downScore += 10;
    details.push(`trend=bearish (prix < SMA20) → +10 DOWN`);
  } else {
    details.push("trend=neutral");
  }

  // --- Volume ---
  if (stockData.avgVolume > 0 && stockData.volume > stockData.avgVolume * 1.5) {
    // Le volume confirme la tendance dominante
    if (upScore >= downScore) {
      upScore += 5;
      details.push(`volume=${(stockData.volume / 1e6).toFixed(1)}M > avg×1.5 → +5 UP`);
    } else {
      downScore += 5;
      details.push(`volume=${(stockData.volume / 1e6).toFixed(1)}M > avg×1.5 → +5 DOWN`);
    }
  }

  return { upScore, downScore, details };
}

// ---------------------------------------------------------------------------
// Résolution de la direction du marché
// ---------------------------------------------------------------------------

/**
 * Détermine quel outcome d'un marché binaire correspond à "UP" ou "DOWN".
 * Pour un marché "Will AAPL close higher?", les outcomes sont souvent
 * ["Yes", "No"] ou ["Higher", "Lower"].
 */
function resolveOutcomeDirection(
  outcomeLabel: string,
  marketDirection: "up" | "down" | "unknown"
): "up" | "down" | "unknown" {
  const o = outcomeLabel.toLowerCase().trim();

  if (/^yes$|higher|above|gain|up|rise/.test(o)) return "up";
  if (/^no$|lower|below|drop|down|fall/.test(o)) return "down";

  // Si le marché est directionnel et qu'on n'a qu'un seul outcome ambigu,
  // on suppose que "Yes" = sens du marché
  if (marketDirection !== "unknown") return marketDirection;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

/**
 * Analyse un marché stock Polymarket et retourne les Outcome[] exploitables.
 *
 * @param market     Marché Polymarket (StockMarket)
 * @param stockData  Données Yahoo Finance (prix, volume, historique)
 * @param preMarket  Données pré-marché
 * @param technicals RSI, SMA20, tendance
 * @returns Outcomes avec edge >= 7.98%, triés par edge décroissant
 */
export function analyzeStockMarket(
  market:     StockMarket,
  stockData:  StockData,
  preMarket:  PreMarketData,
  technicals: Technicals
): Outcome[] {
  const { upScore, downScore, details } = computeScore(stockData, preMarket, technicals);

  const dominantScore     = Math.max(upScore, downScore);
  const dominantDirection = upScore >= downScore ? "up" : "down";

  // Niveau de confiance
  let confidence: "high" | "medium" | "low";
  let estimatedProbability: number;

  if (dominantScore >= SCORE_HIGH) {
    confidence           = "high";
    estimatedProbability = PROB_HIGH;
  } else if (dominantScore >= SCORE_MEDIUM) {
    confidence           = "medium";
    estimatedProbability = PROB_MEDIUM;
  } else {
    confidence = "low";
    console.log(
      `[finance-agent] ${market.ticker}: score=${dominantScore} (${dominantDirection}) — skip (< ${SCORE_MEDIUM})`
    );
    return [];
  }

  const pmStr = preMarket.preMarketChangePercent !== null
    ? `${preMarket.preMarketChangePercent > 0 ? "+" : ""}${preMarket.preMarketChangePercent.toFixed(2)}%`
    : "N/A";
  const rsiStr = technicals.rsi !== null ? technicals.rsi.toFixed(0) : "N/A";

  console.log(
    `[finance-agent] ${market.ticker}: preMarket=${pmStr}, RSI=${rsiStr}, ` +
    `score=${dominantScore}, confidence=${confidence.toUpperCase()}, ` +
    `direction=${dominantDirection}`
  );
  for (const d of details) {
    console.log(`[finance-agent]   ${d}`);
  }

  // Construire les Outcome[] pour les outcomes correspondant à la direction dominante
  const results: Outcome[] = [];

  for (let i = 0; i < market.outcomes.length; i++) {
    const label       = market.outcomes[i];
    const marketPrice = market.outcomePrices[i];

    const outcomeDir = resolveOutcomeDirection(label, market.direction);
    if (outcomeDir !== dominantDirection) continue;

    const edge = estimatedProbability - marketPrice;
    if (edge < MIN_EDGE) {
      console.log(
        `[finance-agent] ${market.ticker}: outcome="${label}" — edge=${(edge * 100).toFixed(2)}% < ${(MIN_EDGE * 100).toFixed(2)}% — skip`
      );
      continue;
    }

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
