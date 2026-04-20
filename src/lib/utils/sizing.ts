/**
 * Bet sizing adapté à la liquidité du marché (WeatherBot.finance).
 *
 * Règle : ne jamais parier plus de 5 % de la liquidité disponible pour
 * éviter le slippage. Le minimum absolu est 0,10 $.
 */

export function calculateBetSize(
  kellyBet:      number,
  liquidity:     number,
  bankroll:      number,
  maxBetPercent: number
): number {
  const maxFromBankroll  = bankroll * maxBetPercent;
  const maxFromLiquidity = liquidity * 0.05;           // 5 % de la liquidité

  const raw = Math.min(kellyBet, maxFromBankroll, maxFromLiquidity);

  return Math.max(0.10, Math.round(raw * 100) / 100);
}
