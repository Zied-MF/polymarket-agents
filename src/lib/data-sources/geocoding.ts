/**
 * Geocoding — résolution de noms de villes en coordonnées géographiques
 *
 * Stratégie en trois couches :
 *   1. Cache mémoire (Map) — pré-peuplé depuis STATION_MAPPING au démarrage
 *   2. Cache Supabase (table city_coordinates) — persistant entre redémarrages
 *   3. API Open-Meteo Geocoding (gratuite, sans clé, 100ms de délai avant appel)
 *
 * Export principaux :
 *   - getCoordinates(cityName)  → { lat, lon, country } | null
 *   - normalizeCity(raw)        → forme canonique ("NYC" → "New York City")
 */

import { createClient }       from "@supabase/supabase-js";
import { STATION_MAPPING }    from "@/lib/data/station-mapping";
import { getAirportStation }  from "@/lib/data/airport-stations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeoResult {
  lat:     number;
  lon:     number;
  country: string;
}

// ---------------------------------------------------------------------------
// Normalisation des abbréviations
// ---------------------------------------------------------------------------

/**
 * Table de normalisation : abbréviation majuscule → nom canonique.
 * Utilisée à la fois ici et dans gamma-api pour standardiser les noms de villes
 * avant tout lookup ou appel géocodage.
 */
const ABBREVIATIONS: Record<string, string> = {
  // USA
  "NYC":  "New York City",
  "NY":   "New York City",
  "LA":   "Los Angeles",
  "SF":   "San Francisco",
  "DC":   "Washington",
  "CHI":  "Chicago",
  "ATL":  "Atlanta",
  "HOU":  "Houston",
  "PHX":  "Phoenix",
  "LAS":  "Las Vegas",
  "LV":   "Las Vegas",
  "DFW":  "Dallas",
  "MIA":  "Miami",
  // Canada
  "TOR":  "Toronto",
  "VAN":  "Vancouver",
  // UK
  "LON":  "London",
  // Japan
  "TYO":  "Tokyo",
};

/**
 * Retourne la forme canonique d'un nom de ville.
 * - Résout les abbréviations connues (cas insensible)
 * - Title-case le résultat
 * Ex: "nyc" → "New York City", "PARIS" → "Paris"
 */
export function normalizeCity(raw: string): string {
  const trimmed = raw.trim();
  const upper   = trimmed.toUpperCase();
  return ABBREVIATIONS[upper] ?? trimmed;
}

// ---------------------------------------------------------------------------
// Cache mémoire
// ---------------------------------------------------------------------------

/** null = ville connue comme introuvable (évite des appels API répétés). */
const MEMORY_CACHE = new Map<string, GeoResult | null>();

/**
 * Pré-peuple le cache depuis les alias de noms de villes dans STATION_MAPPING.
 * Seules les clés non-ICAO (qui contiennent des minuscules ou des espaces) sont
 * chargées, les codes ICAO (ex: "KLGA") sont ignorés.
 */
(function seedCacheFromMapping() {
  for (const [key, info] of Object.entries(STATION_MAPPING)) {
    // Les codes ICAO sont 3-4 lettres majuscules, les noms de ville ont d'autres formes
    if (/^[A-Z]{3,4}$/.test(key)) continue;
    MEMORY_CACHE.set(key.toLowerCase(), {
      lat:     info.lat,
      lon:     info.lon,
      country: info.country,
    });
  }
})();

// ---------------------------------------------------------------------------
// Client Supabase léger (optionnel — graceful si env vars absentes)
// ---------------------------------------------------------------------------

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadFromSupabase(cacheKey: string): Promise<GeoResult | undefined> {
  const sb = getSupabaseClient();
  if (!sb) return undefined;

  try {
    const { data } = await sb
      .from("city_coordinates")
      .select("latitude, longitude, country")
      .eq("city_name", cacheKey)
      .maybeSingle();

    if (data) {
      return {
        lat:     Number(data.latitude),
        lon:     Number(data.longitude),
        country: data.country ?? "",
      };
    }
  } catch {
    // Supabase indisponible — on continue sans cache persistant
  }
  return undefined;
}

