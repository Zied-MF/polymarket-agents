import { NextResponse }                    from "next/server";
import { getBotState }                    from "@/lib/bot/bot-state";
import { getClient, getCurrentBankroll }  from "@/lib/db/supabase";
import { getAccountBalance }              from "@/lib/polymarket/clob-api";

export async function GET() {
  const db    = getClient();
  const state = await getBotState();

  const today = new Date().toISOString().slice(0, 10);

  const [todayRes, allRes, posRes, bankroll, balancePUsd] = await Promise.all([
    db.from("paper_trades").select("won, potential_pnl").gte("created_at", today),
    db.from("paper_trades").select("won, potential_pnl").not("won", "is", null),
    db.from("positions").select("id").is("sold_at", null),
    getCurrentBankroll(),
    getAccountBalance().catch(() => null),
  ]);

  const todayTrades = todayRes.data ?? [];
  const allTrades   = allRes.data   ?? [];
  const positions   = posRes.data   ?? [];

  const wins    = allTrades.filter((t) => t.won).length;
  const winRate = allTrades.length
    ? ((wins / allTrades.length) * 100).toFixed(1)
    : "0.0";

  const pnlToday = todayTrades
    .reduce((s, t) => s + (Number(t.potential_pnl) || 0), 0)
    .toFixed(2);

  const totalPnl = allTrades
    .reduce((s, t) => s + (Number(t.potential_pnl) || 0), 0)
    .toFixed(2);

  const INITIAL_BANKROLL = 10;
  const roi = ((bankroll - INITIAL_BANKROLL) / INITIAL_BANKROLL * 100).toFixed(1);

  const stats = {
    tradesToday:      todayTrades.length,
    totalTrades:      allTrades.length,
    wins,
    winRate,
    pnlToday,
    totalPnl,
    openPositions:    positions.length,
    currentBankroll:  bankroll.toFixed(2),
    initialBankroll:  INITIAL_BANKROLL,
    roi,
  };

  const trading = {
    realTradingEnabled: process.env.REAL_TRADING_ENABLED === "true",
    balancePUsd:        balancePUsd ?? null,
    funderAddress:      process.env.POLYMARKET_FUNDER_ADDRESS ?? null,
  };

  return NextResponse.json({ state, stats, trading });
}
