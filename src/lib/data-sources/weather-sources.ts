/**
 * Sources météo - Open-Meteo multi-modèles
 *
 * Expose deux fonctions publiques :
 *   - fetchForecast(lat, lon, date, timezone) : appelle Open-Meteo avec
 *     trois modèles (GFS, ECMWF, Icon) et retourne un WeatherForecast enrichi :
 *       • highTemp / lowTemp : moyenne des modèles disponibles (°C)
 *       • modelHighTemps     : températures max par modèle
 *       • modelSpread        : écart max entre modèles (°C)
 *       • dynamicSigma       : sigma calculé depuis spread + délai temporel
 *       • confidenceLevel    : "high" | "medium" | "low" selon spread
 *   - fetchForecastForStation(stationCode, date) : raccourci ICAO → coordonnées
 *
 * Sigma dynamique :
 *   spread = max(|GFS - ECMWF|, |GFS - Icon|, |ECMWF - Icon|)
 *   timeFactor : < 24h → 1.0 / < 48h → 1.5 / sinon → 2.0
 *   sigma = max(1.5, spread / 2 + timeFactor)
 */

import { STATION_MAPPING }                    from "@/lib/data/station-mapping";
import { getCoordinates }                     from "@/lib/data-sources/geocoding";
import type { WeatherForecast, ModelTemps }   from "@/types";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

// Modèles à interroger — les trois sont disponibles mondialement
const MODELS = ["gfs_seamless", "ecmwf_ifs04", "icon_seamless"] as const;
type ModelKey = typeof MODELS[number];

// ---------------------------------------------------------------------------
// Types internes
// ---------------------------------------------------------------------------

/** Réponse brute Open-Meteo multi-modèles */
interface MultiModelResponse {
  daily?: {
    time?: string[];
    [key: string]: unknown; // clés dynamiques: "{model}_temperature_2m_max"
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Confiance temporelle [0, 1] basée sur le délai de prévision.
 * Utilisée pour la compatibilité avec le champ `confidence` (numérique).
 */
function forecastConfidence(targetDate: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  if (diffDays <= 1) return 0.9;
  if (diffDays <= 3) return 0.8;
  if (diffDays <= 6) return 0.7;
  if (diffDays <= 10) return 0.6;
  return 0.5;
}

/**
 * Heures entre maintenant et la date cible (à minuit UTC).
 * Utilisé pour le time factor du sigma dynamique.
 */
function hoursUntil(targetDate: Date): number {
  const now = Date.now();
  const target = new Date(targetDate);
  target.setUTCHours(23, 59, 0, 0); // fin de journée cible
  return Math.max(0, (target.getTime() - now) / (1000 * 60 * 60));
}

/**
 * Extrait la valeur d'une clé "{model}_temperature_2m_{type}" depuis la
 * réponse brute pour une date donnée.
 * Retourne null si absent ou invalide.
 */
function extractModelTemp(
  daily: MultiModelResponse["daily"],
  dateStr: string,
  model: ModelKey,
  type: "max" | "min"
): number | null {
  if (!daily) return null;
  const times = (daily.time as string[] | undefined) ?? [];
  const idx = times.indexOf(dateStr);
  if (idx === -1) return null;

  const key = `${model}_temperature_2m_${type}`;
  const series = daily[key];
  if (!Array.isArray(series)) return null;
  const val = series[idx];
  return typeof val === "number" && isFinite(val) ? val : null;
}

/**
 * Moyenne d'un tableau de valeurs non-null.
 * Retourne null si le tableau est vide.
 */
function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Écart max entre toutes les paires d'un tableau de valeurs.
 * Retourne 0 si moins de 2 valeurs.
 */
function maxSpread(values: number[]): number {
  if (values.length < 2) return 0;
  let spread = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      spread = Math.max(spread, Math.abs(values[i] - values[j]));
    }
  }
  return spread;
}

/**
 * Sigma dynamique en °C :
 *   timeFactor : < 24h → 1.0 / < 48h → 1.5 / sinon → 2.0
 *   sigma = max(1.5, modelSpread / 2 + timeFactor)
 */
function computeDynamicSigma(spreadC: number, targetDate: Date): number {
  const hours = hoursUntil(targetDate);
  const timeFactor = hours < 24 ? 1.0 : hours < 48 ? 1.5 : 2.0;
  return Math.max(1.5, spreadC / 2 + timeFactor);
}

