import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

export async function GET() {
  const db = getClient();
  const { data, error } = await db
    .from("positions")
    .select("*")
    .is("sold_at", null)
    .order("opened_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ positions: data ?? [] });
}
