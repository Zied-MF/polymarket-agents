/**
 * Post-Mortem Agent — analyse les trades résolus et génère des leçons.
 *
 * Flux :
 *   1. Récupère les paper trades weather résolus sans post-mortem (post_mortem_done=false)
 *   2. Pour chacun, extrait forecastTemp depuis market_context et actualTemp depuis actual_result
 *   3. Appelle generateAndSavePostMortem (Claude Haiku → leçon + calibration)
 *   4. Marque le trade comme post_mortem_done=true
 *
 * Appelé par /api/post-mortem (cron toutes les 6h).
 */

import { getResolvedTradesForPostMortem, markPostMortemDone, type PaperTradeRow } from "@/lib/db/supabase";
import { generateAndSavePostMortem, type PostMortemInput }                        from "@/lib/agents/post-mortem";

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
      const actualTemp   = extractActualTemp(trade);

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
