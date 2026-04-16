/**
 * Client Supabase + fonctions d'accès aux données
 *
 * Le client est initialisé en singleton avec SERVICE_ROLE_KEY pour bypasser
 * les RLS — ce fichier ne doit jamais être importé côté client (browser).
 * Toutes les fonctions sont async et retournent les données insérées/lues.
 *
 * Variables d'environnement requises :
 *   NEXT_PUBLIC_SUPABASE_URL    — URL du projet Supabase
 *   SUPABASE_SERVICE_ROLE_KEY   — clé service (accès complet, serveur uniquement)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase non configuré. Vérifiez NEXT_PUBLIC_SUPABASE_URL et " +
        "SUPABASE_SERVICE_ROLE_KEY dans .env.local"
    );
  }

  _client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return _client;
}

// ---------------------------------------------------------------------------
// Types reflétant le schéma SQL
// ---------------------------------------------------------------------------

export type OpportunityStatus = "detected" | "bet_placed" | "won" | "lost" | "skipped";
export type BetStatus = "pending" | "won" | "lost";

export interface OpportunityRow {
  id: string;
  market_id: string;
  question: string | null;
  city: string | null;
  station_code: string | null;
  outcome: string;
  market_price: number;
  estimated_probability: number;
  edge: number;
  multiplier: number;
  detected_at: string;
  status: OpportunityStatus;
  /** Température réelle observée (°C), remplie par check-results. */
  actual_result: number | null;
  /** P&L en USDC, rempli par check-results. */
  pnl: number | null;
}

export interface BetRow {
  id: string;
  opportunity_id: string | null;
  amount: number;
  entry_price: number;
  placed_at: string;
  resolved_at: string | null;
  result_price: number | null;
  pnl: number | null;
  status: BetStatus;
}

export interface DailyStatsRow {
  id: string;
  date: string;
  opportunities_detected: number;
  bets_placed: number;
  wins: number;
  losses: number;
  total_pnl: number;
}

// ---------------------------------------------------------------------------
// Types d'input (sans les champs auto-générés)
// ---------------------------------------------------------------------------

export type SaveOpportunityInput = Omit<
  OpportunityRow,
  "id" | "detected_at" | "status" | "actual_result" | "pnl"
>;

export interface PaperTradeRow {
  id: string;
  market_id: string;
  question: string | null;
  city: string | null;
  ticker: string | null;
  agent: "weather" | "finance" | "crypto";
  outcome: string;
  market_price: number;
  estimated_probability: number;
  edge: number;
  suggested_bet: number;
  confidence: string | null;
  created_at: string;
  resolution_date: string | null;
  actual_result: string | null;
  won: boolean | null;
  potential_pnl: number | null;
  resolved_at: string | null;
  /** Contexte du marché au moment du bet (liquidité, spread, outcomes…) — pour post-mortem. */
  market_context: Record<string, unknown> | null;
  /** Date+heure exacte de résolution prévue (UTC) — pour détecter les délais UMA. */
  expected_resolution: string | null;
  /** Outcome officiel retourné par Polymarket après résolution (ex: "Yes", "Above 68"). */
  polymarket_outcome: string | null;
  /** true si notre prédiction correspond à l'outcome officiel Polymarket. */
  outcome_match: boolean | null;
}

export type SavePaperTradeInput = Omit<
  PaperTradeRow,
  // Champs auto-générés ou remplis à la résolution
  "id" | "created_at" | "actual_result" | "won" | "resolved_at" | "polymarket_outcome" | "outcome_match"
>;

export type SaveBetInput = {
  opportunity_id: string;
  amount: number;
  entry_price: number;
};

export type UpdateBetResultInput = {
  resolved_at: string;
  result_price: number;
  pnl: number;
  status: "won" | "lost";
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lance une requête Supabase et throw si elle retourne une erreur. */
async function execute<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`[supabase][${label}] ${error.message}`);
  if (data === null) throw new Error(`[supabase][${label}] réponse vide inattendue`);
  return data;
}

// ---------------------------------------------------------------------------
// Fonctions publiques
// ---------------------------------------------------------------------------

/**
 * Persiste une opportunité détectée.
 * Retourne la ligne insérée (avec son UUID et detected_at générés par la DB).
 */
export async function saveOpportunity(
  input: SaveOpportunityInput
): Promise<OpportunityRow> {
  const db = getClient();
  return execute<OpportunityRow>(
    "saveOpportunity",
    db
      .from("opportunities")
      .insert({
        market_id:             input.market_id,
        question:              input.question,
        city:                  input.city,
        station_code:          input.station_code,
        outcome:               input.outcome,
        market_price:          input.market_price,
        estimated_probability: input.estimated_probability,
        edge:                  input.edge,
        multiplier:            input.multiplier,
      })
      .select()
      .single()
  );
}

