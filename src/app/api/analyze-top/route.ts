/**
 * Analyze Top Markets — endpoint WeatherBot-style
 *
 * POST /api/analyze-top   body: { mode?: TradingMode }
 * GET  /api/analyze-top?mode=balanced&limit=20
 *
 * Pipeline :
 *   1. Fetch tous les marchés météo (fetchAllWeatherMarkets)
 *   2. Filtre horizon (1-48h), anti-churn, accord des modèles
 *   3. Multi-model forecast (GFS + ECMWF + UKMO + Ensemble)
 *   4. Calcul probabilité + edge
 *   5. Filtres du mode (prix YES/NO, edge min)
 *   6. Claude AI — validation finale
 *   7. Retourne STRONG_BUY / BUY / SKIP triés par edge
 */

import { NextResponse }                                                    from "next/server";
import { fetchAllWeatherMarkets }                                          from "@/lib/polymarket/gamma-api";
import { fetchMultiModelForecast, calculateMultiModelProbability }         from "@/lib/data-sources/multi-model-weather";
import { getAirportStation, isUSCity }                                     from "@/lib/data/airport-stations";
import { parseOutcomeForMarket }                                           from "@/lib/agents/weather-agent";
import { analyzeWithClaude, type MarketContext }                           from "@/lib/agents/claude-analyst";
import { TRADING_MODES, getCurrentMode, isConfidenceAtLeast,
         type TradingMode }                                                from "@/lib/config/trading-modes";
