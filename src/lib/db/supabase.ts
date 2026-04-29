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

export function getClient(): SupabaseClient {
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
  /** true une fois que le post-mortem a été généré pour ce trade. */
  post_mortem_done: boolean | null;
  /** true si ce trade a été exécuté en réel (CLOB Polymarket). false = paper only. */
  is_real: boolean | null;
}

export type SavePaperTradeInput = Omit<
  PaperTradeRow,
  // Champs auto-générés ou remplis à la résolution
  "id" | "created_at" | "actual_result" | "won" | "resolved_at" | "polymarket_outcome" | "outcome_match" | "post_mortem_done" | "is_real"
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
 * Calcule le bankroll courant : initial + P&L net de tous les trades résolus.
 * Plancher = INITIAL_BANKROLL pour ne jamais descendre en dessous.
 */
export async function getCurrentBankroll(): Promise<number> {
  const INITIAL_BANKROLL = 10;
  const db = getClient();

  const { data } = await db
    .from("paper_trades")
    .select("potential_pnl")
    .not("won", "is", null);

  const totalPnL = data?.reduce((sum, t) => sum + (Number(t.potential_pnl) || 0), 0) ?? 0;
  const current  = Math.max(INITIAL_BANKROLL, INITIAL_BANKROLL + totalPnL);

  console.log(
    `[bankroll] Initial: ${INITIAL_BANKROLL}$, Net P&L: ${totalPnL.toFixed(2)}$, Current: ${current.toFixed(2)}$`
  );
  return current;
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

  // Normalise resolution_date en YYYY-MM-DD (tronque toute heure ou timezone éventuelle)
  const resolutionDate =
    typeof input.resolution_date === "string"
      ? input.resolution_date.slice(0, 10)
      : null;

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
        resolution_date:       resolutionDate,
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
 * sold_early=true quand vendu par le Position Manager avant expiration.
 */
export async function resolvePaperTrade(
  id: string,
  data: {
    actual_result:       string;
    won:                 boolean;
    potential_pnl:       number;
    polymarket_outcome?: string | null;
    outcome_match?:      boolean | null;
    sold_early?:         boolean;
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
      sold_early:         data.sold_early         ?? false,
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
// ---------------------------------------------------------------------------
// Verrou de scan (table scan_locks) — anti race-condition
//
// SQL à exécuter une fois dans Supabase :
//   CREATE TABLE IF NOT EXISTS scan_locks (
//     id        TEXT PRIMARY KEY DEFAULT 'scan',
//     locked_at TIMESTAMPTZ,
//     locked_by TEXT
//   );
//   INSERT INTO scan_locks (id) VALUES ('scan') ON CONFLICT DO NOTHING;
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max par scan

/**
 * Essaie d'acquérir le verrou de scan.
 * Retourne true si le verrou est obtenu, false si un scan est déjà en cours.
 * Ignore l'erreur si la table scan_locks n'existe pas encore.
 */
export async function acquireScanLock(): Promise<boolean> {
  const db  = getClient();
  const now = new Date();
  const expiry = new Date(now.getTime() - LOCK_TIMEOUT_MS).toISOString();

  try {
    const { data, error } = await db
      .from("scan_locks")
      .update({
        locked_at: now.toISOString(),
        locked_by: `scan-${now.getTime()}`,
      })
      .eq("id", "scan")
      .or(`locked_at.is.null,locked_at.lt.${expiry}`)
      .select()
      .single();

    if (error) {
      // Table absente ou autre erreur → on laisse passer (best-effort)
      console.warn(`[supabase] acquireScanLock: ${error.message} — proceeding without lock`);
      return true;
    }

    return !!data;
  } catch (err) {
    console.warn(`[supabase] acquireScanLock exception:`, err instanceof Error ? err.message : err);
    return true; // best-effort
  }
}

/**
 * Libère le verrou de scan.
 */
export async function releaseScanLock(): Promise<void> {
  const db = getClient();
  try {
    await db
      .from("scan_locks")
      .update({ locked_at: null, locked_by: null })
      .eq("id", "scan");
  } catch (err) {
    console.warn(`[supabase] releaseScanLock:`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Circuit Breaker — performance des agents sur les dernières 24h
// ---------------------------------------------------------------------------

export interface AgentPerformance {
  trades:  number;
  wins:    number;
  winRate: number; // 0-100
  pnl:     number;
}

// ---------------------------------------------------------------------------
// Shadow Trades — tracking des opportunités détectées en shadow mode
//
// Les shadow trades sont de vrais paper_trades avec is_shadow=true.
// Ils sont résolus par check-results comme les autres, mais ne sont jamais
// considérés comme des positions réelles.
//
// Colonnes requises (à ajouter via Supabase SQL Editor si absentes) :
//   ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS is_shadow BOOLEAN DEFAULT false;
//   ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS hours_to_resolution DECIMAL;
// ---------------------------------------------------------------------------

export interface SaveShadowTradeInput {
  marketId:             string;
  question:             string;
  agent:                "weather" | "finance" | "crypto";
  outcome:              string;
  marketPrice:          number;
  estimatedProbability: number;
  edge:                 number;
  suggestedBet:         number;
  confidence:           string | undefined;
  targetDate?:          string;
  targetDateTime?:      string;
  ticker?:              string;
  city?:                string;
  hoursToResolution:    number;
  marketContext?:       Record<string, unknown>;
}

/**
 * Enregistre un trade shadow dans paper_trades (is_shadow=true).
 * Utilisé par l'orchestrator pour tracer les opportunités détectées
 * par les agents en shadow mode — résolues plus tard par check-results.
 */
export async function saveShadowTrade(input: SaveShadowTradeInput): Promise<void> {
  const db = getClient();

  const { error } = await db.from("paper_trades").insert({
    market_id:             input.marketId,
    question:              input.question,
    agent:                 input.agent,
    outcome:               input.outcome,
    market_price:          input.marketPrice,
    estimated_probability: input.estimatedProbability,
    edge:                  input.edge,
    suggested_bet:         input.suggestedBet,
    confidence:            input.confidence ?? null,
    resolution_date:       input.targetDate ?? null,
    expected_resolution:   input.targetDateTime ?? null,
    ticker:                input.ticker ?? null,
    city:                  input.city ?? null,
    market_context:        input.marketContext ?? null,
    potential_pnl:         null,
    is_shadow:             true,
    hours_to_resolution:   Math.round(input.hoursToResolution * 10) / 10,
  });

  if (error) {
    console.error(`[supabase] saveShadowTrade: ${error.message}`);
  }
}

/**
 * Performances théoriques d'un agent en shadow mode.
 * Lit les N derniers trades shadow (is_shadow=true) résolus depuis paper_trades.
 * Retourne des zéros si aucune donnée — shadow monitoring pas encore actif.
 */
export async function getShadowPerformance(
  agentType: string,
  lastN: number = 20
): Promise<{ trades: number; winRate: number; theoreticalPnl: number }> {
  const db = getClient();

  const { data, error } = await db
    .from("paper_trades")
    .select("won, potential_pnl")
    .eq("agent", agentType)
    .eq("is_shadow", true)
    .not("won", "is", null)
    .order("created_at", { ascending: false })
    .limit(lastN);

  if (error || !data || data.length === 0) {
    return { trades: 0, winRate: 0, theoreticalPnl: 0 };
  }

  const wins = data.filter((r) => r.won === true).length;
  const pnl  = data.reduce((sum, r) => sum + Number(r.potential_pnl ?? 0), 0);

  console.log(`[supabase] getShadowPerformance ${agentType}: ${data.length} trades, WR ${Math.round((wins / data.length) * 100)}%, P&L ${Math.round(pnl * 100) / 100}€`);

  return {
    trades:         data.length,
    winRate:        Math.round((wins / data.length) * 100),
    theoreticalPnl: Math.round(pnl * 100) / 100,
  };
}

export async function getAgentPerformance24h(agentType: string): Promise<AgentPerformance> {
  const db        = getClient();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data } = await db
    .from("paper_trades")
    .select("won, potential_pnl")
    .eq("agent", agentType)
    .gte("created_at", yesterday)
    .not("won", "is", null);

  if (!data || data.length === 0) {
    return { trades: 0, wins: 0, winRate: 100, pnl: 0 };
  }

  const trades  = data.length;
  const wins    = data.filter((t) => t.won).length;
  const pnl     = data.reduce((sum, t) => sum + Number(t.potential_pnl ?? 0), 0);

  return {
    trades,
    wins,
    winRate: Math.round((wins / trades) * 100),
    pnl:     Math.round(pnl * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Post-Mortem
//
// Colonnes requises (à ajouter via Supabase SQL Editor si absentes) :
//   ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS post_mortem_done BOOLEAN DEFAULT false;
// ---------------------------------------------------------------------------

/**
 * Retourne les paper trades résolus (won IS NOT NULL) sans post-mortem généré.
 * Exclut les trades shadow et les trades sans city (non-weather).
 * Limité à `limit` pour éviter de surcharger Claude lors des premiers runs.
 */
export async function getResolvedTradesForPostMortem(
  limit = 20
): Promise<PaperTradeRow[]> {
  const db = getClient();

  const { data, error } = await db
    .from("paper_trades")
    .select("*")
    .not("won", "is", null)
    .or("post_mortem_done.is.null,post_mortem_done.eq.false")
    .eq("agent", "weather")
    .order("resolved_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`[supabase][getResolvedTradesForPostMortem] ${error.message}`);
  return data ?? [];
}

/**
 * Marque un paper trade comme ayant un post-mortem généré.
 */
export async function markPostMortemDone(id: string): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from("paper_trades")
    .update({ post_mortem_done: true })
    .eq("id", id);

  if (error) throw new Error(`[supabase][markPostMortemDone] ${error.message}`);
}

// ---------------------------------------------------------------------------
// Anti-Churn — éviter les positions dupliquées
// ---------------------------------------------------------------------------

/**
 * Vérifie si un paper trade récent existe pour ce marketId.
 * Évite de doubler une position sur le même marché dans la fenêtre donnée.
 */
export async function hasRecentTradeForMarket(
  marketId:  string,
  hoursBack: number = 24
): Promise<boolean> {
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const { data } = await getClient()
    .from("paper_trades")
    .select("id")
    .eq("market_id", marketId)
    .gte("created_at", since)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Vérifie si un paper trade existe pour cette ville + date de résolution.
 * Garantit qu'on n'ouvre qu'une seule position par ville/jour.
 */
export async function hasRecentTradeForCityDate(
  city: string,
  date: string
): Promise<boolean> {
  const { data } = await getClient()
    .from("paper_trades")
    .select("id")
    .ilike("city", city)
    .eq("resolution_date", date)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

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
