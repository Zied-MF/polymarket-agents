/**
 * Debug endpoint — inspection brute de l'API Gamma
 *
 * GET /api/debug-markets
 *
 * Fetch 50 marchés sans filtre métier et retourne :
 *   - total        : nombre de marchés reçus
 *   - sample       : les 10 premiers (question + slug + endDate)
 *   - weather_found: marchés dont la question contient "temperature" ou "weather"
 *
 * Permet de vérifier la structure réelle des réponses Gamma et d'identifier
 * les bons paramètres de filtre (tag, slug_contains, etc.).
 */

import { NextResponse } from "next/server";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

const GAMMA_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

interface RawMarket {
  id?: string;
  question?: string;
  slug?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  [key: string]: unknown;
}

interface DebugResult {
  fetched_at: string;
  total: number;
  sample: { question: string; slug: string; endDate: string }[];
  weather_found: { question: string; slug: string; endDate: string }[];
  all_slugs: string[];
}

export async function GET(): Promise<NextResponse<DebugResult | { error: string }>> {
  const url = new URL(`${GAMMA_BASE}/markets`);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "50");

  console.log(`[debug-markets] GET ${url.toString()}`);

  let markets: RawMarket[];

  try {
    const res = await fetch(url.toString(), { headers: GAMMA_HEADERS });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[debug-markets] HTTP ${res.status}: ${body}`);
      return NextResponse.json({ error: `Gamma API error ${res.status}: ${body}` }, { status: 502 });
    }

    markets = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[debug-markets] Fetch failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Log tous les slugs pour inspection
  console.log(`[debug-markets] ${markets.length} marchés reçus`);
  console.log("[debug-markets] Slugs :");
  for (const m of markets) {
    console.log(`  • ${m.slug ?? "(no slug)"} — ${m.question?.slice(0, 80) ?? "(no question)"}`);
  }

  const toEntry = (m: RawMarket) => ({
    question: String(m.question ?? ""),
    slug:     String(m.slug ?? ""),
    endDate:  String(m.endDate ?? ""),
  });

  const sample = markets.slice(0, 10).map(toEntry);

  const weatherFound = markets.filter((m) => {
    const q = String(m.question ?? "").toLowerCase();
    return q.includes("temperature") || q.includes("weather");
  });

  console.log(`[debug-markets] weather_found: ${weatherFound.length} marchés`);
  for (const m of weatherFound) {
    console.log(`  ✓ "${m.question?.slice(0, 80)}"`);
  }

  return NextResponse.json({
    fetched_at:    new Date().toISOString(),
    total:         markets.length,
    sample,
    weather_found: weatherFound.map(toEntry),
    all_slugs:     markets.map((m) => String(m.slug ?? "")),
  });
}
