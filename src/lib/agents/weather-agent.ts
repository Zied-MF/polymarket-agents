/**
 * Weather Agent - analyse prévisions vs prix de marché
 *
 * Pour chaque marché météo Polymarket, compare la probabilité implicite
 * du marché (outcomePrices) à la probabilité calculée via une distribution
 * gaussienne centrée sur la prévision Open-Meteo.
 *
 * Types d'outcomes supportés :
 *   • "exact"   — "be 22°C" / "22°C" / "22"  → PDF gaussien (e^(-0.5*(d/σ)²))
 *   • "range"   — "22-23°C" / "90 - 94"       → PDF sur le milieu de la plage
 *   • "above"   — "Above 95" / "22°C or above" → CDF : P(X ≥ seuil)
 *   • "below"   — "Below 85" / "22°C or below" → CDF : P(X ≤ seuil)
 *   • "yes/no"  — marchés binaires              → CDF sur le seuil extrait
 *
 * Unité : les seuils des outcomes sont dans l'unité du marché (F ou C).
 * La prévision Open-Meteo (°C) est convertie vers l'unité du marché.
 * Détection d'urgence : si les labels contiennent "°C" sur un marché marqué
 * "F", l'unité est forcée à "C" pour éviter la comparaison 22°C vs 74°F.
 *
 * Retourne les outcomes dont l'edge >= MIN_EDGE, triés par edge décroissant.
 */

import type { WeatherMarket } from "@/lib/polymarket/gamma-api";
import type { WeatherForecast } from "@/types";
import type { Outcome } from "@/types";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MIN_EDGE     = 0.0798;
const BASE_SIGMA_C = 2.0;

/**
 * Température moyenne historique globale utilisée pour calibrer les fat tails.
 * Valeur indicative — l'important est la déviation relative, pas la valeur absolue.
 */
const HISTORICAL_AVG_C = 15.0;

// ---------------------------------------------------------------------------
// Fat tails — correction du sigma pour les événements extrêmes
// ---------------------------------------------------------------------------

/**
 * Les modèles météo sous-estiment l'incertitude quand la température prévue
 * s'éloigne de la normale historique. Augmente sigma proportionnellement à
 * l'écart : +20 % de sigma par 10°C d'écart par rapport à HISTORICAL_AVG_C.
 *
 * Exemples :
 *   forecast=15°C (= avg) → fatTailFactor = 1.0  → sigma inchangé
 *   forecast=25°C (+10°C) → fatTailFactor = 1.2  → sigma × 1.2
 *   forecast=35°C (+20°C) → fatTailFactor = 1.4  → sigma × 1.4
 *   forecast=−5°C (−20°C) → fatTailFactor = 1.4  → sigma × 1.4
 */
function applyFatTailSigma(
  baseSigma:    number,
  forecastC:    number,
  historicalAvg = HISTORICAL_AVG_C
): number {
  const deviation      = Math.abs(forecastC - historicalAvg);
  const fatTailFactor  = 1 + (deviation / 10) * 0.2;
  return baseSigma * fatTailFactor;
}

// ---------------------------------------------------------------------------
// Maths : distribution gaussienne
// ---------------------------------------------------------------------------

/** Approximation de la fonction erf (Abramowitz & Stegun 7.1.26). */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

/** CDF de la loi normale : P(X <= x) avec X ~ N(mean, sigma²). */
function gaussianCDF(x: number, mean: number, sigma: number): number {
  return 0.5 * (1 + erf((x - mean) / (sigma * Math.SQRT2)));
}

/** P(X >= threshold) via CDF — pour les outcomes "above". */
function probAboveCDF(threshold: number, mean: number, sigma: number): number {
  const result = 1 - gaussianCDF(threshold, mean, sigma);
  console.log(`[weather-agent] probAboveCDF: threshold=${threshold}, mean=${mean}, sigma=${sigma}, result=${result}`);
  return result;
}

/** P(X <= threshold) via CDF — pour les outcomes "below". */
function probBelowCDF(threshold: number, mean: number, sigma: number): number {
  const result = gaussianCDF(threshold, mean, sigma);
  console.log(`[weather-agent] probBelowCDF: threshold=${threshold}, mean=${mean}, sigma=${sigma}, result=${result}`);
  return result;
}

/**
 * Probabilité gaussienne pour une température cible (type "exact" ou milieu de plage).
 *
 * Formule : exp(-0.5 * ((target - forecast) / sigma)²)
 * Retourne la densité gaussienne en target, normalisée à [0.01, 0.99].
 * Interprétation : 1.0 si target = forecast, décroît avec la distance.
 */
