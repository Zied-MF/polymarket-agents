/**
 * Weather Adapter — adaptateur AgentConfig pour le Weather Agent
 *
 * Pipeline :
 *   fetchMarkets() → marchés météo filtrés (liquidité ≥ $5000, consensus < 90%)
 *   fetchData(market) → prévision Open-Meteo pour la station/date du marché
 *   analyze(market, forecast) → { dominated } ou { skipReason }
 *
 * Seuils relevés après paper trading catastrophique (WR 39.8%, -85€) :
 *   MIN_LIQUIDITY  : $1 000 → $5 000
 *   MIN_EDGE       : 7.98% → 12% (gross)
 *   NET_EDGE_MIN   : 5%    → 8%  (après spread)
 *   Anti-favori    : skip si un outcome > 70%
 *
 * Spread estimé en fonction de la liquidité :
 *   ≥ $10 000 → 2 %   |   ≥ $2 000 → 3 %   |   sinon → 4 %
 */

import { fetchAllWeatherMarkets, type WeatherMarket }                           from "@/lib/polymarket/gamma-api";
import { fetchForecastForStation, fetchEnsembleForecast }                        from "@/lib/data-sources/weather-sources";
import { analyzeMarket, parseOutcomeForMarket }                                  from "@/lib/agents/weather-agent";
import { calculateHalfKelly, BANKROLL }                                          from "@/lib/utils/kelly";
import { getAirportStation, isUSCity }                                           from "@/lib/data/airport-stations";
import { analyzeWithClaude, type MarketContext }                                 from "@/lib/agents/claude-analyst";
import { fetchMultiModelForecast, calculateMultiModelProbability,
         type MultiModelForecast }                                               from "@/lib/data-sources/multi-model-weather";
import {
  getRecentLessons,
  getConfidenceCalibration,
  getCityPerformance,
  getOverallPerformance,
}                                                                                from "@/lib/db/lessons";
import type { AgentConfig, AnalyzeResult }                                       from "@/lib/agents/orchestrator";
import type { WeatherForecast, EnsembleForecast }                                from "@/types";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MIN_LIQUIDITY        = 2_000;  // relevé : $1 000 → $5 000 → $2 000
const MIN_EDGE             = 0.12;   // relevé : 7.98% → 12% (gross)
const NET_EDGE_MIN         = 0.08;   // relevé : 5% → 8% après spread
const MAX_RESOLUTION_HOURS = 48;     // Ne prendre que les marchés qui expirent dans 48h max

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number, d: number): number {
  return Math.round(n * 10 ** d) / 10 ** d;
}

