/**
 * Gamma API — fetch marchés météo Polymarket via l'endpoint /events
 *
 * Expose deux fonctions publiques :
 *   - fetchAllWeatherMarkets() : point d'entrée principal, bascule entre
 *                                mock / Gamma réel selon USE_MOCK_DATA
 *   - parseMarketRules(raw)    : extrait station ICAO, URL Wunderground,
 *                                unité et type de mesure depuis la description
 *
 * fetchRealMarkets() appelle /events?tag_slug=weather&order=endDate&ascending=true
 * et filtre server-side les events d'aujourd'hui et demain. La ville est extraite
 * directement du titre via CITY_ALIASES (ex: "NYC" → KLGA).
 */

import { STATION_MAPPING } from "@/lib/data/station-mapping";
import { MOCK_WEATHER_MARKETS } from "@/lib/polymarket/mock-data";
import type { Market } from "@/types";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 3_000;
const MAX_RETRIES = 3;

const GAMMA_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

/**
 * Alias ville → code station ICAO.
 * La clé est le pattern à chercher dans le titre (insensible à la casse).
 * L'ordre compte : les alias les plus spécifiques en premier.
 */
const CITY_ALIASES: Record<string, string> = {
  "New York City": "KLGA",
  "New York":      "KLGA",
  "NYC":           "KLGA",
  "Los Angeles":   "KLAX",
  " LA ":          "KLAX",   // espace pour éviter faux-positifs (ex: "DALLAS")
  "London":        "EGLC",
  "Miami":         "KMIA",
  "Chicago":       "KMDW",
  "Dallas":        "KDFW",
  "Houston":       "KIAH",
  "Phoenix":       "KPHX",
  "Las Vegas":     "KLAS",
  "Vegas":         "KLAS",
  "Atlanta":       "KATL",
  "Tokyo":         "RJTT",
  "Paris":         "LFPO",
  "Sydney":        "YSSY",
};

// ---------------------------------------------------------------------------
// Types internes — réponse brute Gamma /events
// ---------------------------------------------------------------------------

/** Un market imbriqué dans un event Gamma. */
interface GammaEventMarket {
  id: string;
  question?: string;
  slug?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  volume?: string | number;
  liquidity?: string | number;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
}

/**
 * Un event Gamma (ex: "NYC High Temp April 15").
 * L'event porte le contexte (station, URL Wunderground) dans resolutionSource
 * ou description. Les outcomes/prix sont dans markets[].
 */
interface GammaEvent {
  id: string;
  title?: string;
  slug?: string;
  description?: string;
  /** URL de résolution officielle — contient l'URL Wunderground + station ICAO. */
  resolutionSource?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  markets?: GammaEventMarket[];
}

/**
 * Format intermédiaire commun utilisé par parseMarketRules.
 * Construit depuis un (GammaEvent + GammaEventMarket) combinés.
 */
interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  /** Concatène tout le texte utile de l'event pour le parsing de station. */
  description: string;
  outcomes: string | string[];
  outcomePrices: string | string[];
  volume: string;
  liquidity: string;
  endDate: string;
  active: boolean;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Type public
// ---------------------------------------------------------------------------

/** Extension de Market avec les champs météo extraits des règles du marché. */
export interface WeatherMarket extends Market {
  stationCode: string;
  wundergroundUrl: string;
  unit: "F" | "C";
  measureType: "high" | "low";
  targetDate: Date;
  city: string;
}

