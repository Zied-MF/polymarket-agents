/**
 * Check-results endpoint — résolution des opportunités passées
 *
 * GET /api/check-results
 *
 * Pipeline :
 *   1. Récupère les opportunités "detected" dont detected_at < aujourd'hui
 *   2. Pour chaque, fetch la température réelle via Open-Meteo Archive API
 *   3. Compare avec l'outcome prédit → WIN ou LOSS
 *   4. Calcule le P&L (half-Kelly simulé)
 *   5. Met à jour Supabase (status, actual_result, pnl)
 *   6. Met à jour daily_stats (wins, losses, total_pnl)
 *   7. Envoie un résumé Discord
 *   8. Retourne le rapport complet
 */

import { NextResponse }                  from "next/server";
import { STATION_MAPPING }               from "@/lib/data/station-mapping";
import {
  getPendingOpportunities,
  updateOpportunityResult,
  updateDailyResultStats,
  getPendingPaperTrades,
  resolvePaperTrade,
  type OpportunityRow,
  type PaperTradeRow,
}                                        from "@/lib/db/supabase";
import { calculateHalfKelly, BANKROLL }  from "@/lib/utils/kelly";
import { sendResultsSummary, type ResultDetail } from "@/lib/utils/discord";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";

// ---------------------------------------------------------------------------
// Types de réponse
// ---------------------------------------------------------------------------

interface CheckDetail {
  id: string;
  city: string;
  date: string;
  outcome: string;
  actual: number;
  unit: "F" | "C";
  result: "WIN" | "LOSS";
  marketPrice: number;
  estimatedProbability: number;
  suggestedBet: number;
  pnl: number;
}

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
  checked: number;
  wins: number;
  losses: number;
  skipped: number;
  winRate: number;
  totalPnL: number;
  details: CheckDetail[];
  paper_trades_resolved: number;
  paper_trades_wins: number;
  paper_trades_pnl: number;
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
 * Fallback : lendemain de detected_at.
 */
function parseDateFromQuestion(question: string, detectedAt: string): string {
  const m = question.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i
  );
  if (m) {
    const month   = MONTHS[m[1].toLowerCase()];
    const day     = parseInt(m[2], 10);
    const detYear = new Date(detectedAt).getUTCFullYear();
    const date    = new Date(Date.UTC(detYear, month, day));
    return date.toISOString().split("T")[0];
  }
  // Fallback : lendemain de la détection (marché J+1 le plus fréquent)
  const det = new Date(detectedAt);
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
 * Récupère la température max/min observée pour une station et une date.
 * Utilise Open-Meteo Archive (ERA5 — données réelles, délai ~5 jours).
 *
 * @returns { highC, lowC } en °Celsius
 */