import { hasRecentTradeForCityDate }                                       from "@/lib/db/supabase";
import { getRecentLessons, getConfidenceCalibration,
         getCityPerformance, getOverallPerformance }                       from "@/lib/db/lessons";

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalyzedMarket {
  marketId:    string;
  question:    string;
  city:        string;
  targetDate:  string;
  outcome:     string;
  marketPrice: number;
  ourProbability: number;
  edge:        number;
  models: {
    gfs?:          number;
    ecmwf?:        number;
    ukmo?:         number;
    consensus:     number;
    agreement:     "strong" | "moderate" | "weak";
    spreadDegrees: number;
  };
  claude: {
    decision:    "TRADE" | "SKIP";
    confidence:  string;
    size:        number;
    reasoning:   string;
    risks:       string[];
  } | null;
  recommendation: "STRONG_BUY" | "BUY" | "SKIP";
  recommendationReason: string;
  suggestedBet: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(req: Request): Promise<{ mode?: TradingMode; limit?: number }> {
  return req.json().catch(() => ({}));
}

// ---------------------------------------------------------------------------
// Handler (GET + POST)
// ---------------------------------------------------------------------------

async function handle(req: Request): Promise<NextResponse> {
  const url    = new URL(req.url);
  const body   = req.method === "POST" ? await parseBody(req) : {};

  const mode  = (body.mode ?? url.searchParams.get("mode") ?? getCurrentMode()) as TradingMode;
  const limit = Number(body.limit ?? url.searchParams.get("limit") ?? 20);
  const includeSkipped = url.searchParams.get("includeSkipped") === "true";

  const tradingMode = TRADING_MODES[mode] ?? TRADING_MODES.balanced;
  const startTime   = Date.now();

  console.log(`[analyze-top] mode=${mode} limit=${limit}`);

  try {
    // 1. Markets + shared context
    const [markets, lessons, calibration, overallPerf] = await Promise.all([
      fetchAllWeatherMarkets(),
      getRecentLessons(20),
      getConfidenceCalibration(),
      getOverallPerformance(),
    ]);

    console.log(`[analyze-top] ${markets.length} marchés météo`);

    const analyzed: AnalyzedMarket[] = [];
    const skipped: Array<{ marketId: string; question: string; reason: string }> = [];

    for (const market of markets) {
      if (analyzed.length >= limit) break;

      // Filtre horizon (1-48h)
      const hoursToResolution = (market.endDate.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursToResolution < 1 || hoursToResolution > 48) {
        skipped.push({ marketId: market.id, question: market.question, reason: `Horizon ${Math.round(hoursToResolution)}h hors [1-48h]` });
        continue;
      }

      // Anti-churn
      const targetDate = market.targetDate.toISOString().slice(0, 10);
      try {
        if (await hasRecentTradeForCityDate(market.city, targetDate)) {
          skipped.push({ marketId: market.id, question: market.question, reason: `Position déjà ouverte pour ${market.city} le ${targetDate}` });
          continue;
        }
      } catch { /* non-bloquant */ }

      // Coordonnées airport uniquement (WeatherMarket n'a pas lat/lon)
      const station = getAirportStation(market.city);
      if (!station) {
        skipped.push({ marketId: market.id, question: market.question, reason: `Aéroport inconnu pour ${market.city}` });
        continue;
      }

      // Multi-model forecast
      const forecast = await fetchMultiModelForecast(station.lat, station.lon, targetDate)
        .catch(() => null);
      if (!forecast) {
        skipped.push({ marketId: market.id, question: market.question, reason: "Échec fetch multi-model" });
        continue;
      }

      // Filtre accord des modèles
      if (forecast.consensus.agreement === "weak") {
        skipped.push({ marketId: market.id, question: market.question, reason: `Désaccord modèles (spread=${forecast.consensus.spreadDegrees}°C)` });
        continue;
      }

      // Filtre consensus fort
      if (market.outcomePrices.some((p) => p > 0.70)) {
        skipped.push({ marketId: market.id, question: market.question, reason: `Prix dominant > 70%` });
        continue;
      }

      // Parse outcome + calcul probabilité multi-model
      const useFahrenheit = isUSCity(market.city) || market.unit === "F";
      const toC = (v: number) => useFahrenheit ? (v - 32) * 5 / 9 : v;

      // Trouver le meilleur outcome avec edge > 0
      let bestOutcome: string | null = null;
      let bestPrice   = 0;
      let bestProb    = 0;
      let bestEdge    = -Infinity;

      for (let i = 0; i < market.outcomes.length; i++) {
        const label = market.outcomes[i];
        const price = market.outcomePrices[i];
        if (price < 0.01 || price > 0.99) continue;

        const parsed = parseOutcomeForMarket(market.question, label);
        if (!parsed || parsed.type === "unknown") continue;

        let thresholdC: number;
        let rangeMaxC:  number | undefined;

        if (parsed.type === "above" || parsed.type === "below") {
          thresholdC = toC(parsed.threshold!);
        } else if (parsed.type === "range") {
          thresholdC = toC(parsed.lo ?? parsed.target! - 1);
          rangeMaxC  = toC(parsed.hi ?? parsed.target! + 1);
        } else {
          thresholdC = toC(parsed.target!);
        }

        const pr   = calculateMultiModelProbability(forecast, thresholdC, parsed.type as "exact" | "above" | "below" | "range", rangeMaxC);
        const edge = pr.probability - price;

        if (edge > bestEdge) {
          bestEdge    = edge;
          bestOutcome = label;
          bestPrice   = price;
          bestProb    = pr.probability;
        }
      }

      if (!bestOutcome) {
        skipped.push({ marketId: market.id, question: market.question, reason: "Aucun outcome parseable" });
        continue;
      }

      // Filtres du mode
      const yesPrice = market.outcomePrices[0];

      if (bestOutcome === "Yes" && bestPrice > tradingMode.yesMaxPrice) {
        skipped.push({ marketId: market.id, question: market.question, reason: `YES ${(bestPrice * 100).toFixed(0)}¢ > ${tradingMode.yesMaxPrice * 100}¢` });
        continue;
      }
      if (bestOutcome === "No" && yesPrice < tradingMode.noMinYesPrice) {
        skipped.push({ marketId: market.id, question: market.question, reason: `NO non rentable: YES ${(yesPrice * 100).toFixed(0)}¢` });
        continue;
      }
      if (bestEdge < tradingMode.minEdge) {
        skipped.push({ marketId: market.id, question: market.question, reason: `Edge ${(bestEdge * 100).toFixed(1)}% < ${tradingMode.minEdge * 100}%` });
        continue;
      }

      // Claude AI — validation finale
      const forecastTemp = market.measureType === "high"
        ? (forecast.models.find((mm) => mm.model === "gfs")?.temperature ?? forecast.consensus.temperature)
        : (forecast.consensus.temperature - 5); // approx low temp

      const [cityPerf] = await Promise.all([getCityPerformance(market.city)]);

      const context: MarketContext = {
        question:   market.question,
        city:       market.city,
        targetDate,
        outcomes:   market.outcomes,
        prices:     market.outcomePrices,
        forecasts: {
          gfs: forecastTemp,
          ensemble: forecast.ensemble
            ? { mean: forecast.ensemble.mean, min: forecast.ensemble.min, max: forecast.ensemble.max, stdDev: forecast.ensemble.stdDev, members: forecast.ensemble.members }
            : { mean: forecastTemp, min: forecastTemp - 2, max: forecastTemp + 2, stdDev: forecast.consensus.stdDev, members: [] },
        },
        multiModel: {
          consensus:     forecast.consensus.temperature,
          agreement:     forecast.consensus.agreement,
          spreadDegrees: forecast.consensus.spreadDegrees,
          gfs:           forecast.models.find((mm) => mm.model === "gfs")?.temperature,
          ecmwf:         forecast.models.find((mm) => mm.model === "ecmwf")?.temperature,
          ukmo:          forecast.models.find((mm) => mm.model === "ukmo")?.temperature,
          method:        forecast.ensemble ? "ensemble_members" : "gaussian_consensus",
          probability:   bestProb,
        },
        gaussianEdge: bestEdge,
        measureType:  market.measureType,
        recentPerformance: {
          cityWinRate:    cityPerf.winRate,
          overallWinRate: overallPerf.winRate,
          last7DaysPnL:   overallPerf.pnl7d,
        },
        lessons:               lessons.map((l) => l.lesson),
        confidenceCalibration: calibration,
      };

      let claudeResult: AnalyzedMarket["claude"] = null;
      try {
        const raw = await analyzeWithClaude(context);
        claudeResult = {
          decision:   raw.decision,
          confidence: raw.confidence,
          size:       raw.size ?? 5,
          reasoning:  raw.reason,
          risks:      raw.risks ?? [],
        };
      } catch (err) {
        console.warn(`[analyze-top] Claude error ${market.id}:`, err instanceof Error ? err.message : err);
      }

      // Recommandation finale
      let recommendation: AnalyzedMarket["recommendation"] = "SKIP";
      let recommendationReason = "Ne passe pas tous les filtres";

      if (claudeResult?.decision === "SKIP") {
        recommendation        = "SKIP";
        recommendationReason  = claudeResult.reasoning;
      } else if (
        bestEdge >= 0.20 &&
        forecast.consensus.agreement === "strong" &&
        (claudeResult?.confidence === "VERY_HIGH" || claudeResult?.confidence === "HIGH")
      ) {
        recommendation        = "STRONG_BUY";
        recommendationReason  = `Edge ${(bestEdge * 100).toFixed(0)}%, modèles unanimes, Claude ${claudeResult.confidence}`;
      } else if (
        claudeResult?.decision === "TRADE" &&
        isConfidenceAtLeast(claudeResult.confidence, tradingMode.minConfidence)
      ) {
        recommendation        = "BUY";
        recommendationReason  = claudeResult.reasoning;
      }

      // Bet sizing
      const claudeSize  = claudeResult?.size ?? 5;
      const BANKROLL    = 10;
      const sizePercent = (claudeSize / 10) * tradingMode.maxBetPercent;
      const suggestedBet = recommendation !== "SKIP"
        ? Math.max(0.10, Math.min(BANKROLL * sizePercent, BANKROLL * tradingMode.maxBetPercent))
        : 0;

      analyzed.push({
        marketId:      market.id,
        question:      market.question,
        city:          market.city,
        targetDate,
        outcome:       bestOutcome,
        marketPrice:   bestPrice,
        ourProbability: bestProb,
        edge:          bestEdge,
        models: {
          gfs:          forecast.models.find((mm) => mm.model === "gfs")?.temperature,
          ecmwf:        forecast.models.find((mm) => mm.model === "ecmwf")?.temperature,
          ukmo:         forecast.models.find((mm) => mm.model === "ukmo")?.temperature,
          consensus:    forecast.consensus.temperature,
          agreement:    forecast.consensus.agreement,
          spreadDegrees: forecast.consensus.spreadDegrees,
        },
        claude:               claudeResult,
        recommendation,
        recommendationReason,
        suggestedBet,
      });
    }

    // Sort by recommendation priority then edge
    const ORDER = { STRONG_BUY: 0, BUY: 1, SKIP: 2 };
    const sorted = analyzed.sort((a, b) => {
      if (ORDER[a.recommendation] !== ORDER[b.recommendation]) return ORDER[a.recommendation] - ORDER[b.recommendation];
      return b.edge - a.edge;
    });

    const buys = sorted.filter((m) => m.recommendation !== "SKIP");

    return NextResponse.json({
      timestamp:    new Date().toISOString(),
      duration:     `${Date.now() - startTime}ms`,
      mode,
      modeConfig:   tradingMode,
      // page.tsx compatibility
      trades:       buys.length,
      decisions:    buys.map((m) => ({
        city:       m.city,
        decision:   m.recommendation,
        confidence: m.claude?.confidence ?? "N/A",
        reasoning:  m.recommendationReason,
      })),
      summary: {
        totalAnalyzed:      analyzed.length,
        strongBuy:          sorted.filter((m) => m.recommendation === "STRONG_BUY").length,
        buy:                sorted.filter((m) => m.recommendation === "BUY").length,
        skip:               sorted.filter((m) => m.recommendation === "SKIP").length,
        skippedByFilters:   skipped.length,
      },
      opportunities: buys,
      allAnalyzed:   sorted,
      skipped:       includeSkipped ? skipped : undefined,
    });

  } catch (err) {
    console.error("[analyze-top]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const GET  = handle;
export const POST = handle;
