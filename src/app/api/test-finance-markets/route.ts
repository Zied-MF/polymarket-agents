/**
 * Endpoint de debug temporaire
 *
 * GET /api/test-finance-markets
 *
 * Appelle fetchStockMarkets() et retourne un rapport de debug :
 *   - totalFound      : nombre de marchés stocks trouvés
 *   - marketsToday    : marchés qui closent aujourd'hui ou demain
 *   - sample          : 10 premiers avec question, ticker, endDate, outcomes, outcomePrices
 *   - errors          : erreurs éventuelles
 *   - rawFallback     : résultat brut de l'API Gamma si fetchStockMarkets échoue
 */

import { NextResponse } from "next/server";
import { fetchStockMarkets } from "@/lib/polymarket/gamma-api";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

export async function GET() {
  const errors: string[] = [];

  const nowUtc   = new Date();
  const today    = nowUtc.toISOString().split("T")[0];
  const tomorrow = new Date(nowUtc.getTime() + 86_400_000).toISOString().split("T")[0];

  // ── 1. Tentative via fetchStockMarkets() ──────────────────────────────────
  try {
    const markets = await fetchStockMarkets();

    const marketsToday = markets.filter((m) => {
      const d = m.endDate instanceof Date ? m.endDate.toISOString() : String(m.endDate);
      return d.includes(today) || d.includes(tomorrow);
    });

    const sample = markets.slice(0, 10).map((m) => ({
      question:      m.question,
      ticker:        m.ticker,
      endDate:       m.endDate instanceof Date ? m.endDate.toISOString() : m.endDate,
      outcomes:      m.outcomes,
      outcomePrices: m.outcomePrices,
    }));

    return NextResponse.json({
      totalFound:   markets.length,
      marketsToday: marketsToday.length,
      today,
      tomorrow,
      sample,
      errors,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`fetchStockMarkets() failed: ${msg}`);
    console.error("[test-finance-markets] fetchStockMarkets error:", msg);
  }

  // ── 2. Fallback : appel direct à l'API Gamma ─────────────────────────────
  try {
    const url = `${GAMMA_BASE}/events?tag_slug=stocks&active=true&closed=false&limit=20`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      errors.push(`Gamma API direct call HTTP ${res.status}`);
      return NextResponse.json({ totalFound: 0, marketsToday: 0, today, tomorrow, sample: [], errors }, { status: 502 });
    }

    const raw: unknown = await res.json();
    const events = Array.isArray(raw)
      ? raw
      : ((raw as Record<string, unknown>).data ?? []);

    const sample = (Array.isArray(events) ? events : []).slice(0, 10).map((ev: Record<string, unknown>) => ({
      title:    ev.title,
      endDate:  ev.endDate,
      markets:  (ev.markets as unknown[] | undefined)?.slice(0, 2),
    }));

    return NextResponse.json({
      totalFound:   Array.isArray(events) ? events.length : 0,
      marketsToday: null,
      today,
      tomorrow,
      sample,
      errors,
      rawFallback:  true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Gamma API direct call failed: ${msg}`);
    return NextResponse.json({ totalFound: 0, marketsToday: 0, today, tomorrow, sample: [], errors }, { status: 500 });
  }
}