/**
 * Enregistre un nouveau bet associé à une opportunité.
 * Met également à jour le statut de l'opportunité à "bet_placed".
 * Retourne la ligne bet insérée.
 */
export async function saveBet(input: SaveBetInput): Promise<BetRow> {
  const db = getClient();

  const bet = await execute<BetRow>(
    "saveBet",
    db
      .from("bets")
      .insert({
        opportunity_id: input.opportunity_id,
        amount:         input.amount,
        entry_price:    input.entry_price,
      })
      .select()
      .single()
  );

  // Mise à jour du statut de l'opportunité en parallèle (best-effort)
  db.from("opportunities")
    .update({ status: "bet_placed" })
    .eq("id", input.opportunity_id)
    .then(({ error }) => {
      if (error) {
        console.error(
          `[supabase] Impossible de mettre à jour le statut de l'opportunité ${input.opportunity_id} :`,
          error.message
        );
      }
    });

  return bet;
}

/**
 * Met à jour un bet résolu avec le prix final et le P&L.
 * Met également à jour le statut de l'opportunité liée (won / lost).
 * Retourne la ligne bet mise à jour.
 */
export async function updateBetResult(
  betId: string,
  input: UpdateBetResultInput
): Promise<BetRow> {
  const db = getClient();

  const updated = await execute<BetRow>(
    "updateBetResult",
    db
      .from("bets")
      .update({
        resolved_at:  input.resolved_at,
        result_price: input.result_price,
        pnl:          input.pnl,
        status:       input.status,
      })
      .eq("id", betId)
      .select()
      .single()
  );

  // Propager le résultat sur l'opportunité associée (best-effort)
  if (updated.opportunity_id) {
    db.from("opportunities")
      .update({ status: input.status })
      .eq("id", updated.opportunity_id)
      .then(({ error }) => {
        if (error) {
          console.error(
            `[supabase] Impossible de propager le résultat sur l'opportunité :`,
            error.message
          );
        }
      });
  }

  return updated;
}

/**
 * Retourne les opportunités détectées au cours des dernières `hours` heures.
 * Utilisé par scan-markets pour dédupliquer avant d'insérer.
 */
export async function getRecentOpportunities(hours = 24): Promise<OpportunityRow[]> {
  const db = getClient();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("opportunities")
    .select("*")
    .gte("detected_at", since)
    .order("detected_at", { ascending: false });

  if (error) throw new Error(`[supabase][getRecentOpportunities] ${error.message}`);
  return data ?? [];
}

/**
 * Met à jour le statut d'une opportunité.
 * Utilisé par l'orchestrateur (bet_placed) et check-results (won / lost).
 */
export async function updateOpportunityStatus(
  id: string,
  status: OpportunityStatus
): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from("opportunities")
    .update({ status })
    .eq("id", id);

  if (error) {
    throw new Error(`[supabase][updateOpportunityStatus] ${error.message}`);
  }
}

/**
 * Retourne les statistiques agrégées pour une date donnée (défaut : aujourd'hui).
 * Retourne null si aucune ligne n'existe encore pour cette date.
 */
export async function getDailyStats(
  date?: string
): Promise<DailyStatsRow | null> {
  const db = getClient();
  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await db
    .from("daily_stats")
    .select("*")
    .eq("date", targetDate)
    .maybeSingle();

  if (error) throw new Error(`[supabase][getDailyStats] ${error.message}`);
  return data;
}

/**
 * Retourne les opportunités "detected" dont la date de détection est antérieure
 * à aujourd'hui — i.e. le marché devrait être résolu.
 * Utilisé par check-results pour récupérer les opportunités à vérifier.
 */
export async function getPendingOpportunities(): Promise<OpportunityRow[]> {
  const db = getClient();
  const todayUtc = new Date().toISOString().split("T")[0] + "T00:00:00.000Z";

  const { data, error } = await db
    .from("opportunities")
    .select("*")
    .eq("status", "detected")
    .lt("detected_at", todayUtc)
    .order("detected_at", { ascending: true });

  if (error) throw new Error(`[supabase][getPendingOpportunities] ${error.message}`);
  return data ?? [];
}

/**
 * Résout une opportunité après vérification du résultat réel.
 * Met à jour status, actual_result et pnl en une seule requête.
 */
export async function updateOpportunityResult(
  id: string,
  result: {
    status: "won" | "lost";
    actual_result: number;
    pnl: number;
  }
): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from("opportunities")
    .update({
      status:        result.status,
      actual_result: result.actual_result,
      pnl:           result.pnl,
    })
    .eq("id", id);

  if (error) throw new Error(`[supabase][updateOpportunityResult] ${error.message}`);
}

/**
 * Met à jour les compteurs de résultats dans daily_stats.
 * Upsert idempotent : crée la ligne si elle n'existe pas.
 */
