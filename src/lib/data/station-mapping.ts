/**
 * Mapping ICAO station code → coordonnées géographiques + métadonnées
 *
 * Utilisé par weather-sources.ts pour convertir un code de station
 * extrait des règles d'un marché Polymarket en coordonnées exploitables
 * par l'API Open-Meteo.
 *
 * Les 10 stations correspondent aux villes les plus actives sur les
 * marchés météo Polymarket (classement par volume observé).
 */

export interface StationInfo {
  lat: number;
  lon: number;
  city: string;
  country: string;
  /** Timezone IANA, nécessaire pour que Open-Meteo retourne les bonnes dates. */
  timezone: string;
}

/** Toutes les stations météo connues, indexées par code ICAO. */
export const STATION_MAPPING: Record<string, StationInfo> = {
  // 1. New York City — LaGuardia (station de référence Polymarket pour NYC)
  KLGA: {
    lat: 40.7769,
    lon: -73.874,
    city: "New York City",
    country: "US",
    timezone: "America/New_York",
  },
  // 2. Los Angeles — LAX
  KLAX: {
    lat: 33.9425,
    lon: -118.4081,
    city: "Los Angeles",
    country: "US",
    timezone: "America/Los_Angeles",
  },
  // 3. London — London City Airport (utilisé par Polymarket pour les marchés UK)
  EGLC: {
    lat: 51.5053,
    lon: 0.0553,
    city: "London",
    country: "GB",
    timezone: "Europe/London",
  },
  // 4. Miami — Miami International
  KMIA: {
    lat: 25.7959,
    lon: -80.287,
    city: "Miami",
    country: "US",
    timezone: "America/New_York",
  },
  // 5. Chicago — Midway (station Polymarket pour Chicago, non O'Hare)
  KMDW: {
    lat: 41.7868,
    lon: -87.7522,
    city: "Chicago",
    country: "US",
    timezone: "America/Chicago",
  },
  // 6. Dallas/Fort Worth
  KDFW: {
    lat: 32.8998,
    lon: -97.0403,
    city: "Dallas",
    country: "US",
    timezone: "America/Chicago",
  },
  // 7. Houston — George Bush Intercontinental
  KIAH: {
    lat: 29.9902,
    lon: -95.3368,
    city: "Houston",
    country: "US",
    timezone: "America/Chicago",
  },
  // 8. Phoenix — Sky Harbor
  KPHX: {
    lat: 33.4373,
    lon: -112.0078,
    city: "Phoenix",
    country: "US",
    timezone: "America/Phoenix",
  },
  // 9. Las Vegas — Harry Reid International
  KLAS: {
    lat: 36.08,
    lon: -115.1522,
    city: "Las Vegas",
    country: "US",
    timezone: "America/Los_Angeles",
  },
  // 10. Atlanta — Hartsfield-Jackson
  KATL: {
    lat: 33.6407,
    lon: -84.4277,
    city: "Atlanta",
    country: "US",
    timezone: "America/New_York",
  },
  // 11. Tokyo — Haneda (RJTT, station de référence pour les marchés Polymarket Japan)
  RJTT: {
    lat: 35.5494,
    lon: 139.7798,
    city: "Tokyo",
    country: "JP",
    timezone: "Asia/Tokyo",
  },
  // 12. Paris — Orly (LFPO, plus proche du centre que CDG)
  LFPO: {
    lat: 48.7233,
    lon: 2.3794,
    city: "Paris",
    country: "FR",
    timezone: "Europe/Paris",
  },
  // 13. Sydney — Kingsford Smith
  YSSY: {
    lat: -33.9461,
    lon: 151.1772,
    city: "Sydney",
    country: "AU",
    timezone: "Australia/Sydney",
  },
};
