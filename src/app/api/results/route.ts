/**
 * Results endpoint — agrégation des paper trades pour le dashboard P&L
 *
 * GET /api/results?period=7   → derniers 7 jours
 * GET /api/results?period=30  → derniers 30 jours
 * GET /api/results?period=all → tous les trades (défaut)
 *
 * Retourne :
 *   stats        — métriques globales (win rate en %, P&L…)
 *   byAgent      — ventilé weather / finance
 *   dailyPnl[]   — P&L journalier + cumulatif (pour le graphique)
 *   recentTrades — liste brute triée par created_at desc
 */

import { NextResponse }                       from "next/server";
import { getPaperTrades, type PaperTradeRow } from "@/lib/db/supabase";

// ---------------------------------------------------------------------------
// Types exportés (consommés par la page results)
// ---------------------------------------------------------------------------

export interface AgentStats {
  trades:  number;
  wins:    number;
  losses:  number;
  /** Win rate en pourcentage — ex : 66.7 */
  winRate: number;
  pnl:     number;
}

export interface DailyPnL {
  date:       string;   // "YYYY-MM-DD"
  pnl:        number;   // P&L net du jour
  cumulative: number;   // P&L cumulé depuis le début de la période
}

export interface ResultStats {
  totalTrades: number;
  resolved:    number;
  pending:     number;
  wins:        number;
  losses:      number;
  /** Win rate en pourcentage — ex : 62.2 */
  winRate:     number;
  totalPnl:    number;
  avgPnl:      number;
  bestTrade:   number;
  worstTrade:  number;
}

export interface ResultsResponse {
  period:       string;
  stats:        ResultStats;
  byAgent: {
    weather: AgentStats;
    finance: AgentStats;
  };
  dailyPnl:     DailyPnL[];
  recentTrades: PaperTradeRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildAgentStats(trades: PaperTradeRow[]): AgentStats {
  const resolved = trades.filter((t) => t.won !== null);
  const wins     = resolved.filter((t) => t.won === true).length;
  const losses   = resolved.length - wins;
  const pnl      = r2(resolved.reduce((s, t) => s + (t.potential_pnl ?? 0), 0));
  const winRate  = resolved.length > 0
    ? r2((wins / resolved.length) * 100)
    : 0;

  return { trades: trades.length, wins, losses, winRate, pnl };
}

/**
 * Agrège les trades résolus par date de résolution en P&L journalier + cumulatif.
 * Les jours sans trade ne sont pas inclus (le graphique gère les gaps).
 */
function buildDailyPnL(resolved: PaperTradeRow[]): DailyPnL[] {
  // Trier par date de résolution croissante
  const sorted = [...resolved].sort((a, b) => {
    const dA = a.resolved_at ?? a.created_at;
    const dB = b.resolved_at ?? b.created_at;
    return dA < dB ? -1 : dA > dB ? 1 : 0;
  });

  // Grouper par date (YYYY-MM-DD)
  const byDate = new Map<string, number>();
  for (const t of sorted) {
    const date = (t.resolved_at ?? t.created_at).slice(0, 10);
    byDate.set(date, (byDate.get(date) ?? 0) + (t.potential_pnl ?? 0));
  }

  // Construire le tableau avec cumulatif
  let cumulative = 0;
  return Array.from(byDate.entries()).map(([date, pnl]) => {
    cumulative += pnl;
    return { date, pnl: r2(pnl), cumulative: r2(cumulative) };
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(
  request: Request
): Promise<NextResponse<ResultsResponse | { error: string }>> {
  const { searchParams } = new URL(request.url);
  const periodParam = searchParams.get("period") ?? "all";
  const days        = periodParam === "all" ? null : (parseInt(periodParam, 10) || 7);

  // Label affiché dans la réponse
  const periodLabel = days === null ? "all" : `${days}d`;

  let allTrades: PaperTradeRow[];
  try {
    allTrades = await getPaperTrades(days);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[api/results] ✗ getPaperTrades : ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // --- Partition résolus / en attente ---
  const resolved  = allTrades.filter((t) => t.won !== null);
  const pending   = allTrades.filter((t) => t.won === null);
  const wins      = resolved.filter((t) => t.won === true).length;
  const losses    = resolved.length - wins;
  const pnlValues = resolved.map((t) => t.potential_pnl ?? 0);
  const totalPnl  = r2(pnlValues.reduce((s, v) => s + v, 0));

  const stats: ResultStats = {
    totalTrades: allTrades.length,
    resolved:    resolved.length,
    pending:     pending.length,
    wins,
    losses,
    winRate:     resolved.length > 0 ? r2((wins / resolved.length) * 100) : 0,
    totalPnl,
    avgPnl:      resolved.length > 0 ? r2(totalPnl / resolved.length) : 0,
    bestTrade:   pnlValues.length > 0 ? r2(Math.max(...pnlValues)) : 0,
    worstTrade:  pnlValues.length > 0 ? r2(Math.min(...pnlValues)) : 0,
  };

  // --- Stats par agent ---
  const byAgent = {
    weather: buildAgentStats(allTrades.filter((t) => t.agent === "weather")),
    finance: buildAgentStats(allTrades.filter((t) => t.agent === "finance")),
  };

  // --- P&L journalier ---
  const dailyPnl = buildDailyPnL(resolved);

  // --- Trades récents (triés par created_at desc, déjà l'ordre de getPaperTrades) ---
  const recentTrades = allTrades;

  return NextResponse.json({
    period:  periodLabel,
    stats,
    byAgent,
    dailyPnl,
    recentTrades,
  });
}