export async function updateDailyResultStats(
  date: string,
  wins: number,
  losses: number,
  pnl: number
): Promise<void> {
  const db = getClient();
  const { error } = await db.rpc("update_daily_result_stats", {
    p_date:   date,
    p_wins:   wins,
    p_losses: losses,
    p_pnl:    pnl,
  });

  if (error) {
    // Fallback : upsert manuel si la RPC n'existe pas
    console.warn(`[supabase] RPC update_daily_result_stats indisponible, fallback : ${error.message}`);
    await db.from("daily_stats").upsert(
      { date, wins, losses, total_pnl: pnl },
      { onConflict: "date", ignoreDuplicates: false }
    );
  }
}

// ---------------------------------------------------------------------------
// Paper Trades
// ---------------------------------------------------------------------------

/**
 * Persiste un paper trade (bet virtuel).
 * Retourne la ligne insérée avec son UUID généré par la DB.
 */
export async function savePaperTrade(
  input: SavePaperTradeInput
): Promise<PaperTradeRow> {
  const db = getClient();
  return execute<PaperTradeRow>(
    "savePaperTrade",
    db
      .from("paper_trades")
      .insert({
        market_id:             input.market_id,
        question:              input.question,
        city:                  input.city,
        ticker:                input.ticker,
        agent:                 input.agent,
        outcome:               input.outcome,
        market_price:          input.market_price,
        estimated_probability: input.estimated_probability,
        edge:                  input.edge,
        suggested_bet:         input.suggested_bet,
        confidence:            input.confidence,
        resolution_date:       input.resolution_date,
        potential_pnl:         input.potential_pnl,
        market_context:        input.market_context ?? null,
        expected_resolution:   input.expected_resolution ?? null,
      })
      .select()
      .single()
  );
}

/**
 * Retourne les paper trades créés dans les derniers `days` jours.
 * Passer `null` pour récupérer tous les trades sans filtre de date.
 * Triés par created_at décroissant (les plus récents en premier).
 */
export async function getPaperTrades(days: number | null = 7): Promise<PaperTradeRow[]> {
  const db = getClient();

  let query = db
    .from("paper_trades")
    .select("*")
    .order("created_at", { ascending: false });

  if (days !== null) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", since);
  }

  const { data, error } = await query;
  if (error) throw new Error(`[supabase][getPaperTrades] ${error.message}`);
  return data ?? [];
}

/**
 * Retourne les paper trades non résolus (won IS NULL) dont la resolution_date
 * est passée (< aujourd'hui). Utilisé par check-results.
 */
export async function getPendingPaperTrades(): Promise<PaperTradeRow[]> {
  const db = getClient();
  const today = new Date().toISOString().split("T")[0];

  // Exclut les paper trades déjà vendus via monitor-positions (actual_result = 'sold')
  const { data, error } = await db
    .from("paper_trades")
    .select("*")
    .is("won", null)
    .lt("resolution_date", today)
    .neq("actual_result", "sold")
    .order("resolution_date", { ascending: true });

  if (error) throw new Error(`[supabase][getPendingPaperTrades] ${error.message}`);
  return data ?? [];
}

/**
 * Résout un paper trade après vérification du résultat réel.
 * Met à jour actual_result, won, potential_pnl, resolved_at,
 * et optionnellement polymarket_outcome + outcome_match pour audit.
 */
export async function resolvePaperTrade(
  id: string,
  data: {
    actual_result:       string;
    won:                 boolean;
    potential_pnl:       number;
    polymarket_outcome?: string | null;
    outcome_match?:      boolean | null;
  }
): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from("paper_trades")
    .update({
      actual_result:      data.actual_result,
      won:                data.won,
      potential_pnl:      data.potential_pnl,
      resolved_at:        new Date().toISOString(),
      polymarket_outcome: data.polymarket_outcome ?? null,
      outcome_match:      data.outcome_match      ?? null,
    })
    .eq("id", id);

  if (error) throw new Error(`[supabase][resolvePaperTrade] ${error.message}`);
}

// ---------------------------------------------------------------------------
// Daily Stats
// ---------------------------------------------------------------------------

/**
 * Incrémente les compteurs de la ligne daily_stats du jour.
 * Crée la ligne si elle n'existe pas encore (upsert idempotent).
 * Utilisé en interne par le cron scan-markets.
 */
export async function incrementDailyOpportunities(
  count: number,
  date?: string
): Promise<void> {
  const db = getClient();
  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  // Upsert : crée la ligne si absente, incrémente sinon via RPC
  const { error } = await db.rpc("increment_daily_opportunities", {
    p_date:  targetDate,
    p_count: count,
  });

  if (error) {
    // La RPC n'existe peut-être pas encore — fallback manuel
    console.warn(
      `[supabase] RPC increment_daily_opportunities indisponible, fallback upsert : ${error.message}`
    );
    await db.from("daily_stats").upsert(
      { date: targetDate, opportunities_detected: count },
      {
        onConflict: "date",
        ignoreDuplicates: false,
      }
    );
  }
}
