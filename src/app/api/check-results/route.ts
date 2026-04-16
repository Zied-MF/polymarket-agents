/**
 * Check-results endpoint — résolution des paper trades passés
 *
 * GET /api/check-results
 *
 * Pipeline :
 *   1. Récupère les paper trades weather non résolus dont resolution_date < aujourd'hui
 *      (exclut les trades déjà vendus via monitor-positions)
 *   2. Pour chaque, fetch la température réelle via Open-Meteo Archive API
 *   3. Compare avec l'outcome prédit → WIN ou LOSS
 *   4. Met à jour Supabase (actual_result, won, potential_pnl, resolved_at)
 *   5. Envoie un résumé Discord
 *   6. Retourne le rapport complet
 *
 * P&L calculé avec le bet HISTORIQUE (trade.suggested_bet), pas recalculé avec Kelly
 */

import { NextResponse }                  from "next/server";
import { STATION_MAPPING }               from "@/lib/data/station-mapping";
import { getCoordinates }               from "@/lib/data-sources/geocoding";
import {
  getPendingPaperTrades,
  resolvePaperTrade,
  type PaperTradeRow,
}                                        from "@/lib/db/supabase";
import { getPositionByPaperTradeId }    from "@/lib/db/positions";
import { sendResultsSummary, type ResultDetail } from "@/lib/utils/discord";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";

// ---------------------------------------------------------------------------
// Types de réponse
// ---------------------------------------------------------------------------

interface PaperTradeResolved {
  id: string;
  agent: string;
  outcome: string;
  actualResult: string;
  won: boolean;
  pnl: number;
}

interface CheckSummary {
  checkedAt: string;
  paper_trades_resolved: number;
  paper_trades_wins: number;
  paper_trades_losses: number;
  paper_trades_pnl: number;
  details: PaperTradeResolved[];
  errors: { id: string; question: string | null; error: string }[];
}

// ---------------------------------------------------------------------------
// Helpers — parsing de la question
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Extrait la date cible depuis la question Polymarket.
 * Exemples :
 *   "Highest temperature in NYC on April 14?" → "2026-04-14"
 *   "Will the low temp in Chicago on April 15 be below 50°F?" → "2026-04-15"
 * Fallback : lendemain de created_at.
 */
function parseDateFromQuestion(question: string, createdAt: string): string {
  const m = question.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i
  );
  if (m) {
    const month   = MONTHS[m[1].toLowerCase()];
    const day     = parseInt(m[2], 10);
    const detYear = new Date(createdAt).getUTCFullYear();
    const date    = new Date(Date.UTC(detYear, month, day));
    return date.toISOString().split("T")[0];
  }
  const det = new Date(createdAt);
  det.setUTCDate(det.getUTCDate() + 1);
  return det.toISOString().split("T")[0];
}

/**
 * Détecte l'unité depuis la chaîne outcome.
 * Par défaut °F (majoritaire sur Polymarket US).
 */
function detectUnit(outcome: string): "F" | "C" {
  if (/°\s*C|celsius/i.test(outcome)) return "C";
  return "F";
}

// ---------------------------------------------------------------------------
// Helpers — température réelle (Open-Meteo Archive)
// ---------------------------------------------------------------------------

interface ArchiveResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
  };
}

/**
 * Récupère la température max/min observée pour une station/ville et une date.
 * Utilise Open-Meteo Archive (ERA5 — données réelles, délai ~5 jours).
 *
 * Résolution des coordonnées :
 *   1. STATION_MAPPING (lookup immédiat)
 *   2. getCoordinates() — geocoding avec cache (mémoire + Supabase + API)
 *
 * @returns { highC, lowC } en °Celsius
 */
