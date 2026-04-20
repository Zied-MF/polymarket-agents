/**
 * Bot State — persiste l'état du bot (running/stopped, mode) dans Supabase.
 *
 * Table requise :
 *   CREATE TABLE IF NOT EXISTS bot_state (
 *     id            TEXT PRIMARY KEY DEFAULT 'default',
 *     is_running    BOOLEAN DEFAULT false,
 *     mode          TEXT    DEFAULT 'balanced',
 *     started_at    TIMESTAMPTZ,
 *     last_scan_at  TIMESTAMPTZ,
 *     updated_at    TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   INSERT INTO bot_state (id) VALUES ('default') ON CONFLICT DO NOTHING;
 */

import { getClient } from "@/lib/db/supabase";
import type { TradingMode } from "@/lib/config/trading-modes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotState {
  isRunning:   boolean;
  mode:        TradingMode;
  startedAt:   string | null;
  lastScanAt:  string | null;
  tradesToday: number;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getBotState(): Promise<BotState> {
  const db = getClient();
  const { data } = await db
    .from("bot_state")
    .select("*")
    .eq("id", "default")
    .single();

  return {
    isRunning:   data?.is_running  ?? false,
    mode:        (data?.mode as TradingMode) ?? "balanced",
    startedAt:   data?.started_at  ?? null,
    lastScanAt:  data?.last_scan_at ?? null,
    tradesToday: 0,
  };
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

export async function startBot(): Promise<void> {
  const db = getClient();
  await db.from("bot_state").upsert({
    id:          "default",
    is_running:  true,
    started_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
  });
}

export async function stopBot(): Promise<void> {
  const db = getClient();
  await db.from("bot_state").upsert({
    id:          "default",
    is_running:  false,
    started_at:  null,
    updated_at:  new Date().toISOString(),
  });
}

export async function setTradingMode(mode: TradingMode): Promise<void> {
  const db = getClient();
  await db.from("bot_state").upsert({
    id:         "default",
    mode,
    updated_at: new Date().toISOString(),
  });
}

export async function updateLastScan(): Promise<void> {
  const db = getClient();
  await db
    .from("bot_state")
    .update({
      last_scan_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq("id", "default");
}
