/**
 * Kelly Criterion — sizing optimal des mises
 *
 * Sur Polymarket le prix d'un outcome [0,1] est sa probabilité implicite.
 * Le multiplicateur décimal (odds) vaut 1 / marketPrice, donc :
 *
 *   b = (1 / marketPrice) - 1   (gain net par unité misée si victoire)
 *   f* = (p·b − q) / b
 *
 * Si f* ≤ 0 → espérance négative, on ne mise pas.
 * Plafond à maxBetPercent × bankroll pour maîtriser le risque.
 * Minimum à MIN_BET_AMOUNT : en dessous les frais mangent le gain.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Capital total disponible pour les bets de test (en USDC). */
export const BANKROLL = 10;

/** En dessous de ce montant la mise n'est pas suggérée (frais > edge). */
const MIN_BET_AMOUNT = 0.05;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KellyResult {
  /** Fraction Kelly brute [0, 1]. */
  kellyFraction: number;
  /** Fraction effectivement utilisée après plafonnement. */
  effectiveFraction: number;
  /** Montant à miser en USDC, arrondi à 2 décimales. 0 si non rentable. */
  betAmount: number;
  /** Gain potentiel net si l'outcome est correct. */
  potentialProfit: number;
}

// ---------------------------------------------------------------------------
// Helpers internes
// ---------------------------------------------------------------------------

function zero(): KellyResult {
  return { kellyFraction: 0, effectiveFraction: 0, betAmount: 0, potentialProfit: 0 };
}

// ---------------------------------------------------------------------------
// Fonctions publiques
// ---------------------------------------------------------------------------

/**
 * Calcule la mise optimale selon le critère de Kelly (full Kelly).
 *
 * @param probability   Notre estimation de P(outcome = vrai)    ex: 0.55
 * @param marketPrice   Prix Polymarket de l'outcome [0, 1]      ex: 0.40
 * @param bankroll      Capital total disponible (USDC)
 * @param maxBetPercent Plafond par bet en fraction du bankroll  (défaut 10%)
 */
export function calculateKellyBet(
  probability: number,
  marketPrice: number,
  bankroll: number,
  maxBetPercent = 0.1
): KellyResult {
  if (marketPrice <= 0 || marketPrice >= 1) return zero();

  // b = gain net par unité misée si l'outcome gagne
  const b = (1 / marketPrice) - 1;
  const p = probability;
  const q = 1 - p;

  const kellyFraction = (p * b - q) / b;

  if (kellyFraction <= 0) return zero();

  const effectiveFraction = Math.min(kellyFraction, maxBetPercent);
  const rawAmount = effectiveFraction * bankroll;
  const betAmount = Math.round(rawAmount * 100) / 100;

  // Seuil minimum : en dessous les frais rendent le pari non rentable
  if (betAmount < MIN_BET_AMOUNT) return zero();

  const potentialProfit = Math.round(betAmount * b * 100) / 100;

  return { kellyFraction, effectiveFraction, betAmount, potentialProfit };
}

/**
 * Variante demi-Kelly : mise la moitié de la fraction Kelly optimale.
 * Réduit la variance ~50% pour une perte d'espérance de croissance ~25%.
 * Recommandé en phase de test ou sur marchés peu liquides.
 *
 * Paramètres identiques à calculateKellyBet.
 */
export function calculateHalfKelly(
  probability: number,
  marketPrice: number,
  bankroll: number,
  maxBetPercent = 0.1
): KellyResult {
  const full = calculateKellyBet(probability, marketPrice, bankroll, maxBetPercent);

  if (full.betAmount === 0) return full;

  const b = (1 / marketPrice) - 1;
  const effectiveFraction = full.effectiveFraction / 2;
  const rawAmount = effectiveFraction * bankroll;
  const betAmount = Math.round(rawAmount * 100) / 100;

  if (betAmount < MIN_BET_AMOUNT) return zero();

  const potentialProfit = Math.round(betAmount * b * 100) / 100;

  return {
    kellyFraction: full.kellyFraction,
    effectiveFraction,
    betAmount,
    potentialProfit,
  };
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/**
 * Espérance mathématique d'un pari, exprimée en fraction du montant misé.
 * EV > 0 ↔ pari favorable.
 */
export function expectedValue(probability: number, marketPrice: number): number {
  const b = (1 / marketPrice) - 1;
  return probability * b - (1 - probability);
}
