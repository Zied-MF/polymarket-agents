/**
 * Finance Adapter — adaptateur AgentConfig pour le Finance Agent
 *
 * Pipeline :
 *   fetchMarkets() → marchés stocks filtrés (liquidité ≥ $1000, consensus < 95%)
 *   fetchData(market) → données Finnhub /quote pour le ticker
 *   analyze(market, stockData) → { dominated } ou { skipReason }
 *
 * Spread estimé en fonction de la liquidité :
 *   ≥ $10 000 → 2 %   |   ≥ $2 000 → 3 %   |   sinon → 4 %
 * Si edgeNet = edge − spread < 5 %, le marché est ignoré.
 */

import { fetchStockMarkets, type StockMarket }                    from "@/lib/polymarket/gamma-api";
import {
  fetchStockData,
  fetchPreMarketData,
  calculateTechnicals,
  type StockData,
}                                                                  from "@/lib/data-sources/finance-sources";
import { analyzeStockMarket }                                      from "@/lib/agents/finance-agent";
import { calculateHalfKelly, BANKROLL }                            from "@/lib/utils/kelly";
import type { AgentConfig, AnalyzeResult }                         from "@/lib/agents/orchestrator";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MIN_LIQUIDITY = 1_000;
const NET_EDGE_MIN  = 0.05;

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

export const financeAdapter: AgentConfig = {
  name: "Finance Agent",
  type: "finance",

  async fetchMarkets(): Promise<StockMarket[]> {
    const markets = await fetchStockMarkets();

    return markets.filter((m) => {
      if (m.liquidity < MIN_LIQUIDITY) {
        console.log(`[finance-adapter] ⏭ Liquidité insuffisante ($${round(m.liquidity, 2)}) — ${m.ticker}`);
        return false;
      }
      if (m.outcomePrices.some((p) => p >= 0.95)) {
        const dominant = Math.max(...m.outcomePrices);
        console.log(`[finance-agent] ${m.ticker}: consensus ${round(dominant * 100, 1)}% → skipped`);
        return false;
      }
      return true;
    });
  },

  async fetchData(market: unknown): Promise<StockData> {
    const m = market as StockMarket;
    const upPct   = round(m.outcomePrices[0] * 100, 1);
    const downPct = round((m.outcomePrices[1] ?? 1 - m.outcomePrices[0]) * 100, 1);
    console.log(`[finance-agent] ${m.ticker}: Up=${upPct}%, Down=${downPct}% → analyzing...`);
    return fetchStockData(m.ticker);
  },

  async analyze(market: unknown, data: unknown): Promise<AnalyzeResult | null> {
    const m         = market as StockMarket;
    const stockData = data as StockData;

    // preMarket et technicals sont no-op sur le plan Finnhub gratuit
    const [preMarket] = await Promise.all([fetchPreMarketData(m.ticker)]);
    const technicals  = calculateTechnicals(stockData.priceHistory);

    const outcomes = analyzeStockMarket(m, stockData, preMarket, technicals);
    if (outcomes.length === 0) {
      return { skipReason: `Aucun edge suffisant (edge < 7.98%)` };
    }

    const best = outcomes[0];

    // Spread estimation + filtre net edge
    const spreadEstimate = estimateSpread(m.liquidity);
    const edgeNet        = best.edge - spreadEstimate;
    if (edgeNet < NET_EDGE_MIN) {
      console.log(
        `[finance-adapter] ⏭ Edge net insuffisant: gross=${(best.edge * 100).toFixed(1)}%, ` +
        `spread≈${(spreadEstimate * 100).toFixed(1)}%, net=${(edgeNet * 100).toFixed(1)}% — ${m.ticker}`
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
        confidence:           best.estimatedProbability >= 0.70 ? "high" : "medium",
        agent:                "finance",
        ticker:               m.ticker,
        targetDate:           m.endDate.toISOString().slice(0, 10),
        targetDateTime:       m.endDate.toISOString(),
        marketContext: {
          liquidity:       m.liquidity,
          spread_estimate: spreadEstimate,
          edge_net:        round(edgeNet, 4),
          all_outcomes:    m.outcomes,
          all_prices:      m.outcomePrices,
          ticker:          m.ticker,
          direction:       m.direction,
          timestamp:       new Date().toISOString(),
          data_source: {
            provider:       "finnhub",
            current_price:  stockData.currentPrice,
            change_percent: stockData.changePercent,
            high:           stockData.high,
            low:            stockData.low,
          },
        },
      },
    };
  },
};