function probGaussianPDF(target: number, forecast: number, sigma: number): number {
  const distance = target - forecast;
  const raw = Math.exp(-0.5 * Math.pow(distance / sigma, 2));
  return Math.max(0.01, Math.min(0.99, raw));
}

// ---------------------------------------------------------------------------
// Conversion d'unité
// ---------------------------------------------------------------------------

function celsiusToFahrenheit(c: number): number {
  return c * (9 / 5) + 32;
}

// Codes ICAO US commencent par K ; villes US courantes en minuscules
const US_CITY_NAMES = new Set([
  "new york", "new york city", "los angeles", "miami", "chicago",
  "dallas", "houston", "phoenix", "las vegas", "atlanta",
  "boston", "seattle", "denver", "minneapolis", "detroit",
  "san francisco", "washington", "philadelphia", "portland",
]);

/**
 * Détermine l'unité de température d'un marché Polymarket en appliquant
 * la hiérarchie suivante (premier signal non-ambigu gagne) :
 *
 *   1. Symbole explicite dans la question   ("°F" → F, "°C" → C)
 *   2. Symbole explicite dans les outcomes  ("°F" → F, "°C" → C)
 *   3. Heuristique géographique             (ICAO K… ou ville US → F)
 *   4. Fallback sur market.unit             (défaut Gamma)
 */
function resolveMarketUnit(
  question:     string,
  outcomes:     string[],
  stationCode:  string,
  city:         string,
  marketUnit:   "F" | "C"
): "F" | "C" {
  // 1. Question
  if (/°\s*F\b/i.test(question) || /fahrenheit/i.test(question)) return "F";
  if (/°\s*C\b/i.test(question) || /celsius/i.test(question))    return "C";

  // 2. Outcomes
  for (const o of outcomes) {
    if (/°\s*F\b/i.test(o) || /fahrenheit/i.test(o)) return "F";
    if (/°\s*C\b/i.test(o) || /celsius/i.test(o))    return "C";
  }

  // 3. Heuristique géographique
  //    Codes ICAO US (K…) et villes US → Fahrenheit
  if (/^K[A-Z]{3}$/i.test(stationCode)) return "F";
  if (US_CITY_NAMES.has(city.toLowerCase())) return "F";

  // 4. Fallback
  return marketUnit;
}

// ---------------------------------------------------------------------------
// Parsing des outcomes
// ---------------------------------------------------------------------------

interface ParsedOutcome {
  type: "exact" | "range" | "above" | "below" | "unknown";
  /** Température cible pour les types "exact" et "range" — dans l'unité du marché. */
  target?: number;
  /** Seuil pour les types "above" et "below" — dans l'unité du marché. */
  threshold?: number;
}

/**
 * Parse un libellé d'outcome Polymarket en bornes numériques.
 *
 * Formats supportés (par ordre de priorité) :
 *   "22°C or above" / "22°F or above" / "above 22°C"  → above, threshold=22
 *   "22°C or below" / "below 22°C"                    → below, threshold=22
 *   "90 - 94" / "22-23°C"                             → range,  target=midpoint
 *   "Above 95" / "≥ 95"                               → above, threshold=94.5
 *   "Below 85" / "≤ 85"                               → below, threshold=85.5
 *   "22°C" / "22" / "be 22°C"                         → exact,  target=22
 *   "Yes" / "No"                                      → binary (seuil question)
 */
/**
 * Parse un libellé d'outcome Polymarket en bornes numériques.
 *
 * Pour les marchés binaires (Yes/No), le sens de la question est propagé
 * via `binaryQ` pour résoudre directement au bon type :
 *   "Yes" + above → above   "Yes" + exact → exact   "Yes" + below → below
 *   "No"  + above → below   "No"  + exact → unknown  "No"  + below → above
 */
