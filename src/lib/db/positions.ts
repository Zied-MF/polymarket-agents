/**
 * Couche d'accès aux données — table `positions`
 *
 * Crée cette table dans Supabase avant d'utiliser ce module :
 *
 *   CREATE TABLE positions (
 *     id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
 *     paper_trade_id      uuid REFERENCES paper_trades(id) ON DELETE SET NULL,
 *     market_id           text NOT NULL,
 *     question            text,
 *     city                text,
 *     ticker              text,
 *     agent               text NOT NULL CHECK (agent IN ('weather', 'finance', 'crypto')),
 *     outcome             text NOT NULL,
 *     entry_price         numeric NOT NULL,
 *     entry_probability   numeric NOT NULL,
 *     current_price       numeric,
 *     current_probability numeric,
 *     suggested_bet       numeric NOT NULL,
 *     status              text NOT NULL DEFAULT 'open'
 *                           CHECK (status IN ('open', 'hold', 'sell_signal', 'sold', 'resolved')),
 *     sell_reason         text,
 *     sell_signal_at      timestamptz,
 *     sold_at             timestamptz,
 *     sell_price          numeric,
 *     sell_pnl            numeric,
 *     opened_at           timestamptz DEFAULT now(),
 *     resolution_date     date
 *   );
 *
 *   -- Colonnes ajoutées après coup (si la table existe déjà) :
 *   ALTER TABLE positions ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ;
 *   ALTER TABLE positions ADD COLUMN IF NOT EXISTS sell_price DECIMAL;
 *   ALTER TABLE positions ADD COLUMN IF NOT EXISTS sell_pnl DECIMAL;
 *
 *   CREATE INDEX positions_status_idx ON positions(status);
 *   CREATE INDEX positions_market_id_idx ON positions(market_id);
 *
 *   -- Colonnes real trading (à ajouter si la table existe déjà) :
 *   ALTER TABLE positions    ADD COLUMN IF NOT EXISTS is_real        BOOLEAN DEFAULT false;
 *   ALTER TABLE positions    ADD COLUMN IF NOT EXISTS clob_order_id  TEXT;
 *   ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS is_real        BOOLEAN DEFAULT false;
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Position } from "@/lib/positions/position-manager";

// ---------------------------------------------------------------------------
// Singleton client (réutilise les mêmes variables d'env que supabase.ts)
// ---------------------------------------------------------------------------

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase non configuré");
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

async function execute<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`[positions][${label}] ${error.message}`);
  if (data === null) throw new Error(`[positions][${label}] réponse vide inattendue`);
  return data;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ligne brute telle que stockée en DB (snake_case). */
export interface PositionRow {
  id: string;
  paper_trade_id: string | null;
  market_id: string;
  question: string | null;
  city: string | null;
  ticker: string | null;
  agent: "weather" | "finance" | "crypto";
  outcome: string;
  entry_price: number;
  entry_probability: number;
  current_price: number | null;
  current_probability: number | null;
  suggested_bet: number;
  status: "open" | "hold" | "sell_signal" | "sold" | "resolved";
  sell_reason: string | null;
  sell_signal_at: string | null;
  sold_at: string | null;
  sell_price: number | null;
  sell_pnl: number | null;
  opened_at: string;
  resolution_date: string | null;
  /** true si la position a été placée en réel sur le CLOB Polymarket. */
  is_real: boolean | null;
  /** Order ID CLOB — permet d'annuler l'ordre lors d'un sell réel. */
  clob_order_id: string | null;
  /** Peak P&L % observé depuis entrée — trailing stop Layer 5. */
  peak_pnl_percent: number | null;
}

export type OpenPositionInput = {
  paperTradeId: string | null;
  marketId: string;
  question: string | null;
  city: string | null;
  ticker: string | null;
  agent: "weather" | "finance" | "crypto";
  outcome: string;
  entryPrice: number;
  entryProbability: number;
  suggestedBet: number;
  resolutionDate: string | null;
};

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function rowToPosition(row: PositionRow): Position {
  return {
    id:                  row.id,
    paperTradeId:        row.paper_trade_id ?? "",
    marketId:            row.market_id,
    question:            row.question ?? "",
    city:                row.city,
    ticker:              row.ticker,
    agent:               row.agent,
    outcome:             row.outcome,
    entryPrice:          row.entry_price,
    entryProbability:    row.entry_probability,
    currentPrice:        row.current_price,
    currentProbability:  row.current_probability,
    suggestedBet:        row.suggested_bet,
    status:              row.status,
    sellReason:          row.sell_reason,
    openedAt:            new Date(row.opened_at),
    resolutionDate:      row.resolution_date ? new Date(row.resolution_date) : null,
    isReal:              row.is_real,
    clobOrderId:         row.clob_order_id,
    peakPnlPercent:      row.peak_pnl_percent,
  };
}

// ---------------------------------------------------------------------------
// Fonctions publiques
// ---------------------------------------------------------------------------

/**
 * Ouvre une nouvelle position (INSERT).
 * Retourne la position créée avec son UUID généré par la DB.
 */
