/**
 * Mapping station/ville → coordonnées géographiques + métadonnées
 *
 * Deux types de clés dans STATION_MAPPING :
 *   • Codes ICAO  (ex: "KLGA") — utilisés quand la résolution Polymarket cite
 *     un code aéroport dans l'URL Wunderground.
 *   • Noms de ville (ex: "Atlanta") — utilisés par check-results pour la
 *     résolution des paper trades (qui stockent trade.city, pas station_code).
 *
 * Les coordonnées sont celles du centre-ville (pas de l'aéroport) pour que
 * l'API Open-Meteo retourne une température représentative de la ville entière.
 * Open-Meteo interpole à partir d'une grille ERA5 — quelques km de décalage
 * n'ont pas d'impact significatif sur la température prévue.
 */

export interface StationInfo {
  lat:      number;
  lon:      number;
  city:     string;
  country:  string;
  /** Timezone IANA, nécessaire pour que Open-Meteo retourne les bonnes dates. */
  timezone: string;
}

// ---------------------------------------------------------------------------
// Stations de référence (définies une fois, réutilisées par les deux indexes)
// ---------------------------------------------------------------------------

function s(
  lat: number, lon: number,
  city: string, country: string,
  timezone: string
): StationInfo {
  return { lat, lon, city, country, timezone };
}

const NYC     = s( 40.7769,   -73.8740,  "New York City",  "US", "America/New_York");
const LAX     = s( 33.9425,  -118.4081,  "Los Angeles",    "US", "America/Los_Angeles");
const LON     = s( 51.5074,    -0.1278,  "London",         "GB", "Europe/London");
const MIA     = s( 25.7959,   -80.2870,  "Miami",          "US", "America/New_York");
const CHI     = s( 41.7868,   -87.7522,  "Chicago",        "US", "America/Chicago");
const DAL     = s( 32.8998,   -97.0403,  "Dallas",         "US", "America/Chicago");
const HOU     = s( 29.7604,   -95.3698,  "Houston",        "US", "America/Chicago");
const PHX     = s( 33.4373,  -112.0078,  "Phoenix",        "US", "America/Phoenix");
const LAS     = s( 36.0800,  -115.1522,  "Las Vegas",      "US", "America/Los_Angeles");
const ATL     = s( 33.7490,   -84.3880,  "Atlanta",        "US", "America/New_York");
const TKY     = s( 35.6762,   139.6503,  "Tokyo",          "JP", "Asia/Tokyo");
const PAR     = s( 48.8566,     2.3522,  "Paris",          "FR", "Europe/Paris");
const SYD     = s(-33.8688,   151.2093,  "Sydney",         "AU", "Australia/Sydney");
const TOR     = s( 43.6532,   -79.3832,  "Toronto",        "CA", "America/Toronto");
const SEO     = s( 37.5665,   126.9780,  "Seoul",          "KR", "Asia/Seoul");

// ---------------------------------------------------------------------------
// Index principal — clé ICAO (utilisé par scan-markets via stationCode)
// ---------------------------------------------------------------------------

/** Toutes les stations connues. Supporte deux types de clés :
 *  - code ICAO (ex: "KLGA") pour les lookups depuis gamma-api / weather-sources
 *  - nom de ville (ex: "Atlanta") pour la résolution des paper trades
 */
export const STATION_MAPPING: Record<string, StationInfo> = {
  // ── USA ───────────────────────────────────────────────────────────────────
  // New York — LaGuardia (station de référence Polymarket pour NYC)
  KLGA:  NYC,

  // Los Angeles — LAX
  KLAX:  LAX,

  // Miami — Miami International
  KMIA:  MIA,

  // Chicago — Midway (station Polymarket pour Chicago, non O'Hare)
  KMDW:  CHI,

  // Dallas/Fort Worth
  KDFW:  DAL,

  // Houston — George Bush Intercontinental
  KIAH:  HOU,

  // Phoenix — Sky Harbor
  KPHX:  PHX,

  // Las Vegas — Harry Reid International
  KLAS:  LAS,

  // Atlanta — Hartsfield-Jackson
  KATL:  ATL,

  // ── Canada ───────────────────────────────────────────────────────────────
  // Toronto — Pearson International
  CYYZ:  TOR,

  // ── Europe ───────────────────────────────────────────────────────────────
  // London — London City Airport (code ICAO utilisé par Polymarket)
  EGLC:  LON,

  // Paris — Orly (LFPO, plus proche du centre que CDG)
  LFPO:  PAR,

  // ── Asia-Pacific ─────────────────────────────────────────────────────────
  // Tokyo — Haneda
  RJTT:  TKY,

  // Seoul — Gimpo International (plus proche du centre que Incheon)
  RKSS:  SEO,

  // Sydney — Kingsford Smith
  YSSY:  SYD,

  // ── Aliases par nom de ville ──────────────────────────────────────────────
  // Utilisés par check-results pour résoudre les paper trades via trade.city
  "New York City":  NYC,
  "New York":       NYC,
  "NYC":            NYC,
  "Los Angeles":    LAX,
  "Miami":          MIA,
  "Chicago":        CHI,
  "Dallas":         DAL,
  "Houston":        HOU,
  "Phoenix":        PHX,
  "Las Vegas":      LAS,
  "Vegas":          LAS,
  "Atlanta":        ATL,
  "Toronto":        TOR,
  "London":         LON,
  "Paris":          PAR,
  "Tokyo":          TKY,
  "Seoul":          SEO,
  "Sydney":         SYD,
};
