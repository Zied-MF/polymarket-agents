import { fetchAllWeatherMarkets } from "@/lib/polymarket/gamma-api";
import { NextResponse } from "next/server";

export async function GET() {
  const allMarkets = await fetchAllWeatherMarkets();

  const now = Date.now();

  const analysis = allMarkets.map((m) => {
    const hoursToRes = (m.endDate.getTime() - now) / (1000 * 60 * 60);
    const maxPrice   = Math.max(...m.outcomePrices);

    return {
      city:               m.city,
      question:           m.question.slice(0, 60),
      liquidity:          Math.round(m.liquidity),
      hoursToResolution:  Math.round(hoursToRes * 10) / 10,
      maxPrice:           parseFloat(maxPrice.toFixed(2)),
      passesLiquidity:    m.liquidity >= 5000,
      passesHorizon:      hoursToRes >= 1 && hoursToRes <= 48,
      passesAntiFavori:   maxPrice <= 0.70,
    };
  });

  const stats = {
    total:          allMarkets.length,
    passLiquidity:  analysis.filter((a) => a.passesLiquidity).length,
    passHorizon:    analysis.filter((a) => a.passesHorizon).length,
    passAntiFavori: analysis.filter((a) => a.passesAntiFavori).length,
    passAll:        analysis.filter((a) => a.passesLiquidity && a.passesHorizon && a.passesAntiFavori).length,
  };

  return NextResponse.json({ stats, markets: analysis });
}
