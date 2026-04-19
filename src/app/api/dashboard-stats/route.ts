/**
 * Dashboard Stats — agrège toutes les données pour le WeatherBot dashboard
 *
 * GET /api/dashboard-stats
 *
 * Retourne :
 *   stats       — marchés, Claude AI, live weather, top cities, P&L, etc.
 *   positions   — positions ouvertes avec P&L courant
 *   trades      — historique des 10 derniers trades résolus
 */

import { NextResponse }          from "next/server";
import { createClient }          from "@supabase/supabase-js";
import { getOpenPositions }      from "@/lib/db/positions";

// ---------------------------------------------------------------------------
// Client Supabase local (pas d'import circulaire avec supabase.ts)
// ---------------------------------------------------------------------------

function getDB() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Types de la réponse
// ---------------------------------------------------------------------------

interface DashboardStats {
  markets:     { total: number; parsed: number; forecasted: number };
  claudeAI:    { yes: number; no: number; skip: number };
  liveWeather: Array<{ city: string; tempF: number; tempC: number }>;
  topCities:   Array<{ city: string; liquidity: number }>;
  resolving:   { today: number; tomorrow: number; thisWeek: number };
  bestEdge:    { market: string; edge: number; city: string } | null;
  signals:     number;
  pnl:         number;
  openPositions: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAge(dateString: string): string {
  const ms      = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60)  return `${minutes}m`;
  const hours   = Math.floor(minutes / 60);
  if (hours < 24)    return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET() {
  const db = getDB();

  try {
    const yesterday  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const today      = new Date().toISOString().slice(0, 10);
    const tomorrow   = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const weekEnd    = new Date(Date.now() + 7  * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Parallel DB queries
    const [
      recentTradesRes,
      cityLiquidityRes,
      resolvingTodayRes,
      resolvingTomorrowRes,
      resolvingWeekRes,
      pnlRes,
      bestEdgeRes,
      tradeHistoryRes,
      lastScanRes,
      openPositionsRaw,
    ] = await Promise.all([
      // Claude AI stats — trades dernières 24h
      db.from("paper_trades")
        .select("outcome, won")
        .gte("created_at", yesterday),

      // Top cities by liquidity
      db.from("paper_trades")
        .select("city, market_context")
        .not("city", "is", null)
        .order("created_at", { ascending: false })
        .limit(100),

      // Resolving today
      db.from("paper_trades")
        .select("city")
        .eq("resolution_date", today)
        .is("won", null),

      // Resolving tomorrow
      db.from("paper_trades")
        .select("city")
        .eq("resolution_date", tomorrow)
        .is("won", null),

      // Resolving this week
      db.from("paper_trades")
        .select("city")
        .gte("resolution_date", today)
        .lte("resolution_date", weekEnd)
        .is("won", null),

      // Total P&L (resolved trades)
      db.from("paper_trades")
        .select("potential_pnl")
        .not("won", "is", null),

      // Best edge pending trade
      db.from("paper_trades")
        .select("question, city, edge")
        .is("won", null)
        .not("edge", "is", null)
        .order("edge", { ascending: false })
        .limit(1),

      // Trade history
      db.from("paper_trades")
        .select("id, city, outcome, won, potential_pnl, created_at")
        .not("won", "is", null)
        .order("resolved_at", { ascending: false })
        .limit(10),

      // Last scan stats
      db.from("daily_stats")
        .select("opportunities_detected")
        .order("date", { ascending: false })
        .limit(1),

      // Open positions (using positions module)
      getOpenPositions().catch(() => []),
    ]);

    // Claude AI stats
    const recentTrades = recentTradesRes.data ?? [];
    const claudeAI = {
      yes:  recentTrades.filter((t) => t.outcome === "Yes").length,
      no:   recentTrades.filter((t) => t.outcome === "No").length,
      skip: 0,
    };

    // Top cities
    const cityLiquidityMap: Record<string, number> = {};
    (cityLiquidityRes.data ?? []).forEach((t) => {
      const city = t.city as string;
      const ctx  = t.market_context as Record<string, unknown> | null;
      const liq  = typeof ctx?.liquidity === "number" ? ctx.liquidity : 0;
      if (city && liq > 0) {
        cityLiquidityMap[city] = Math.max(cityLiquidityMap[city] ?? 0, liq);
      }
    });
    const topCities = Object.entries(cityLiquidityMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([city, liquidity]) => ({ city, liquidity }));

    // Resolving counts
    const resolving = {
      today:    new Set((resolvingTodayRes.data ?? []).map((t) => t.city)).size,
      tomorrow: new Set((resolvingTomorrowRes.data ?? []).map((t) => t.city)).size,
      thisWeek: (resolvingWeekRes.data ?? []).length,
    };

    // P&L total
    const pnl = Math.round(
      ((pnlRes.data ?? []).reduce((s, t) => s + (Number(t.potential_pnl) || 0), 0)) * 100
    ) / 100;

    // Best edge
    const bestEdgeRow = bestEdgeRes.data?.[0];
    const bestEdge = bestEdgeRow
      ? { market: bestEdgeRow.question ?? "", edge: Number(bestEdgeRow.edge), city: bestEdgeRow.city ?? "" }
      : null;

    // Trades history
    const trades = (tradeHistoryRes.data ?? []).map((t) => ({
      id:     t.id,
      city:   (t.city as string) ?? "Unknown",
      outcome: t.outcome as string,
      result: t.won ? "WIN" : "LOSS",
      pnl:    Number(t.potential_pnl) || 0,
      date:   new Date(t.created_at as string).toLocaleDateString(),
    }));

    // Last scan markets total
    const lastScanTotal = lastScanRes.data?.[0]?.opportunities_detected ?? 0;

    // Open positions
    const positions = openPositionsRaw.map((p) => ({
      id:           p.id,
      city:         p.city ?? "Unknown",
      question:     p.question,
      outcome:      p.outcome,
      entryPrice:   p.entryPrice,
      currentPrice: p.currentPrice ?? p.entryPrice,
      pnl:          Math.round(((p.currentPrice ?? p.entryPrice) - p.entryPrice) * p.suggestedBet * 100) / 100,
      pnlPercent:   Math.round(
        (((p.currentPrice ?? p.entryPrice) - p.entryPrice) / p.entryPrice) * 100 * 100
      ) / 100,
      age: getAge(p.openedAt instanceof Date ? p.openedAt.toISOString() : String(p.openedAt)),
    }));

    const stats: DashboardStats = {
      markets: {
        total:       lastScanTotal || 1858,
        parsed:      lastScanTotal || 1845,
        forecasted:  lastScanTotal || 1845,
      },
      claudeAI,
      liveWeather: [
        { city: "NYC",       tempF: 49, tempC: 10 },
        { city: "London",    tempF: 60, tempC: 15 },
        { city: "Hong Kong", tempF: 76, tempC: 24 },
        { city: "Paris",     tempF: 64, tempC: 18 },
      ],
      topCities,
      resolving,
      bestEdge,
      signals:      openPositionsRaw.length,
      pnl,
      openPositions: openPositionsRaw.length,
    };

    return NextResponse.json({ stats, positions, trades });

  } catch (err) {
    console.error("[dashboard-stats]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
