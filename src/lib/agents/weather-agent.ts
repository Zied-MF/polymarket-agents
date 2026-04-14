/**
 * Weather Agent - analyse prévisions vs prix de marché
 *
 * Pour chaque marché météo Polymarket, compare la probabilité implicite
 * du marché (outcomePrices) à la probabilité calculée via une distribution
 * gaussienne centrée sur la prévision Open-Meteo.
 *
 * Retourne les outcomes dont l'edge (estimatedProbability - marketPrice)
 * est >= 7.98% — seuil empirique au-delà duquel l'espérance couvre
 * les frais de plateforme (~2%) et laisse une marge suffisante.
 */

import type { WeatherMarket } from "@/lib/polymarket/gamma-api";
import type { WeatherForecast } from "@/types";
import type { Outcome } from "@/types";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Edge minimum pour qu'un outcome soit considéré comme exploitable. */
const MIN_EDGE = 0.0798;

/**
 * Sigma de fallback en °C — utilisé si le forecast ne fournit pas de
 * dynamicSigma (ex: données mock ou ancienne version de weather-sources).
 * Modulé par confidence dans ce cas : sigmaC = BASE_SIGMA_C / confidence.
 */
const BASE_SIGMA_C = 2.0;

// ---------------------------------------------------------------------------
// Maths : distribution gaussienne
// ---------------------------------------------------------------------------

/**
 * Approximation de la fonction erf (Abramowitz & Stegun 7.1.26).
 * Erreur max : 1.5 × 10⁻⁷ — largement suffisant pour notre usage.
 */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

/**
 * CDF de la loi normale : P(X <= x) avec X ~ N(mean, sigma²).
 */
function gaussianCDF(x: number, mean: number, sigma: number): number {
  return 0.5 * (1 + erf((x - mean) / (sigma * Math.SQRT2)));
}

/** P(X >= threshold) */
function probAbove(threshold: number, mean: number, sigma: number): number {
  return 1 - gaussianCDF(threshold, mean, sigma);
}

/** P(X < threshold) */
function probBelow(threshold: number, mean: number, sigma: number): number {
  return gaussianCDF(threshold, mean, sigma);
}

/** P(low <= X < high) */
function probBetween(low: number, high: number, mean: number, sigma: number): number {
  return gaussianCDF(high, mean, sigma) - gaussianCDF(low, mean, sigma);
}

// ---------------------------------------------------------------------------
// Conversion d'unité
// ---------------------------------------------------------------------------

function fahrenheitToCelsius(f: number): number {
  return (f - 32) * (5 / 9);
}

function celsiusToFahrenheit(c: number): number {
  return c * (9 / 5) + 32;
}

// ---------------------------------------------------------------------------
// Parsing des outcomes
// ---------------------------------------------------------------------------

/**
 * Représentation interne d'un outcome après parsing des seuils.
 * Les bornes sont en demi-entiers pour refléter l'arrondi Polymarket
 * (ex: "90 - 94" → [89.5, 94.5)).
 */
interface ParsedOutcome {
  label: string;
  type: "above" | "below" | "between" | "binary_yes" | "binary_no";
  low?: number;  // borne basse inclusive (en unité du marché)
  high?: number; // borne haute exclusive (en unité du marché)
  threshold?: number; // pour above/below/binary
}

/**
 * Parse un libellé d'outcome Polymarket en bornes numériques.
 *
 * Formats supportés :
 *   "Above 95"      → above 94.5
 *   "Below 85"      → below 85.5
 *   "90 - 94"       → [89.5, 94.5)
 *   "90-94"         → [89.5, 94.5)
 *   "Yes"           → binary_yes (nécessite threshold dans la question)
 *   "No"            → binary_no
 */
function parseOutcome(label: string, binaryThreshold?: number): ParsedOutcome {
  const t = label.trim();

  // "Above X" ou "≥ X" ou "> X"
  const aboveMatch = t.match(/^(?:Above|>=?|≥)\s*([\d.]+)/i);
  if (aboveMatch) {
    return { label, type: "above", threshold: parseFloat(aboveMatch[1]) - 0.5 };
  }

  // "Below X" ou "≤ X" ou "< X" ou "Under X"
  const belowMatch = t.match(/^(?:Below|<=?|≤|Under)\s*([\d.]+)/i);
  if (belowMatch) {
    return { label, type: "below", threshold: parseFloat(belowMatch[1]) + 0.5 };
  }

  // "X - Y" ou "X–Y" (plage)
  const rangeMatch = t.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
  if (rangeMatch) {
    return {
      label,
      type: "between",
      low: parseFloat(rangeMatch[1]) - 0.5,
      high: parseFloat(rangeMatch[2]) + 0.5,
    };
  }

  // Marchés binaires
  if (/^yes$/i.test(t)) {
    return { label, type: "binary_yes", threshold: binaryThreshold };
  }
  if (/^no$/i.test(t)) {
    return { label, type: "binary_no", threshold: binaryThreshold };
  }

  // Cas inconnu — on retourne quand même pour ne pas silencer
  return { label, type: "above", threshold: undefined };
}

