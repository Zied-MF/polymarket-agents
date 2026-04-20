import { NextResponse }  from "next/server";
import { getBotState }   from "@/lib/bot/bot-state";
import { getClient }     from "@/lib/db/supabase";

export async function GET() {
  const db    = getClient();
  const state = await getBotState();

  const today = new Date().toISOString().slice(0, 10);

  const [todayRes, allRes, posRes] = await Promise.all([
    db.from("paper_trades").select("won, potential_pnl").gte("created_at", today),
    db.from("paper_trades").select("won, potential_pnl").not("won", "is", null),
    db.from("positions").select("id").is("sold_at", null),
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

  const stats = {
    tradesToday:   todayTrades.length,
    totalTrades:   allTrades.length,
    wins,
    winRate,
    pnlToday,
    totalPnl,
    openPositions: positions.length,
  };

  return NextResponse.json({ state, stats });
}
