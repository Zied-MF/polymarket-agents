/**
 * Crypto Agent — détection d'opportunités sur les marchés crypto Polymarket
 *
 * Scoring basé sur les données CoinGecko (change24h + volume spike) :
 *
 *   change24h ≥ 3%   → +25 UP   | ≤ -3%  → +25 DOWN
 *   change24h ≥ 1%   → +15 UP   | ≤ -1%  → +15 DOWN
 *   Volume spike (> avg * 1.5) → +10 pts dans la direction du move
 *
 *   Note : CoinGecko /simple/price ne fournit pas de volume moyen sur N jours.
 *   On utilise un seuil absolu : volume24h > $5B pour BTC/ETH, $500M pour les autres.
 *   Cela détecte les journées de forte activité sans endpoint supplémentaire.
 *
 *   Probabilité estimée :
 *   - score ≤ 20 → P = 0.55 (floor)
 *   - score > 20 → P = 0.65 + (score - 20) / 100
 *   - Clampée entre 0.55 et 0.85
 *
 *   Edge = estimatedProbability - marketPrice ≥ 7.98% pour valider.
 */

import type { CryptoMarket }  from "@/lib/polymarket/gamma-api";
import type { CryptoData }    from "@/lib/data-sources/crypto-sources";
import type { Outcome }       from "@/types";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MIN_EDGE  = 0.0798;
const MIN_SCORE = 15;
const PROB_MIN  = 0.55;
const PROB_MAX  = 0.85;

/** Volume 24h considéré comme élevé selon la capitalisation du token. */
const HIGH_VOLUME_LARGE_CAP = 5_000_000_000;  // $5B — BTC, ETH
const HIGH_VOLUME_OTHER     =   500_000_000;  // $500M — autres

const LARGE_CAP_TOKENS = new Set(["BTC", "ETH"]);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoreBreakdown {
  upScore:   number;
  downScore: number;
  signals:   string[];
}

function computeScore(data: CryptoData): ScoreBreakdown {
  let upScore   = 0;
  let downScore = 0;
  const signals: string[] = [];

  // --- Variation 24h ---
  const ch = data.change24h;
  if (ch >= 3) {
    upScore += 25;
    signals.push(`change24h=+${ch.toFixed(2)}% → UP +25`);
  } else if (ch >= 1) {
    upScore += 15;
    signals.push(`change24h=+${ch.toFixed(2)}% → UP +15`);
  } else if (ch <= -3) {
    downScore += 25;
    signals.push(`change24h=${ch.toFixed(2)}% → DOWN +25`);
  } else if (ch <= -1) {
    downScore += 15;
    signals.push(`change24h=${ch.toFixed(2)}% → DOWN +15`);
  } else {
    signals.push(`change24h=${ch.toFixed(2)}% → neutral`);
  }

  // --- Volume spike ---
  const volThreshold = LARGE_CAP_TOKENS.has(data.token)
    ? HIGH_VOLUME_LARGE_CAP
    : HIGH_VOLUME_OTHER;

  if (data.volume24h > volThreshold) {
    // Renforce la direction du move
    if (ch > 0) {
      upScore += 10;
      signals.push(`volume spike $${(data.volume24h / 1e9).toFixed(1)}B → UP +10`);
    } else if (ch < 0) {
      downScore += 10;
      signals.push(`volume spike $${(data.volume24h / 1e9).toFixed(1)}B → DOWN +10`);
    } else {
      signals.push(`volume spike $${(data.volume24h / 1e9).toFixed(1)}B → neutral (no direction)`);
    }
  }

  return { upScore, downScore, signals };
}

// ---------------------------------------------------------------------------
// Probabilité estimée
// ---------------------------------------------------------------------------

function estimateProbability(score: number): number {
  if (score <= 20) return PROB_MIN;
  const raw = 0.65 + (score - 20) / 100;
  return Math.min(PROB_MAX, Math.max(PROB_MIN, raw));
}

// ---------------------------------------------------------------------------
// Volume spike — signal d'épuisement possible
// ---------------------------------------------------------------------------

/**
 * Un volume spike peut signaler la FIN d'un mouvement, pas son début.
 * Si le volume est > 3× le seuil normal ET que le prix a déjà bougé de > 5%,
 * le mouvement est potentiellement épuisé : réduit le score de 70%.
 *
 * @param rawScore     Score brut calculé (upScore ou downScore)
 * @param volumeRatio  Volume24h / volThreshold (ex: 3.5 = 3.5× le seuil)
 * @param changePercent Variation 24h en % (peut être négatif)
 */
