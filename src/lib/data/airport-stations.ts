/**
 * Mapping complet des villes vers leurs aéroports de résolution Polymarket.
 * Source: Weather Underground stations utilisées par Polymarket.
 *
 * CRITIQUE: Utiliser ces coordonnées pour TOUTES les requêtes météo.
 * Les aéroports peuvent être 3-8°F différents du city center — impact direct sur le win rate.
 */

export interface AirportStation {
  lat:      number;
  lon:      number;
  icao:     string;
  name:     string;
  timezone: string;
  country:  string;
}

export const AIRPORT_STATIONS: Record<string, AirportStation> = {
  // === ÉTATS-UNIS ===
  "new york":      { lat: 40.7769, lon: -73.8740,  icao: "KLGA",  name: "LaGuardia Airport",              timezone: "America/New_York",                  country: "US" },
  "nyc":           { lat: 40.7769, lon: -73.8740,  icao: "KLGA",  name: "LaGuardia Airport",              timezone: "America/New_York",                  country: "US" },
  "los angeles":   { lat: 33.9416, lon: -118.4085, icao: "KLAX",  name: "Los Angeles International",      timezone: "America/Los_Angeles",               country: "US" },
  "la":            { lat: 33.9416, lon: -118.4085, icao: "KLAX",  name: "Los Angeles International",      timezone: "America/Los_Angeles",               country: "US" },
  "chicago":       { lat: 41.9742, lon: -87.9073,  icao: "KORD",  name: "O'Hare International",           timezone: "America/Chicago",                   country: "US" },
  "miami":         { lat: 25.7959, lon: -80.2870,  icao: "KMIA",  name: "Miami International",            timezone: "America/New_York",                  country: "US" },
  "houston":       { lat: 29.9844, lon: -95.3414,  icao: "KIAH",  name: "George Bush Intercontinental",   timezone: "America/Chicago",                   country: "US" },
  "atlanta":       { lat: 33.6407, lon: -84.4277,  icao: "KATL",  name: "Hartsfield-Jackson",             timezone: "America/New_York",                  country: "US" },
  "denver":        { lat: 39.8561, lon: -104.6737, icao: "KDEN",  name: "Denver International",           timezone: "America/Denver",                    country: "US" },
  "seattle":       { lat: 47.4502, lon: -122.3088, icao: "KSEA",  name: "Seattle-Tacoma International",   timezone: "America/Los_Angeles",               country: "US" },
  "boston":        { lat: 42.3656, lon: -71.0096,  icao: "KBOS",  name: "Logan International",            timezone: "America/New_York",                  country: "US" },
  "dallas":        { lat: 32.8471, lon: -96.8518,  icao: "KDAL",  name: "Dallas Love Field",              timezone: "America/Chicago",                   country: "US" },
  "san francisco": { lat: 37.6213, lon: -122.3790, icao: "KSFO",  name: "San Francisco International",    timezone: "America/Los_Angeles",               country: "US" },
  "phoenix":       { lat: 33.4373, lon: -112.0078, icao: "KPHX",  name: "Phoenix Sky Harbor",             timezone: "America/Phoenix",                   country: "US" },
  "las vegas":     { lat: 36.0840, lon: -115.1537, icao: "KLAS",  name: "Harry Reid International",       timezone: "America/Los_Angeles",               country: "US" },
  "philadelphia":  { lat: 39.8729, lon: -75.2437,  icao: "KPHL",  name: "Philadelphia International",     timezone: "America/New_York",                  country: "US" },
  "san diego":     { lat: 32.7336, lon: -117.1897, icao: "KSAN",  name: "San Diego International",        timezone: "America/Los_Angeles",               country: "US" },
  "detroit":       { lat: 42.2162, lon: -83.3554,  icao: "KDTW",  name: "Detroit Metropolitan",           timezone: "America/Detroit",                   country: "US" },
  "minneapolis":   { lat: 44.8848, lon: -93.2223,  icao: "KMSP",  name: "Minneapolis-Saint Paul",         timezone: "America/Chicago",                   country: "US" },
  "orlando":       { lat: 28.4312, lon: -81.3081,  icao: "KMCO",  name: "Orlando International",          timezone: "America/New_York",                  country: "US" },
  "portland":      { lat: 45.5898, lon: -122.5951, icao: "KPDX",  name: "Portland International",         timezone: "America/Los_Angeles",               country: "US" },
  "charlotte":     { lat: 35.2140, lon: -80.9431,  icao: "KCLT",  name: "Charlotte Douglas",              timezone: "America/New_York",                  country: "US" },
  "austin":        { lat: 30.1975, lon: -97.6664,  icao: "KAUS",  name: "Austin-Bergstrom",               timezone: "America/Chicago",                   country: "US" },
  "nashville":     { lat: 36.1263, lon: -86.6774,  icao: "KBNA",  name: "Nashville International",        timezone: "America/Chicago",                   country: "US" },
  "salt lake city":{ lat: 40.7884, lon: -111.9778, icao: "KSLC",  name: "Salt Lake City International",   timezone: "America/Denver",                    country: "US" },
  "washington":    { lat: 38.8512, lon: -77.0402,  icao: "KDCA",  name: "Reagan National",                timezone: "America/New_York",                  country: "US" },
  "washington dc": { lat: 38.8512, lon: -77.0402,  icao: "KDCA",  name: "Reagan National",                timezone: "America/New_York",                  country: "US" },
  "baltimore":     { lat: 39.1774, lon: -76.6684,  icao: "KBWI",  name: "Baltimore/Washington",           timezone: "America/New_York",                  country: "US" },
  "tampa":         { lat: 27.9756, lon: -82.5333,  icao: "KTPA",  name: "Tampa International",            timezone: "America/New_York",                  country: "US" },
  "st louis":      { lat: 38.7487, lon: -90.3700,  icao: "KSTL",  name: "St. Louis Lambert",              timezone: "America/Chicago",                   country: "US" },
  "pittsburgh":    { lat: 40.4915, lon: -80.2329,  icao: "KPIT",  name: "Pittsburgh International",       timezone: "America/New_York",                  country: "US" },
  "cleveland":     { lat: 41.4117, lon: -81.8498,  icao: "KCLE",  name: "Cleveland Hopkins",              timezone: "America/New_York",                  country: "US" },
  "kansas city":   { lat: 39.2976, lon: -94.7139,  icao: "KMCI",  name: "Kansas City International",      timezone: "America/Chicago",                   country: "US" },
  "indianapolis":  { lat: 39.7173, lon: -86.2944,  icao: "KIND",  name: "Indianapolis International",     timezone: "America/Indiana/Indianapolis",       country: "US" },
  "new orleans":   { lat: 29.9934, lon: -90.2580,  icao: "KMSY",  name: "Louis Armstrong",                timezone: "America/Chicago",                   country: "US" },
  "san antonio":   { lat: 29.5337, lon: -98.4698,  icao: "KSAT",  name: "San Antonio International",      timezone: "America/Chicago",                   country: "US" },
  "honolulu":      { lat: 21.3187, lon: -157.9225, icao: "PHNL",  name: "Daniel K. Inouye",               timezone: "Pacific/Honolulu",                  country: "US" },
  "anchorage":     { lat: 61.1743, lon: -149.9962, icao: "PANC",  name: "Ted Stevens Anchorage",          timezone: "America/Anchorage",                 country: "US" },

  // === EUROPE ===
  "london":        { lat: 51.4700, lon: -0.4543,   icao: "EGLL",  name: "Heathrow Airport",               timezone: "Europe/London",                     country: "UK" },
  "paris":         { lat: 49.0097, lon: 2.5479,    icao: "LFPG",  name: "Charles de Gaulle",              timezone: "Europe/Paris",                      country: "FR" },
  "berlin":        { lat: 52.3570, lon: 13.5214,   icao: "EDDB",  name: "Berlin Brandenburg",             timezone: "Europe/Berlin",                     country: "DE" },
  "madrid":        { lat: 40.4719, lon: -3.5626,   icao: "LEMD",  name: "Adolfo Suárez Madrid–Barajas",   timezone: "Europe/Madrid",                     country: "ES" },
  "rome":          { lat: 41.8003, lon: 12.2389,   icao: "LIRF",  name: "Leonardo da Vinci–Fiumicino",    timezone: "Europe/Rome",                       country: "IT" },
  "amsterdam":     { lat: 52.3105, lon: 4.7683,    icao: "EHAM",  name: "Schiphol",                       timezone: "Europe/Amsterdam",                  country: "NL" },
  "frankfurt":     { lat: 50.0379, lon: 8.5622,    icao: "EDDF",  name: "Frankfurt Airport",              timezone: "Europe/Berlin",                     country: "DE" },
  "munich":        { lat: 48.3537, lon: 11.7750,   icao: "EDDM",  name: "Munich Airport",                 timezone: "Europe/Berlin",                     country: "DE" },
  "zurich":        { lat: 47.4582, lon: 8.5555,    icao: "LSZH",  name: "Zurich Airport",                 timezone: "Europe/Zurich",                     country: "CH" },
  "vienna":        { lat: 48.1103, lon: 16.5697,   icao: "LOWW",  name: "Vienna International",           timezone: "Europe/Vienna",                     country: "AT" },
  "barcelona":     { lat: 41.2974, lon: 2.0833,    icao: "LEBL",  name: "Barcelona–El Prat",              timezone: "Europe/Madrid",                     country: "ES" },
  "milan":         { lat: 45.6306, lon: 8.7281,    icao: "LIMC",  name: "Milan Malpensa",                 timezone: "Europe/Rome",                       country: "IT" },
  "dublin":        { lat: 53.4264, lon: -6.2499,   icao: "EIDW",  name: "Dublin Airport",                 timezone: "Europe/Dublin",                     country: "IE" },
  "lisbon":        { lat: 38.7742, lon: -9.1342,   icao: "LPPT",  name: "Humberto Delgado",               timezone: "Europe/Lisbon",                     country: "PT" },
  "stockholm":     { lat: 59.6498, lon: 17.9238,   icao: "ESSA",  name: "Stockholm Arlanda",              timezone: "Europe/Stockholm",                  country: "SE" },
  "copenhagen":    { lat: 55.6180, lon: 12.6508,   icao: "EKCH",  name: "Copenhagen Airport",             timezone: "Europe/Copenhagen",                 country: "DK" },
  "oslo":          { lat: 60.1976, lon: 11.1004,   icao: "ENGM",  name: "Oslo Gardermoen",                timezone: "Europe/Oslo",                       country: "NO" },
  "helsinki":      { lat: 60.3172, lon: 24.9633,   icao: "EFHK",  name: "Helsinki-Vantaa",                timezone: "Europe/Helsinki",                   country: "FI" },
  "brussels":      { lat: 50.9014, lon: 4.4844,    icao: "EBBR",  name: "Brussels Airport",               timezone: "Europe/Brussels",                   country: "BE" },
  "prague":        { lat: 50.1008, lon: 14.2600,   icao: "LKPR",  name: "Václav Havel Airport",           timezone: "Europe/Prague",                     country: "CZ" },
  "warsaw":        { lat: 52.1657, lon: 20.9671,   icao: "EPWA",  name: "Warsaw Chopin",                  timezone: "Europe/Warsaw",                     country: "PL" },
  "athens":        { lat: 37.9364, lon: 23.9445,   icao: "LGAV",  name: "Athens International",           timezone: "Europe/Athens",                     country: "GR" },
  "istanbul":      { lat: 41.2753, lon: 28.7519,   icao: "LTFM",  name: "Istanbul Airport",               timezone: "Europe/Istanbul",                   country: "TR" },
  "moscow":        { lat: 55.9726, lon: 37.4146,   icao: "UUEE",  name: "Sheremetyevo",                   timezone: "Europe/Moscow",                     country: "RU" },

  // === ASIE ===
  "tokyo":         { lat: 35.5494, lon: 139.7798,  icao: "RJTT",  name: "Haneda Airport",                 timezone: "Asia/Tokyo",                        country: "JP" },
  "seoul":         { lat: 37.4602, lon: 126.4407,  icao: "RKSI",  name: "Incheon International",          timezone: "Asia/Seoul",                        country: "KR" },
  "beijing":       { lat: 40.0799, lon: 116.6031,  icao: "ZBAA",  name: "Beijing Capital",                timezone: "Asia/Shanghai",                     country: "CN" },
  "shanghai":      { lat: 31.1443, lon: 121.8083,  icao: "ZSPD",  name: "Shanghai Pudong",                timezone: "Asia/Shanghai",                     country: "CN" },
  "hong kong":     { lat: 22.3080, lon: 113.9185,  icao: "VHHH",  name: "Hong Kong International",        timezone: "Asia/Hong_Kong",                    country: "HK" },
  "singapore":     { lat: 1.3644,  lon: 103.9915,  icao: "WSSS",  name: "Changi Airport",                 timezone: "Asia/Singapore",                    country: "SG" },
  "bangkok":       { lat: 13.6900, lon: 100.7501,  icao: "VTBS",  name: "Suvarnabhumi Airport",           timezone: "Asia/Bangkok",                      country: "TH" },
  "mumbai":        { lat: 19.0896, lon: 72.8656,   icao: "VABB",  name: "Chhatrapati Shivaji",            timezone: "Asia/Kolkata",                      country: "IN" },
  "delhi":         { lat: 28.5562, lon: 77.1000,   icao: "VIDP",  name: "Indira Gandhi International",    timezone: "Asia/Kolkata",                      country: "IN" },
  "dubai":         { lat: 25.2532, lon: 55.3657,   icao: "OMDB",  name: "Dubai International",            timezone: "Asia/Dubai",                        country: "AE" },
  "abu dhabi":     { lat: 24.4330, lon: 54.6511,   icao: "OMAA",  name: "Abu Dhabi International",        timezone: "Asia/Dubai",                        country: "AE" },
  "kuala lumpur":  { lat: 2.7456,  lon: 101.7099,  icao: "WMKK",  name: "Kuala Lumpur International",     timezone: "Asia/Kuala_Lumpur",                 country: "MY" },
  "taipei":        { lat: 25.0797, lon: 121.2342,  icao: "RCTP",  name: "Taiwan Taoyuan",                 timezone: "Asia/Taipei",                       country: "TW" },
  "osaka":         { lat: 34.4347, lon: 135.2441,  icao: "RJBB",  name: "Kansai International",           timezone: "Asia/Tokyo",                        country: "JP" },
  "jakarta":       { lat: -6.1256, lon: 106.6558,  icao: "WIII",  name: "Soekarno-Hatta",                 timezone: "Asia/Jakarta",                      country: "ID" },
  "manila":        { lat: 14.5086, lon: 121.0198,  icao: "RPLL",  name: "Ninoy Aquino",                   timezone: "Asia/Manila",                       country: "PH" },
  "ho chi minh":   { lat: 10.8188, lon: 106.6519,  icao: "VVTS",  name: "Tan Son Nhat",                   timezone: "Asia/Ho_Chi_Minh",                  country: "VN" },
  "hanoi":         { lat: 21.2212, lon: 105.8070,  icao: "VVNB",  name: "Noi Bai International",          timezone: "Asia/Ho_Chi_Minh",                  country: "VN" },

  // === OCÉANIE ===
  "sydney":        { lat: -33.9399, lon: 151.1753, icao: "YSSY",  name: "Sydney Kingsford Smith",         timezone: "Australia/Sydney",                  country: "AU" },
  "melbourne":     { lat: -37.6690, lon: 144.8410, icao: "YMML",  name: "Melbourne Airport",              timezone: "Australia/Melbourne",               country: "AU" },
  "brisbane":      { lat: -27.3942, lon: 153.1218, icao: "YBBN",  name: "Brisbane Airport",               timezone: "Australia/Brisbane",               country: "AU" },
  "perth":         { lat: -31.9403, lon: 115.9669, icao: "YPPH",  name: "Perth Airport",                  timezone: "Australia/Perth",                   country: "AU" },
  "auckland":      { lat: -37.0082, lon: 174.7850, icao: "NZAA",  name: "Auckland Airport",               timezone: "Pacific/Auckland",                  country: "NZ" },

  // === AMÉRIQUE DU SUD ===
  "sao paulo":     { lat: -23.6273, lon: -46.6566, icao: "SBGR",  name: "Guarulhos International",        timezone: "America/Sao_Paulo",                 country: "BR" },
  "rio de janeiro":{ lat: -22.8100, lon: -43.2505, icao: "SBGL",  name: "Galeão International",           timezone: "America/Sao_Paulo",                 country: "BR" },
  "buenos aires":  { lat: -34.8222, lon: -58.5358, icao: "SAEZ",  name: "Ezeiza International",           timezone: "America/Argentina/Buenos_Aires",     country: "AR" },
  "bogota":        { lat: 4.7016,   lon: -74.1469, icao: "SKBO",  name: "El Dorado International",        timezone: "America/Bogota",                    country: "CO" },
  "lima":          { lat: -12.0219, lon: -77.1143, icao: "SPJC",  name: "Jorge Chávez International",     timezone: "America/Lima",                      country: "PE" },
  "santiago":      { lat: -33.3930, lon: -70.7858, icao: "SCEL",  name: "Arturo Merino Benítez",          timezone: "America/Santiago",                  country: "CL" },
  "mexico city":   { lat: 19.4363,  lon: -99.0721, icao: "MMMX",  name: "Benito Juárez International",    timezone: "America/Mexico_City",               country: "MX" },

  // === AFRIQUE & MOYEN-ORIENT ===
  "cairo":         { lat: 30.1219, lon: 31.4056,   icao: "HECA",  name: "Cairo International",            timezone: "Africa/Cairo",                      country: "EG" },
  "johannesburg":  { lat: -26.1392, lon: 28.2460,  icao: "FAOR",  name: "O. R. Tambo International",      timezone: "Africa/Johannesburg",               country: "ZA" },
  "cape town":     { lat: -33.9715, lon: 18.6021,  icao: "FACT",  name: "Cape Town International",        timezone: "Africa/Johannesburg",               country: "ZA" },
  "nairobi":       { lat: -1.3192,  lon: 36.9278,  icao: "HKJK",  name: "Jomo Kenyatta",                  timezone: "Africa/Nairobi",                    country: "KE" },
  "tel aviv":      { lat: 32.0055, lon: 34.8854,   icao: "LLBG",  name: "Ben Gurion Airport",             timezone: "Asia/Jerusalem",                    country: "IL" },
  "doha":          { lat: 25.2731, lon: 51.6081,   icao: "OTHH",  name: "Hamad International",            timezone: "Asia/Qatar",                        country: "QA" },
  "riyadh":        { lat: 24.9576, lon: 46.6988,   icao: "OERK",  name: "King Khalid International",      timezone: "Asia/Riyadh",                       country: "SA" },

  // === CANADA ===
  "toronto":       { lat: 43.6777, lon: -79.6248,  icao: "CYYZ",  name: "Toronto Pearson",                timezone: "America/Toronto",                   country: "CA" },
  "vancouver":     { lat: 49.1967, lon: -123.1815, icao: "CYVR",  name: "Vancouver International",        timezone: "America/Vancouver",                 country: "CA" },
  "montreal":      { lat: 45.4706, lon: -73.7408,  icao: "CYUL",  name: "Montréal-Trudeau",               timezone: "America/Toronto",                   country: "CA" },
  "calgary":       { lat: 51.1315, lon: -114.0103, icao: "CYYC",  name: "Calgary International",          timezone: "America/Edmonton",                  country: "CA" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Aliases courts → clé canonique dans AIRPORT_STATIONS. */
export const CITY_ALIASES: Record<string, string> = {
  nyc:    "new york",
  la:     "los angeles",
  sf:     "san francisco",
  dc:     "washington dc",
  philly: "philadelphia",
  vegas:  "las vegas",
  nola:   "new orleans",
  hk:     "hong kong",
  kl:     "kuala lumpur",
};

/** Normalise une ville en clé lowercase canonique pour lookup dans AIRPORT_STATIONS. */
export function normalizeAirportCity(city: string): string {
  const lower = city.toLowerCase().trim();
  return CITY_ALIASES[lower] ?? lower;
}

/** Retourne la station aéroport pour une ville, ou null si inconnue. */
export function getAirportStation(city: string): AirportStation | null {
  return AIRPORT_STATIONS[normalizeAirportCity(city)] ?? null;
}

/** Retourne true si la ville est aux États-Unis selon le mapping. */
export function isUSCity(city: string): boolean {
  return getAirportStation(city)?.country === "US";
}
