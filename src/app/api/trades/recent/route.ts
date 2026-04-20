import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

export async function GET() {
  const db = getClient();
  const { data, error } = await db
    .from("paper_trades")
    .select("id, question, city, outcome, market_price, suggested_bet, won, potential_pnl, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ trades: data ?? [] });
}