// ---------------------------------------------------------------------------
// Helpers généraux
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonField<T>(raw: string | T[] | undefined): T[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

function toNumberStr(val: string | number | undefined): string {
  if (val == null) return "0";
  return String(typeof val === "number" ? val : parseFloat(val) || 0);
}

// ---------------------------------------------------------------------------
// Helpers de parsing
// ---------------------------------------------------------------------------

/**
 * Extrait le code station ICAO depuis le titre d'un event Gamma.
 * Parcourt CITY_ALIASES dans l'ordre de déclaration (plus spécifique en premier).
 * Retourne null si aucune ville connue n'est trouvée.
 */
function extractCityFromTitle(title: string): { city: string; stationCode: string } | null {
  for (const [alias, stationCode] of Object.entries(CITY_ALIASES)) {
    // Construire un pattern regex :
    //   - alias avec espaces internes → recherche litérale insensible à la casse
    //   - alias entouré d'espaces (ex: " LA ") → pattern tel quel
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").trim();
    const pattern = alias.startsWith(" ") || alias.endsWith(" ")
      ? alias.trim()   // conserver les espaces pour les alias ambigus (" LA ")
      : `\\b${escaped}\\b`;
    if (new RegExp(pattern, "i").test(title)) {
      return { city: alias.trim(), stationCode };
    }
  }
  return null;
}

function extractWundergroundUrl(text: string): string | null {
  const match = text.match(
    /https?:\/\/(?:www\.)?wunderground\.com\/history\/[^\s)>"]+/
  );
  return match ? match[0] : null;
}

function extractUnit(text: string): "F" | "C" {
  if (/fahrenheit|°\s*F/i.test(text)) return "F";
  if (/celsius|°\s*C/i.test(text)) return "C";
  return "F";
}

function extractMeasureType(text: string): "high" | "low" {
  if (/\blow(est)?\s+temp/i.test(text) || /minimum\s+temp/i.test(text)) return "low";
  return "high";
}

function extractTargetDate(text: string): Date | null {
  const urlDateMatch = text.match(/\/date\/(\d{4}-\d{2}-\d{2})/);
  if (urlDateMatch) return new Date(urlDateMatch[1] + "T12:00:00Z");

  const humanMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (humanMatch) return new Date(humanMatch[0]);

  return null;
}

function extractStationCode(text: string): string | null {
  const knownCodes = Object.keys(STATION_MAPPING);

  const urlMatch = text.match(
    /wunderground\.com\/history\/daily\/[^/]+\/[^/]+\/[^/]+\/([A-Z]{3,4})\/date/
  );
  if (urlMatch && knownCodes.includes(urlMatch[1])) return urlMatch[1];

  for (const code of knownCodes) {
    if (new RegExp(`\\b${code}\\b`).test(text)) return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP — fetch avec retry et timeout
// ---------------------------------------------------------------------------

async function fetchWithRetry(url: string): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { headers: GAMMA_HEADERS, signal: controller.signal });

      if (res.status === 429 || res.status === 503) {
        if (attempt < MAX_RETRIES) {
          console.warn(
            `[gamma-api] ⚠ HTTP ${res.status} (tentative ${attempt}/${MAX_RETRIES}) — retry dans ${RETRY_DELAY_MS / 1000}s…`
          );
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(`Gamma API bloquée après ${MAX_RETRIES} tentatives : HTTP ${res.status}`);
      }

      if (!res.ok) throw new Error(`Gamma API erreur HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("aborted"));

      if (isAbort) {
        if (attempt < MAX_RETRIES) {
          console.warn(`[gamma-api] ⏱ Timeout (tentative ${attempt}/${MAX_RETRIES}) — retry dans ${RETRY_DELAY_MS / 1000}s…`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(`Gamma API timeout (${REQUEST_TIMEOUT_MS}ms) après ${MAX_RETRIES} tentatives`);
      }

      if (attempt < MAX_RETRIES) {
        console.warn(`[gamma-api] ✗ Erreur réseau (tentative ${attempt}/${MAX_RETRIES}) — retry dans ${RETRY_DELAY_MS / 1000}s…`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("fetchWithRetry: toutes les tentatives ont échoué");
}

// ---------------------------------------------------------------------------
// fetchRealMarkets — /events endpoint
// ---------------------------------------------------------------------------

/**
 * Récupère les marchés météo pour aujourd'hui et demain via :
 *   GET /events?tag_slug=weather&active=true&closed=false&order=endDate&ascending=true&limit=100
 *
 * Stratégie :
 *   - Les events sont triés par endDate croissant → on s'arrête dès qu'on
 *     dépasse demain (pas besoin de paginer au-delà).
 *   - La ville est extraite directement du titre via CITY_ALIASES.
 *   - Si le titre ne contient pas de ville connue, fallback sur l'extraction
 *     de station ICAO depuis la description/resolutionSource.
 *   - Les outcomes et prix proviennent des markets imbriqués dans l'event.
 */
async function fetchRealMarkets(): Promise<WeatherMarket[]> {
  const startTime = Date.now();

  // Dates en UTC dérivées dynamiquement depuis l'horloge serveur
  const nowUtc   = new Date();
  const today    = nowUtc.toISOString().split("T")[0];                                            // ex: "2026-04-14"
  const tomorrow = new Date(nowUtc.getTime() + 24 * 60 * 60 * 1000).toISOString().split("T")[0]; // ex: "2026-04-15"

  // Endpoint exact — tag_slug=weather + tri endDate ASC pour arrêt précoce possible
  const url =
    `${GAMMA_BASE}/events?tag_slug=weather&active=true&closed=false` +
    `&order=endDate&ascending=true&limit=100`;

  console.log(`[gamma-api] GET ${url}`);

  const res = await fetchWithRetry(url);
  const raw: unknown = await res.json();

  const allEvents: GammaEvent[] = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>).data as GammaEvent[] | undefined) ?? [];

  console.log(`[gamma-api] Fetched ${allEvents.length} total events`);

  // Filtre JS sur la chaîne ISO — .includes() est insensible aux suffixes de timezone
  const events = allEvents.filter((event) => {
    if (!event.endDate) return false;
    return event.endDate.includes(today) || event.endDate.includes(tomorrow);
  });

  console.log(`[gamma-api] Filtered to ${events.length} events for ${today} - ${tomorrow}`);

  if (events.length === 0) {
    console.warn("[gamma-api] WARNING: No weather events found for today or tomorrow");
  }

  const results: WeatherMarket[] = [];
  const seenIds = new Set<string>();

  for (const event of events) {
    const endDateStr = event.endDate ?? "";

    const title = event.title ?? "";
    const contextText = [title, event.description, event.resolutionSource]
      .filter(Boolean)
      .join(" ");

    // --- Résolution du code station ---
    // 1. Extraction depuis le titre (alias ville)
    const cityInfo = extractCityFromTitle(title);
    let stationCode: string | null = cityInfo?.stationCode ?? null;
    let resolvedCity: string | null = cityInfo?.city ?? null;

    // 2. Fallback : extraction depuis URL Wunderground dans la description
    if (!stationCode) {
      stationCode = extractStationCode(contextText);
      if (stationCode) {
        resolvedCity = STATION_MAPPING[stationCode]?.city ?? stationCode;
      }
    }

    if (!stationCode) {
      console.log(`[gamma-api] ⏭ Station introuvable pour "${title.slice(0, 60)}" — ignoré`);
      continue;
    }

    const stationInfo = STATION_MAPPING[stationCode];
    const city = stationInfo?.city ?? resolvedCity ?? stationCode;

    const markets = event.markets ?? [];
    if (markets.length === 0) {
      console.log(`[gamma-api] ⏭ Pas de markets imbriqués pour "${title.slice(0, 60)}" — ignoré`);
      continue;
    }

    // Métadonnées communes à tous les markets de cet event
    const unit = extractUnit(contextText);
    const measureType = extractMeasureType(contextText);
    const wundergroundUrl = extractWundergroundUrl(contextText) ?? "";
    const targetDate = extractTargetDate(contextText) ?? new Date(endDateStr);

    for (const m of markets) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);

      const outcomes = parseJsonField<string>(m.outcomes);
      const rawPrices = parseJsonField<string>(m.outcomePrices);
      const outcomePrices = rawPrices.map(Number);

      if (outcomes.length === 0 || outcomes.length !== outcomePrices.length) {
        console.log(`[gamma-api] ⏭ Outcomes invalides pour market ${m.id} — ignoré`);
        continue;
      }

      const market: WeatherMarket = {
        id:            m.id,
        question:      m.question ?? title,
        slug:          m.slug ?? event.slug ?? m.id,
        category:      "weather",
        outcomes,
        outcomePrices,
        volume:        parseFloat(toNumberStr(m.volume)),
        liquidity:     parseFloat(toNumberStr(m.liquidity)),
        endDate:       new Date(m.endDate ?? endDateStr),
        stationCode,
        wundergroundUrl,
        unit,
        measureType,
        targetDate,
        city,
      };

      results.push(market);
      console.log(
        `[gamma-api] ✓ ${city} (${stationCode}) — "${market.question.slice(0, 70)}"`
      );
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[gamma-api] Found ${results.length} weather events for today/tomorrow (${elapsed}s)`);

  return results;
}

// ---------------------------------------------------------------------------
// fetchAllWeatherMarkets — point d'entrée public
// ---------------------------------------------------------------------------

export async function fetchAllWeatherMarkets(): Promise<WeatherMarket[]> {
  if (process.env.USE_MOCK_DATA === "true") {
    console.log(`[gamma-api] Mode mock activé — ${MOCK_WEATHER_MARKETS.length} marchés retournés`);
    return MOCK_WEATHER_MARKETS;
  }

  try {
    const markets = await fetchRealMarkets();
    if (markets.length === 0) {
      console.warn("[gamma-api] Aucun marché météo trouvé (aujourd'hui/demain).");
    }
    return markets;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[gamma-api] ✗ Échec total après ${MAX_RETRIES} tentatives : ${msg}\n` +
        `           → Fallback sur ${MOCK_WEATHER_MARKETS.length} marchés mock`
    );
    return MOCK_WEATHER_MARKETS;
  }
}

// ---------------------------------------------------------------------------
// parseMarketRules — export public (utilisé par les tests et le mock)
// ---------------------------------------------------------------------------

export function parseMarketRules(raw: GammaMarket): WeatherMarket | null {
  const text = `${raw.question} ${raw.description}`;

  const stationCode = extractStationCode(text);
  if (!stationCode) return null;

  const wundergroundUrl = extractWundergroundUrl(text);
  if (!wundergroundUrl) return null;

  const outcomes = parseJsonField<string>(raw.outcomes);
  const rawPrices = parseJsonField<string>(raw.outcomePrices);
  const outcomePrices = rawPrices.map(Number);

  if (outcomes.length === 0 || outcomes.length !== outcomePrices.length) return null;

  const stationInfo = STATION_MAPPING[stationCode];
  const unit = extractUnit(text);
  const measureType = extractMeasureType(text);
  const targetDate = extractTargetDate(text) ?? new Date(raw.endDate);

  return {
    id:            raw.id,
    question:      raw.question,
    slug:          raw.slug,
    category:      "weather",
    outcomes,
    outcomePrices,
    volume:        parseFloat(raw.volume),
    liquidity:     parseFloat(raw.liquidity),
    endDate:       new Date(raw.endDate),
    stationCode,
    wundergroundUrl,
    unit,
    measureType,
    targetDate,
    city:          stationInfo?.city ?? stationCode,
  };
}
