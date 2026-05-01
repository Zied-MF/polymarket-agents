import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode"); // "real" | "paper" | null (all)

  const db = getClient();
  let query = db
    .from("paper_trades")
    .select("id, question, city, outcome, market_price, suggested_bet, won, potential_pnl, is_real, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  if (mode === "real") {
    query = query.eq("is_real", true);
  } else if (mode === "paper") {
    query = query.or("is_real.is.null,is_real.eq.false");
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ trades: data ?? [] });
}