function adjustForVolumeSpike(
  rawScore:      number,
  volumeRatio:   number,
  changePercent: number
): number {
  if (volumeRatio > 3 && Math.abs(changePercent) > 5) {
    console.log(
      `[crypto-agent] Volume spike warning: vol=${volumeRatio.toFixed(1)}x, ` +
      `change=${changePercent.toFixed(2)}% → possible exhaustion`
    );
    return rawScore * 0.3;
  }
  return rawScore;
}

// ---------------------------------------------------------------------------
// Résolution de la direction d'un outcome
// ---------------------------------------------------------------------------

function resolveOutcomeDirection(label: string): "up" | "down" | "unknown" {
  const o = label.toLowerCase().trim();
  if (/^yes$|higher|above|gain|up|rise|bull|more/.test(o)) return "up";
  if (/^no$|lower|below|drop|down|fall|bear|less/.test(o))  return "down";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

export function analyzeCryptoMarket(
  market:     CryptoMarket,
  cryptoData: CryptoData
): Outcome[] {
  const { upScore, downScore, signals } = computeScore(cryptoData);

  const rawDominantScore  = Math.max(upScore, downScore);
  const dominantDirection = upScore >= downScore ? "up" : "down";

  // Log formaté selon la spec
  const priceStr = cryptoData.price >= 1000
    ? `$${cryptoData.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${cryptoData.price.toFixed(4)}`;
  const changeStr = `${cryptoData.change24h >= 0 ? "+" : ""}${cryptoData.change24h.toFixed(2)}%`;

  // Calcul du ratio volume pour la détection d'épuisement
  const volThreshold = LARGE_CAP_TOKENS.has(cryptoData.token)
    ? HIGH_VOLUME_LARGE_CAP
    : HIGH_VOLUME_OTHER;
  const volumeRatio = cryptoData.volume24h / volThreshold;

  // Ajustement pour épuisement potentiel sur volume spike
  const dominantScore = adjustForVolumeSpike(rawDominantScore, volumeRatio, cryptoData.change24h);

  console.log(
    `[crypto-agent] ${cryptoData.token}: price=${priceStr}, change24h=${changeStr}, ` +
    `score=${dominantScore.toFixed(1)} → ${dominantDirection.toUpperCase()}`
  );

  if (dominantScore < MIN_SCORE) {
    console.log(
      `[crypto-agent] ${cryptoData.token}: score=${dominantScore.toFixed(1)} < ${MIN_SCORE} — skip`
    );
    return [];
  }

  const estimatedProbability = estimateProbability(dominantScore);

  console.log(
    `[crypto-agent] ${cryptoData.token}: estimatedP=${estimatedProbability.toFixed(3)}`
  );
  for (const s of signals) {
    console.log(`[crypto-agent]   ${s}`);
  }

  const results: Outcome[] = [];

  for (let i = 0; i < market.outcomes.length; i++) {
    const label       = market.outcomes[i];
    const marketPrice = market.outcomePrices[i];

    if (marketPrice < 0.01 || marketPrice > 0.99) {
      console.log(`[crypto-agent] ${cryptoData.token}: prix invalide ${marketPrice} — "${label}" ignoré`);
      continue;
    }

    const outcomeDir = resolveOutcomeDirection(label);
    if (outcomeDir !== dominantDirection) continue;

    const edge = estimatedProbability - marketPrice;

    if (edge > 0.50) {
      console.warn(
        `[crypto-agent] ${cryptoData.token}: edge suspect (${(edge * 100).toFixed(1)}% > 50%) pour "${label}" — ignoré`
      );
      continue;
    }

    if (edge < MIN_EDGE) {
      console.log(
        `[crypto-agent] ${cryptoData.token}: outcome="${label}" — ` +
        `edge=${(edge * 100).toFixed(2)}% < ${(MIN_EDGE * 100).toFixed(2)}% — skip`
      );
      continue;
    }

    console.log(
      `[crypto-agent] ${cryptoData.token}: outcome="${label}" — edge=+${(edge * 100).toFixed(2)}% ✅`
    );

    results.push({
      market,
      outcome:              label,
      marketPrice,
      estimatedProbability,
      edge,
      multiplier:           marketPrice > 0 ? 1 / marketPrice : Infinity,
    });
  }

  return results.sort((a, b) => b.edge - a.edge);
}
