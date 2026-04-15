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

import { STATION_MAPPING }                    from "@/lib/data/station-mapping";
import { normalizeCity }                      from "@/lib/data-sources/geocoding";
import { MOCK_WEATHER_MARKETS }               from "@/lib/polymarket/mock-data";
import type { Market }                        from "@/types";

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
  "Toronto":       "CYYZ",
  "Tokyo":         "RJTT",
  "Paris":         "LFPO",
  "Seoul":         "RKSS",
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

/**
 * Extrait le nom d'une ville depuis une phrase naturelle anglaise.
 * Exemples :
 *   "Highest temperature in Atlanta on April 14?"   → "Atlanta"
 *   "Will the high temp in New York City exceed 70°F?" → "New York City"
 *   "Low temperature in San Francisco for April 16" → "San Francisco"
 *
 * Stratégie :
 *   1. Cherche le pattern "in {City}" (1–3 mots en Title Case)
 *      suivi d'un marqueur temporel ou d'un indicateur de condition.
 *   2. Fallback : cherche simplement "in {CityWord}" sans contrainte de fin.
 *   3. Normalise via normalizeCity() pour résoudre les abbréviations.
 */
function extractCityFromSentence(title: string): string | null {
  // Pattern 1 : "in {City}" suivi d'un contexte temporel / conditionnel
  const strict = title.match(
    /\bin\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s+(?:on|for|be|above|below|exceed|at|during)\b/i
  );
  if (strict) return normalizeCity(strict[1].trim());

  // Pattern 2 : "in {City}" plus souple (fin de phrase ou ponctuation)
  const loose = title.match(
    /\bin\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/i
  );
  if (loose) {
    const candidate = loose[1].trim();
    // Écarter les faux positifs courants (articles, prépositions)
    const STOPWORDS = new Set(["the", "a", "an", "this", "that", "which", "its"]);
    if (!STOPWORDS.has(candidate.toLowerCase())) {
      return normalizeCity(candidate);
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

    // 3. Fallback : extraction depuis la phrase (ex: "temperature in Atlanta on April 14")
    //    La valeur retournée est le nom de ville normalisé — le géocodage se chargera
    //    de le résoudre en coordonnées si STATION_MAPPING ne le connaît pas.
    if (!stationCode) {
      const cityFromSentence = extractCityFromSentence(title);
      if (cityFromSentence) {
        stationCode  = cityFromSentence;
        resolvedCity = cityFromSentence;
        console.log(
          `[gamma-api] 🏙 Ville extraite depuis la phrase : "${cityFromSentence}" — "${title.slice(0, 60)}"`
        );
      }
    }

    if (!stationCode) {
      console.log(`[gamma-api] ⏭ Ville introuvable pour "${title.slice(0, 60)}" — ignoré`);
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

      // Skip les marchés résolus ou invalides : tous les prix à 0 ou 1
      if (outcomePrices.every((p) => p <= 0.01 || p >= 0.99)) {
        console.log(
          `[gamma-api] ⏭ Marché probablement résolu (tous les prix à 0 ou 1) : ${m.id} — ignoré`
        );
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
// StockMarket — type public pour les marchés finance
// ---------------------------------------------------------------------------

/**
 * Marché Polymarket de type stock (ex: "Will AAPL close higher on April 15?").
 * Étend Market avec le ticker boursier et la direction prédite.
 */
export interface StockMarket extends Market {
  /** Ticker boursier extrait de la question, ex: "AAPL". */
  ticker: string;
  /** Direction implicite du marché : "up", "down" ou "unknown". */
  direction: "up" | "down" | "unknown";
}

// ---------------------------------------------------------------------------
// fetchStockMarkets — /events?tag_slug=stocks
// ---------------------------------------------------------------------------

/** Mots anglais en majuscules courants à ignorer lors du parsing du ticker. */
const TICKER_SKIP = new Set([
  "WILL", "THE", "ON", "AT", "UP", "DOWN", "OR", "AND", "FOR", "IN", "BY",
  "IS", "IT", "TO", "BE", "AS", "AN", "IF", "OF", "DO", "SO", "NO", "YES",
  "CAN", "MAY", "HAS", "ITS", "ETF", "IPO", "CEO", "CFO",
]);

/**
 * Extrait le ticker boursier depuis la question d'un event Polymarket.
 * Priorité :
 *   1. Ticker entre parenthèses — ex: "Tesla (TSLA) close…" → "TSLA"
 *   2. Premier mot majuscule 2–5 lettres hors mots courants
 */
function extractTicker(question: string): string | null {
  const parenM = question.match(/\(([A-Z]{1,5})\)/);
  if (parenM) return parenM[1];

  const words = question.match(/\b[A-Z]{2,5}\b/g);
  if (words) {
    return words.find((w) => !TICKER_SKIP.has(w)) ?? null;
  }
  return null;
}

/**
 * Déduit la direction (up/down) depuis la question.
 * Ex: "close higher" / "end up" → "up" ; "close lower" / "end down" → "down".
 */
function extractDirection(question: string): "up" | "down" | "unknown" {
  const q = question.toLowerCase();
  if (/higher|above|gain|up|rise|rally|bull/i.test(q)) return "up";
  if (/lower|below|drop|down|fall|decline|bear/i.test(q)) return "down";
  return "unknown";
}

/**
 * Récupère les marchés financiers (stocks) actifs pour aujourd'hui et demain.
 *
 *   GET /events?tag_slug=stocks&active=true&closed=false&order=endDate&ascending=true&limit=100
 *
 * Tente aussi tag_slug=finance en parallèle pour maximiser la couverture.
 * Filtre strict en JS sur la date (identique à fetchRealMarkets).
 */
export async function fetchStockMarkets(): Promise<StockMarket[]> {
  const startTime = Date.now();
  const nowUtc    = new Date();
  const today     = nowUtc.toISOString().split("T")[0];
  const tomorrow  = new Date(nowUtc.getTime() + 86_400_000).toISOString().split("T")[0];

  console.log(`[gamma-api] fetchStockMarkets — today=${today} tomorrow=${tomorrow}`);

  // Fetch les deux tags en parallèle
  const tags = ["stocks", "finance"] as const;
  const fetchTag = async (tag: string): Promise<GammaEvent[]> => {
    const url =
      `${GAMMA_BASE}/events?tag_slug=${tag}&active=true&closed=false` +
      `&order=endDate&ascending=true&limit=100`;
    try {
      const res = await fetchWithRetry(url);
      const raw: unknown = await res.json();
      return Array.isArray(raw)
        ? raw
        : ((raw as Record<string, unknown>).data as GammaEvent[] | undefined) ?? [];
    } catch (err) {
      console.warn(
        `[gamma-api] ⚠ tag_slug=${tag} indisponible :`,
        err instanceof Error ? err.message : err
      );
      return [];
    }
  };

  const [stockEvents, financeEvents] = await Promise.all([
    fetchTag("stocks"),
    fetchTag("finance"),
  ]);

  // Dédupliquer par id
  const seen = new Set<string>();
  const allEvents: GammaEvent[] = [];
  for (const ev of [...stockEvents, ...financeEvents]) {
    if (ev.id && !seen.has(ev.id)) {
      seen.add(ev.id);
      allEvents.push(ev);
    }
  }

  console.log(`[gamma-api] fetchStockMarkets — ${allEvents.length} events bruts (stocks+finance)`);

  // Filtre sur la date
  const events = allEvents.filter((ev) => {
    if (!ev.endDate) return false;
    return ev.endDate.includes(today) || ev.endDate.includes(tomorrow);
  });

  console.log(`[gamma-api] fetchStockMarkets — ${events.length} events pour ${today}-${tomorrow}`);

  const results: StockMarket[] = [];
  const seenMarkets = new Set<string>();

  for (const event of events) {
    const title    = event.title ?? "";
    const endDateStr = event.endDate ?? "";
    const ticker   = extractTicker(title);
    const direction = extractDirection(title);

    if (!ticker) {
      console.log(`[gamma-api] ⏭ Ticker introuvable : "${title.slice(0, 60)}" — ignoré`);
      continue;
    }

    const markets = event.markets ?? [];
    if (markets.length === 0) continue;

    for (const m of markets) {
      if (seenMarkets.has(m.id)) continue;
      seenMarkets.add(m.id);

      const outcomes     = parseJsonField<string>(m.outcomes);
      const rawPrices    = parseJsonField<string>(m.outcomePrices);
      const outcomePrices = rawPrices.map(Number);

      if (outcomes.length === 0 || outcomes.length !== outcomePrices.length) continue;

      // Skip les marchés résolus ou invalides : tous les prix à 0 ou 1
      if (outcomePrices.every((p) => p <= 0.01 || p >= 0.99)) {
        console.log(
          `[gamma-api] ⏭ Marché finance probablement résolu (tous les prix à 0 ou 1) : ${m.id} — ignoré`
        );
        continue;
      }

      results.push({
        id:           m.id,
        question:     m.question ?? title,
        slug:         m.slug ?? event.slug ?? m.id,
        category:     "finance",
        outcomes,
        outcomePrices,
        volume:       parseFloat(toNumberStr(m.volume)),
        liquidity:    parseFloat(toNumberStr(m.liquidity)),
        endDate:      new Date(m.endDate ?? endDateStr),
        ticker,
        direction,
      });

      console.log(
        `[gamma-api] ✓ ${ticker} (${direction}) — "${(m.question ?? title).slice(0, 70)}"`
      );
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[gamma-api] fetchStockMarkets — ${results.length} marchés finance (${elapsed}s)`);
  return results;
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
