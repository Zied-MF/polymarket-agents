import { NextResponse }                    from "next/server";
import { getBotState }                    from "@/lib/bot/bot-state";
import { getClient, getCurrentBankroll }  from "@/lib/db/supabase";
import { getAccountBalance }              from "@/lib/polymarket/clob-api";

export async function GET() {
  const db    = getClient();
  const state = await getBotState();

  const today = new Date().toISOString().slice(0, 10);

  const [todayAllRes, allResRaw, posRes, bankroll, balancePUsd, realPosRes] = await Promise.all([
    db.from("paper_trades").select("won, potential_pnl, is_real").gte("created_at", today),
    db.from("paper_trades").select("won, potential_pnl, is_real").not("won", "is", null),
    db.from("positions").select("id").is("sold_at", null).is("is_real", null),
    getCurrentBankroll(),
    getAccountBalance().catch(() => null),
    db.from("positions").select("id").is("sold_at", null).eq("is_real", true),
  ]);

  const allTodayTrades = todayAllRes.data ?? [];
  const allTrades      = allResRaw.data   ?? [];
  const positions      = posRes.data      ?? [];
  const realPositions  = realPosRes.data  ?? [];

  function computeStats(
    today: { won: boolean | null; potential_pnl: number }[],
    all:   { won: boolean | null; potential_pnl: number }[],
    openPos: number,
    currentBankroll: string,
    initialBankroll: number,
  ) {
    const wins    = all.filter((t) => t.won).length;
    const winRate = all.length ? ((wins / all.length) * 100).toFixed(1) : "0.0";
    const pnlToday = today.reduce((s, t) => s + (Number(t.potential_pnl) || 0), 0).toFixed(2);
    const totalPnl = all.reduce((s, t) => s + (Number(t.potential_pnl) || 0), 0).toFixed(2);
    const roi = ((parseFloat(currentBankroll) - initialBankroll) / initialBankroll * 100).toFixed(1);
    return {
      tradesToday: today.length, totalTrades: all.length, wins, winRate,
      pnlToday, totalPnl, openPositions: openPos, currentBankroll, initialBankroll, roi,
    };
  }

  // Initial bankrolls — configurable via env vars so they update when topped up.
  // PAPER_BANKROLL_INITIAL : starting capital for paper simulation (default $10)
  // REAL_BANKROLL_INITIAL  : actual USDC deposited on Polymarket (default $61.59)
  const PAPER_BANKROLL_INITIAL = parseFloat(process.env.PAPER_BANKROLL_INITIAL ?? "10");
  const REAL_BANKROLL_INITIAL  = parseFloat(process.env.REAL_BANKROLL_INITIAL  ?? "61.59");

  // Paper stats (is_real = false or null)
  const paperToday = allTodayTrades.filter((t) => !t.is_real);
  const paperAll   = allTrades.filter((t) => !t.is_real);
  const paperStats = computeStats(paperToday, paperAll, positions.length, bankroll.toFixed(2), PAPER_BANKROLL_INITIAL);

  // Real stats (is_real = true)
  const realToday    = allTodayTrades.filter((t) => t.is_real);
  const realAll      = allTrades.filter((t) => t.is_real);
  const realBankroll = balancePUsd != null ? balancePUsd.toFixed(2) : "0.00";
  const realStats    = computeStats(realToday, realAll, realPositions.length, realBankroll, REAL_BANKROLL_INITIAL);

  // Legacy combined stats (for backwards compat)
  const stats = paperStats;

  const trading = {
    realTradingEnabled: process.env.REAL_TRADING_ENABLED === "true",
    balancePUsd:        balancePUsd ?? null,
    funderAddress:      process.env.POLYMARKET_FUNDER_ADDRESS ?? null,
  };

  return NextResponse.json({ state, stats, paperStats, realStats, trading });
}
