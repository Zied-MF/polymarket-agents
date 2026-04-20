import { fetchAllWeatherMarkets } from "@/lib/polymarket/gamma-api";
import { NextResponse }           from "next/server";

export async function GET() {
  const allMarkets = await fetchAllWeatherMarkets();

  const now = Date.now();

  const analysis = allMarkets.map((m) => {
    const hoursToRes = (m.endDate.getTime() - now) / (1000 * 60 * 60);
    const maxPrice   = Math.max(...m.outcomePrices);

    // Bet cap based on liquidity (5% rule — for info only, no filter)
    const liquidityCap = Math.round(m.liquidity * 0.05 * 100) / 100;

    return {
      city:              m.city,
      question:          m.question.slice(0, 60),
      liquidity:         Math.round(m.liquidity),
      liquidityCap:      liquidityCap,          // max bet allowed by 5% rule
      hoursToResolution: Math.round(hoursToRes * 10) / 10,
      maxPrice:          parseFloat(maxPrice.toFixed(2)),
      passesLiquidity:   true,                  // no liquidity filter anymore
      passesHorizon:     hoursToRes >= 1 && hoursToRes <= 48,
      passesAntiFavori:  maxPrice <= 0.70,
    };
  });

  const stats = {
    total:          allMarkets.length,
    passLiquidity:  analysis.length,            // all pass — filter removed
    passHorizon:    analysis.filter((a) => a.passesHorizon).length,
    passAntiFavori: analysis.filter((a) => a.passesAntiFavori).length,
    passAll:        analysis.filter((a) => a.passesHorizon && a.passesAntiFavori).length,
    avgLiquidity:   Math.round(
      allMarkets.reduce((s, m) => s + m.liquidity, 0) / (allMarkets.length || 1)
    ),
    medianLiquidityCap: (() => {
      const caps = analysis.map((a) => a.liquidityCap).sort((a, b) => a - b);
      return caps[Math.floor(caps.length / 2)] ?? 0;
    })(),
  };

  return NextResponse.json({ stats, markets: analysis });
}
