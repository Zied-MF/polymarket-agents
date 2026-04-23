/**
 * Claude AI — météorologue expert pour la validation finale des trades
 *
 * Appelé uniquement APRÈS que tous les filtres mécaniques ont été passés,
 * pour une décision de qualité sur les marchés prometteurs seulement.
 *
 * Modèle : Haiku (claude-haiku-4-5) — rapide et économique pour une boucle de 15 min.
 * Basculer sur claude-sonnet-4-6 pour plus de précision si le budget le permet.
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeAnalysis {
  decision:            "TRADE" | "SKIP";
  confidence:          "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW";
  size:                number;        // 1-10
  outcome?:            "Yes" | "No"; // which outcome to buy
  reason:              string;
  risks:               string[];
  meteorologicalNotes: string;
  edgeEstimate?:       number;        // edge estimé (décimal)
}

export interface MarketContext {
  question:   string;
  city:       string;
  targetDate: string;
  outcomes:   string[];
  prices:     number[];
  forecasts: {
    gfs:       number;        // température standard forecast (°C)
    ensemble: {
      mean:    number;
      min:     number;
      max:     number;
      stdDev:  number;
      members: number[];      // jusqu'à 31 membres
    };
  };
  /** Consensus multi-modèle (GFS+ECMWF+UKMO+Ensemble) — optionnel si fetch échoue. */
  multiModel?: {
    consensus:     number;    // température consensus pondéré (°C)
    agreement:     "strong" | "moderate" | "weak";
    spreadDegrees: number;
    gfs?:          number;
    ecmwf?:        number;
    ukmo?:         number;
    method:        string;    // "ensemble_members" ou "gaussian_consensus"
    probability:   number;    // probabilité calculée
  };
  gaussianEdge:  number;      // edge calculé par le modèle gaussien/ensemble
  measureType:   "high" | "low";
  recentPerformance: {
    cityWinRate:     number;  // 0-1
    overallWinRate:  number;  // 0-1
    last7DaysPnL:    number;
  };
  lessons:               string[];              // leçons post-mortem récentes
  confidenceCalibration: Record<string, number>; // ex: { HIGH: 0.72 }
}

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

/**
 * Demande à Claude d'analyser un marché météo et de décider TRADE ou SKIP.
 *
 * @returns ClaudeAnalysis — contient la décision, la taille suggérée et le raisonnement.
 */
