/**
 * GET /api/debug/scan-stats
 *
 * Lance un scan complet et retourne le décompte des skips par filtre,
 * sans créer aucun trade ni paper_trade.
 * Utile pour diagnostiquer pourquoi le bot ne place pas de trades.
 */

import { NextResponse }           from "next/server";
import { weatherAdapter }         from "@/lib/agents/adapters/weather-adapter";
import { setWeatherAdapterMode }  from "@/lib/agents/adapters/weather-adapter";
import { getBotState }            from "@/lib/bot/bot-state";

interface SkipBucket {
  [reason: string]: number;
}

export async function GET() {
  const botState   = await getBotState().catch(() => null);
  const scanMode   = (botState?.mode ?? "balanced") as Parameters<typeof setWeatherAdapterMode>[0];
  setWeatherAdapterMode(scanMode);

  // Fetch markets
  const markets = await weatherAdapter.fetchMarkets();

  const skipBuckets: SkipBucket = {};
  const dominated: { city: string; edge: number; outcome: string; price: number }[] = [];
  const dropped:   { city: string; edge: number; reason: string }[]                 = [];

  let fetchErrors = 0;

  for (const market of markets) {
    let data: unknown;
    try {
      data = weatherAdapter.fetchData ? await weatherAdapter.fetchData(market) : undefined;
    } catch {
      fetchErrors++;
      bucket(skipBuckets, "fetchData error");
      continue;
    }

    let result: { dominated?: { edge: number; outcome: string; marketPrice: number }; skipReason?: string } | null = null;
    try {
      result = await weatherAdapter.analyze(market, data);
    } catch {
      bucket(skipBuckets, "analyze error");
      continue;
    }

    if (!result) {
      bucket(skipBuckets, "analyze returned null");
      continue;
    }

    if (result.skipReason) {
      // Normalise la raison pour grouper les variantes
      const key = normalizeReason(result.skipReason);
      bucket(skipBuckets, key);
      continue;
    }

    if (result.dominated) {
      const m = market as { city?: string };
      const edge = result.dominated.edge;
      if (edge >= 0.12) {
        dominated.push({
          city:    m.city ?? "?",
          edge:    Math.round(edge * 1000) / 10,
          outcome: result.dominated.outcome,
          price:   Math.round(result.dominated.marketPrice * 100),
        });
      } else {
        dropped.push({
          city:   m.city ?? "?",
          edge:   Math.round(edge * 1000) / 10,
          reason: `edge ${(edge * 100).toFixed(1)}% < 12% (orchestrator minEdge)`,
        });
        bucket(skipBuckets, `orchestrator: edge < 12%`);
      }
    }
  }

  // Tri skip buckets par count décroissant
  const skipsSorted = Object.entries(skipBuckets)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({ reason, count }));

  return NextResponse.json({
    mode:          scanMode,
    totalMarkets:  markets.length,
    dominated:     dominated.length,
    dropped:       dropped.length,
    fetchErrors,
    skipsTotal:    Object.values(skipBuckets).reduce((s, n) => s + n, 0),
    skipsByFilter: skipsSorted,
    dominatedList: dominated,
    droppedList:   dropped,
  });
}

function bucket(b: SkipBucket, key: string) {
  b[key] = (b[key] ?? 0) + 1;
}

function normalizeReason(r: string): string {
  if (r.startsWith("Claude SKIP"))              return "Claude SKIP";
  if (r.startsWith("Confidence "))              return "Confidence trop basse";
  if (r.startsWith("Edge net "))                return "Edge net < minEdge";
  if (r.startsWith("YES ") && r.includes("¢")) return "YES price > max";
  if (r.startsWith("NO not worth"))             return "NO: YES price trop basse";
  if (r.startsWith("Resolution > 24h"))         return "Horizon > 24h (balanced)";
  if (r.startsWith("Resolution > 48h"))         return "Horizon > 48h";
  if (r.startsWith("Too close to resolution"))  return "Résolution < 1h";
  if (r.startsWith("Already have position"))    return "Anti-churn: ville/date déjà tradée";
  if (r.startsWith("Modèles en désaccord"))     return "Multi-model: désaccord weak";
  if (r.startsWith("Aucun edge suffisant"))      return "Edge gaussien insuffisant";
  if (r.startsWith("Station inconnue"))         return "Station inconnue";
  if (r.startsWith("Liquidity "))               return "Liquidité trop basse";
  if (r.startsWith("Prix dominant"))            return "Anti-favori > 70%";
  if (r.startsWith("Price "))                   return "Prix > 70¢";
  return r.slice(0, 60);
}
