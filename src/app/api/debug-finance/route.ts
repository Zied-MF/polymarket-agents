/**
 * Endpoint de debug finance
 *
 * GET /api/debug-finance
 *
 * Analyse les 10 premiers marchés stocks et expose le détail complet du pipeline :
 * score changePercent + range, raison précise du skip, edge calculé.
 */

import { NextResponse } from "next/server";
import { fetchStockMarkets }                                         from "@/lib/polymarket/gamma-api";
import { fetchStockData, fetchPreMarketData, calculateTechnicals }   from "@/lib/data-sources/finance-sources";
import { analyzeStockMarket }                                        from "@/lib/agents/finance-agent";

// ── Constantes identiques à finance-agent.ts ─────────────────────────────────
const MIN_EDGE  = 0.0798;
const MIN_SCORE = 10;
const PROB_BASE = 0.5;
const PROB_MIN  = 0.55;
const PROB_MAX  = 0.85;

// ── Scoring miroir de finance-agent.ts ───────────────────────────────────────

function debugScore(stockData: {
  changePercent: number;
  currentPrice:  number;
  high:          number;
  low:           number;
}) {
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
  } else {
    signals.push("range=N/A");
  }

  const dominantScore     = Math.max(upScore, downScore);
  const dominantDirection = upScore >= downScore ? "up" : "down";

  return { upScore, downScore, dominantScore, dominantDirection, signals };
}

function estimateProbability(upScore: number, downScore: number): number {
  const raw = PROB_BASE + (upScore - downScore) / 100;
  return Math.min(PROB_MAX, Math.max(PROB_MIN, raw));
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET() {
  const errors: string[] = [];
  const results = [];

  let markets;
  try {
    markets = await fetchStockMarkets();
    console.log(`[debug-finance] ${markets.length} marchés stocks récupérés`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `fetchStockMarkets failed: ${msg}` }, { status: 500 });
  }

  const sample = markets.slice(0, 10);

  for (const market of sample) {
    const entry: Record<string, unknown> = {
      question:      market.question,
      ticker:        market.ticker,
      direction:     market.direction,
      endDate:       market.endDate instanceof Date ? market.endDate.toISOString() : market.endDate,
      liquidity:     market.liquidity,
      outcomes:      market.outcomes,
      outcomePrices: market.outcomePrices,
    };

    // Filtre consensus (seuil 95% — identique à scan-markets)
    if (market.outcomePrices.some((p) => p >= 0.95)) {
      const dominant = Math.max(...market.outcomePrices);
      entry.skipped    = true;
      entry.skipReason = `consensus fort — prix dominant ${(dominant * 100).toFixed(1)}%`;
      entry.analysis   = null;
      results.push(entry);
      continue;
    }

    // Filtre liquidité
    if (market.liquidity < 100) {
      entry.skipped    = true;
      entry.skipReason = `liquidité insuffisante — $${market.liquidity.toFixed(2)} < $100`;
      entry.analysis   = null;
      results.push(entry);
      continue;
    }

    // Fetch Finnhub
    let stockData, preMarket, technicals;
    try {
      [stockData, preMarket] = await Promise.all([
        fetchStockData(market.ticker),
        fetchPreMarketData(market.ticker),
      ]);
      technicals = calculateTechnicals(stockData.priceHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[debug-finance] ${market.ticker} Finnhub error:`, msg);
      errors.push(`${market.ticker}: ${msg}`);
      entry.skipped    = true;
      entry.skipReason = `erreur API Finnhub — ${msg}`;
      entry.analysis   = null;
      results.push(entry);
      continue;
    }

    // Scoring (miroir exact de finance-agent.ts)
    const { upScore, downScore, dominantScore, dominantDirection, signals } =
      debugScore(stockData);

    const estimatedProbability =
      dominantScore >= MIN_SCORE
        ? estimateProbability(
            dominantDirection === "up" ? upScore : 0,
            dominantDirection === "up" ? 0 : downScore
          )
        : null;

    // Prix de l'outcome correspondant à la direction dominante
    const matchIdx = market.outcomes.findIndex((o) => {
      const l = o.toLowerCase().trim();
      return dominantDirection === "up"
        ? /^yes$|higher|above|gain|up|rise/.test(l)
        : /^no$|lower|below|drop|down|fall/.test(l);
    });
    const matchPrice = matchIdx >= 0 ? market.outcomePrices[matchIdx] : market.outcomePrices[0];
    const edge       = estimatedProbability !== null ? estimatedProbability - matchPrice : null;

    // Raison du skip
    let skipReason: string | null = null;
    if (dominantScore < MIN_SCORE) {
      skipReason = `score trop faible — ${dominantScore} < ${MIN_SCORE} requis`;
    } else if (matchIdx < 0) {
      skipReason = `direction inconnue — aucun outcome ne correspond à "${dominantDirection}"`;
    } else if (edge !== null && edge > 0.50) {
      skipReason = `edge suspect (${(edge * 100).toFixed(1)}% > 50%) — données corrompues`;
    } else if (edge !== null && edge < MIN_EDGE) {
      skipReason = `edge trop faible — ${(edge * 100).toFixed(2)}% < ${(MIN_EDGE * 100).toFixed(2)}% requis (estimé=${((estimatedProbability ?? 0) * 100).toFixed(1)}%, marché=${(matchPrice * 100).toFixed(1)}%)`;
    }

    // Source de vérité : appel réel à analyzeStockMarket
    const finalOpportunities = analyzeStockMarket(market, stockData, preMarket, technicals);

    entry.skipped    = skipReason !== null;
    entry.skipReason = skipReason;
    entry.analysis   = {
      currentPrice:          stockData.currentPrice,
      previousClose:         stockData.previousClose,
      open:                  stockData.open,
      high:                  stockData.high,
      low:                   stockData.low,
      changePercent:         stockData.changePercent,
      upScore,
      downScore,
      dominantScore,
      dominantDirection,
      estimatedProbability,
      matchPrice,
      edge,
      signals,
      opportunities: finalOpportunities.map((o) => ({
        outcome:              o.outcome,
        marketPrice:          o.marketPrice,
        estimatedProbability: o.estimatedProbability,
        edge:                 o.edge,
      })),
    };

    results.push(entry);
  }

  return NextResponse.json({
    scannedAt:    new Date().toISOString(),
    totalMarkets: markets.length,
    analyzed:     sample.length,
    results,
    errors,
  });
}