export async function analyzeWithClaude(context: MarketContext): Promise<ClaudeAnalysis> {
  const { forecasts, recentPerformance, lessons, confidenceCalibration } = context;

  const calibrationText = Object.keys(confidenceCalibration).length > 0
    ? Object.entries(confidenceCalibration)
        .map(([level, wr]) => `- ${level}: ${(wr * 100).toFixed(1)}% actual win rate`)
        .join("\n")
    : "- No calibration data yet (system is new)";

  const lessonsText = lessons.length > 0
    ? lessons.slice(-10).map((l) => `- ${l}`).join("\n")
    : "- No lessons yet.";

  // Dériver des règles critiques dynamiques à partir des leçons apprises
  const criticalRules: string[] = [];
  const lessonsLower = lessons.join(" ").toLowerCase();
  if (lessonsLower.includes("narrow") || lessonsLower.includes("range") || lessonsLower.includes("band")) {
    criticalRules.push("Avoid narrow temperature bands (1°C/1°F ranges) — they resolve incorrectly too often");
  }
  if (lessonsLower.includes("margin") || lessonsLower.includes("thin") || lessonsLower.includes("close to threshold")) {
    criticalRules.push("Require > 2°C margin between forecast and threshold — thin margins lead to losses");
  }
  if (lessonsLower.includes("spread") || lessonsLower.includes("uncertain") || lessonsLower.includes("disagreement")) {
    criticalRules.push("Skip when model spread > 3°C — disagreement signals unreliable forecast");
  }
  if (lessonsLower.includes("coastal") || lessonsLower.includes("sea breeze") || lessonsLower.includes("marine")) {
    criticalRules.push("Apply extra caution for coastal cities — sea breeze creates systematic forecast bias");
  }
  if (lessonsLower.includes("overnight") || lessonsLower.includes("low temp") || lessonsLower.includes("minimum")) {
    criticalRules.push("Low temperature forecasts are less reliable — prefer high temperature markets");
  }
  const criticalRulesText = criticalRules.length > 0
    ? `Apply these rules strictly — they come from real losses:\n${criticalRules.map((r) => `- ${r}`).join("\n")}`
    : "- No critical rules derived yet (insufficient post-mortem data)";

  const ensembleMemberSample = forecasts.ensemble.members
    .slice(0, 10)
    .map((t, i) => `M${i + 1}: ${t.toFixed(1)}°C`)
    .join(", ");

  const systemPrompt = `You are a Senior Meteorologist with 15 years of experience analyzing weather prediction markets. Your job is to decide whether to TRADE or SKIP each market opportunity.

## Analysis Process:
1. Assess ensemble spread — if > 4°C, uncertainty is high → lean SKIP
2. Consider microclimate factors (urban heat island, coastal effects, elevation)
3. Compare forecast probability vs market price to confirm edge
4. Factor in historical performance for this city
5. Apply the trading rules below strictly

## Trading Rules (non-negotiable):
- Only TRADE if net edge > 8% after ~3% spread
- BUY YES only if price < 45¢
- BUY NO only if YES price > 45¢ (i.e., NO < 55¢)
- When ensemble spread > 4°C → SKIP (too uncertain)
- When this city has < 40% win rate → size ≤ 3

## Your Calibration:
${calibrationText}

## Lessons from Past Trades:
${lessonsText}

## Critical Rules from Post-Mortem Analysis:
${criticalRulesText}

## Recent Performance:
- ${context.city} win rate: ${(recentPerformance.cityWinRate * 100).toFixed(1)}%
- Overall win rate: ${(recentPerformance.overallWinRate * 100).toFixed(1)}%
- Last 7 days P&L: ${recentPerformance.last7DaysPnL >= 0 ? "+" : ""}${recentPerformance.last7DaysPnL.toFixed(2)}€

Respond with a JSON object only — no preamble, no explanation outside the JSON.`;

  const multiModelSection = context.multiModel
    ? `\n**Multi-Model Consensus (ECMWF×0.4 + GFS×0.3 + UKMO×0.2 + Ensemble×0.1):**
- Consensus: ${context.multiModel.consensus.toFixed(1)}°C (agreement=${context.multiModel.agreement}, spread=${context.multiModel.spreadDegrees}°C)
- GFS: ${context.multiModel.gfs != null ? context.multiModel.gfs.toFixed(1) + "°C" : "N/A"} | ECMWF: ${context.multiModel.ecmwf != null ? context.multiModel.ecmwf.toFixed(1) + "°C" : "N/A"} | UKMO: ${context.multiModel.ukmo != null ? context.multiModel.ukmo.toFixed(1) + "°C" : "N/A"}
- Multi-model probability: ${(context.multiModel.probability * 100).toFixed(1)}% (method: ${context.multiModel.method})`
    : "";

  const userPrompt = `Analyze this weather prediction market:

**Question:** ${context.question}
**City:** ${context.city} | **Date:** ${context.targetDate} | **Measure:** ${context.measureType} temp
**Outcomes:** ${context.outcomes.join(" | ")}
**Market prices:** ${context.prices.map((p) => `${(p * 100).toFixed(1)}¢`).join(" | ")}

**Weather Forecasts:**
- Standard GFS: ${forecasts.gfs.toFixed(1)}°C
- Ensemble (31 members): mean=${forecasts.ensemble.mean.toFixed(1)}°C, spread=${(forecasts.ensemble.max - forecasts.ensemble.min).toFixed(1)}°C, σ=${forecasts.ensemble.stdDev.toFixed(2)}°C
- Sample members: ${ensembleMemberSample}... (${forecasts.ensemble.members.length} total)${multiModelSection}

**Pre-computed edge (Gaussian/Ensemble model):** ${(context.gaussianEdge * 100).toFixed(1)}%

Provide your analysis as JSON:
{
  "decision": "TRADE" or "SKIP",
  "confidence": "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW",
  "size": 1-10,
  "outcome": "Yes" or "No",
  "reason": "Brief explanation (max 120 chars)",
  "risks": ["Risk 1", "Risk 2"],
  "meteorologicalNotes": "Technical weather analysis (max 200 chars)",
  "edgeEstimate": 0.XX
}`;

  try {
    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    });

    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected response type");

    const jsonMatch = block.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in Claude response");

    const analysis = JSON.parse(jsonMatch[0]) as ClaudeAnalysis;

    console.log(
      `[claude] ${context.city}: ${analysis.decision} (${analysis.confidence}) — ${analysis.reason}`
    );

    return analysis;
  } catch (err) {
    console.error("[claude] analyzeWithClaude failed:", err instanceof Error ? err.message : err);
    return {
      decision:            "SKIP",
      confidence:          "LOW",
      size:                0,
      reason:              "Claude analysis failed — fallback to skip",
      risks:               ["API error"],
      meteorologicalNotes: "",
    };
  }
}
