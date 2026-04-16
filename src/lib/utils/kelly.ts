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
 * Plafond à 10 % × bankroll pour maîtriser le risque.
 * Minimum à MIN_BET_AMOUNT : en dessous les frais mangent le gain.
 *
 * Frais intégrés dans calculateHalfKelly :
 *   GAS_FEE      — ~1 centime de gas Polygon par transaction
 *   PLATFORM_FEE — 2 % prélevés par Polymarket sur les gains nets
 *   spreadEstimate — edge perdu à l'entrée (bid/ask), passé par les adapters
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Capital total disponible pour les bets de test (en USDC). */
export const BANKROLL = 10;

/** Gas Polygon estimé par transaction (en USDC). */
const GAS_FEE = 0.01;

/** Frais de plateforme Polymarket sur les gains nets. */
const PLATFORM_FEE = 0.02;

/** En dessous de ce montant la mise n'est pas suggérée (frais > edge). */
const MIN_BET_AMOUNT = 0.10;

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
 * Variante demi-Kelly avec intégration des frais réels (spread, gas, plateforme).
 *
 * Pipeline :
 *   1. effectiveProbability = probability − spreadEstimate  (edge perdu au spread)
 *   2. netOdds = grossOdds × (1 − PLATFORM_FEE)           (frais sur les gains)
 *   3. Kelly = (p·b − q) / b  sur effectiveProbability + netOdds
 *   4. Half-Kelly : diviser par 2
 *   5. Cap à 10 % du bankroll
 *   6. betAmount = bankroll × fraction − GAS_FEE
 *   7. Si betAmount < 0.10€ → 0 (pas rentable)
 *
 * @param probability      Notre P(outcome) estimée        ex: 0.65
 * @param marketPrice      Prix Polymarket [0, 1]          ex: 0.50
 * @param bankroll         Capital disponible (USDC)       ex: 10
 * @param spreadEstimate   Spread estimé [0, 1] (defaut 0) ex: 0.03
 */
export function calculateHalfKelly(
  probability:    number,
  marketPrice:    number,
  bankroll:       number,
  spreadEstimate: number = 0
): KellyResult {
  if (marketPrice <= 0 || marketPrice >= 1) return zero();

  // 1. Probabilité effective après spread (on perd de l'edge à l'entrée)
  const effectiveProbability = Math.max(0, probability - spreadEstimate);
  const q = 1 - effectiveProbability;

  // 2. Cote ajustée pour les frais de plateforme
  const grossOdds = (1 / marketPrice) - 1;
  const netOdds   = grossOdds * (1 - PLATFORM_FEE);

  if (netOdds <= 0) return zero();

  // 3. Fraction Kelly sur probabilité et cote nettes
  const kellyFraction = (effectiveProbability * netOdds - q) / netOdds;

  if (kellyFraction <= 0) return zero();

  // 4. Half-Kelly + cap à 10 % du bankroll
  const halfKelly        = kellyFraction / 2;
  const effectiveFraction = Math.min(halfKelly, 0.10);

  // 5. Montant brut − gas fee
  const rawAmount = effectiveFraction * bankroll;
  let betAmount   = rawAmount - GAS_FEE;

  // 6. Minimum 0.10€, sinon pas rentable
  // Warning : Kelly suggère un montant positif mais trop faible pour couvrir les frais
  if (betAmount < MIN_BET_AMOUNT) {
    if (kellyFraction > 0) {
      console.warn(
        `[kelly] ⚠️ OVERBETTING: Kelly suggests ${rawAmount.toFixed(3)}€ ` +
        `(after gas: ${betAmount.toFixed(3)}€) but min_bet is ${MIN_BET_AMOUNT}€ — skipping`
      );
    }
    return zero();
  }

  betAmount = Math.round(betAmount * 100) / 100;

  const potentialProfit = Math.round(betAmount * netOdds * 100) / 100;

  console.log(
    `[kelly] p=${(effectiveProbability * 100).toFixed(1)}% (spread−${(spreadEstimate * 100).toFixed(1)}%), ` +
    `odds=${netOdds.toFixed(2)} (net), kelly=${(kellyFraction * 100).toFixed(1)}%, ` +
    `half-kelly=${(effectiveFraction * 100).toFixed(1)}%, bet=${betAmount}€`
  );

  return { kellyFraction, effectiveFraction, betAmount, potentialProfit };
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
