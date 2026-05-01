import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode"); // "real" | "paper" | null (all)

  const db = getClient();

  let query = db
    .from("positions")
    .select("*")
    .is("sold_at", null)
    .order("opened_at", { ascending: false });

  if (mode === "real") {
    query = query.eq("is_real", true);
  } else if (mode === "paper") {
    query = query.or("is_real.is.null,is_real.eq.false");
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ positions: data ?? [] });
}