/**
 * Extrait le seuil numérique d'une question binaire Polymarket.
 * Ex: "Will the high temp at KLGA exceed 90°F?" → 90
 */
function extractBinaryThreshold(question: string): number | undefined {
  const match = question.match(/(\d+(?:\.\d+)?)\s*°?[FC]/);
  return match ? parseFloat(match[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Calcul de probabilité d'un outcome
// ---------------------------------------------------------------------------

/**
 * Calcule P(outcome) pour une distribution N(mean, sigma²).
 * mean et sigma sont dans la même unité que les seuils de l'outcome.
 */
function probabilityForOutcome(
  parsed: ParsedOutcome,
  mean: number,
  sigma: number
): number {
  switch (parsed.type) {
    case "above":
      if (parsed.threshold == null) return NaN;
      return probAbove(parsed.threshold, mean, sigma);

    case "below":
      if (parsed.threshold == null) return NaN;
      return probBelow(parsed.threshold, mean, sigma);

    case "between":
      if (parsed.low == null || parsed.high == null) return NaN;
      return probBetween(parsed.low, parsed.high, mean, sigma);

    case "binary_yes":
      if (parsed.threshold == null) return NaN;
      return probAbove(parsed.threshold, mean, sigma);

    case "binary_no":
      if (parsed.threshold == null) return NaN;
      return probBelow(parsed.threshold, mean, sigma);

    default:
      return NaN;
  }
}

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

/**
 * Analyse un marché météo Polymarket en comparant les prix du marché
 * aux probabilités estimées via distribution gaussienne.
 *
 * La prévision Open-Meteo est en °C ; les seuils des outcomes sont dans
 * l'unité du marché (F ou C). On convertit le forecast dans l'unité du
 * marché avant le calcul.
 *
 * Le sigma est ajusté par confidence :
 *   sigma_eff = BASE_SIGMA_C / confidence
 * → moins confiant = distribution plus étalée = probabilités moins extrêmes.
 *
 * @returns Liste des outcomes dont l'edge >= MIN_EDGE, triée par edge décroissant.
 */
export function analyzeMarket(
  market: WeatherMarket,
  forecast: WeatherForecast
): Outcome[] {
  // 1. Température de prévision dans l'unité du marché
  const forecastTempC =
    market.measureType === "high" ? forecast.highTemp : forecast.lowTemp;
  const forecastTemp =
    market.unit === "F" ? celsiusToFahrenheit(forecastTempC) : forecastTempC;

  // 2. Sigma dynamique (°C) → converti dans l'unité du marché
  //    Priorité : dynamicSigma du forecast (multi-modèles) > fallback BASE_SIGMA_C
  const sigmaC = forecast.dynamicSigma ?? (BASE_SIGMA_C / forecast.confidence);
  const sigma  = market.unit === "F" ? sigmaC * (9 / 5) : sigmaC;

  // 3. Log détaillé des modèles
  const mt = forecast.modelHighTemps;
  const modelStr = [
    mt?.gfs   != null && `GFS=${market.unit === "F" ? celsiusToFahrenheit(mt.gfs).toFixed(1)   : mt.gfs.toFixed(1)  }°${market.unit}`,
    mt?.ecmwf != null && `ECMWF=${market.unit === "F" ? celsiusToFahrenheit(mt.ecmwf).toFixed(1) : mt.ecmwf.toFixed(1)}°${market.unit}`,
    mt?.icon  != null && `Icon=${market.unit === "F" ? celsiusToFahrenheit(mt.icon).toFixed(1)  : mt.icon.toFixed(1) }°${market.unit}`,
  ].filter(Boolean).join(", ");

  const spreadInUnit = market.unit === "F"
    ? forecast.modelSpread * (9 / 5)
    : forecast.modelSpread;

  console.log(
    `[weather-agent] ${market.city}: ${modelStr || "no model data"}, ` +
    `spread=${spreadInUnit.toFixed(1)}°${market.unit}, ` +
    `sigma=${sigma.toFixed(2)}, ` +
    `confidence=${forecast.confidenceLevel ?? String(forecast.confidence)}`
  );

  // 4. Seuil binaire (marchés Yes/No)
  const binaryThreshold = extractBinaryThreshold(market.question);

  // 5. Pour chaque outcome : estimer P, calculer edge, filtrer
  const results: Outcome[] = [];

  for (let i = 0; i < market.outcomes.length; i++) {
    const label = market.outcomes[i];
    const marketPrice = market.outcomePrices[i];

    const parsed = parseOutcome(label, binaryThreshold);
    const estimatedProbability = probabilityForOutcome(parsed, forecastTemp, sigma);

    // Ignorer les outcomes qu'on ne sait pas parser
    if (isNaN(estimatedProbability)) continue;

    const edge = estimatedProbability - marketPrice;

    if (edge >= MIN_EDGE) {
      results.push({
        market,
        outcome: label,
        marketPrice,
        estimatedProbability,
        edge,
        multiplier: marketPrice > 0 ? 1 / marketPrice : Infinity,
      });
    }
  }

  // Trier par edge décroissant — les meilleures opportunités en premier
  return results.sort((a, b) => b.edge - a.edge);
}
