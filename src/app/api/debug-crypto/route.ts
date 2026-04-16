/**
 * Debug endpoint — sonde l'API Gamma pour les marchés crypto
 *
 * GET /api/debug-crypto
 *
 * Teste quatre tag_slug différents et retourne pour chacun :
 *   - le nombre de marchés bruts retournés
 *   - un échantillon de 3 marchés (id, question, liquidity, outcomes, outcomePrices)
 *   - les erreurs éventuelles
 */

import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const TAGS       = ["crypto", "bitcoin", "ethereum", "cryptocurrency"] as const;

const GAMMA_HEADERS: HeadersInit = {
  Accept:           "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control":   "no-cache",
};

// ---------------------------------------------------------------------------
// Types de réponse
// ---------------------------------------------------------------------------

interface MarketSample {
  id:            string;
  question:      string;
  liquidity:     number;
  outcomes:      string[];
  outcomePrices: number[];
  endDate:       string | null;
  active:        boolean;
  closed:        boolean;
}

interface TagResult {
  tag:    string;
  count:  number;
  sample: MarketSample[];
  error:  string | null;
}

interface DebugResponse {
  testedAt: string;
  tests:    TagResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse outcomePrices depuis string JSON ou tableau. */
function parsePrices(raw: unknown): number[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === "string") {
    try { return (JSON.parse(raw) as string[]).map(Number); } catch { return []; }
  }
  return [];
}

/** Parse outcomes depuis string JSON ou tableau. */
function parseOutcomes(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as string[]; } catch { return [raw]; }
  }
  return [];
}

/** Fetch tous les marchés pour un tag_slug donné. */
async function fetchByTag(tag: string): Promise<TagResult> {
  const url =
    `${GAMMA_BASE}/events` +
    `?tag_slug=${encodeURIComponent(tag)}` +
    `&order=startDate&ascending=false&limit=100&active=true&closed=false`;

  console.log(`[debug-crypto] GET ${url}`);

  let raw: unknown;
  try {
    const res = await fetch(url, {
      headers: GAMMA_HEADERS,
      signal:  AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[debug-crypto] tag=${tag} → HTTP ${res.status}: ${body.slice(0, 200)}`);
      return { tag, count: 0, sample: [], error: `HTTP ${res.status}` };
    }

    raw = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[debug-crypto] tag=${tag} → ${msg}`);
    return { tag, count: 0, sample: [], error: msg };
  }

  // La réponse peut être un tableau d'events ou un objet { data: [...] }
  const events: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown[] }).data)
      ? (raw as { data: unknown[] }).data
      : [];

  console.log(`[debug-crypto] tag=${tag} → ${events.length} events bruts`);

  // Aplatir : chaque event peut contenir plusieurs markets
  const markets: MarketSample[] = [];

  for (const event of events) {
    const ev = event as Record<string, unknown>;

    // Marchés imbriqués dans l'event
    const nested = Array.isArray(ev.markets)
      ? (ev.markets as Record<string, unknown>[])
      : [];

    if (nested.length === 0) {
      // Certains events sont eux-mêmes des marchés
      markets.push({
        id:            String(ev.id ?? ""),
        question:      String(ev.title ?? ev.question ?? ""),
        liquidity:     Number(ev.liquidity ?? 0),
        outcomes:      parseOutcomes(ev.outcomes),
        outcomePrices: parsePrices(ev.outcomePrices),
        endDate:       (ev.endDate as string) ?? null,
        active:        Boolean(ev.active),
        closed:        Boolean(ev.closed),
      });
    } else {
      for (const m of nested) {
        markets.push({
          id:            String(m.id ?? ""),
          question:      String(m.question ?? ev.title ?? ""),
          liquidity:     Number(m.liquidity ?? ev.liquidity ?? 0),
          outcomes:      parseOutcomes(m.outcomes),
          outcomePrices: parsePrices(m.outcomePrices),
          endDate:       (m.endDate as string) ?? (ev.endDate as string) ?? null,
          active:        Boolean(m.active ?? ev.active),
          closed:        Boolean(m.closed ?? ev.closed),
        });
      }
    }
  }

  console.log(`[debug-crypto] tag=${tag} → ${markets.length} marchés après aplatissement`);
  for (const m of markets.slice(0, 3)) {
    console.log(
      `[debug-crypto]   id=${m.id} liq=${m.liquidity} ` +
      `outcomes=${JSON.stringify(m.outcomes)} prices=${JSON.stringify(m.outcomePrices)} ` +
      `q="${m.question.slice(0, 80)}"`
    );
  }

  return {
    tag,
    count:  markets.length,
    sample: markets.slice(0, 3),
    error:  null,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<DebugResponse>> {
  const testedAt = new Date().toISOString();
  console.log(`[debug-crypto] ▶ Démarrage — ${testedAt}`);

  // Tester les 4 tags en parallèle
  const tests = await Promise.all(TAGS.map(fetchByTag));

  console.log(
    `[debug-crypto] ■ Terminé — résultats : ` +
    tests.map((t) => `${t.tag}=${t.count}`).join(", ")
  );

  return NextResponse.json({ testedAt, tests });
}