async function fetchActualTemperature(
  stationCode: string,
  dateStr: string
): Promise<{ highC: number; lowC: number }> {
  let lat: number;
  let lon: number;

  const station = STATION_MAPPING[stationCode];
  if (station) {
    lat = station.lat;
    lon = station.lon;
  } else {
    const geo = await getCoordinates(stationCode);
    if (!geo) throw new Error(`Station/ville inconnue : "${stationCode}"`);
    lat = geo.lat;
    lon = geo.lon;
  }

  const url = new URL(ARCHIVE_BASE);
  url.searchParams.set("latitude",   String(lat));
  url.searchParams.set("longitude",  String(lon));
  url.searchParams.set("start_date", dateStr);
  url.searchParams.set("end_date",   dateStr);
  url.searchParams.set("daily",      "temperature_2m_max,temperature_2m_min");
  url.searchParams.set("timezone",   "UTC");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Open-Meteo Archive HTTP ${res.status}: ${await res.text()}`);
  }

  const data: ArchiveResponse = await res.json();
  const times = data.daily?.time ?? [];
  const idx   = times.indexOf(dateStr);

  if (idx === -1) {
    throw new Error(
      `Pas de données pour ${dateStr} à ${stationCode}. ` +
      `Dates disponibles : ${times.join(", ") || "(aucune)"}`
    );
  }

  const highC = data.daily?.temperature_2m_max?.[idx];
  const lowC  = data.daily?.temperature_2m_min?.[idx];

  if (highC == null || lowC == null) {
    throw new Error(`Données manquantes pour ${dateStr} à ${stationCode}`);
  }

  return { highC, lowC };
}

// ---------------------------------------------------------------------------
// Helpers — résolution WIN / LOSS
// ---------------------------------------------------------------------------

/**
 * Sélectionne la température pertinente (high ou low) et la convertit si besoin.
 * "low"/"minimum" dans l'outcome → lowC, sinon → highC.
 */
function selectTemp(
  outcome: string,
  highC: number,
  lowC: number,
  unit: "F" | "C"
): number {
  const isLow = /\blow(est)?\b|minimum/i.test(outcome);
  const tempC = isLow ? lowC : highC;
  return unit === "F" ? tempC * 9 / 5 + 32 : tempC;
}

/**
 * Détermine WIN ou LOSS.
 *
 * Formats d'outcome supportés :
 *   "Above 68"  / "Above 68°F"
 *   "Below 68"  / "Below 68°F"
 *   "65 - 69"   / "65-69°F"
 *   "Yes" / "No"  (déduit le sens depuis la question)
 */
function resolveOutcome(
  outcome: string,
  actual: number,
  question: string
): "WIN" | "LOSS" {
  const o = outcome.toLowerCase().trim();

  const aboveM = o.match(/above\s+([\d.]+)/);
  if (aboveM) return actual > parseFloat(aboveM[1]) ? "WIN" : "LOSS";

  const belowM = o.match(/below\s+([\d.]+)/);
  if (belowM) return actual < parseFloat(belowM[1]) ? "WIN" : "LOSS";

  const rangeM = o.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
  if (rangeM) {
    const lo = parseFloat(rangeM[1]);
    const hi = parseFloat(rangeM[2]);
    return actual >= lo && actual <= hi ? "WIN" : "LOSS";
  }

  if (o === "yes" || o === "no") {
    const q      = question.toLowerCase();
    const numM   = q.match(/([\d.]+)/);
    const thresh = numM ? parseFloat(numM[1]) : null;
    let base: "WIN" | "LOSS";
    if (thresh !== null && /above|high(est)?/i.test(q)) {
      base = actual > thresh ? "WIN" : "LOSS";
    } else if (thresh !== null && /below|low(est)?/i.test(q)) {
      base = actual < thresh ? "WIN" : "LOSS";
    } else {
      console.warn(`[check-results] Impossible de résoudre Yes/No sans seuil dans "${question}"`);
      return "LOSS";
    }
    return o === "yes" ? base : (base === "WIN" ? "LOSS" : "WIN");
  }

  console.warn(`[check-results] Format d'outcome non reconnu : "${outcome}" — LOSS par défaut`);
  return "LOSS";
}

// ---------------------------------------------------------------------------
// Helpers — résultat officiel Polymarket
// ---------------------------------------------------------------------------

