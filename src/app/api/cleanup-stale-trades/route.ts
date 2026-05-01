import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

/**
 * POST /api/cleanup-stale-trades
 *
 * Nettoie les paper_trades réels dont l'ordre CLOB n'a jamais été rempli :
 *   - is_real = true
 *   - won = null  (jamais résolu = ordre jamais matché)
 *
 * Action : set won=false, potential_pnl=0
 * Effet   : retirés du Today P&L et du Total P&L
 *
 * Aussi ferme les positions réelles encore ouvertes correspondantes.
 */
export async function POST() {
  const db  = getClient();
  const now = new Date().toISOString();

  // 1. Paper trades réels non résolus
  const { data: staleTrades, error: fetchErr } = await db
    .from("paper_trades")
    .select("id")
    .eq("is_real", true)
    .is("won", null);

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  const count = staleTrades?.length ?? 0;
  if (count === 0) {
    return NextResponse.json({ ok: true, cleaned: 0, message: "Nothing to clean" });
  }

  const ids = staleTrades!.map((t) => t.id);

  // 2. Zéroïser les paper_trades
  const { error: ptErr } = await db
    .from("paper_trades")
    .update({ won: false, potential_pnl: 0 })
    .in("id", ids);

  if (ptErr) {
    return NextResponse.json({ error: ptErr.message }, { status: 500 });
  }

  // 3. Fermer les positions réelles ouvertes liées
  const { error: posErr } = await db
    .from("positions")
    .update({
      status:         "sold",
      sell_reason:    "cleanup_stale_unfilled",
      sold_at:        now,
      sell_signal_at: now,
      sell_pnl:       0,
    })
    .in("paper_trade_id", ids)
    .is("sold_at", null);

  if (posErr) console.warn("[cleanup-stale-trades] positions update warn:", posErr.message);

  const msg = `🧹 Cleaned ${count} stale real trade(s) — P&L zeroed`;
  console.log(`[cleanup-stale-trades] ${msg}`);

  return NextResponse.json({ ok: true, cleaned: count, message: msg });
}
