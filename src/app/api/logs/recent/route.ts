import { NextResponse } from "next/server";
import { getClient }    from "@/lib/db/supabase";

export async function GET() {
  const db = getClient();
  const { data, error } = await db
    .from("activity_logs")
    .select("id, type, message, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Map created_at → timestamp for component compatibility
  const logs = (data ?? []).map((row) => ({
    id:        row.id,
    type:      row.type,
    message:   row.message,
    timestamp: row.created_at,
  }));

  return NextResponse.json({ logs });
}
