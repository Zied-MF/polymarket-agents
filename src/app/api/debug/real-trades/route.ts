/**
 * GET /api/debug/real-trades
 *
 * Forensic endpoint — liste tous les trades réels depuis l'activation du bot.
 * Répond à : "où sont passés mes $X ?"
 *
 * Retourne :
 *   - Tous les paper_trades avec is_real=true (trade tenté en réel)
 *   - Toutes les positions avec is_real=true (position ouverte + clob_order_id)
 *   - Balance pUSD actuelle
 *   - Schéma détecté (colonnes is_real / clob_order_id présentes ?)
 */

import { NextResponse }        from "next/server";
import { getClient }           from "@/lib/db/supabase";
import { getAccountBalance }   from "@/lib/polymarket/clob-api";

export async function GET() {
  const db = getClient();

  // ── 1. Tous les paper_trades is_real=true ──────────────────────────────────
  const { data: realTrades, error: tradesErr } = await db
    .from("paper_trades")
    .select("id, created_at, question, city, outcome, market_price, suggested_bet, won, potential_pnl, is_real")
    .eq("is_real", true)
    .order("created_at", { ascending: false });

  // ── 2. Toutes les positions is_real=true ───────────────────────────────────
  const { data: realPositions, error: posErr } = await db
    .from("positions")
    .select("id, created_at, market_id, question, outcome, entry_price, suggested_bet, is_real, clob_order_id, sold_at, sell_pnl, status")
    .eq("is_real", true)
    .order("created_at", { ascending: false });

  // ── 3. Derniers paper_trades (all) pour détecter les tentatives sans is_real ─
  const { data: recentAll, error: recentErr } = await db
    .from("paper_trades")
    .select("id, created_at, question, outcome, suggested_bet, is_real")
    .order("created_at", { ascending: false })
    .limit(10);

  // ── 4. Vérification colonnes schéma ───────────────────────────────────────
  const schemaCheck = {
    paper_trades_is_real:    !tradesErr || !tradesErr.message.includes("is_real"),
    positions_is_real:       !posErr    || !posErr.message.includes("is_real"),
    positions_clob_order_id: !posErr    || !posErr.message.includes("clob_order_id"),
    trades_error:            tradesErr?.message ?? null,
    positions_error:         posErr?.message    ?? null,
  };

  // ── 5. Balance pUSD actuelle ───────────────────────────────────────────────
  const balancePUsd = await getAccountBalance().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

  // ── 6. Summary ────────────────────────────────────────────────────────────
  const totalBetReal    = (realTrades ?? []).reduce((s, t) => s + Number(t.suggested_bet ?? 0), 0);
  const totalPnlReal    = (realTrades ?? []).reduce((s, t) => s + Number(t.potential_pnl ?? 0), 0);

  const summary = {
    realTradesCount:    realTrades?.length  ?? 0,
    realPositionsCount: realPositions?.length ?? 0,
    totalBetReal:       Math.round(totalBetReal  * 100) / 100,
    totalPnlReal:       Math.round(totalPnlReal  * 100) / 100,
    balancePUsd,
    schemaCheck,
  };

  return NextResponse.json({
    summary,
    realTrades:     realTrades    ?? [],
    realPositions:  realPositions ?? [],
    recentAll:      recentAll     ?? [],
    errors: {
      trades:   tradesErr?.message ?? null,
      positions: posErr?.message  ?? null,
      recent:    recentErr?.message ?? null,
    },
  });
}
