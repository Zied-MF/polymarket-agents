/**
 * Crypto Adapter — adaptateur AgentConfig pour le Crypto Agent
 *
 * Pipeline :
 *   fetchMarkets() → marchés crypto filtrés (liquidité ≥ $1000, consensus < 95%)
 *   fetchData(market) → données CoinGecko pour le token
 *   analyze(market, cryptoData) → { dominated } ou { skipReason }
 *
 * Spread estimé en fonction de la liquidité :
 *   ≥ $10 000 → 2 %   |   ≥ $2 000 → 3 %   |   sinon → 4 %
 * Si edgeNet = edge − spread < 5 %, le marché est ignoré.
 */

import { fetchCryptoMarkets, type CryptoMarket }  from "@/lib/polymarket/gamma-api";
import { fetchCryptoData, type CryptoData }        from "@/lib/data-sources/crypto-sources";
import { analyzeCryptoMarket }                     from "@/lib/agents/crypto-agent";
import { calculateHalfKelly, BANKROLL }            from "@/lib/utils/kelly";
import type { AgentConfig, AnalyzeResult }         from "@/lib/agents/orchestrator";

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

export const cryptoAdapter: AgentConfig = {
  name: "Crypto Agent",
  type: "crypto",

  async fetchMarkets(): Promise<CryptoMarket[]> {
    const markets = await fetchCryptoMarkets();

    console.log(`[crypto-adapter] ${markets.length} marchés récupérés depuis Gamma`);
    if (markets.length > 0) {
      const s = markets[0];
      console.log(
        `[crypto-adapter] Premier marché: id=${s.id} token=${s.token}` +
        ` liq=${s.liquidity} outcomes=${JSON.stringify(s.outcomes)}` +
        ` prices=${JSON.stringify(s.outcomePrices)} q="${s.question.slice(0, 80)}"`
      );
    }

    return markets.filter((m) => {
      if (m.liquidity < MIN_LIQUIDITY) {
        console.log(`[crypto-adapter] ⏭ Liquidité insuffisante ($${round(m.liquidity, 2)}) — ${m.token}`);
        return false;
      }
      if (m.outcomePrices.some((p) => p >= 0.95)) {
        const dominant = Math.max(...m.outcomePrices);
        console.log(`[crypto-agent] ${m.token}: consensus ${round(dominant * 100, 1)}% → skipped`);
        return false;
      }
      return true;
    });
  },

  async fetchData(market: unknown): Promise<CryptoData> {
    const m = market as CryptoMarket;
    return fetchCryptoData(m.token);
  },

  async analyze(market: unknown, data: unknown): Promise<AnalyzeResult | null> {
    const m          = market as CryptoMarket;
    const cryptoData = data as CryptoData;

    const outcomes = analyzeCryptoMarket(m, cryptoData);
    if (outcomes.length === 0) {
      return { skipReason: `Aucun edge suffisant (edge < 7.98%)` };
    }

    const best = outcomes[0];

    // Spread estimation + filtre net edge
    const spreadEstimate = estimateSpread(m.liquidity);
    const edgeNet        = best.edge - spreadEstimate;
    if (edgeNet < NET_EDGE_MIN) {
      console.log(
        `[crypto-adapter] ⏭ Edge net insuffisant: gross=${(best.edge * 100).toFixed(1)}%, ` +
        `spread≈${(spreadEstimate * 100).toFixed(1)}%, net=${(edgeNet * 100).toFixed(1)}% — ${m.token}`
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
        agent:                "crypto",
        ticker:               m.token,
        token:                m.token,
        targetDate:           m.endDate.toISOString().slice(0, 10),
        targetDateTime:       m.endDate.toISOString(),
        marketContext: {
          liquidity:       m.liquidity,
          spread_estimate: spreadEstimate,
          edge_net:        round(edgeNet, 4),
          all_outcomes:    m.outcomes,
          all_prices:      m.outcomePrices,
          token:           m.token,
          timestamp:       new Date().toISOString(),
          data_source: {
            provider:   "coingecko",
            price:      cryptoData.price,
            change_24h: cryptoData.change24h,
            volume_24h: cryptoData.volume24h,
          },
        },
      },
    };
  },
};