export async function openPosition(input: OpenPositionInput): Promise<Position> {
  const db = getClient();
  const row = await execute<PositionRow>(
    "openPosition",
    db
      .from("positions")
      .insert({
        paper_trade_id:    input.paperTradeId,
        market_id:         input.marketId,
        question:          input.question,
        city:              input.city,
        ticker:            input.ticker,
        agent:             input.agent,
        outcome:           input.outcome,
        entry_price:       input.entryPrice,
        entry_probability: input.entryProbability,
        suggested_bet:     input.suggestedBet,
        resolution_date:   input.resolutionDate,
      })
      .select()
      .single()
  );
  return rowToPosition(row);
}

/**
 * Retourne toutes les positions ouvertes (status = 'open' ou 'hold').
 * Triées par opened_at décroissant.
 */
export async function getOpenPositions(): Promise<Position[]> {
  const db = getClient();
  const { data, error } = await db
    .from("positions")
    .select("*")
    .in("status", ["open", "hold"])
    .order("opened_at", { ascending: false });

  if (error) throw new Error(`[positions][getOpenPositions] ${error.message}`);
  return (data ?? []).map(rowToPosition);
}

/**
 * Met à jour les champs d'une position (prix courant, statut, etc.).
 */
export async function updatePosition(
  id: string,
  data: Partial<{
    currentPrice: number;
    currentProbability: number;
    status: Position["status"];
    sellReason: string;
    peakPnlPercent: number;
  }>
): Promise<void> {
  const db = getClient();
  const patch: Record<string, unknown> = {};
  if (data.currentPrice       !== undefined) patch.current_price       = data.currentPrice;
  if (data.currentProbability !== undefined) patch.current_probability = data.currentProbability;
  if (data.status             !== undefined) patch.status              = data.status;
  if (data.sellReason         !== undefined) patch.sell_reason         = data.sellReason;
  if (data.peakPnlPercent     !== undefined) patch.peak_pnl_percent    = data.peakPnlPercent;

  const { error } = await db.from("positions").update(patch).eq("id", id);
  if (error) throw new Error(`[positions][updatePosition] ${error.message}`);
}

/**
 * Enregistre un sell signal sur une position :
 * met à jour status = 'sell_signal', sell_reason et sell_signal_at.
 */
export async function recordSellSignal(
  id: string,
  reason: string,
  currentPrice: number,
  currentProbability: number
): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from("positions")
    .update({
      status:              "sell_signal",
      sell_reason:         reason,
      sell_signal_at:      new Date().toISOString(),
      current_price:       currentPrice,
      current_probability: currentProbability,
    })
    .eq("id", id);

  if (error) throw new Error(`[positions][recordSellSignal] ${error.message}`);
}

/**
 * Exécute la vente simulée d'une position (status → 'sold').
 * Calcule et persiste le P&L de vente.
 * Retourne le sellPnl calculé.
 */
export async function executeSell(
  id: string,
  sellPrice: number,
  entryPrice: number,
  suggestedBet: number,
  reason: string
): Promise<number> {
  // P&L de vente simulée : gain/perte proportionnel au mouvement de prix
  // (sellPrice - entryPrice) / entryPrice × suggestedBet
  // Ex: entrée 0.40, sortie 0.60, bet 1 USDC → +0.50 USDC
  const sellPnl = Math.round(((sellPrice - entryPrice) / entryPrice) * suggestedBet * 100) / 100;
  const now     = new Date().toISOString();

  const db = getClient();
  const { error } = await db
    .from("positions")
    .update({
      status:              "sold",
      sell_reason:         reason,
      sell_signal_at:      now,
      sold_at:             now,
      sell_price:          sellPrice,
      sell_pnl:            sellPnl,
      current_price:       sellPrice,
      current_probability: sellPrice,
    })
    .eq("id", id);

  if (error) throw new Error(`[positions][executeSell] ${error.message}`);
  return sellPnl;
}

/**
 * Marque le paper_trade associé à une position vendue comme résolu (résolution manuelle).
 * Cela empêche check-results de tenter de le résoudre via l'archive météo.
 */
export async function markPaperTradeSold(paperTradeId: string, sellPnl: number): Promise<void> {
  if (!paperTradeId) return;
  const db = getClient();
  const { error } = await db
    .from("paper_trades")
    .update({
      actual_result: "sold",
      won:           sellPnl >= 0,
      potential_pnl: sellPnl,
      resolved_at:   new Date().toISOString(),
    })
    .eq("id", paperTradeId);

  if (error) throw new Error(`[positions][markPaperTradeSold] ${error.message}`);
}

/**
 * Retourne la position associée à un paper trade donné.
 * Retourne null si introuvable ou en cas d'erreur (best-effort).
 */
export async function getPositionByPaperTradeId(paperTradeId: string): Promise<PositionRow | null> {
  const db = getClient();
  const { data, error } = await db
    .from("positions")
    .select("*")
    .eq("paper_trade_id", paperTradeId)
    .single();

  if (error) return null;
  return data as PositionRow;
}
