/**
 * Sources météo - Open-Meteo endpoint standard
 *
 * Expose deux fonctions publiques :
 *   - fetchForecast(lat, lon, date, timezone) : appelle Open-Meteo (endpoint
 *     standard, pas multi-modèles) et retourne un WeatherForecast avec :
 *       • highTemp / lowTemp  : températures du jour cible (°C)
 *       • dynamicSigma        : sigma basé sur le délai de prévision
 *       • confidenceLevel     : "high" (J+1) | "medium" (J+2) | "low" (J+3+)
 *   - fetchForecastForStation(cityOrCode, date) : raccourci ICAO → coordonnées
 *
 * Sigma simplifié (sans multi-modèles) :
 *   J+1 (demain)  → sigma = 1.5°C, confidence = "high"
 *   J+2           → sigma = 2.5°C, confidence = "medium"
 *   J+3+          → sigma = 3.5°C, confidence = "low"
 */

import { STATION_MAPPING }                    from "@/lib/data/station-mapping";
import { getCoordinates }                     from "@/lib/data-sources/geocoding";
import type { WeatherForecast, ModelTemps }   from "@/types";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

// ---------------------------------------------------------------------------
// Cache mémoire — évite de refetch les mêmes coordonnées/date en 10 min
// (plusieurs marchés NYC 80°F / 81°F / 82°F partagent le même appel)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data:      WeatherForecast;
  timestamp: number;
}

const forecastCache = new Map<string, CacheEntry>();
const CACHE_TTL     = 10 * 60 * 1000; // 10 minutes

