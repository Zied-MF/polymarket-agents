import { NextResponse } from "next/server";

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

interface EventSummary {
  title: string;
  endDate: string;
  marketsCount: number;
}

interface ApproachResult {
  status: number;
  count: number;
  events: EventSummary[];
  error?: string;
}

async function tryApproach(label: string, url: string): Promise<ApproachResult> {
  console.log(`[test-gamma] ${label} — GET ${url}`);

  try {
    const res = await fetch(url, { headers: HEADERS });
    console.log(`[test-gamma] ${label} → status ${res.status} ${res.statusText}`);

    if (!res.ok) {
      const body = await res.text();
      const error = `HTTP ${res.status}: ${body.slice(0, 300)}`;
      console.error(`[test-gamma] ${label} error: ${error}`);
      return { status: res.status, count: 0, events: [], error };
    }

    const raw = await res.json();

    // L'endpoint peut retourner un tableau direct ou { data: [...] }
    const items: Record<string, unknown>[] = Array.isArray(raw)
      ? raw
      : ((raw as Record<string, unknown>).data as Record<string, unknown>[] | undefined) ?? [];

    const events: EventSummary[] = items.map((e) => {
      const markets = (e.markets as unknown[] | undefined) ?? [];
      return {
        title: String(e.title ?? e.question ?? "(no title)"),
        endDate: String(e.endDate ?? ""),
        marketsCount: markets.length,
      };
    });

    console.log(`[test-gamma] ${label} → ${events.length} events`);
    for (const ev of events) {
      console.log(
        `  • [${ev.endDate.slice(0, 10)}] "${ev.title.slice(0, 70)}" (${ev.marketsCount} markets)`
      );
    }

    return { status: res.status, count: events.length, events };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[test-gamma] ${label} threw: ${error}`);
    return { status: 0, count: 0, events: [], error };
  }
}

export async function GET() {
  const [a, b, c] = await Promise.all([
    tryApproach(
      "approach_a (tag_slug=daily-temperature)",
      "https://gamma-api.polymarket.com/events?tag_slug=daily-temperature&active=true&limit=50"
    ),
    tryApproach(
      "approach_b (tag_slug=temperature)",
      "https://gamma-api.polymarket.com/events?tag_slug=temperature&active=true&limit=50"
    ),
    tryApproach(
      "approach_c (tag_slug=weather, sorted by endDate)",
      "https://gamma-api.polymarket.com/events?tag_slug=weather&active=true&closed=false&order=endDate&ascending=true&limit=50"
    ),
  ]);

  return NextResponse.json({ approach_a: a, approach_b: b, approach_c: c });
}
