import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode"); // "real" | "paper" | null (all)

  const db = getClient();

  let query = db
    .from("activity_logs")
    .select("id, type, message, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  // Filter by is_real_mode stored in JSONB metadata.
  // Old logs without metadata are treated as paper (no is_real_mode key → NULL).
  if (mode === "real") {
    query = query.filter("metadata->>is_real_mode", "eq", "true");
  } else if (mode === "paper") {
    // is_real_mode=false OR key absent (old logs / paper-only context)
    query = query.or("metadata->>is_real_mode.eq.false,metadata->>is_real_mode.is.null");
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const logs = (data ?? []).map((row) => ({
    id:        row.id,
    type:      row.type,
    message:   row.message,
    timestamp: row.created_at,
  }));

  return NextResponse.json({ logs });
}
