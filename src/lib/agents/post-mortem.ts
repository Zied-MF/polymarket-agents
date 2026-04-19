/**
 * Post-Mortem — génère une leçon d'apprentissage après chaque trade résolu.
 *
 * Appelé par check-results après résolution d'un paper trade.
 * Sauvegarde la leçon dans `trading_lessons` et met à jour la calibration.
 */

import Anthropic from "@anthropic-ai/sdk";
import { saveLesson, updateConfidenceCalibration } from "@/lib/db/lessons";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const MODEL     = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostMortemInput {
  tradeId?:      string;
  question:      string;
  city:          string;
  outcome:       string;     // l'outcome acheté ("Yes" / "No" / etc.)
  entryPrice:    number;     // prix d'achat (0-1)
  forecastTemp:  number;     // température prévue (°C)
  actualTemp?:   number;     // température réelle (°C), undefined si non disponible
  won:           boolean;
  pnl:           number;
  confidence?:   string;     // niveau de confiance Claude ("HIGH", etc.)
}

export interface PostMortemResult {
  lesson:   string;
  category: "pricing" | "forecast" | "timing" | "city_bias" | "model_error";
}

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

/**
 * Génère et persiste une leçon post-mortem pour un trade résolu.
 * Fire-and-forget safe — n'émet pas d'exception vers l'appelant.
 */
export async function generateAndSavePostMortem(
  trade: PostMortemInput
): Promise<PostMortemResult | null> {
  try {
    const result = await generatePostMortem(trade);

    // Persiste la leçon en arrière-plan
    await saveLesson(result.lesson, result.category, trade.city, trade.tradeId);

    // Met à jour la calibration si le trade avait un niveau de confiance Claude
    if (trade.confidence) {
      await updateConfidenceCalibration(trade.confidence, trade.won);
    }

    return result;
  } catch (err) {
    console.error("[post-mortem] generateAndSavePostMortem:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Appelle Claude pour générer une leçon à partir des données du trade.
 */
async function generatePostMortem(trade: PostMortemInput): Promise<PostMortemResult> {
  const prompt = `A weather prediction trade just resolved. Generate ONE concise, actionable lesson.

**Trade:** ${trade.question}
**City:** ${trade.city}
**Outcome bought:** ${trade.outcome} at ${(trade.entryPrice * 100).toFixed(1)}¢
**Forecast:** ${trade.forecastTemp.toFixed(1)}°C
**Actual:** ${trade.actualTemp != null ? `${trade.actualTemp.toFixed(1)}°C` : "unknown"}
**Error:** ${trade.actualTemp != null ? `${(trade.actualTemp - trade.forecastTemp).toFixed(1)}°C` : "n/a"}
**Result:** ${trade.won ? "WON ✅" : "LOST ❌"} (${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}€)
**Confidence:** ${trade.confidence ?? "unknown"}

Respond with JSON only:
{
  "lesson": "Actionable rule for future trades (max 100 chars)",
  "category": "pricing" | "forecast" | "timing" | "city_bias" | "model_error"
}`;

  const response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 256,
    messages:   [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");

  const jsonMatch = block.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in post-mortem response");

  const result = JSON.parse(jsonMatch[0]) as PostMortemResult;

  console.log(`[post-mortem] ${trade.city} (${trade.won ? "WIN" : "LOSS"}): [${result.category}] ${result.lesson}`);

  return result;
}
