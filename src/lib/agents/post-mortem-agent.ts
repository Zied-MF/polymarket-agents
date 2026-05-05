/**
 * Post-Mortem Agent — analyse les trades résolus et génère des leçons.
 *
 * Flux :
 *   1. Récupère les paper trades weather résolus sans post-mortem (post_mortem_done=false)
 *   2. Pour chacun, extrait forecastTemp depuis market_context et actualTemp depuis actual_result
 *      → Pour les trades réels vendus tôt (actual_result="sold"), fetch la météo réelle
 *        depuis Open-Meteo Archive et met à jour actual_result en DB.
 *   3. Appelle generateAndSavePostMortem (Claude Haiku → leçon + calibration)
 *   4. Marque le trade comme post_mortem_done=true
 *
 * Appelé par /api/post-mortem (cron toutes les 6h).
 */

import { getResolvedTradesForPostMortem, markPostMortemDone, getClient, type PaperTradeRow } from "@/lib/db/supabase";
import { generateAndSavePostMortem, type PostMortemInput }                                    from "@/lib/agents/post-mortem";
import { STATION_MAPPING }                                                                     from "@/lib/data/station-mapping";
import { getCoordinates }                                                                      from "@/lib/data-sources/geocoding";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostMortemReport {
  processed: number;
  succeeded: number;
  failed:    number;
  details:   Array<{
    tradeId:  string;
    city:     string;
    question: string;
    lesson:   string | null;
    category: string | null;
    error:    string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extrait la température prévue depuis market_context.
 * market_context.data_source.high_temp ou .low_temp selon measure_type.
 */
function extractForecastTemp(trade: PaperTradeRow): number | null {
  try {
    const ctx = trade.market_context as Record<string, unknown> | null;
    if (!ctx) return null;

    const ds = ctx["data_source"] as Record<string, unknown> | undefined;
    if (!ds) return null;

    const measureType = (ctx["measure_type"] as string | undefined) ?? "high";
    const temp = measureType === "low" ? ds["low_temp"] : ds["high_temp"];

    return typeof temp === "number" ? temp : null;
  } catch {
    return null;
  }
}

/**
 * Extrait la température réelle depuis actual_result.
 * Format attendu : "high=25.3°C low=18.1°C actual=77.5°F"
 * Convertit en °C si nécessaire.
 */
function extractActualTemp(trade: PaperTradeRow): number | null {
  try {
    const result = trade.actual_result;
    if (!result || result === "sold") return null;

    // Format: "actual=77.5°F" ou "actual=25.3°C"
    const actualMatch = result.match(/actual=([\d.]+)°([FC])/i);
    if (actualMatch) {
      const val  = parseFloat(actualMatch[1]);
      const unit = actualMatch[2].toUpperCase();
      return unit === "F" ? (val - 32) * 5 / 9 : val;
    }

    // Format alternatif: "high=25.3°C ..."
    const highMatch = result.match(/high=([\d.]+)°C/i);
    if (highMatch) return parseFloat(highMatch[1]);

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch météo réelle (Open-Meteo Archive) — pour les trades réels vendus tôt
// ---------------------------------------------------------------------------

const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";

/**
 * Récupère la température max réelle (°C) pour une ville et une date.
 * Retourne null si les données ne sont pas encore disponibles (délai ~5 jours)
 * ou si la ville est inconnue.
 */
async function fetchActualHighTemp(city: string, dateStr: string): Promise<number | null> {
  // Open-Meteo Archive a un délai de ~5 jours
  const resolutionDate = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 4);
  if (resolutionDate > cutoff) {
    console.log(`[post-mortem] ${city} ${dateStr}: archive pas encore dispo (< 4 jours)`);
    return null;
  }

  try {
    let lat: number;
    let lon: number;
    const station = STATION_MAPPING[city];
    if (station) {
      lat = station.lat;
      lon = station.lon;
    } else {
      const geo = await getCoordinates(city);
      if (!geo) {
        console.warn(`[post-mortem] Coordonnées inconnues pour "${city}"`);
        return null;
      }
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
    if (!res.ok) return null;

    const data = await res.json() as {
      daily?: { time?: string[]; temperature_2m_max?: (number | null)[] };
    };
    const times = data.daily?.time ?? [];
    const idx   = times.indexOf(dateStr);
    if (idx === -1) return null;

    return data.daily?.temperature_2m_max?.[idx] ?? null;
  } catch (err) {
    console.warn(`[post-mortem] fetchActualHighTemp(${city}, ${dateStr}): ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Pour un trade réel vendu tôt (actual_result="sold"), tente de récupérer
 * la météo réelle et met à jour actual_result en DB.
 * Retourne la highTemp en °C, ou null si non disponible.
 */
async function fetchAndPatchActualResult(trade: PaperTradeRow): Promise<number | null> {
  if (!trade.city) return null;

  // Date de résolution depuis la colonne resolution_date ou parsée depuis la question
  const dateStr = trade.resolution_date?.slice(0, 10) ?? null;
  if (!dateStr) return null;

  const highC = await fetchActualHighTemp(trade.city, dateStr);
  if (highC === null) return null;

  // Mettre à jour actual_result en DB avec les vraies données météo
  const actualStr = `high=${highC.toFixed(1)}°C actual=${highC.toFixed(1)}°C (fetched by post-mortem)`;
  try {
    const db = getClient();
    await db.from("paper_trades").update({ actual_result: actualStr }).eq("id", trade.id);
    console.log(`[post-mortem] ✅ actual_result mis à jour pour ${trade.city}: ${actualStr}`);
  } catch (err) {
    console.warn(`[post-mortem] ⚠ patch actual_result échoué: ${err instanceof Error ? err.message : err}`);
  }

  return highC;
}

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

/**
 * Analyse les trades résolus et génère des leçons via Claude.
 * Fire-and-forget safe — capture toutes les erreurs individuellement.
 */
export async function runPostMortemAnalysis(batchSize = 20): Promise<PostMortemReport> {
  const report: PostMortemReport = {
    processed: 0,
    succeeded: 0,
    failed:    0,
    details:   [],
  };

  let trades: PaperTradeRow[];
  try {
    trades = await getResolvedTradesForPostMortem(batchSize);
  } catch (err) {
    console.error("[post-mortem-agent] getResolvedTradesForPostMortem:", err instanceof Error ? err.message : err);
    return report;
  }

  console.log(`[post-mortem-agent] ${trades.length} trade(s) à analyser`);

  for (const trade of trades) {
    report.processed++;

    const city     = trade.city ?? "Unknown";
    const question = trade.question ?? "";
    const tag      = `[post-mortem-agent][${city}][${trade.id.slice(0, 8)}]`;

    try {
      if (trade.won === null) {
        console.warn(`${tag} won=null — ignoré`);
        await markPostMortemDone(trade.id);
        continue;
      }

      const forecastTemp = extractForecastTemp(trade);
      let actualTemp     = extractActualTemp(trade);

      // Pour les trades réels vendus tôt (actual_result="sold"), tenter de
      // récupérer la météo réelle depuis Open-Meteo Archive.
      if (actualTemp === null && trade.actual_result === "sold" && trade.city) {
        console.log(`${tag} actual_result="sold" → fetch météo réelle depuis archive…`);
        const fetched = await fetchAndPatchActualResult(trade);
        if (fetched !== null) {
          actualTemp = fetched;
          console.log(`${tag} ✅ actualTemp récupéré: ${fetched.toFixed(1)}°C`);
        } else {
          console.warn(`${tag} ⚠ météo archive non disponible — post-mortem sans actualTemp`);
        }
      }

      if (forecastTemp === null) {
        console.warn(`${tag} forecastTemp introuvable dans market_context — skip`);
        await markPostMortemDone(trade.id);
        report.details.push({ tradeId: trade.id, city, question, lesson: null, category: null, error: "forecastTemp introuvable" });
        report.failed++;
        continue;
      }

      const input: PostMortemInput = {
        tradeId:      trade.id,
        question,
        city,
        outcome:      trade.outcome,
        entryPrice:   Number(trade.market_price),
        forecastTemp,
        actualTemp:   actualTemp ?? undefined,
        won:          trade.won,
        pnl:          Number(trade.potential_pnl ?? 0),
        confidence:   trade.confidence ?? undefined,
      };

      const result = await generateAndSavePostMortem(input);

      // Marque comme traité (même si result est null = erreur Claude gérée)
      await markPostMortemDone(trade.id);

      if (result) {
        console.log(`${tag} ✅ ${result.category}: ${result.lesson}`);
        report.succeeded++;
        report.details.push({ tradeId: trade.id, city, question, lesson: result.lesson, category: result.category, error: null });
      } else {
        console.warn(`${tag} ⚠️ generateAndSavePostMortem retourné null`);
        report.failed++;
        report.details.push({ tradeId: trade.id, city, question, lesson: null, category: null, error: "Claude retourné null" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} ✗ Erreur :`, msg);
      report.failed++;
      report.details.push({ tradeId: trade.id, city, question, lesson: null, category: null, error: msg });

      // Tenter de marquer quand même pour ne pas boucler indéfiniment
      try { await markPostMortemDone(trade.id); } catch { /* best-effort */ }
    }
  }

  console.log(
    `[post-mortem-agent] ■ Terminé — ${report.processed} traité(s), ` +
    `${report.succeeded} réussi(s), ${report.failed} échoué(s)`
  );

  return report;
}
