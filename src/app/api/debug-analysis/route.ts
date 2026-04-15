/**
 * Debug Analysis Endpoint
 *
 * GET /api/debug-analysis
 *
 * Retourne TOUS les outcomes de chaque marché (y compris ceux en-dessous
 * du seuil MIN_EDGE), avec `wouldBet` et `skipReason` pour comprendre
 * pourquoi chaque outcome est ou n'est pas exploité.
 *
 * Trie par meilleur edge du marché (descendant) et retourne les 20 premiers.
 */

import { NextResponse }                                              from "next/server";
import { fetchAllWeatherMarkets, fetchStockMarkets }                 from "@/lib/polymarket/gamma-api";
import { fetchForecastForStation }                                   from "@/lib/data-sources/weather-sources";
import { fetchStockData, fetchPreMarketData, calculateTechnicals }   from "@/lib/data-sources/finance-sources";

// ---------------------------------------------------------------------------
// Constantes (mirror weather-agent & finance-agent)
// ---------------------------------------------------------------------------

const MIN_EDGE     = 0.0798;
const BASE_SIGMA_C = 2.0;
const SCORE_HIGH   = 30;
const SCORE_MEDIUM = 20;
const PROB_HIGH    = 0.70;
const PROB_MEDIUM  = 0.62;

// ---------------------------------------------------------------------------
// Maths : distribution gaussienne (copié depuis weather-agent)
// ---------------------------------------------------------------------------

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

function gaussianCDF(x: number, mean: number, sigma: number): number {
  return 0.5 * (1 + erf((x - mean) / (sigma * Math.SQRT2)));
}

function probAbove(threshold: number, mean: number, sigma: number): number {
  return 1 - gaussianCDF(threshold, mean, sigma);
}

function probBelow(threshold: number, mean: number, sigma: number): number {
  return gaussianCDF(threshold, mean, sigma);
}

function probBetween(low: number, high: number, mean: number, sigma: number): number {
  return gaussianCDF(high, mean, sigma) - gaussianCDF(low, mean, sigma);
}

function celsiusToFahrenheit(c: number): number {
  return c * (9 / 5) + 32;
}

// ---------------------------------------------------------------------------
// Parsing outcomes météo (copié depuis weather-agent)
// ---------------------------------------------------------------------------

interface ParsedOutcome {
  type: "above" | "below" | "between" | "binary_yes" | "binary_no" | "unknown";
  low?: number;
  high?: number;
  threshold?: number;
}

function parseOutcome(label: string, binaryThreshold?: number): ParsedOutcome {
  const t = label.trim();

  const aboveMatch = t.match(/^(?:Above|>=?|≥)\s*([\d.]+)/i);
  if (aboveMatch) return { type: "above", threshold: parseFloat(aboveMatch[1]) - 0.5 };

  const belowMatch = t.match(/^(?:Below|<=?|≤|Under)\s*([\d.]+)/i);
  if (belowMatch) return { type: "below", threshold: parseFloat(belowMatch[1]) + 0.5 };

  const rangeMatch = t.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
  if (rangeMatch) {
    return {
      type: "between",
      low:  parseFloat(rangeMatch[1]) - 0.5,
      high: parseFloat(rangeMatch[2]) + 0.5,
    };
  }

  if (/^yes$/i.test(t)) return { type: "binary_yes", threshold: binaryThreshold };
  if (/^no$/i.test(t))  return { type: "binary_no",  threshold: binaryThreshold };

  return { type: "unknown" };
}

function extractBinaryThreshold(question: string): number | undefined {
  const match = question.match(/(\d+(?:\.\d+)?)\s*°?[FC]/);
  return match ? parseFloat(match[1]) : undefined;
}

function probabilityForOutcome(parsed: ParsedOutcome, mean: number, sigma: number): number {
  switch (parsed.type) {
    case "above":
      if (parsed.threshold == null) return NaN;
      return probAbove(parsed.threshold, mean, sigma);
    case "below":
      if (parsed.threshold == null) return NaN;
      return probBelow(parsed.threshold, mean, sigma);
    case "between":
      if (parsed.low == null || parsed.high == null) return NaN;
      return probBetween(parsed.low, parsed.high, mean, sigma);
    case "binary_yes":
      if (parsed.threshold == null) return NaN;
      return probAbove(parsed.threshold, mean, sigma);
    case "binary_no":
      if (parsed.threshold == null) return NaN;
      return probBelow(parsed.threshold, mean, sigma);
    default:
      return NaN;
  }
}

// ---------------------------------------------------------------------------
// Finance : résolution direction outcome (copié depuis finance-agent)
// ---------------------------------------------------------------------------

