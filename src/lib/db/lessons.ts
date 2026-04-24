/**
 * Accès Supabase — leçons post-mortem et calibration de confiance
 *
 * Tables requises (à créer dans Supabase SQL Editor) :
 *
 *   CREATE TABLE IF NOT EXISTS lessons_learned (
 *     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     agent           TEXT NOT NULL,
 *     lesson          TEXT NOT NULL,
 *     source_trade_id UUID REFERENCES paper_trades(id),
 *     created_at      TIMESTAMPTZ DEFAULT NOW(),
 *     times_applied   INT DEFAULT 0
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS confidence_calibration (
 *     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     confidence_level TEXT NOT NULL UNIQUE,
 *     total_trades     INT DEFAULT 0,
 *     wins             INT DEFAULT 0,
 *     updated_at       TIMESTAMPTZ DEFAULT NOW()
 *   );
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Client Supabase (singleton local)
// ---------------------------------------------------------------------------

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env vars missing");
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LessonRow {
  id:              string;
  agent:           string;
  lesson:          string;
  source_trade_id: string | null;
  created_at:      string;
  times_applied:   number;
}

// ---------------------------------------------------------------------------
// Leçons post-mortem
// ---------------------------------------------------------------------------

/**
 * Retourne les N dernières leçons, triées par date décroissante.
 * Retourne [] si la table n'existe pas encore.
 */
export async function getRecentLessons(n = 20): Promise<LessonRow[]> {
  try {
    const { data, error } = await getClient()
      .from("lessons_learned")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(n);

    if (error) {
      console.warn(`[lessons] getRecentLessons: ${error.message}`);
      return [];
    }
    return (data ?? []) as LessonRow[];
  } catch {
    return [];
  }
}

/**
 * Persiste une leçon post-mortem.
 */
export async function saveLesson(
  lesson:         string,
  agent:          string,
  sourceTradeId?: string
): Promise<void> {
  try {
    const { data, error } = await getClient().from("lessons_learned").insert({
      lesson,
      agent,
      source_trade_id: sourceTradeId ?? null,
    }).select();
    if (error) {
      console.error(`[lessons] DB Insert error:`, error);
    } else {
      console.log(`[lessons] ✅ Lesson saved:`, data);
    }
  } catch (err) {
    console.error("[lessons] saveLesson exception:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Calibration de confiance
// ---------------------------------------------------------------------------

/**
 * Retourne la calibration actuelle sous forme { LEVEL: winRate }.
 * Ex: { HIGH: 0.72, MEDIUM: 0.58 }
 * Retourne {} si pas encore de données.
 */
export async function getConfidenceCalibration(): Promise<Record<string, number>> {
  try {
    const { data, error } = await getClient()
      .from("confidence_calibration")
      .select("confidence_level, total_trades, wins");

    if (error || !data) return {};

    return Object.fromEntries(
      data
        .filter((r) => r.total_trades > 0)
        .map((r) => [r.confidence_level, r.wins / r.total_trades])
    );
  } catch {
    return {};
  }
}

/**
 * Incrémente les compteurs de calibration après résolution d'un trade.
 * Upsert idempotent sur confidence_level.
 */
export async function updateConfidenceCalibration(
  level: string,
  won:   boolean
): Promise<void> {
  try {
    const db = getClient();

    // Lire la ligne existante
    const { data } = await db
      .from("confidence_calibration")
      .select("total_trades, wins")
      .eq("confidence_level", level.toUpperCase())
      .maybeSingle();

    const total = (data?.total_trades ?? 0) + 1;
    const wins  = (data?.wins  ?? 0) + (won ? 1 : 0);

    await db.from("confidence_calibration").upsert(
      { confidence_level: level.toUpperCase(), total_trades: total, wins, updated_at: new Date().toISOString() },
      { onConflict: "confidence_level" }
    );
  } catch (err) {
    console.error("[lessons] updateConfidenceCalibration:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Performance par ville et globale
// ---------------------------------------------------------------------------

/**
 * Win rate d'une ville sur les 30 derniers jours (min 5 trades pour être significatif).
 */
export async function getCityPerformance(
  city: string
): Promise<{ winRate: number; trades: number }> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await getClient()
      .from("paper_trades")
      .select("won")
      .eq("city", city)
      .not("won", "is", null)
      .gte("created_at", since);

    if (error || !data || data.length < 5) {
      return { winRate: 0.5, trades: data?.length ?? 0 }; // default 50% si pas assez de données
    }

    const wins = data.filter((t) => t.won).length;
    return { winRate: wins / data.length, trades: data.length };
  } catch {
    return { winRate: 0.5, trades: 0 };
  }
}

/**
 * Performance globale : win rate + P&L des 7 derniers jours.
 */
export async function getOverallPerformance(): Promise<{ winRate: number; pnl7d: number }> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await getClient()
      .from("paper_trades")
      .select("won, potential_pnl")
      .not("won", "is", null)
      .gte("created_at", since);

    if (error || !data || data.length === 0) {
      return { winRate: 0.5, pnl7d: 0 };
    }

    const wins    = data.filter((t) => t.won).length;
    const pnl7d   = data.reduce((s, t) => s + Number(t.potential_pnl ?? 0), 0);
    return {
      winRate: wins / data.length,
      pnl7d:   Math.round(pnl7d * 100) / 100,
    };
  } catch {
    return { winRate: 0.5, pnl7d: 0 };
  }
}
