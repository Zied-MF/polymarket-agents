import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode"); // "real" | "paper" | null (all)

  const db = getClient();

  try {
    // Base query — select all columns needed
    let query = db
      .from("paper_trades")
      .select("id, question, city, outcome, market_price, suggested_bet, won, potential_pnl, created_at, is_real")
      .order("created_at", { ascending: false })
      .limit(20);

    if (mode === "real") {
      query = query.eq("is_real", true);
    } else if (mode === "paper") {
      // Use separate filters joined by or — avoid PostgREST .or() null syntax issues
      query = query.not("is_real", "eq", true);
    }

    const { data, error } = await query;

    if (error) {
      // is_real column may not exist yet — fallback to query without that field
      if (error.message.includes("is_real") || error.code === "42703") {
        console.warn("[trades/recent] is_real column missing, falling back to basic query");
        const fallback = await db
          .from("paper_trades")
          .select("id, question, city, outcome, market_price, suggested_bet, won, potential_pnl, created_at")
          .order("created_at", { ascending: false })
          .limit(20);

        if (fallback.error) {
          console.error("[trades/recent] Fallback query error:", fallback.error);
          return NextResponse.json({ error: fallback.error.message, code: fallback.error.code }, { status: 500 });
        }
        return NextResponse.json({ trades: fallback.data ?? [], warning: "is_real column missing — run migration" });
      }

      console.error("[trades/recent] Supabase error:", error.message, "code:", error.code);
      return NextResponse.json({ error: error.message, code: error.code }, { status: 500 });
    }

    return NextResponse.json({ trades: data ?? [] });

  } catch (e: unknown) {
    const msg   = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack   : undefined;
    console.error("[trades/recent] Exception:", msg, stack);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
