/**
 * Debug endpoint — inspection des marchés finance Gamma
 *
 * GET /api/test-finance
 *
 * 1. Appelle fetchStockMarkets() (gamma-api.ts)
 * 2. En parallèle, sonde directement les tags "stocks" et "finance"
 *    pour comparer ce que l'API retourne brut vs ce que le parser garde.
 *
 * Retourne :
 *   {
 *     parsed   : résultat de fetchStockMarkets() (10 premiers)
 *     raw      : événements bruts des deux tags (10 premiers chacun)
 *     errors   : erreurs éventuelles
 *   }
 */

import { NextResponse } from "next/server";
import { fetchStockMarkets } from "@/lib/polymarket/gamma-api";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

const HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Cache-Control": "no-cache",
};

interface RawEventSummary {
  id: string;
  title: string;
  endDate: string;
  marketsCount: number;
}

interface RawTagResult {
  tag: string;
  status: number;
  total: number;
  events: RawEventSummary[];
  error?: string;
}

async function probeTag(tag: string): Promise<RawTagResult> {
  const url =
    `${GAMMA_BASE}/events?tag_slug=${tag}&active=true&closed=false` +
    `&order=endDate&ascending=true&limit=20`;

  console.log(`[test-finance] GET ${url}`);

  try {
    const res = await fetch(url, { headers: HEADERS });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        tag,
        status: res.status,
        total: 0,
        events: [],
        error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const raw: unknown = await res.json();
    const items: Record<string, unknown>[] = Array.isArray(raw)
      ? raw
      : ((raw as Record<string, unknown>).data as Record<string, unknown>[] | undefined) ?? [];

    const events: RawEventSummary[] = items.slice(0, 10).map((e) => ({
      id:           String(e.id ?? ""),
      title:        String(e.title ?? e.question ?? "(no title)"),
      endDate:      String(e.endDate ?? ""),
      marketsCount: Array.isArray(e.markets) ? e.markets.length : 0,
    }));

    console.log(`[test-finance] tag=${tag} → ${items.length} events`);
    for (const ev of events) {
      console.log(
        `  [${ev.endDate.slice(0, 10)}] "${ev.title.slice(0, 70)}" (${ev.marketsCount} markets)`
      );
    }

    return { tag, status: res.status, total: items.length, events };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[test-finance] tag=${tag} threw: ${error}`);
    return { tag, status: 0, total: 0, events: [], error };
  }
}

export async function GET() {
  console.log("[test-finance] ▶ Démarrage");

  // Lancer les trois appels en parallèle
  const [parsedMarkets, stocksRaw, financeRaw] = await Promise.allSettled([
    fetchStockMarkets(),
    probeTag("stocks"),
    probeTag("finance"),
  ]);

  // Résultat de fetchStockMarkets()
  const parsedResult =
    parsedMarkets.status === "fulfilled"
      ? {
          totalMarkets: parsedMarkets.value.length,
          markets: parsedMarkets.value.slice(0, 10).map((m) => ({
            question: m.question,
            ticker:   m.ticker,
            direction: m.direction,
            endDate:  m.endDate.toISOString().slice(0, 10),
            outcomes: m.outcomes,
            outcomePrices: m.outcomePrices,
          })),
          error: null,
        }
      : {
          totalMarkets: 0,
          markets: [],
          error: parsedMarkets.reason instanceof Error
            ? parsedMarkets.reason.message
            : String(parsedMarkets.reason),
        };

  const rawStocks  = stocksRaw.status  === "fulfilled" ? stocksRaw.value  : { tag: "stocks",  status: 0, total: 0, events: [], error: String((stocksRaw  as PromiseRejectedResult).reason) };
  const rawFinance = financeRaw.status === "fulfilled" ? financeRaw.value : { tag: "finance", status: 0, total: 0, events: [], error: String((financeRaw as PromiseRejectedResult).reason) };

  console.log(
    `[test-finance] ■ parsed=${parsedResult.totalMarkets} | ` +
    `stocks_raw=${rawStocks.total} | finance_raw=${rawFinance.total}`
  );

  return NextResponse.json({
    parsed:  parsedResult,
    raw: {
      stocks:  rawStocks,
      finance: rawFinance,
    },
  });
}