function parseOutcome(label: string, binaryQ?: BinaryQuestion): ParsedOutcome {
  const t = label.trim();

  // 1. "X°C or above" / "X°F or above" / "above X°C"
  const orAboveMatch = t.match(/^([\d.]+)\s*°?[FCfc]?\s+or\s+above$/i)
    ?? t.match(/^above\s+([\d.]+)\s*°?[FCfc]?$/i);
  if (orAboveMatch) {
    return { type: "above", threshold: parseFloat(orAboveMatch[1]) };
  }

  // 2. "X°C or below" / "X°F or below" / "below X°C"
  const orBelowMatch = t.match(/^([\d.]+)\s*°?[FCfc]?\s+or\s+below$/i)
    ?? t.match(/^below\s+([\d.]+)\s*°?[FCfc]?$/i);
  if (orBelowMatch) {
    return { type: "below", threshold: parseFloat(orBelowMatch[1]) };
  }

  // 3. "X - Y" / "X–Y" / "X-Y°C" / "X°C - Y°C" (plage)
  const rangeMatch = t.match(/^([\d.]+)\s*°?[FCfc]?\s*[-–]\s*([\d.]+)\s*°?[FCfc]?$/);
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1]);
    const hi = parseFloat(rangeMatch[2]);
    return { type: "range", target: (lo + hi) / 2 };
  }

  // 4. "Above X" / "≥ X" / "> X" (sans unité suffixée)
  const aboveMatch = t.match(/^(?:Above|>=?|≥)\s*([\d.]+)/i);
  if (aboveMatch) {
    return { type: "above", threshold: parseFloat(aboveMatch[1]) - 0.5 };
  }

  // 5. "Below X" / "≤ X" / "< X" / "Under X" (sans unité suffixée)
  const belowMatch = t.match(/^(?:Below|<=?|≤|Under)\s*([\d.]+)/i);
  if (belowMatch) {
    return { type: "below", threshold: parseFloat(belowMatch[1]) + 0.5 };
  }

  // 6. "be X°C" / "be X°F" / "X°C" / "X°F" / nombre seul → exact
  const exactMatch = t.match(/^(?:be\s+)?([\d.]+)\s*°?[FCfc]?$/i);
  if (exactMatch) {
    return { type: "exact", target: parseFloat(exactMatch[1]) };
  }

  // 7. Marchés binaires (Yes / No) — résolution via le type de question
  if (/^yes$/i.test(t)) {
    if (!binaryQ) return { type: "unknown" };
    if (binaryQ.type === "exact") return { type: "exact",  target:    binaryQ.threshold };
    if (binaryQ.type === "above") return { type: "above",  threshold: binaryQ.threshold };
    if (binaryQ.type === "below") return { type: "below",  threshold: binaryQ.threshold };
  }
  if (/^no$/i.test(t)) {
    if (!binaryQ) return { type: "unknown" };
    // "No" = complément logique de la question
    if (binaryQ.type === "exact") return { type: "unknown" }; // P(≠ exactement X) non calculable simplement
    if (binaryQ.type === "above") return { type: "below",  threshold: binaryQ.threshold };
    if (binaryQ.type === "below") return { type: "above",  threshold: binaryQ.threshold };
  }

  return { type: "unknown" };
}

/** Résultat de l'analyse d'une question binaire Polymarket. */
interface BinaryQuestion {
  /** Sémantique de la question : "Will temp exceed X?" → above, "be X?" → exact */
  type:      "above" | "below" | "exact";
  threshold: number;
}

/**
 * Analyse la question d'un marché binaire pour extraire le seuil ET le sens.
 *
 *   "exceed X°" / "above X°"        → above  (P(X >= seuil))
 *   "below X°"  / "under X°"        → below  (P(X <= seuil))
 *   "be X°"     / "reach X°"        → exact  (PDF gaussien centré sur seuil)
 *   fallback "X°"                   → exact  (juste un nombre avec degré)
 */
function extractBinaryQuestion(question: string): BinaryQuestion | undefined {
  const aboveMatch = question.match(/(?:exceed|above)\s+([\d.]+)\s*°?[FCfc]/i);
  if (aboveMatch) return { type: "above", threshold: parseFloat(aboveMatch[1]) };

  const belowMatch = question.match(/(?:below|under)\s+([\d.]+)\s*°?[FCfc]/i);
  if (belowMatch) return { type: "below", threshold: parseFloat(belowMatch[1]) };

  const exactMatch = question.match(/(?:be|reach)\s+([\d.]+)\s*°?[FCfc]/i);
  if (exactMatch) return { type: "exact", threshold: parseFloat(exactMatch[1]) };

  const numMatch = question.match(/([\d.]+)\s*°[FCfc]/i);
  if (numMatch) return { type: "exact", threshold: parseFloat(numMatch[1]) };

  return undefined;
}

// ---------------------------------------------------------------------------
// Calcul de probabilité d'un outcome
// ---------------------------------------------------------------------------

/**
 * Calcule P(outcome) pour une distribution N(mean=forecast, sigma²).
 *
 * "exact" / "range" → PDF gaussien : exp(-0.5 * ((target - forecast) / sigma)²)
 * "above" / "below" / "binary" → CDF classique
 */
