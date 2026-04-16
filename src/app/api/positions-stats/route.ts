/**
 * Positions Stats endpoint
 *
 * GET /api/positions-stats
 *
 * Retourne toutes les positions avec stats agrégées et comparaison HOLD vs SELL.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { PositionRow } from "@/lib/db/positions";

// ---------------------------------------------------------------------------
// Client Supabase
// ---------------------------------------------------------------------------

function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase non configuré");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Types de réponse (exportés pour le client)
// ---------------------------------------------------------------------------

export interface PositionStats {
  id: string;
  marketId: string;
  question: string;
  city: string | null;
  ticker: string | null;
  agent: "weather" | "finance" | "crypto";
  outcome: string;
  entryPrice: number;
  currentPrice: number | null;
  entryProbability: number;
  currentProbability: number | null;
  suggestedBet: number;
  status: "open" | "hold" | "sell_signal" | "sold" | "resolved";
  sellReason: string | null;
  sellSignalAt: string | null;
  soldAt: string | null;
  sellPrice: number | null;
  sellPnl: number | null;
  openedAt: string;
  resolutionDate: string | null;
  /** P&L non réalisé au prix courant : (currentPrice - entryPrice) × bet */
  unrealizedPnl: number | null;
  /** P&L si on avait vendu au moment du sell signal (currentPrice à ce moment-là) */
  pnlIfSold: number | null;
}

export interface PositionsStatsResponse {
  fetchedAt: string;
  counts: {
    open: number;
    hold: number;
    sellSignals: number;
    sold: number;
    resolved: number;
    total: number;
  };
  comparison: {
    /** Somme P&L non réalisé de toutes les positions avec sell signal */
    totalPnlHold: number;
    /** Somme P&L si on avait vendu à chaque sell signal */
    totalPnlSell: number;
    difference: number;
    betterStrategy: "SELL" | "HOLD" | "EQUAL";
    signalsCount: number;
  };
  positions: PositionStats[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<PositionsStatsResponse>> {
  const fetchedAt = new Date();

  let rows: PositionRow[] = [];
  try {
    const db = getClient();
    const { data, error } = await db
      .from("positions")
      .select("*")
      .order("opened_at", { ascending: false });

    if (error) throw new Error(error.message);
    rows = (data ?? []) as PositionRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[positions-stats] ✗ fetch positions :", msg);
    return NextResponse.json(
      {
        fetchedAt: fetchedAt.toISOString(),
        counts: { open: 0, hold: 0, sellSignals: 0, sold: 0, resolved: 0, total: 0 },
        comparison: { totalPnlHold: 0, totalPnlSell: 0, difference: 0, betterStrategy: "EQUAL", signalsCount: 0 },
        positions: [],
      },
      { status: 502 }
    );
  }

  // ── Mapper chaque ligne ──────────────────────────────────────────────────
  const positions: PositionStats[] = rows.map((row) => {
    const unrealizedPnl =
      row.current_price !== null
        ? Math.round((row.current_price - row.entry_price) * row.suggested_bet * 100) / 100
        : null;

    // Pour les positions vendues : utiliser sell_pnl stocké en DB
    // Pour les sell_signal en attente : utiliser unrealizedPnl
    const pnlIfSold =
      row.status === "sold"
        ? (row.sell_pnl ?? unrealizedPnl)
        : row.status === "sell_signal"
        ? unrealizedPnl
        : null;

    return {
      id:                 row.id,
      marketId:           row.market_id,
      question:           row.question ?? "",
      city:               row.city,
      ticker:             row.ticker,
      agent:              row.agent,
      outcome:            row.outcome,
      entryPrice:         row.entry_price,
      currentPrice:       row.current_price,
      entryProbability:   row.entry_probability,
      currentProbability: row.current_probability,
      suggestedBet:       row.suggested_bet,
      status:             row.status,
      sellReason:         row.sell_reason,
      sellSignalAt:       row.sell_signal_at,
      soldAt:             row.sold_at,
      sellPrice:          row.sell_price,
      sellPnl:            row.sell_pnl,
      openedAt:           row.opened_at,
      resolutionDate:     row.resolution_date,
      unrealizedPnl,
      pnlIfSold,
    };
  });

  // ── Compteurs ────────────────────────────────────────────────────────────
  const counts = {
    open:        positions.filter((p) => p.status === "open").length,
    hold:        positions.filter((p) => p.status === "hold").length,
    sellSignals: positions.filter((p) => p.status === "sell_signal").length,
    sold:        positions.filter((p) => p.status === "sold").length,
    resolved:    positions.filter((p) => p.status === "resolved").length,
    total:       positions.length,
  };

  // ── Comparaison HOLD vs SELL (sur positions vendues ou avec sell signal) ─
  //
  // SELL strategy : P&L réel au moment de la vente (sell_pnl stocké en DB).
  // HOLD strategy : P&L au prix courant (unrealizedPnl — ce qu'on aurait aujourd'hui).
  // La différence est significative : si on a vendu à 0.25 et le marché monte à 0.70,
  // HOLD gagne plus ; si le marché chute à 0.05, SELL a eu raison.
  const signalPositions = positions.filter(
    (p) => p.status === "sell_signal" || p.status === "sold"
  );

  // P&L SELL = somme des sell_pnl réels (positions sold) + unrealizedPnl (sell_signal en attente)
  const totalPnlSell = Math.round(
    signalPositions.reduce((sum, p) => sum + (p.pnlIfSold ?? 0), 0) * 100
  ) / 100;

  // P&L HOLD = ce que vaudrait chaque position aujourd'hui si on n'avait pas vendu
  const totalPnlHold = Math.round(
    signalPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0) * 100
  ) / 100;

  const difference = Math.round((totalPnlSell - totalPnlHold) * 100) / 100;
  const betterStrategy: "SELL" | "HOLD" | "EQUAL" =
    difference > 0.01 ? "SELL" : difference < -0.01 ? "HOLD" : "EQUAL";

  return NextResponse.json({
    fetchedAt: fetchedAt.toISOString(),
    counts,
    comparison: {
      totalPnlHold,
      totalPnlSell,
      difference,
      betterStrategy,
      signalsCount: signalPositions.length,
    },
    positions,
  });
}
