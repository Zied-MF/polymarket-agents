/**
 * Weather Adapter — adaptateur AgentConfig pour le Weather Agent
 *
 * Pipeline :
 *   fetchMarkets() → marchés météo filtrés (liquidité ≥ $1000, consensus < 90%)
 *   fetchData(market) → prévision Open-Meteo pour la station/date du marché
 *   analyze(market, forecast) → { dominated } ou { skipReason }
 *
 * Spread estimé en fonction de la liquidité :
 *   ≥ $10 000 → 2 %   |   ≥ $2 000 → 3 %   |   sinon → 4 %
 * Si edgeNet = edge − spread < 5 %, le marché est ignoré.
 */

import { fetchAllWeatherMarkets, type WeatherMarket } from "@/lib/polymarket/gamma-api";
import { fetchForecastForStation }                     from "@/lib/data-sources/weather-sources";
import { analyzeMarket }                               from "@/lib/agents/weather-agent";
import { calculateHalfKelly, BANKROLL }                from "@/lib/utils/kelly";
import type { AgentConfig, AnalyzeResult }             from "@/lib/agents/orchestrator";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MIN_LIQUIDITY  = 1_000;
const NET_EDGE_MIN   = 0.05;   // 5 % après spread

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

    return markets.filter((m) => {
      if (m.liquidity < MIN_LIQUIDITY) {
        console.log(`[weather-adapter] ⏭ Liquidité insuffisante ($${round(m.liquidity, 2)}) — "${m.question.slice(0, 60)}"`);
        return false;
      }
      if (m.outcomePrices.some((p) => p >= 0.9)) {
        const dominant = Math.max(...m.outcomePrices);
        console.log(`[weather-adapter] ⏭ Consensus fort (${round(dominant * 100, 1)}%) — "${m.question.slice(0, 60)}"`);
        return false;
      }
      return true;
    });
  },

  async fetchData(market: unknown) {
    const m = market as WeatherMarket;
    return fetchForecastForStation(m.stationCode, m.targetDate);
  },

  async analyze(market: unknown, data: unknown): Promise<AnalyzeResult | null> {
    const m        = market as WeatherMarket;
    const forecast = data as Awaited<ReturnType<typeof fetchForecastForStation>>;

    if (!forecast) {
      return { skipReason: `Station inconnue : ${m.stationCode}` };
    }

    const outcomes = analyzeMarket(m, forecast);
    if (outcomes.length === 0) {
      return { skipReason: `Aucun edge suffisant (edge < 7.98%)` };
    }

    const best = outcomes[0];

    // Spread estimation + filtre net edge
    const spreadEstimate = estimateSpread(m.liquidity);
    const edgeNet        = best.edge - spreadEstimate;
    if (edgeNet < NET_EDGE_MIN) {
      console.log(
        `[weather-adapter] ⏭ Edge net insuffisant: gross=${(best.edge * 100).toFixed(1)}%, ` +
        `spread≈${(spreadEstimate * 100).toFixed(1)}%, net=${(edgeNet * 100).toFixed(1)}% — "${m.question.slice(0, 60)}"`
      );
      return { skipReason: `Edge net ${(edgeNet * 100).toFixed(1)}% < 5% (spread≈${(spreadEstimate * 100).toFixed(1)}%)` };
    }

    const kelly = calculateHalfKelly(best.estimatedProbability, best.marketPrice, BANKROLL, spreadEstimate);

    return {
      dominated: {
        marketId:             m.id,
        question:             m.question,
        outcome:              best.outcome,
        marketPrice:          round(best.marketPrice, 4),
        estimatedProbability: round(best.estimatedProbability, 4),
        edge:                 round(best.edge, 4),
        suggestedBet:         kelly.betAmount,
        confidence:           forecast.confidenceLevel,
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
            provider:    "open-meteo",
            high_temp:   forecast.highTemp,
            low_temp:    forecast.lowTemp,
            confidence:  forecast.confidence,
            dynamic_sigma: forecast.dynamicSigma ?? null,
          },
        },
      },
    };
  },
};
