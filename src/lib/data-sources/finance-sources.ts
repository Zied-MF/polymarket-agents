/**
 * Finance data sources — Finnhub (gratuit, 60 req/min)
 *
 * Expose trois fonctions publiques :
 *   - fetchStockData(ticker)       : prix, variation, open/high/low via /quote
 *   - fetchPreMarketData(ticker)   : toujours null (non disponible plan gratuit)
 *   - calculateTechnicals(history) : no-op — retourne neutral (RSI/SMA indisponibles)
 *
 * Endpoint Finnhub utilisé :
 *   GET /quote?symbol={ticker}&token={key}
 *   → { c: current, d: change, dp: change%, h: high, l: low, o: open, pc: previousClose }
 *
 * Rate limit : 60 req/min → délai 100ms entre requêtes.
 */

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface StockData {
  /** Dernier prix en séance. */
  currentPrice: number;
  /** Clôture précédente. */
  previousClose: number;
  /** Prix d'ouverture du jour. */
  open: number;
  /** Plus haut du jour. */
  high: number;
  /** Plus bas du jour. */
  low: number;
  /** Variation absolue en USD. */
  change: number;
  /** Variation relative en %. */
  changePercent: number;
  /** Volume du jour — 0 (non disponible sur /quote gratuit). */
  volume: number;
  /** Volume moyen — 0 (non disponible sur /quote gratuit). */
  avgVolume: number;
  /** Historique de clôtures — vide (pas de /stock/candle sur plan gratuit). */
  priceHistory: number[];
}

export interface PreMarketData {
  preMarketPrice: number | null;
  preMarketChange: number | null;
  /** En %, ex: 1.25 signifie +1.25%. */
  preMarketChangePercent: number | null;
}

export interface Technicals {
  /** RSI — null (historique indisponible). */
  rsi: number | null;
  /** SMA20 — null (historique indisponible). */
  sma20: number | null;
  /** Tendance — toujours neutral (sans historique). */
  trend: "bullish" | "bearish" | "neutral";
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const FINNHUB_BASE         = "https://finnhub.io/api/v1";
const FINNHUB_API_KEY      = process.env.FINNHUB_API_KEY ?? "demo";
const INTER_REQUEST_DELAY_MS = 100; // ms — plan gratuit 60 req/min
const MAX_RETRIES            = 3;

// ---------------------------------------------------------------------------
// Types internes — réponse brute Finnhub /quote
// ---------------------------------------------------------------------------

interface FinnhubQuote {
  c:  number; // current price
  d:  number; // change
  dp: number; // change percent
  h:  number; // high of day
  l:  number; // low of day
  o:  number; // open of day
  pc: number; // previous close
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch avec exponential backoff sur 429 et erreurs réseau.
 * Délais : 1 s → 2 s → 4 s.
 */
async function fetchWithRetry<T>(
  url:       string,
  options?:  RequestInit,
  maxRetries = MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);

      if (res.status === 429) {
        const delay = Math.pow(2, attempt) * 1_000;
        console.log(`[finance-sources] Rate limited (429), retry in ${delay}ms…`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} : ${body}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1_000;
        console.log(`[finance-sources] Error: ${lastError.message}, retry in ${delay}ms…`);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

async function fetchFinnhub<T>(path: string): Promise<T> {
  await sleep(INTER_REQUEST_DELAY_MS);
  const url = `${FINNHUB_BASE}${path}`;
  return fetchWithRetry<T>(url, { headers: { Accept: "application/json" } });
}

// ---------------------------------------------------------------------------
// Fonctions publiques
// ---------------------------------------------------------------------------

/**
 * Récupère le prix actuel, variation et range du jour via /quote.
 * @throws si le ticker est invalide ou si Finnhub est indisponible.
 */
export async function fetchStockData(ticker: string): Promise<StockData> {
  const sym   = encodeURIComponent(ticker);
  const quote = await fetchFinnhub<FinnhubQuote>(
    `/quote?symbol=${sym}&token=${FINNHUB_API_KEY}`
  );

  if (!quote.c || quote.c === 0) {
    throw new Error(`Finnhub: ticker inconnu ou marché fermé pour "${ticker}"`);
  }

  return {
    currentPrice:  Math.round(quote.c  * 100) / 100,
    previousClose: Math.round(quote.pc * 100) / 100,
    open:          Math.round(quote.o  * 100) / 100,
    high:          Math.round(quote.h  * 100) / 100,
    low:           Math.round(quote.l  * 100) / 100,
    change:        Math.round(quote.d  * 100) / 100,
    changePercent: Math.round(quote.dp * 100) / 100,
    // Non disponibles sur /quote gratuit — conservés pour compatibilité
    volume:        0,
    avgVolume:     0,
    priceHistory:  [],
  };
}

/**
 * Données pré-marché — indisponibles sur le plan gratuit Finnhub.
 * Retourne toujours null : le Finance Agent traitera le signal comme neutre (0 pts).
 */
export async function fetchPreMarketData(_ticker: string): Promise<PreMarketData> {
  return { preMarketPrice: null, preMarketChange: null, preMarketChangePercent: null };
}

/**
 * Indicateurs techniques — RSI/SMA indisponibles sans historique.
 * Retourne toujours neutral : le Finance Agent utilise désormais changePercent et range.
 */
export function calculateTechnicals(_priceHistory: number[]): Technicals {
  return { rsi: null, sma20: null, trend: "neutral" };
}