/**
 * Fetch le résultat officiel d'un marché résolu via la Gamma API.
 * Retourne le libellé de l'outcome gagnant, ou null si le marché n'est pas
 * encore résolu ou si l'API ne répond pas.
 *
 * Champs Gamma examinés (par ordre de priorité) :
 *   data.outcome          — outcome JSON (format récent)
 *   data.winningOutcome   — ancien champ
 *   data.resolution       — certains endpoints
 */
async function fetchPolymarketOutcome(marketId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets/${marketId}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) {
      console.warn(`[check-results] Gamma API ${res.status} pour market ${marketId}`);
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const outcome =
      (data.outcome         as string | undefined) ??
      (data.winningOutcome  as string | undefined) ??
      (data.resolution      as string | undefined) ??
      null;
    return outcome ?? null;
  } catch (err) {
    console.warn(
      `[check-results] fetchPolymarketOutcome(${marketId}) failed:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers — P&L
// ---------------------------------------------------------------------------

// P&L calculé avec le bet HISTORIQUE (trade.suggested_bet), pas recalculé avec Kelly
function computePnl(
  won: boolean,
  marketPrice: number,
  suggestedBet: number
): number {
  if (suggestedBet === 0) return 0;
  return won
    ? Math.round(((1 / marketPrice - 1) * suggestedBet) * 100) / 100
    : -suggestedBet;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<CheckSummary>> {
  const checkedAt = new Date();
  console.log(`[check-results] ▶ Démarrage — ${checkedAt.toISOString()}`);

  const paperResolved: PaperTradeResolved[] = [];
  const errors: CheckSummary["errors"]      = [];
  let pendingPaperTrades: PaperTradeRow[]   = [];

  try {
    pendingPaperTrades = await getPendingPaperTrades();
    console.log(`[check-results] ${pendingPaperTrades.length} paper trade(s) à résoudre`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[check-results] ✗ getPendingPaperTrades : ${msg}`);
    return NextResponse.json(
      {
        checkedAt: checkedAt.toISOString(),
        paper_trades_resolved: 0,
        paper_trades_wins:     0,
        paper_trades_losses:   0,
        paper_trades_pnl:      0,
        details: [],
        errors: [{ id: "N/A", question: null, error: msg }],
      },
      { status: 502 }
    );
  }

  for (const trade of pendingPaperTrades) {
    const tag = `[check-results][paper][${trade.agent}][${trade.id.slice(0, 8)}]`;

    // Vérifier si le trade a été vendu par le Position Manager
    // (cas où markPaperTradeSold a échoué silencieusement mais la position est bien sold)
    try {
      const position = await getPositionByPaperTradeId(trade.id);
      if (position?.status === "sold" && position.sell_pnl !== null) {
        console.log(
          `${tag} Trade vendu via Position Manager — sell_pnl=${position.sell_pnl >= 0 ? "+" : ""}${position.sell_pnl}`
        );
        await resolvePaperTrade(trade.id, {
          actual_result: "sold",
          won:           position.sell_pnl >= 0,
          potential_pnl: position.sell_pnl,
        });
        paperResolved.push({
          id:           trade.id,
          agent:        trade.agent,
          outcome:      trade.outcome,
          actualResult: "sold",
          won:          position.sell_pnl >= 0,
          pnl:          position.sell_pnl,
        });
        continue;
      }
    } catch (err) {
      console.warn(`${tag} getPositionByPaperTradeId échoué — résolution normale :`, err instanceof Error ? err.message : err);
    }

    if (trade.agent === "weather") {
      if (!trade.city) {
        console.warn(`${tag} Pas de city — ignoré`);
        continue;
      }

      const question   = trade.question ?? "";
      const targetDate = trade.resolution_date ?? parseDateFromQuestion(question, trade.created_at);
      const unit       = detectUnit(trade.outcome);

      let highC: number, lowC: number;
      try {
        ({ highC, lowC } = await fetchActualTemperature(trade.city, targetDate));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ✗ fetchActualTemperature : ${msg}`);
        errors.push({ id: trade.id, question, error: msg });
        continue;
      }

      const actual    = selectTemp(trade.outcome, highC, lowC, unit);
      const ourResult = resolveOutcome(trade.outcome, actual, question);
      const actualStr = `high=${highC.toFixed(1)}°C low=${lowC.toFixed(1)}°C actual=${actual.toFixed(1)}°${unit}`;

      // Fetch le résultat officiel Polymarket (best-effort)
      const polymarketOutcome = await fetchPolymarketOutcome(trade.market_id);

      // outcome_match : est-ce que Polymarket confirme notre outcome prédit ?
      // Si Polymarket n'a pas encore résolu, on revient à notre calcul.
      const outcomeMatch: boolean | null = polymarketOutcome !== null
        ? polymarketOutcome.toLowerCase() === trade.outcome.toLowerCase()
        : null;

      const won         = outcomeMatch !== null ? outcomeMatch : ourResult === "WIN";
      const marketPrice  = Number(trade.market_price);
      const suggestedBet = Number(trade.suggested_bet);
      const pnl          = computePnl(won, marketPrice, suggestedBet);

      console.log(
        `${tag} our=${ourResult}, polymarket=${polymarketOutcome ?? "N/A"}, ` +
        `match=${outcomeMatch ?? "unknown"} — outcome="${trade.outcome}"  ${actualStr}  ` +
        `price=${marketPrice}, bet=${suggestedBet}, pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`
      );

      try {
        await resolvePaperTrade(trade.id, {
          actual_result:      actualStr,
          won,
          potential_pnl:      pnl,
          polymarket_outcome: polymarketOutcome,
          outcome_match:      outcomeMatch,
        });
        paperResolved.push({ id: trade.id, agent: trade.agent, outcome: trade.outcome, actualResult: actualStr, won, pnl });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ✗ resolvePaperTrade : ${msg}`);
        errors.push({ id: trade.id, question, error: msg });
      }

    } else if (trade.agent === "finance") {
      console.log(`${tag} Finance paper trade — résolution manuelle requise, ignoré`);
    }
  }

  // Résumé
  const wins   = paperResolved.filter((p) => p.won).length;
  const losses = paperResolved.filter((p) => !p.won).length;
  const pnl    = Math.round(paperResolved.reduce((s, p) => s + p.pnl, 0) * 100) / 100;

  if (paperResolved.length > 0) {
    console.log(
      `[check-results] ■ Terminé — ${paperResolved.length} paper trade(s) résolus — ` +
      `${wins}W / ${losses}L  P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}€, ${errors.length} erreurs`
    );

    // Notification Discord (fire-and-forget)
    const discordDetails: ResultDetail[] = paperResolved
      .filter((p) => p.agent === "weather")
      .map((p) => ({
        city:    p.actualResult.split(" ")[0],
        date:    checkedAt.toISOString().split("T")[0],
        outcome: p.outcome,
        actual:  0,
        unit:    "F" as const,
        result:  p.won ? "WIN" : "LOSS",
        pnl:     p.pnl,
      }));

    if (discordDetails.length > 0) {
      sendResultsSummary(
        { checked: paperResolved.length, wins, losses, winRate: wins / paperResolved.length, totalPnL: pnl, details: discordDetails },
        checkedAt
      ).catch((err) =>
        console.error(
          "[check-results] ✗ sendResultsSummary :",
          err instanceof Error ? err.message : err
        )
      );
    }
  } else {
    console.log(`[check-results] ■ Terminé — aucun paper trade à résoudre, ${errors.length} erreurs`);
  }

  return NextResponse.json({
    checkedAt:             checkedAt.toISOString(),
    paper_trades_resolved: paperResolved.length,
    paper_trades_wins:     wins,
    paper_trades_losses:   losses,
    paper_trades_pnl:      pnl,
    details:               paperResolved,
    errors,
  });
}