function probabilityForOutcome(
  parsed:   ParsedOutcome,
  forecast: number,
  sigma:    number,
  label:    string        // pour le log uniquement
): number {
  switch (parsed.type) {
    case "exact":
    case "range": {
      if (parsed.target == null) return NaN;
      const prob = probGaussianPDF(parsed.target, forecast, sigma);
      console.log(
        `[weather-agent] ${label}: question type=${parsed.type}, threshold=${parsed.target.toFixed(1)}, ` +
        `forecast=${forecast.toFixed(1)}, prob=${prob.toFixed(4)}`
      );
      return prob;
    }

    case "above":
      if (parsed.threshold == null) return NaN;
      return probAboveCDF(parsed.threshold, forecast, sigma);

    case "below":
      if (parsed.threshold == null) return NaN;
      return probBelowCDF(parsed.threshold, forecast, sigma);

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
 * @returns Liste des outcomes dont l'edge >= MIN_EDGE, triée par edge décroissant.
 */
export function analyzeMarket(
  market:   WeatherMarket,
  forecast: WeatherForecast
): Outcome[] {
  // 1. Unité effective — hiérarchie : question → outcomes → géographie → market.unit
  const effectiveUnit = resolveMarketUnit(
    market.question,
    market.outcomes,
    market.stationCode,
    market.city,
    market.unit
  );

  // 2. Température de prévision (Open-Meteo → °C) convertie si nécessaire
  const forecastTempC =
    market.measureType === "high" ? forecast.highTemp : forecast.lowTemp;
  const forecastTemp =
    effectiveUnit === "F" ? celsiusToFahrenheit(forecastTempC) : forecastTempC;

  // 3. Sigma dans l'unité effective (1°C ≈ 1.8°F) — avec correction fat tails
  const baseSigmaC  = forecast.dynamicSigma ?? (BASE_SIGMA_C / forecast.confidence);
  const sigmaC      = applyFatTailSigma(baseSigmaC, forecastTempC);
  const sigma       = effectiveUnit === "F" ? sigmaC * (9 / 5) : sigmaC;

  if (effectiveUnit === "F") {
    console.log(
      `[weather-agent] ${market.city}: forecast=${forecastTempC.toFixed(1)}°C → ${forecastTemp.toFixed(1)}°F (market is in °F)`
    );
  } else {
    console.log(
      `[weather-agent] ${market.city}: forecast=${forecastTemp.toFixed(1)}°C (market is in °C)`
    );
  }
  console.log(
    `[weather-agent] ${market.city}: baseSigma=${baseSigmaC.toFixed(2)}°C, adjustedSigma=${sigmaC.toFixed(2)}°C → ${sigma.toFixed(2)}°${effectiveUnit}, ` +
    `confidence=${forecast.confidenceLevel ?? forecast.confidence}` +
    (effectiveUnit !== market.unit ? ` [unit override: ${market.unit}→${effectiveUnit}]` : "")
  );

  // 4. Analyse de la question binaire (marchés Yes/No)
  const binaryQ = extractBinaryQuestion(market.question);
  console.log(`[weather-agent] Question: ${market.question}`);
  console.log(`[weather-agent] Binary question: type=${binaryQ?.type ?? "none"}, threshold=${binaryQ?.threshold ?? "none"}`);
  console.log(`[weather-agent] Forecast temp: ${forecastTemp}°${effectiveUnit}, Sigma: ${sigma}`);

  // 5. Pour chaque outcome : estimer P, calculer edge, filtrer
  const results: Outcome[] = [];

  for (let i = 0; i < market.outcomes.length; i++) {
    const label       = market.outcomes[i];
    const marketPrice = market.outcomePrices[i];

    // Prix invalides (marché résolu ou corrompu)
    if (marketPrice < 0.01 || marketPrice > 0.99) {
      console.log(`[weather-agent] Skipping outcome with invalid price: ${marketPrice} — "${label}"`);
      continue;
    }

    const parsed = parseOutcome(label, binaryQ);

    if (parsed.type === "unknown") {
      console.log(`[weather-agent] Outcome non reconnu : "${label}" — ignoré`);
      continue;
    }

    const estimatedProbability = probabilityForOutcome(parsed, forecastTemp, sigma, label);

    if (isNaN(estimatedProbability)) continue;

    const edge = estimatedProbability - marketPrice;

    // Edge > 50% : probablement une erreur de données
    if (edge > 0.50) {
      console.warn(
        `[weather-agent] Edge suspect (${(edge * 100).toFixed(1)}% > 50%) pour "${label}" ` +
        `— estimated=${(estimatedProbability * 100).toFixed(1)}%, price=${(marketPrice * 100).toFixed(1)}% — ignoré`
      );
      continue;
    }

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

  return results.sort((a, b) => b.edge - a.edge);
}