function computeConfidenceLevel(spreadC: number): "high" | "medium" | "low" {
  if (spreadC < 1) return "high";
  if (spreadC <= 3) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Fonctions publiques
// ---------------------------------------------------------------------------

export function getStationCoordinates(stationCode: string) {
  return STATION_MAPPING[stationCode] ?? STATION_MAPPING[stationCode.toUpperCase()];
}

/**
 * Appelle Open-Meteo avec GFS + ECMWF + Icon et retourne un WeatherForecast
 * enrichi avec sigma dynamique et niveau de confiance basé sur l'accord des modèles.
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

  const url = new URL(OPEN_METEO_BASE);
  url.searchParams.set("latitude",   String(lat));
  url.searchParams.set("longitude",  String(lon));
  url.searchParams.set("daily",      "temperature_2m_max,temperature_2m_min");
  url.searchParams.set("models",     MODELS.join(","));
  url.searchParams.set("timezone",   timezone);
  url.searchParams.set("start_date", dateStr);
  url.searchParams.set("end_date",   dateStr);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Open-Meteo error ${res.status}: ${await res.text()}`);
  }

  const data: MultiModelResponse = await res.json();

  // --- Extraction des températures max par modèle ---
  const gfsHigh  = extractModelTemp(data.daily, dateStr, "gfs_seamless",   "max");
  const ecmwfHigh = extractModelTemp(data.daily, dateStr, "ecmwf_ifs04",    "max");
  const iconHigh = extractModelTemp(data.daily, dateStr, "icon_seamless",  "max");

  const gfsLow   = extractModelTemp(data.daily, dateStr, "gfs_seamless",   "min");
  const ecmwfLow  = extractModelTemp(data.daily, dateStr, "ecmwf_ifs04",    "min");
  const iconLow  = extractModelTemp(data.daily, dateStr, "icon_seamless",  "min");

  // --- Moyennes (au moins un modèle requis) ---
  const highValues = [gfsHigh, ecmwfHigh, iconHigh].filter((v): v is number => v !== null);
  const lowValues  = [gfsLow,  ecmwfLow,  iconLow ].filter((v): v is number => v !== null);

  if (highValues.length === 0 || lowValues.length === 0) {
    throw new Error(
      `Open-Meteo: aucune donnée de température pour ${dateStr} ` +
      `à (${lat}, ${lon}). Modèles: ${MODELS.join(", ")}`
    );
  }

  const highTemp = average(highValues)!;
  const lowTemp  = average(lowValues)!;

  // --- Spread et sigma dynamique ---
  const spreadC        = maxSpread(highValues);
  const dynamicSigma   = computeDynamicSigma(spreadC, date);
  const confidenceLevel = computeConfidenceLevel(spreadC);

  const modelHighTemps: ModelTemps = {
    ...(gfsHigh   !== null && { gfs:   gfsHigh   }),
    ...(ecmwfHigh !== null && { ecmwf: ecmwfHigh }),
    ...(iconHigh  !== null && { icon:  iconHigh  }),
  };

  return {
    city:            "", // rempli par fetchForecastForStation
    country:         "",
    highTemp,
    lowTemp,
    confidence:      forecastConfidence(date),
    confidenceLevel,
    dynamicSigma,
    modelSpread:     Math.round(spreadC * 10) / 10,
    modelHighTemps,
    source:          `open-meteo(${Object.keys(modelHighTemps).join("+")})`,
    fetchedAt:       new Date(),
  };
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
  // --- Chemin rapide : mapping statique ---
  const station = getStationCoordinates(cityOrCode);
  if (station) {
    const forecast = await fetchForecast(station.lat, station.lon, date, station.timezone);
    return { ...forecast, city: station.city, country: station.country };
  }

  // --- Fallback : géocodage dynamique ---
  const geo = await getCoordinates(cityOrCode);
  if (!geo) {
    // Le log "[geocoding] Unknown city: …" est déjà émis par getCoordinates
    return null;
  }

  const forecast = await fetchForecast(geo.lat, geo.lon, date, "auto");
  return { ...forecast, city: cityOrCode, country: geo.country };
}
