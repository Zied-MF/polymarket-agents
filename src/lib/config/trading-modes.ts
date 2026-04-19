/**
 * Trading Modes — configuration des seuils par stratégie
 *
 * Aligné sur WeatherBot.finance (3 modes) :
 *   balanced       — stratégie gopfan2, conservatrice, win rate élevé
 *   aggressive     — exposition max, risk/reward plus élevé
 *   high_conviction — outcomes quasi-certains uniquement
 *
 * Mode actif : variable d'env TRADING_MODE (défaut: balanced)
 */

export type TradingMode = "balanced" | "aggressive" | "high_conviction";

export interface ModeConfig {
  name:            string;
  description:     string;
  /** Prix max pour acheter YES (ex: 0.15 = 15¢). */
  yesMaxPrice:     number;
  /** Prix YES minimum pour que NO soit intéressant (ex: 0.45 → NO valide si YES > 45¢). */
  noMinYesPrice:   number;
  /** Fraction max du bankroll par trade. */
  maxBetPercent:   number;
  /** Edge net minimum (après spread). */
  minEdge:         number;
  /** Niveau de confiance Claude minimum pour trader. */
  minConfidence:   "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW";
}

export const TRADING_MODES: Record<TradingMode, ModeConfig> = {
  balanced: {
    name:          "Balanced",
    description:   "gopfan2 strategy — conservative, high win rate",
    yesMaxPrice:   0.15,   // YES seulement < 15¢
    noMinYesPrice: 0.45,   // NO seulement si YES > 45¢
    maxBetPercent: 0.05,   // 5% max du bankroll
    minEdge:       0.10,   // 10% edge minimum
    minConfidence: "MEDIUM",
  },
  aggressive: {
    name:          "Aggressive",
    description:   "Maximum exposure — higher risk/reward",
    yesMaxPrice:   0.50,   // YES jusqu'à 50¢
    noMinYesPrice: 0.50,   // NO si YES > 50¢
    maxBetPercent: 0.10,   // 10% max du bankroll
    minEdge:       0.08,   // 8% edge minimum
    minConfidence: "LOW",
  },
  high_conviction: {
    name:          "High Conviction",
    description:   "Near-certain outcomes only",
    yesMaxPrice:   0.15,   // YES seulement < 15¢
    noMinYesPrice: 0.90,   // NO seulement si YES > 90¢ (quasi impossible)
    maxBetPercent: 0.05,   // 5% max
    minEdge:       0.15,   // 15% edge minimum
    minConfidence: "VERY_HIGH",
  },
};

/** Retourne le mode actif depuis TRADING_MODE (env var) ou "balanced" par défaut. */
export function getCurrentMode(): TradingMode {
  const raw = process.env.TRADING_MODE;
  if (raw === "aggressive" || raw === "high_conviction") return raw;
  return "balanced";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: ModeConfig["minConfidence"][] = ["LOW", "MEDIUM", "HIGH", "VERY_HIGH"];

/**
 * Vérifie si `actual` atteint le seuil `minimum`.
 * Ex: isConfidenceAtLeast("HIGH", "MEDIUM") → true
 */
export function isConfidenceAtLeast(
  actual:  string,
  minimum: ModeConfig["minConfidence"]
): boolean {
  const ai = CONFIDENCE_ORDER.indexOf(actual as ModeConfig["minConfidence"]);
  const mi = CONFIDENCE_ORDER.indexOf(minimum);
  return ai >= 0 && mi >= 0 && ai >= mi;
}
