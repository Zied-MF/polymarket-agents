/**
 * Activity Logger — écrit dans la table `activity_logs` Supabase.
 *
 * Table requise :
 *   CREATE TABLE IF NOT EXISTS activity_logs (
 *     id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     type       TEXT NOT NULL,
 *     message    TEXT NOT NULL,
 *     metadata   JSONB,
 *     created_at TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   CREATE INDEX idx_activity_logs_created ON activity_logs(created_at DESC);
 */

import { getClient } from "@/lib/db/supabase";

export type LogType = "scan" | "trade" | "skip" | "error" | "exit" | "info";

export async function logActivity(
  type:      LogType,
  message:   string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const db = getClient();
    await db.from("activity_logs").insert({
      type,
      message,
      metadata: metadata ?? null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Non-bloquant — juste loguer en console si ça échoue
    console.error("[logger] Failed to write activity log:", err instanceof Error ? err.message : err);
  }
}

/** Purge les logs de plus de 24 h. À appeler depuis un cron. */
export async function cleanOldLogs(): Promise<void> {
  const db     = getClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await db.from("activity_logs").delete().lt("created_at", cutoff);
}