function estimateSpread(liquidity: number): number {
  if (liquidity >= 10_000) return 0.02;
  if (liquidity >= 2_000)  return 0.03;
  return 0.04;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const weatherAdapter: AgentConfig = {
  name: "Weather Agent",
  type: "weather",

  async fetchMarkets(): Promise<WeatherMarket[]> {
    const markets = await fetchAllWeatherMarkets();

    const filtered = markets.filter((m) => {
      if (m.liquidity < MIN_LIQUIDITY) {
        console.log(`[weather-adapter] ⏭ Liquidité insuffisante ($${round(m.liquidity, 0)}) — "${m.question.slice(0, 60)}"`);
        return false;
      }
      if (m.outcomePrices.some((p) => p >= 0.9)) {
        const dominant = Math.max(...m.outcomePrices);
        console.log(`[weather-adapter] ⏭ Consensus fort (${round(dominant * 100, 1)}%) — "${m.question.slice(0, 60)}"`);
        return false;
      }
      return true;
    });

    console.log(`[weather-adapter] Filtre liquidité : ${filtered.length}/${markets.length} marchés conservés (min $${MIN_LIQUIDITY})`);
    return filtered;
  },

  async fetchData(market: unknown): Promise<{ forecast: WeatherForecast | null; ensemble: EnsembleForecast | null; multiModel: MultiModelForecast | null }> {
    const m              = market as WeatherMarket;
    const targetDateStr  = m.targetDate.toISOString().slice(0, 10);
    const airportStation = getAirportStation(m.city);

    const [forecast, ensemble, multiModel] = await Promise.all([
      fetchForecastForStation(m.stationCode, m.targetDate),
      airportStation
        ? fetchEnsembleForecast(airportStation.lat, airportStation.lon, targetDateStr)
        : Promise.resolve(null),
      airportStation
        ? fetchMultiModelForecast(airportStation.lat, airportStation.lon, targetDateStr)
            .catch((err) => {
              console.warn(`[weather-adapter] ⚠️ Multi-model fetch failed for ${m.city}: ${err instanceof Error ? err.message : err}`);
              return null;
            })
        : Promise.resolve(null),
    ]);

    if (ensemble) {
      console.log(`[weather-adapter] ✈️ Ensemble ${m.city} (${airportStation!.icao}): mean=${ensemble.mean}°C spread=${ensemble.spread}°C`);
    } else {
      console.log(`[weather-adapter] ⚠️ Pas d'ensemble pour ${m.city} — fallback gaussienne`);
    }

    if (multiModel) {
      console.log(
        `[weather-adapter] 🌐 Multi-model ${m.city}: ` +
        `consensus=${multiModel.consensus.temperature}°C ` +
        `agreement=${multiModel.consensus.agreement} ` +
        `(${multiModel.models.filter((mm) => mm.available).length}/4 models)`
      );
    }

    return { forecast, ensemble, multiModel };
  },

  async analyze(market: unknown, data: unknown): Promise<AnalyzeResult | null> {
    const m = market as WeatherMarket;
    const { forecast, ensemble, multiModel } = data as {
      forecast:   WeatherForecast   | null;
      ensemble:   EnsembleForecast  | null;
      multiModel: MultiModelForecast | null;
    };

    // Filtre horizon : ne pas bloquer les slots avec des trades longs
    if (isNaN(m.endDate.getTime())) {
      console.log(`[weather-adapter] ⚠️ Date invalide pour ${m.id}, skip`);
      return { skipReason: "Date de résolution invalide" };
    }
    const hoursToResolution = (m.endDate.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursToResolution > MAX_RESOLUTION_HOURS) {
      console.log(`[weather-adapter] ⏭ Résolution trop lointaine: ${Math.round(hoursToResolution)}h > ${MAX_RESOLUTION_HOURS}h — ${m.city}`);
      return { skipReason: `Résolution dans ${Math.round(hoursToResolution)}h > ${MAX_RESOLUTION_HOURS}h` };
    }
    if (hoursToResolution < 1) {
      console.log(`[weather-adapter] ⏭ Résolution trop proche: ${Math.round(hoursToResolution * 60)}min — ${m.city}`);
      return { skipReason: "Résolution < 1h (trop tard pour entrer)" };
    }

    if (!forecast) {
      return { skipReason: `Station inconnue : ${m.stationCode}` };
    }

    // Filtre anti-favori : si un outcome dépasse 70%, le marché est trop consensuel
    if (m.outcomePrices.some((p) => p > 0.70)) {
      const dominant = Math.max(...m.outcomePrices);
      console.log(`[weather-adapter] ⏭ Anti-favori (${(dominant * 100).toFixed(0)}% > 70%) — "${m.question.slice(0, 60)}"`);
      return { skipReason: `Prix dominant ${(dominant * 100).toFixed(0)}% > 70% (favori évident)` };
    }

    // Filtre accord des modèles : si weak → trop incertain, skip
    if (multiModel && multiModel.consensus.agreement === "weak") {
      console.log(
        `[weather-adapter] ⏭ Désaccord des modèles trop élevé : ` +
        `spread=${multiModel.consensus.spreadDegrees}°C (σ=${multiModel.consensus.stdDev}°C) — ${m.city}`
      );
      return { skipReason: `Modèles en désaccord (spread=${multiModel.consensus.spreadDegrees}°C > 2°C σ)` };
    }

    const outcomes = analyzeMarket(m, forecast, ensemble ?? undefined);
    if (outcomes.length === 0) {
      return { skipReason: `Aucun edge suffisant (edge < ${(MIN_EDGE * 100).toFixed(0)}%)` };
    }

    const best = outcomes[0];

    // Amélioration multi-modèle : recalculer la probabilité avec le consensus pondéré
    // (ECMWF×0.4 + GFS×0.3 + UKMO×0.2 + Ensemble×0.1) si disponible et agreement = strong/moderate.
    if (multiModel) {
      const parsed = parseOutcomeForMarket(m.question, best.outcome);
      if (parsed && parsed.type !== "unknown") {
        // Convertir les seuils vers °C (multi-model travaille toujours en °C)
        const toC = (v: number) => isUSCity(m.city) || m.unit === "F" ? (v - 32) * 5 / 9 : v;

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

        const probResult = calculateMultiModelProbability(
          multiModel,
          thresholdC,
          parsed.type as "exact" | "above" | "below" | "range",
          rangeMaxC
        );

        const multiProb = probResult.probability;
        const multiEdge = multiProb - best.marketPrice;

        // N'overrider que si l'écart est > 2% (évite le bruit)
        if (Math.abs(multiProb - best.estimatedProbability) > 0.02) {
          console.log(
            `[weather-adapter] 🌐 Multi-model override: ` +
            `gaussienne=${(best.estimatedProbability * 100).toFixed(1)}% → ` +
            `multi-model=${(multiProb * 100).toFixed(1)}% ` +
            `(method=${probResult.method}, agreement=${probResult.confidence})`
          );
          best.estimatedProbability = multiProb;
          best.edge                 = multiEdge;
        }
      }
    }

    // === PRICE THRESHOLDS (WeatherBot rules) ===
    const yesPrice = m.outcomePrices[0];

    // Règle 1 : ne jamais acheter YES au-dessus de 45¢
    if (best.outcome === "Yes" && best.marketPrice > 0.45) {
      console.log(`[weather-adapter] ⏭ YES trop cher: ${(best.marketPrice * 100).toFixed(0)}¢ > 45¢`);
      return { skipReason: `YES price ${(best.marketPrice * 100).toFixed(0)}¢ > 45¢ (trop cher)` };
    }

    // Règle 2 : ne jamais acheter NO si YES est en-dessous de 45¢ (NO > 55¢)
    if (best.outcome === "No" && yesPrice < 0.45) {
      console.log(`[weather-adapter] ⏭ NO pas rentable: YES seulement ${(yesPrice * 100).toFixed(0)}¢`);
      return { skipReason: `NO not worth: YES only ${(yesPrice * 100).toFixed(0)}¢` };
    }

    // Règle 3 : forte conviction sur YES cheap (< 20¢, forecast > 70%)
    let confidenceOverride: "high" | "medium" | "low" | undefined = forecast.confidenceLevel;
    if (best.outcome === "Yes" && best.marketPrice < 0.20 && best.estimatedProbability > 0.70) {
      console.log(
        `[weather-adapter] 🎯 STRONG BUY: YES à ${(best.marketPrice * 100).toFixed(0)}¢ ` +
        `avec forecast ${(best.estimatedProbability * 100).toFixed(0)}%`
      );
      confidenceOverride = "high";
    }

    // Règle 4 : prix max 70¢ pour tout outcome (filet de sécurité)
    if (best.marketPrice > 0.70) {
      return { skipReason: `Price ${(best.marketPrice * 100).toFixed(0)}¢ > 70¢ (favori évident)` };
    }

    // Filtre gross edge — seuil relevé à 12%
    if (best.edge < MIN_EDGE) {
      console.log(`[weather-adapter] ⏭ Edge brut insuffisant: ${(best.edge * 100).toFixed(1)}% < ${(MIN_EDGE * 100).toFixed(0)}% — "${m.question.slice(0, 60)}"`);
      return { skipReason: `Edge brut ${(best.edge * 100).toFixed(1)}% < ${(MIN_EDGE * 100).toFixed(0)}%` };
    }

    // Spread estimation + filtre net edge — seuil relevé à 8%
    const spreadEstimate = estimateSpread(m.liquidity);
    const edgeNet        = best.edge - spreadEstimate;
    if (edgeNet < NET_EDGE_MIN) {
      console.log(
        `[weather-adapter] ⏭ Edge net insuffisant: gross=${(best.edge * 100).toFixed(1)}%, ` +
        `spread≈${(spreadEstimate * 100).toFixed(1)}%, net=${(edgeNet * 100).toFixed(1)}% — "${m.question.slice(0, 60)}"`
      );
      return { skipReason: `Edge net ${(edgeNet * 100).toFixed(1)}% < ${(NET_EDGE_MIN * 100).toFixed(0)}% (spread≈${(spreadEstimate * 100).toFixed(1)}%)` };
    }

    const kelly = calculateHalfKelly(best.estimatedProbability, best.marketPrice, BANKROLL, spreadEstimate);

    if (kelly.betAmount === 0) {
      return { skipReason: `Kelly bet insuffisant (spread≈${(spreadEstimate * 100).toFixed(1)}%, mise < MIN)` };
    }

    // === CLAUDE AI — validation finale ===
    // Appelé uniquement sur les trades qui ont passé tous les filtres mécaniques.
    const forecastTemp = m.measureType === "high" ? forecast.highTemp : forecast.lowTemp;
    const [lessons, calibration, cityPerf, overallPerf] = await Promise.all([
      getRecentLessons(20),
      getConfidenceCalibration(),
      getCityPerformance(m.city),
      getOverallPerformance(),
    ]);

    // Préparer les données multi-modèle pour Claude (si disponibles)
    let multiModelCtx: MarketContext["multiModel"] | undefined;
    if (multiModel) {
      const parsed = parseOutcomeForMarket(m.question, best.outcome);
      let multiProb = best.estimatedProbability; // déjà overridé si écart > 2%
      let method    = "gaussian_consensus";

      if (parsed && parsed.type !== "unknown") {
        const toC = (v: number) => isUSCity(m.city) || m.unit === "F" ? (v - 32) * 5 / 9 : v;
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

        const pr = calculateMultiModelProbability(
          multiModel, thresholdC,
          parsed.type as "exact" | "above" | "below" | "range",
          rangeMaxC
        );
        multiProb = pr.probability;
        method    = pr.method;
      }

      const gfsModel   = multiModel.models.find((mm) => mm.model === "gfs");
      const ecmwfModel = multiModel.models.find((mm) => mm.model === "ecmwf");
      const ukmoModel  = multiModel.models.find((mm) => mm.model === "ukmo");

      multiModelCtx = {
        consensus:     multiModel.consensus.temperature,
        agreement:     multiModel.consensus.agreement,
        spreadDegrees: multiModel.consensus.spreadDegrees,
        gfs:           gfsModel?.available   ? gfsModel.temperature   : undefined,
        ecmwf:         ecmwfModel?.available ? ecmwfModel.temperature : undefined,
        ukmo:          ukmoModel?.available  ? ukmoModel.temperature  : undefined,
        method,
        probability:   multiProb,
      };
    }

    const context: MarketContext = {
      question:   m.question,
      city:       m.city,
      targetDate: m.targetDate.toISOString().slice(0, 10),
      outcomes:   m.outcomes,
      prices:     m.outcomePrices,
      forecasts: {
        gfs:      forecastTemp,
        ensemble: ensemble
          ? {
              mean:    ensemble.mean,
              min:     Math.min(...ensemble.membersMax),
              max:     Math.max(...ensemble.membersMax),
              stdDev:  ensemble.stdDev,
              members: ensemble.membersMax,
            }
          : { mean: forecastTemp, min: forecastTemp, max: forecastTemp, stdDev: 0, members: [] },
      },
      multiModel: multiModelCtx,
      gaussianEdge: best.edge,
      measureType:  m.measureType,
      recentPerformance: {
        cityWinRate:    cityPerf.winRate,
        overallWinRate: overallPerf.winRate,
        last7DaysPnL:   overallPerf.pnl7d,
      },
      lessons:               lessons.map((l) => l.lesson),
      confidenceCalibration: calibration,
    };

    const claudeAnalysis = await analyzeWithClaude(context);

    if (claudeAnalysis.decision === "SKIP") {
      console.log(`[weather-adapter] 🤖 Claude SKIP: ${claudeAnalysis.reason}`);
      return { skipReason: `Claude: ${claudeAnalysis.reason}` };
    }

    // Claude dit TRADE — ajuster la mise selon sa conviction (size 1-10)
    const sizeMultiplier  = Math.max(0.1, Math.min(1.0, (claudeAnalysis.size ?? 5) / 10));
    const adjustedBet     = Math.max(0.10, Math.min(kelly.betAmount * sizeMultiplier, BANKROLL * 0.9));

    // Confiance : VERY_HIGH → high, HIGH → high, MEDIUM → medium, LOW → low
    const claudeConfidence = claudeAnalysis.confidence === "VERY_HIGH" || claudeAnalysis.confidence === "HIGH"
      ? "high"
      : claudeAnalysis.confidence === "MEDIUM"
        ? "medium"
        : "low";
    confidenceOverride = claudeConfidence;

    // Probabilité estimée : préférer l'edge de Claude si fourni
    const finalEdge  = claudeAnalysis.edgeEstimate ?? best.edge;
    const finalProb  = round(best.marketPrice + finalEdge, 4);

    return {
      dominated: {
        marketId:             m.id,
        question:             m.question,
        outcome:              claudeAnalysis.outcome ?? best.outcome,
        marketPrice:          round(best.marketPrice, 4),
        estimatedProbability: Math.min(0.99, Math.max(0.01, finalProb)),
        edge:                 round(finalEdge, 4),
        suggestedBet:         Math.round(adjustedBet * 100) / 100,
        confidence:           confidenceOverride,
        agent:                "weather",
        city:                 m.city,
        targetDate:           m.targetDate.toISOString().slice(0, 10),
        targetDateTime:       m.targetDate.toISOString(),
        marketContext: {
          liquidity:       m.liquidity,
          spread_estimate: spreadEstimate,
          edge_net:        round(edgeNet, 4),
          all_outcomes:    m.outcomes,
          all_prices:      m.outcomePrices,
          station_code:    m.stationCode,
          measure_type:    m.measureType,
          unit:            m.unit,
          timestamp:       new Date().toISOString(),
          data_source: {
            provider:      "open-meteo",
            high_temp:     forecast.highTemp,
            low_temp:      forecast.lowTemp,
            confidence:    forecast.confidence,
            dynamic_sigma: forecast.dynamicSigma ?? null,
          },
          multi_model: multiModelCtx
            ? {
                consensus:     multiModelCtx.consensus,
                agreement:     multiModelCtx.agreement,
                spread:        multiModelCtx.spreadDegrees,
                gfs:           multiModelCtx.gfs    ?? null,
                ecmwf:         multiModelCtx.ecmwf  ?? null,
                ukmo:          multiModelCtx.ukmo   ?? null,
                probability:   multiModelCtx.probability,
                method:        multiModelCtx.method,
              }
            : null,
          claude: {
            reason:               claudeAnalysis.reason,
            risks:                claudeAnalysis.risks,
            meteorologicalNotes:  claudeAnalysis.meteorologicalNotes,
            size:                 claudeAnalysis.size,
            edgeEstimate:         claudeAnalysis.edgeEstimate ?? null,
          },
        },
      },
    };
  },
};
