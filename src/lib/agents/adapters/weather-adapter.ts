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

import { fetchAllWeatherMarkets, type WeatherMarket } from "@/lib/polymarket/gamma-api";
import { fetchForecastForStation }                     from "@/lib/data-sources/weather-sources";
import { analyzeMarket }                               from "@/lib/agents/weather-agent";
import { calculateHalfKelly, BANKROLL }                from "@/lib/utils/kelly";
import type { AgentConfig, AnalyzeResult }             from "@/lib/agents/orchestrator";

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

  async fetchData(market: unknown) {
    const m = market as WeatherMarket;
    return fetchForecastForStation(m.stationCode, m.targetDate);
  },

  async analyze(market: unknown, data: unknown): Promise<AnalyzeResult | null> {
    const m        = market as WeatherMarket;
    const forecast = data as Awaited<ReturnType<typeof fetchForecastForStation>>;

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

    const outcomes = analyzeMarket(m, forecast);
    if (outcomes.length === 0) {
      return { skipReason: `Aucun edge suffisant (edge < ${(MIN_EDGE * 100).toFixed(0)}%)` };
    }

    const best = outcomes[0];

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
