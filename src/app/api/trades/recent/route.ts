import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get("mode"); // "real" | "paper" | null (all)

    // getClient() is inside the try so any init error is caught and logged
    const db = getClient();

    // Build the query without reassignment to avoid Supabase builder type drift
    const SELECT_COLS =
      "id, question, city, outcome, market_price, suggested_bet, won, potential_pnl, created_at, is_real";

    let { data, error } = mode === "real"
      ? await db
          .from("paper_trades")
          .select(SELECT_COLS)
          .eq("is_real", true)
          .order("created_at", { ascending: false })
          .limit(20)
      : mode === "paper"
      ? await db
          .from("paper_trades")
          .select(SELECT_COLS)
          .or("is_real.is.null,is_real.eq.false")
          .order("created_at", { ascending: false })
          .limit(20)
      : await db
          .from("paper_trades")
          .select(SELECT_COLS)
          .order("created_at", { ascending: false })
          .limit(20);

    // is_real column may not exist yet (migration not run) — graceful fallback
    if (error && (error.message.includes("is_real") || (error as { code?: string }).code === "42703")) {
      console.warn(`[trades/recent] is_real column missing (${error.message}) — falling back`);

      const fallback = await db
        .from("paper_trades")
        .select("id, question, city, outcome, market_price, suggested_bet, won, potential_pnl, created_at")
        .order("created_at", { ascending: false })
        .limit(20);

      if (fallback.error) {
        console.error("[trades/recent] Fallback query failed:", fallback.error.message, fallback.error);
        return NextResponse.json(
          { error: fallback.error.message, hint: "Run: ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS is_real BOOLEAN DEFAULT false;" },
          { status: 500 }
        );
      }
      return NextResponse.json({
        trades:  fallback.data ?? [],
        warning: "is_real column missing — run migration",
      });
    }

    if (error) {
      console.error("[trades/recent] Supabase query error:", error.message, JSON.stringify(error));
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ trades: data ?? [] });

  } catch (e: unknown) {
    const msg   = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack   : undefined;
    console.error("[trades/recent] Unhandled exception:", msg, "\n", stack);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