async function fetchActualTemperature(
  stationCode: string,
  dateStr: string
): Promise<{ highC: number; lowC: number }> {
  const station = STATION_MAPPING[stationCode];
  if (!station) throw new Error(`Station inconnue : ${stationCode}`);

  const url = new URL(ARCHIVE_BASE);
  url.searchParams.set("latitude",   String(station.lat));
  url.searchParams.set("longitude",  String(station.lon));
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
    const q       = question.toLowerCase();
    const numM    = q.match(/([\d.]+)/);
    const thresh  = numM ? parseFloat(numM[1]) : null;
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
// Helpers — P&L
// ---------------------------------------------------------------------------

function computePnl(
  result: "WIN" | "LOSS",
  marketPrice: number,
  estimatedProbability: number
): { pnl: number; suggestedBet: number } {
  const kelly        = calculateHalfKelly(estimatedProbability, marketPrice, BANKROLL);
  const suggestedBet = kelly.betAmount;

  if (suggestedBet === 0) return { pnl: 0, suggestedBet: 0 };

  const pnl = result === "WIN"
    ? Math.round(((1 / marketPrice - 1) * suggestedBet) * 100) / 100
    : -suggestedBet;

  return { pnl, suggestedBet };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<CheckSummary>> {
  const checkedAt = new Date();
  console.log(`[check-results] ▶ Démarrage — ${checkedAt.toISOString()}`);

  // 1. Récupérer les opportunités en attente
  let pending: OpportunityRow[];
  try {
    pending = await getPendingOpportunities();
    console.log(`[check-results] ${pending.length} opportunité(s) à vérifier`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[check-results] ✗ getPendingOpportunities : ${msg}`);
    return NextResponse.json(
      {
        checkedAt: checkedAt.toISOString(),
        checked: 0, wins: 0, losses: 0, skipped: 0,
        winRate: 0, totalPnL: 0, details: [],
        paper_trades_resolved: 0, paper_trades_wins: 0, paper_trades_pnl: 0,
        errors: [{ id: "N/A", question: null, error: msg }],
      },
      { status: 502 }
    );
  }

  const details: CheckDetail[]         = [];
  const errors: CheckSummary["errors"] = [];
  let skipped = 0;

  // 2. Traiter chaque opportunité
  for (const opp of pending) {
    const tag = `[check-results][${opp.station_code ?? "?"}][${opp.id.slice(0, 8)}]`;

    if (!opp.station_code) {
      console.warn(`${tag} Pas de station_code — ignoré`);
      skipped++;
      continue;
    }

    const question   = opp.question ?? "";
    const targetDate = parseDateFromQuestion(question, opp.detected_at);
    const unit       = detectUnit(opp.outcome);

    // 3. Température réelle
    let highC: number, lowC: number;
    try {
      ({ highC, lowC } = await fetchActualTemperature(opp.station_code, targetDate));
      console.log(
        `${tag} Temp réelle ${targetDate} : high=${highC.toFixed(1)}°C  low=${lowC.toFixed(1)}°C`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} ✗ fetchActualTemperature : ${msg}`);
      errors.push({ id: opp.id, question, error: msg });
      continue;
    }

    // 4. Résolution WIN / LOSS
    const actual = selectTemp(opp.outcome, highC, lowC, unit);
    const result = resolveOutcome(opp.outcome, actual, question);
    const { pnl, suggestedBet } = computePnl(
      result,
      opp.market_price,
      opp.estimated_probability
    );

    console.log(
      `${tag} ${result} — outcome="${opp.outcome}"  ` +
      `actual=${actual.toFixed(1)}°${unit}  ` +
      `pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}€`
    );

    // 5. Mise à jour Supabase
    try {
      await updateOpportunityResult(opp.id, {
        status:        result === "WIN" ? "won" : "lost",
        actual_result: highC,   // toujours stocké en °C
        pnl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} ✗ updateOpportunityResult : ${msg}`);
      errors.push({ id: opp.id, question, error: msg });
    }

    details.push({
      id:                   opp.id,
      city:                 opp.city ?? opp.station_code,
      date:                 targetDate,
      outcome:              opp.outcome,
      actual:               Math.round(actual * 10) / 10,
      unit,
      result,
      marketPrice:          opp.market_price,
      estimatedProbability: opp.estimated_probability,
      suggestedBet,
      pnl,
    });
  }

  // 6. Agrégation
  const wins    = details.filter((d) => d.result === "WIN").length;
  const losses  = details.filter((d) => d.result === "LOSS").length;
  const checked = details.length;
  const winRate = checked > 0 ? wins / checked : 0;
  const totalPnL = Math.round(
    details.reduce((sum, d) => sum + d.pnl, 0) * 100
  ) / 100;

  // 7. Mise à jour daily_stats
  if (checked > 0) {
    const todayStr = checkedAt.toISOString().split("T")[0];
    updateDailyResultStats(todayStr, wins, losses, totalPnL).catch((err) =>
      console.error(
        "[check-results] ✗ updateDailyResultStats :",
        err instanceof Error ? err.message : err
      )
    );
  }

  // 7b. Résoudre les paper trades en attente
  const paperResolved: PaperTradeResolved[] = [];
  let pendingPaperTrades: PaperTradeRow[] = [];

  try {
    pendingPaperTrades = await getPendingPaperTrades();
    console.log(`[check-results] ${pendingPaperTrades.length} paper trade(s) à résoudre`);
  } catch (err) {
    console.error(
      "[check-results] ✗ getPendingPaperTrades :",
      err instanceof Error ? err.message : err
    );
  }

  for (const trade of pendingPaperTrades) {
    const tag = `[check-results][paper][${trade.agent}][${trade.id.slice(0, 8)}]`;

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

      const actual     = selectTemp(trade.outcome, highC, lowC, unit);
      const result     = resolveOutcome(trade.outcome, actual, question);
      const won        = result === "WIN";
      const { pnl }    = computePnl(result, trade.market_price, trade.estimated_probability);
      const actualStr  = `high=${highC.toFixed(1)}°C low=${lowC.toFixed(1)}°C actual=${actual.toFixed(1)}°${unit}`;

      console.log(`${tag} ${result} — outcome="${trade.outcome}"  ${actualStr}  pnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);

      try {
        await resolvePaperTrade(trade.id, actualStr, won, pnl);
        paperResolved.push({ id: trade.id, agent: trade.agent, outcome: trade.outcome, actualResult: actualStr, won, pnl });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ✗ resolvePaperTrade : ${msg}`);
        errors.push({ id: trade.id, question, error: msg });
      }

    } else if (trade.agent === "finance") {
      // Finance paper trades: skip resolution (requires live stock data not available in archive)
      console.log(`${tag} Finance paper trade — résolution manuelle requise, ignoré`);
    }
  }

  if (paperResolved.length > 0) {
    const paperWins = paperResolved.filter((p) => p.won).length;
    const paperPnl  = Math.round(paperResolved.reduce((s, p) => s + p.pnl, 0) * 100) / 100;
    console.log(
      `[check-results] 🃏 ${paperResolved.length} paper trade(s) résolus — ` +
      `${paperWins}W / ${paperResolved.length - paperWins}L  P&L ${paperPnl >= 0 ? "+" : ""}${paperPnl.toFixed(2)}`
    );
  }

  // 8. Notification Discord (fire-and-forget)
  if (checked > 0) {
    const discordDetails: ResultDetail[] = details.map((d) => ({
      city:    d.city,
      date:    d.date,
      outcome: d.outcome,
      actual:  d.actual,
      unit:    d.unit,
      result:  d.result,
      pnl:     d.pnl,
    }));
    sendResultsSummary(
      { checked, wins, losses, winRate, totalPnL, details: discordDetails },
      checkedAt
    ).catch((err) =>
      console.error(
        "[check-results] ✗ sendResultsSummary :",
        err instanceof Error ? err.message : err
      )
    );
  }

  // 9. Résumé console
  const pnlSign = totalPnL >= 0 ? "+" : "";
  console.log(
    `[check-results] ■ Terminé — ${checked} vérifiés, ${wins}W / ${losses}L, ` +
    `P&L ${pnlSign}${totalPnL.toFixed(2)}€, ${skipped} ignorés, ${errors.length} erreurs`
  );

  return NextResponse.json({
    checkedAt: checkedAt.toISOString(),
    checked,
    wins,
    losses,
    skipped,
    winRate:  Math.round(winRate * 1000) / 1000,
    totalPnL,
    details,
    paper_trades_resolved: paperResolved.length,
    paper_trades_wins:     paperResolved.filter((p) => p.won).length,
    paper_trades_pnl:      Math.round(paperResolved.reduce((s, p) => s + p.pnl, 0) * 100) / 100,
    errors,
  });
}