function getCachedForecast(key: string): WeatherForecast | null {
  const cached = forecastCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[weather-sources] 📦 Cache hit: ${key}`);
    return cached.data;
  }
  return null;
}

function setCachedForecast(key: string, data: WeatherForecast): void {
  forecastCache.set(key, { data, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// fetchInBatches — fetch séquentiel par batch avec délai entre chaque
// ---------------------------------------------------------------------------

export async function fetchInBatches<T, R>(
  items:     T[],
  fetchFn:   (item: T) => Promise<R>,
  batchSize = 5,
  delayMs   = 200
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch        = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fetchFn));
    results.push(...batchResults);
    // Délai entre les batches (sauf le dernier)
    if (i + batchSize < items.length) {
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Types internes
// ---------------------------------------------------------------------------

/** Réponse brute Open-Meteo endpoint standard */
interface StandardForecastResponse {
  daily?: {
    time?:                string[];
    temperature_2m_max?:  (number | null)[];
    temperature_2m_min?:  (number | null)[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Nombre de jours entiers entre aujourd'hui (minuit local) et la date cible.
 * J+0 = aujourd'hui, J+1 = demain, etc.
 */
function daysUntil(targetDate: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/**
 * Confiance numérique [0, 1] basée sur le délai de prévision.
 * Utilisée pour remplir le champ `confidence` (compatibilité avec les agents).
 */
function forecastConfidence(targetDate: Date): number {
  const days = daysUntil(targetDate);
  if (days <= 1) return 0.9;
  if (days <= 3) return 0.8;
  if (days <= 6) return 0.7;
  if (days <= 10) return 0.6;
  return 0.5;
}

/**
 * Sigma dynamique simplifié (°C) basé sur le délai de prévision.
 *   J+1 → 1.5  J+2 → 2.5  J+3+ → 3.5
 */
function computeDynamicSigma(targetDate: Date): number {
  const days = daysUntil(targetDate);
  if (days <= 1) return 1.5;
  if (days <= 2) return 2.5;
  return 3.5;
}

function computeConfidenceLevel(targetDate: Date): "high" | "medium" | "low" {
  const days = daysUntil(targetDate);
  if (days <= 1) return "high";
  if (days <= 2) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Fonctions publiques
// ---------------------------------------------------------------------------

export function getStationCoordinates(stationCode: string) {
  return STATION_MAPPING[stationCode] ?? STATION_MAPPING[stationCode.toUpperCase()];
}

/**
 * Appelle l'endpoint standard Open-Meteo et retourne un WeatherForecast.
 *
 * @param lat       Latitude décimale
 * @param lon       Longitude décimale
 * @param date      Date cible (seul le jour compte)
 * @param timezone  Timezone IANA de la station (ex: "America/New_York")
 */
export async function fetchForecast(
  lat: number,
  lon: number,
  date: Date,
  timezone = "auto"
): Promise<WeatherForecast> {
  const dateStr = toDateString(date);
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${dateStr}`;

  // Retourner depuis le cache si disponible (même station, même jour)
  const cached = getCachedForecast(cacheKey);
  if (cached) return cached;

  // Demander 16 jours pour couvrir tous les marchés Polymarket actifs
  const url = new URL(OPEN_METEO_BASE);
  url.searchParams.set("latitude",      String(lat));
  url.searchParams.set("longitude",     String(lon));
  url.searchParams.set("daily",         "temperature_2m_max,temperature_2m_min");
  url.searchParams.set("timezone",      timezone);
  url.searchParams.set("forecast_days", "16");

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo error ${res.status}: ${await res.text()}`);
  }

  const data: StandardForecastResponse = await res.json();

  // --- Trouver l'index de la date cible ---
  const times = data.daily?.time ?? [];
  const idx   = times.indexOf(dateStr);

  if (idx === -1) {
    throw new Error(
      `Open-Meteo: date ${dateStr} absente de la réponse ` +
      `(plage disponible: ${times[0] ?? "?"} → ${times[times.length - 1] ?? "?"}) ` +
      `pour (${lat}, ${lon})`
    );
  }

  // --- Extraction des températures ---
  const rawHigh = data.daily?.temperature_2m_max?.[idx] ?? null;
  const rawLow  = data.daily?.temperature_2m_min?.[idx] ?? null;

  if (rawHigh === null || !isFinite(rawHigh)) {
    throw new Error(`Open-Meteo: température max manquante pour ${dateStr} à (${lat}, ${lon})`);
  }
  if (rawLow === null || !isFinite(rawLow)) {
    throw new Error(`Open-Meteo: température min manquante pour ${dateStr} à (${lat}, ${lon})`);
  }

  const highTemp = Math.round(rawHigh * 10) / 10;
  const lowTemp  = Math.round(rawLow  * 10) / 10;

  // --- Sigma et confiance basés sur le délai ---
  const dynamicSigma    = computeDynamicSigma(date);
  const confidenceLevel = computeConfidenceLevel(date);

  // modelHighTemps vide (pas de multi-modèles dans cet endpoint)
  const modelHighTemps: ModelTemps = {};

  const result: WeatherForecast = {
    city:           "", // rempli par fetchForecastForStation
    country:        "",
    highTemp,
    lowTemp,
    confidence:     forecastConfidence(date),
    confidenceLevel,
    dynamicSigma,
    modelSpread:    0,
    modelHighTemps,
    source:         "open-meteo",
    fetchedAt:      new Date(),
  };

  setCachedForecast(cacheKey, result);
  return result;
}

/**
 * Raccourci : récupère coordonnées + prévision en une seule étape.
 *
 * Accepte un code ICAO (ex: "KLGA") ou un nom de ville (ex: "Atlanta").
 * Résolution en deux étapes :
 *   1. STATION_MAPPING (lookup immédiat, pas d'I/O)
 *   2. getCoordinates() — geocoding avec cache mémoire + Supabase + API
 *
 * Retourne null si la ville est introuvable (le marché sera ajouté à skipped[]).
 */
export async function fetchForecastForStation(
  cityOrCode: string,
  date: Date
): Promise<WeatherForecast | null> {
  const t0 = Date.now();

  // --- Chemin rapide : mapping statique ---
  const station = getStationCoordinates(cityOrCode);
  if (station) {
    const forecast = await fetchForecast(station.lat, station.lon, date, station.timezone);
    const result   = { ...forecast, city: station.city, country: station.country };
    const elapsed  = Date.now() - t0;

    console.log(
      `[weather-sources] ${station.city} ${date.toISOString().slice(0, 10)}: ` +
      `high=${result.highTemp}°C low=${result.lowTemp}°C ` +
      `sigma=${result.dynamicSigma} (${elapsed}ms)`
    );

    return result;
  }

  // --- Fallback : géocodage dynamique ---
  const geo = await getCoordinates(cityOrCode);
  if (!geo) {
    // Le log "[geocoding] Unknown city: …" est déjà émis par getCoordinates
    return null;
  }

  const forecast = await fetchForecast(geo.lat, geo.lon, date, "auto");
  const result   = { ...forecast, city: cityOrCode, country: geo.country };
  const elapsed  = Date.now() - t0;

  console.log(
    `[weather-sources] ${cityOrCode} ${date.toISOString().slice(0, 10)}: ` +
    `high=${result.highTemp}°C low=${result.lowTemp}°C ` +
    `sigma=${result.dynamicSigma} (${elapsed}ms)`
  );

  return result;
}

// ---------------------------------------------------------------------------
// ANCIEN CODE MULTI-MODÈLES — conservé pour réactivation éventuelle
// ---------------------------------------------------------------------------
//
// const MODELS = ["gfs_seamless", "ecmwf_ifs04", "icon_seamless"] as const;
// type ModelKey = typeof MODELS[number];
//
// interface MultiModelResponse {
//   daily?: {
//     time?: string[];
//     [key: string]: unknown;
//   };
// }
//
// function extractModelTemp(
//   daily: MultiModelResponse["daily"],
//   dateStr: string,
//   model: ModelKey,
//   type: "max" | "min"
// ): number | null {
//   if (!daily) return null;
//   const times = (daily.time as string[] | undefined) ?? [];
//   const idx = times.indexOf(dateStr);
//   if (idx === -1) return null;
//   const key = `${model}_temperature_2m_${type}`;
//   const series = daily[key];
//   if (!Array.isArray(series)) return null;
//   const val = series[idx];
//   return typeof val === "number" && isFinite(val) ? val : null;
// }
//
// function average(values: number[]): number | null {
//   if (values.length === 0) return null;
//   return values.reduce((s, v) => s + v, 0) / values.length;
// }
//
// function maxSpread(values: number[]): number {
//   if (values.length < 2) return 0;
//   let spread = 0;
//   for (let i = 0; i < values.length; i++) {
//     for (let j = i + 1; j < values.length; j++) {
//       spread = Math.max(spread, Math.abs(values[i] - values[j]));
//     }
//   }
//   return spread;
// }
//
// Pour réactiver, remplacer l'appel fetchForecast par fetchForecastMultiModel :
//
// export async function fetchForecastMultiModel(
//   lat: number, lon: number, date: Date, timezone = "auto"
// ): Promise<WeatherForecast> {
//   const dateStr = toDateString(date);
//   const url = new URL(OPEN_METEO_BASE);
//   url.searchParams.set("latitude",   String(lat));
//   url.searchParams.set("longitude",  String(lon));
//   url.searchParams.set("daily",      "temperature_2m_max,temperature_2m_min");
//   url.searchParams.set("models",     MODELS.join(","));
//   url.searchParams.set("timezone",   timezone);
//   url.searchParams.set("start_date", dateStr);
//   url.searchParams.set("end_date",   dateStr);
//
//   const res = await fetch(url.toString());
//   if (!res.ok) throw new Error(`Open-Meteo error ${res.status}: ${await res.text()}`);
//   const data: MultiModelResponse = await res.json();
//
//   const gfsHigh   = extractModelTemp(data.daily, dateStr, "gfs_seamless",  "max");
//   const ecmwfHigh = extractModelTemp(data.daily, dateStr, "ecmwf_ifs04",   "max");
//   const iconHigh  = extractModelTemp(data.daily, dateStr, "icon_seamless", "max");
//   const gfsLow    = extractModelTemp(data.daily, dateStr, "gfs_seamless",  "min");
//   const ecmwfLow  = extractModelTemp(data.daily, dateStr, "ecmwf_ifs04",   "min");
//   const iconLow   = extractModelTemp(data.daily, dateStr, "icon_seamless", "min");
//
//   const highValues = [gfsHigh, ecmwfHigh, iconHigh].filter((v): v is number => v !== null);
//   const lowValues  = [gfsLow,  ecmwfLow,  iconLow ].filter((v): v is number => v !== null);
//
//   if (highValues.length === 0 || lowValues.length === 0)
//     throw new Error(`Open-Meteo: aucune donnée pour ${dateStr} à (${lat}, ${lon})`);
//
//   const highTemp       = average(highValues)!;
//   const lowTemp        = average(lowValues)!;
//   const spreadC        = maxSpread(highValues);
//   const dynamicSigma   = Math.max(1.5, spreadC / 2 + (hoursUntil(date) < 24 ? 1.0 : hoursUntil(date) < 48 ? 1.5 : 2.0));
//   const confidenceLevel = spreadC < 1 ? "high" : spreadC <= 3 ? "medium" : "low";
//   const modelHighTemps: ModelTemps = {
//     ...(gfsHigh !== null && { gfs: gfsHigh }),
//     ...(ecmwfHigh !== null && { ecmwf: ecmwfHigh }),
//     ...(iconHigh !== null && { icon: iconHigh }),
//   };
//   return {
//     city: "", country: "", highTemp, lowTemp,
//     confidence: forecastConfidence(date), confidenceLevel, dynamicSigma,
//     modelSpread: Math.round(spreadC * 10) / 10, modelHighTemps,
//     source: `open-meteo(${Object.keys(modelHighTemps).join("+")})`, fetchedAt: new Date(),
//   };
// }