function resolveOutcomeDirection(label: string): "up" | "down" | "unknown" {
  const o = label.toLowerCase().trim();
  if (/^yes$|higher|above|gain|up|rise/.test(o)) return "up";
  if (/^no$|lower|below|drop|down|fall/.test(o))  return "down";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Types de réponse
// ---------------------------------------------------------------------------

interface DebugOutcome {
  outcome: string;
  marketPrice: number;
  estimatedProbability: number;
  edge: number;
  wouldBet: boolean;
  skipReason: string | null;
}

interface DebugForecast {
  high: number;
  low: number;
  dynamicSigma: number;
  modelSpread: number;
  confidenceLevel: string;
  source: string;
}

interface DebugMarket {
  question: string;
  agent: "weather" | "finance";
  bestEdge: number;
  outcomes: DebugOutcome[];
  bestOutcome: DebugOutcome | null;
  forecast?: DebugForecast;
  // finance only
  ticker?: string;
  scoreBreakdown?: {
    upScore: number;
    downScore: number;
    dominantDirection: "up" | "down";
    confidence: "high" | "medium" | "low" | "skip";
    estimatedProbability: number | null;
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Analyse météo
// ---------------------------------------------------------------------------

async function analyzeWeatherDebug(
  market: Awaited<ReturnType<typeof fetchAllWeatherMarkets>>[number]
): Promise<DebugMarket> {
  let forecast: Awaited<ReturnType<typeof fetchForecastForStation>> = null;

  try {
    forecast = await fetchForecastForStation(market.stationCode, market.targetDate);
  } catch (err) {
    return {
      question: market.question,
      agent: "weather",
      bestEdge: -Infinity,
      outcomes: [],
      bestOutcome: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!forecast) {
    return {
      question: market.question,
      agent: "weather",
      bestEdge: -Infinity,
      outcomes: [],
      bestOutcome: null,
      error: `Ville introuvable: ${market.stationCode}`,
    };
  }

  const forecastTempC =
    market.measureType === "high" ? forecast.highTemp : forecast.lowTemp;
  const forecastTemp =
    market.unit === "F" ? celsiusToFahrenheit(forecastTempC) : forecastTempC;

  const sigmaC = forecast.dynamicSigma ?? (BASE_SIGMA_C / forecast.confidence);
  const sigma  = market.unit === "F" ? sigmaC * (9 / 5) : sigmaC;

  const binaryThreshold = extractBinaryThreshold(market.question);

  const outcomes: DebugOutcome[] = [];

  for (let i = 0; i < market.outcomes.length; i++) {
    const label       = market.outcomes[i];
    const marketPrice = market.outcomePrices[i];

    const parsed = parseOutcome(label, binaryThreshold);
    const estimatedProbability = probabilityForOutcome(parsed, forecastTemp, sigma);

    if (isNaN(estimatedProbability)) {
      outcomes.push({
        outcome: label,
        marketPrice,
        estimatedProbability: NaN,
        edge: NaN,
        wouldBet: false,
        skipReason: "Impossible de parser l'outcome",
      });
      continue;
    }

    const edge     = estimatedProbability - marketPrice;
    const wouldBet = edge >= MIN_EDGE;
    const skipReason = wouldBet
      ? null
      : edge < 0
        ? `Edge négatif (${(edge * 100).toFixed(2)}%)`
        : `Edge insuffisant (${(edge * 100).toFixed(2)}% < ${(MIN_EDGE * 100).toFixed(2)}%)`;

    outcomes.push({
      outcome: label,
      marketPrice: Math.round(marketPrice * 10000) / 10000,
      estimatedProbability: Math.round(estimatedProbability * 10000) / 10000,
      edge: Math.round(edge * 10000) / 10000,
      wouldBet,
      skipReason,
    });
  }

  // Trier par edge décroissant (NaN en dernier)
  outcomes.sort((a, b) => {
    if (isNaN(a.edge) && isNaN(b.edge)) return 0;
    if (isNaN(a.edge)) return 1;
    if (isNaN(b.edge)) return -1;
    return b.edge - a.edge;
  });

  const validOutcomes = outcomes.filter(o => !isNaN(o.edge));
  const bestEdge      = validOutcomes.length > 0 ? validOutcomes[0].edge : -Infinity;
  const bestOutcome   = validOutcomes.length > 0 ? validOutcomes[0] : null;

  return {
    question: market.question,
    agent: "weather",
    bestEdge,
    outcomes,
    bestOutcome,
    forecast: {
      high:           Math.round(forecast.highTemp * 10) / 10,
      low:            Math.round(forecast.lowTemp  * 10) / 10,
      dynamicSigma:   Math.round(forecast.dynamicSigma   * 100) / 100,
      modelSpread:    forecast.modelSpread,
      confidenceLevel: forecast.confidenceLevel,
      source:         forecast.source,
    },
  };
}

// ---------------------------------------------------------------------------
// Analyse finance
// ---------------------------------------------------------------------------

async function analyzeFinanceDebug(
  market: Awaited<ReturnType<typeof fetchStockMarkets>>[number]
): Promise<DebugMarket> {
  let upScore   = 0;
  let downScore = 0;

  try {
    const [stockData, preMarket] = await Promise.all([
      fetchStockData(market.ticker),
      fetchPreMarketData(market.ticker),
    ]);
    const technicals = calculateTechnicals(stockData.priceHistory);

    // Scoring (mirror finance-agent)
    const pmPct = preMarket.preMarketChangePercent;
    if (pmPct !== null) {
      if (pmPct > 1)   upScore   += 20;
      else if (pmPct < -1) downScore += 20;
    }

    const rsi = technicals.rsi;
    if (rsi !== null) {
      if (rsi < 30)      upScore   += 15;
      else if (rsi > 70) downScore += 15;
    }

    if (technicals.trend === "bullish") upScore   += 10;
    else if (technicals.trend === "bearish") downScore += 10;

    if (stockData.avgVolume > 0 && stockData.volume > stockData.avgVolume * 1.5) {
      if (upScore >= downScore) upScore   += 5;
      else                      downScore += 5;
    }

    const dominantScore     = Math.max(upScore, downScore);
    const dominantDirection = upScore >= downScore ? "up" : "down";

    let confidenceLevel: "high" | "medium" | "low" | "skip";
    let estimatedProbability: number | null;

    if (dominantScore >= SCORE_HIGH) {
      confidenceLevel      = "high";
      estimatedProbability = PROB_HIGH;
    } else if (dominantScore >= SCORE_MEDIUM) {
      confidenceLevel      = "medium";
      estimatedProbability = PROB_MEDIUM;
    } else {
      confidenceLevel      = "skip";
      estimatedProbability = null;
    }

    const outcomes: DebugOutcome[] = [];

    for (let i = 0; i < market.outcomes.length; i++) {
      const label       = market.outcomes[i];
      const marketPrice = market.outcomePrices[i];
      const dir         = resolveOutcomeDirection(label);

      if (estimatedProbability === null) {
        outcomes.push({
          outcome: label,
          marketPrice,
          estimatedProbability: NaN,
          edge: NaN,
          wouldBet: false,
          skipReason: `Score insuffisant (${dominantScore} < ${SCORE_MEDIUM})`,
        });
        continue;
      }

      if (dir === "unknown" || dir !== dominantDirection) {
        outcomes.push({
          outcome: label,
          marketPrice,
          estimatedProbability: NaN,
          edge: NaN,
          wouldBet: false,
          skipReason: dir === "unknown"
            ? "Direction inconnue"
            : `Direction opposée (dominant: ${dominantDirection})`,
        });
        continue;
      }

      const edge     = estimatedProbability - marketPrice;
      const wouldBet = edge >= MIN_EDGE;

      outcomes.push({
        outcome: label,
        marketPrice: Math.round(marketPrice * 10000) / 10000,
        estimatedProbability: Math.round(estimatedProbability * 10000) / 10000,
        edge: Math.round(edge * 10000) / 10000,
        wouldBet,
        skipReason: wouldBet
          ? null
          : `Edge insuffisant (${(edge * 100).toFixed(2)}% < ${(MIN_EDGE * 100).toFixed(2)}%)`,
      });
    }

    outcomes.sort((a, b) => {
      if (isNaN(a.edge) && isNaN(b.edge)) return 0;
      if (isNaN(a.edge)) return 1;
      if (isNaN(b.edge)) return -1;
      return b.edge - a.edge;
    });

    const validOutcomes = outcomes.filter(o => !isNaN(o.edge));
    const bestEdge      = validOutcomes.length > 0 ? validOutcomes[0].edge : -Infinity;
    const bestOutcome   = validOutcomes.length > 0 ? validOutcomes[0] : null;

    return {
      question: market.question,
      agent: "finance",
      ticker: market.ticker,
      bestEdge,
      outcomes,
      bestOutcome,
      scoreBreakdown: {
        upScore,
        downScore,
        dominantDirection,
        confidence: confidenceLevel,
        estimatedProbability,
      },
    };
  } catch (err) {
    return {
      question: market.question,
      agent: "finance",
      ticker: market.ticker,
      bestEdge: -Infinity,
      outcomes: [],
      bestOutcome: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  try {
    // Fetch markets in parallel (limit 20 each)
    const [weatherMarkets, stockMarkets] = await Promise.all([
      fetchAllWeatherMarkets().then(ms => ms.slice(0, 20)),
      fetchStockMarkets().then(ms => ms.slice(0, 20)),
    ]);

    // Analyse all markets in parallel
    const [weatherResults, financeResults] = await Promise.all([
      Promise.all(weatherMarkets.map(analyzeWeatherDebug)),
      Promise.all(stockMarkets.map(analyzeFinanceDebug)),
    ]);

    // Merge, sort by bestEdge descending, take top 20
    const all: DebugMarket[] = [...weatherResults, ...financeResults];
    all.sort((a, b) => {
      if (!isFinite(a.bestEdge) && !isFinite(b.bestEdge)) return 0;
      if (!isFinite(a.bestEdge)) return 1;
      if (!isFinite(b.bestEdge)) return -1;
      return b.bestEdge - a.bestEdge;
    });

    const top20 = all.slice(0, 20);

    return NextResponse.json({
      total:   all.length,
      markets: top20,
      meta: {
        weatherFetched: weatherMarkets.length,
        financeFetched: stockMarkets.length,
        analyzedAt:     new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[debug-analysis] Erreur:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur inconnue" },
      { status: 500 }
    );
  }
}