async function saveToSupabase(cacheKey: string, result: GeoResult): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) return;

  try {
    await sb.from("city_coordinates").upsert(
      {
        city_name:  cacheKey,
        latitude:   result.lat,
        longitude:  result.lon,
        country:    result.country,
      },
      { onConflict: "city_name" }
    );
  } catch {
    // Échec silencieux : le cache Supabase est best-effort
  }
}

// ---------------------------------------------------------------------------
// API Open-Meteo Geocoding
// ---------------------------------------------------------------------------

const GEOCODING_BASE = "https://geocoding-api.open-meteo.com/v1/search";

interface OpenMeteoGeoResult {
  name?:       string;
  latitude?:   number;
  longitude?:  number;
  country?:    string;
}

interface OpenMeteoGeoResponse {
  results?: OpenMeteoGeoResult[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchFromOpenMeteo(cityName: string): Promise<GeoResult | null> {
  const url = new URL(GEOCODING_BASE);
  url.searchParams.set("name",     cityName);
  url.searchParams.set("count",    "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format",   "json");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.warn(`[geocoding] API HTTP ${res.status} pour "${cityName}"`);
      return null;
    }

    const data: OpenMeteoGeoResponse = await res.json();
    const first = data.results?.[0];

    if (
      !first ||
      typeof first.latitude  !== "number" ||
      typeof first.longitude !== "number"
    ) {
      return null;
    }

    return {
      lat:     Math.round(first.latitude  * 10000) / 10000,
      lon:     Math.round(first.longitude * 10000) / 10000,
      country: first.country ?? "",
    };
  } catch (err) {
    console.warn(
      `[geocoding] Erreur réseau pour "${cityName}" :`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

/**
 * Résout un nom de ville (ou abbréviation) en coordonnées géographiques.
 *
 * Priorité : cache mémoire → Supabase → API Open-Meteo (avec 100ms de délai).
 * Les résultats (y compris null) sont mis en cache pour éviter les appels répétés.
 *
 * @returns { lat, lon, country } ou null si la ville est introuvable
 */
export async function getCoordinates(cityName: string): Promise<GeoResult | null> {
  const normalized = normalizeCity(cityName);
  const cacheKey   = normalized.toLowerCase();

  // 0. PRIORITÉ : coordonnées aéroport (stations utilisées par Polymarket pour résolution)
  const airport = getAirportStation(cityName) ?? getAirportStation(normalized);
  if (airport) {
    console.log(`[geocoding] ✈️ Airport: ${normalized} → ${airport.icao} (${airport.lat}, ${airport.lon})`);
    return { lat: airport.lat, lon: airport.lon, country: airport.country };
  }

  // 1. Cache mémoire
  if (MEMORY_CACHE.has(cacheKey)) {
    const cached = MEMORY_CACHE.get(cacheKey) ?? null;
    if (cached) {
      console.log(
        `[geocoding] ${normalized} → ${cached.lat}, ${cached.lon} (cached)`
      );
    } else {
      console.warn(`[geocoding] Unknown city: ${normalized} (skipped)`);
    }
    return cached;
  }

  // 2. Supabase
  const fromDb = await loadFromSupabase(cacheKey);
  if (fromDb !== undefined) {
    MEMORY_CACHE.set(cacheKey, fromDb);
    console.log(
      `[geocoding] ${normalized} → ${fromDb.lat}, ${fromDb.lon} (db)`
    );
    return fromDb;
  }

  // 3. Open-Meteo Geocoding API (rate-limit : 100ms)
  await sleep(100);
  const result = await fetchFromOpenMeteo(normalized);

  // Stocker en cache (même null, pour ne pas rappeler l'API)
  MEMORY_CACHE.set(cacheKey, result);

  if (result) {
    console.log(
      `[geocoding] ${normalized} → ${result.lat}, ${result.lon} (api)`
    );
    // Persister dans Supabase en arrière-plan (best-effort)
    saveToSupabase(cacheKey, result).catch(() => {});
  } else {
    console.warn(`[geocoding] Unknown city: ${normalized} (skipped)`);
  }

  return result;
}
