/**
 * Bet sizing adapté à la liquidité du marché (WeatherBot.finance).
 *
 * Règle : ne jamais parier plus de MAX_PCT_LIQUIDITY de la liquidité disponible
 * pour éviter le slippage. Configurable via env var MAX_PCT_LIQUIDITY (défaut 5%).
 *
 * Retourne 0 si le bet calculé est inférieur au minimum Polymarket ($1.05) —
 * l'appelant est responsable de skipper le marché dans ce cas.
 */

/** Fraction maximale de la liquidité du marché par bet. Configurable via env var. */
export const MAX_PCT_LIQUIDITY =
  parseFloat(process.env.MAX_PCT_LIQUIDITY ?? "0.05");

/** Minimum Polymarket par ordre (imposé par le protocole). */
export const MIN_BET_AMOUNT = 1.05;

/**
 * @returns betAmount en USDC, ou 0 si le bet est inférieur à MIN_BET_AMOUNT.
 */
export function calculateBetSize(
  kellyBet:      number,
  liquidity:     number,
  bankroll:      number,
  maxBetPercent: number
): number {
  const maxFromBankroll  = bankroll * maxBetPercent;
  const maxFromLiquidity = liquidity * MAX_PCT_LIQUIDITY;

  const raw = Math.min(kellyBet, maxFromBankroll, maxFromLiquidity);
  const bet = Math.round(raw * 100) / 100;

  // Retourne 0 plutôt que de forcer un minimum fictif — l'appelant skipera le marché
  return bet >= MIN_BET_AMOUNT ? bet : 0;
}
