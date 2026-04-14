/**
 * Finance data sources — Yahoo Finance (gratuit, sans clé API)
 *
 * Expose trois fonctions :
 *   - fetchStockData(ticker)         : prix, volume, historique 30j
 *   - fetchPreMarketData(ticker)     : données pré-marché (si disponibles)
 *   - calculateTechnicals(history)   : RSI(14), SMA(20), tendance
 *
 * Endpoints Yahoo Finance v8 utilisés (serveur → pas de CORS) :
 *   /v8/finance/chart/{ticker}?interval=1d&range=30d
 *   /v8/finance/chart/{ticker}?interval=1m&range=1d&prepost=true
 */

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface StockData {
  /** Dernier prix en séance (ou clôture si marché fermé). */
  currentPrice: number;
  /** Clôture précédente. */
  previousClose: number;
  /** Variation absolue en USD. */
  change: number;
  /** Variation relative en %. */
  changePercent: number;
  /** Volume du jour. */
  volume: number;
  /** Volume moyen sur 10 jours. */
  avgVolume: number;
  /** Historique de clôtures (jusqu'à 30j) pour les indicateurs techniques. */
  priceHistory: number[];
}

export interface PreMarketData {
  preMarketPrice: number | null;
  preMarketChange: number | null;
  /** En %, ex: 1.25 signifie +1.25%. */
  preMarketChangePercent: number | null;
}

export interface Technicals {
  /** RSI sur 14 périodes — null si historique insuffisant (< 15 points). */
  rsi: number | null;
  /** Moyenne mobile simple 20j — null si historique insuffisant. */
  sma20: number | null;
  /** Tendance déduite du positionnement par rapport à la SMA20. */
  trend: "bullish" | "bearish" | "neutral";
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

const YAHOO_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// ---------------------------------------------------------------------------
// Types internes — réponse brute Yahoo Finance v8
// ---------------------------------------------------------------------------

interface YahooMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketVolume?: number;
  averageDailyVolume10Day?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
}

interface YahooQuote {
  close?: (number | null)[];
}

interface YahooResult {
  meta?: YahooMeta;
  indicators?: {
    quote?: YahooQuote[];
  };
}

interface YahooResponse {
  chart?: {
    result?: YahooResult[];
    error?: { code: string; description: string } | null;
  };
}

// ---------------------------------------------------------------------------
// Helper HTTP
// ---------------------------------------------------------------------------

async function fetchYahoo(url: string): Promise<YahooResult> {
  const res = await fetch(url, { headers: YAHOO_HEADERS });

  if (!res.ok) {
    throw new Error(`Yahoo Finance HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const data: YahooResponse = await res.json();

  if (data.chart?.error) {
    throw new Error(
      `Yahoo Finance API error: ${data.chart.error.code} — ${data.chart.error.description}`
    );
  }

  const result = data.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo Finance: réponse vide pour ${url}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Fonctions publiques
// ---------------------------------------------------------------------------

/**
 * Récupère les données boursières d'un ticker sur 30 jours (clôtures quotidiennes).
 * Utilisé pour calculer RSI, SMA20 et observer la tendance.
 *
 * @throws si le ticker est invalide ou si Yahoo Finance est indisponible.
 */
export async function fetchStockData(ticker: string): Promise<StockData> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=30d`;
  const result = await fetchYahoo(url);

  const meta = result.meta ?? {};
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (v): v is number => v !== null && v !== undefined && isFinite(v)
  );

  if (closes.length === 0) {
    throw new Error(`Yahoo Finance: pas d'historique de clôture pour ${ticker}`);
  }

  const currentPrice  = meta.regularMarketPrice ?? closes[closes.length - 1];
  const previousClose =
    meta.chartPreviousClose ?? meta.previousClose ?? closes[closes.length - 2] ?? currentPrice;
  const change        = currentPrice - previousClose;
  const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

  return {
    currentPrice:  Math.round(currentPrice  * 100) / 100,
    previousClose: Math.round(previousClose * 100) / 100,
    change:        Math.round(change        * 100) / 100,
    changePercent: Math.round(changePercent * 100) / 100,
    volume:        meta.regularMarketVolume ?? 0,
    avgVolume:     meta.averageDailyVolume10Day ?? 0,
    priceHistory:  closes,
  };
}

/**
 * Récupère les données pré-marché si disponibles (avant 9h30 ET).
 * Retourne null pour tous les champs si le pré-marché n'est pas actif.
 */
export async function fetchPreMarketData(ticker: string): Promise<PreMarketData> {
  const url =
    `${YAHOO_BASE}/${encodeURIComponent(ticker)}` +
    `?interval=1m&range=1d&prepost=true`;

  try {
    const result = await fetchYahoo(url);
    const meta = result.meta ?? {};

    const preMarketPrice  = meta.preMarketPrice  ?? null;
    const preMarketChange = meta.preMarketChange ?? null;
    // Yahoo retourne le % en décimal (0.0125 = 1.25%) — on convertit en %
    const raw = meta.preMarketChangePercent ?? null;
    const preMarketChangePercent =
      raw !== null ? Math.round(raw * 100 * 100) / 100 : null;

    return { preMarketPrice, preMarketChange, preMarketChangePercent };
  } catch (err) {
    console.warn(
      `[finance-sources] Pré-marché indisponible pour ${ticker} :`,
      err instanceof Error ? err.message : err
    );
    return { preMarketPrice: null, preMarketChange: null, preMarketChangePercent: null };
  }
}

// ---------------------------------------------------------------------------
// Indicateurs techniques
// ---------------------------------------------------------------------------

/**
 * RSI de Wilder sur N périodes.
 * Retourne null si l'historique contient moins de N+1 points.
 */
function computeRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  const changes = closes.slice(1).map((c, i) => c - closes[i]);

  // Moyennes initiales (simple) sur les `period` premiers changements
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else                 avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Lissage de Wilder pour les périodes restantes
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs  = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Math.round(rsi * 100) / 100;
}

/**
 * SMA sur N périodes (dernières N valeurs de l'historique).
 * Retourne null si l'historique est insuffisant.
 */
function computeSma(closes: number[], period = 20): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sum   = slice.reduce((s, v) => s + v, 0);
  return Math.round((sum / period) * 100) / 100;
}

/**
 * Calcule RSI(14), SMA(20) et la tendance à partir d'un historique de clôtures.
 *
 * Tendance :
 *   bullish  si prix actuel > SMA20 de plus de +0.5%
 *   bearish  si prix actuel < SMA20 de plus de -0.5%
 *   neutral  sinon
 */
export function calculateTechnicals(priceHistory: number[]): Technicals {
  const rsi   = computeRsi(priceHistory, 14);
  const sma20 = computeSma(priceHistory, 20);

  const lastPrice = priceHistory[priceHistory.length - 1];
  let trend: "bullish" | "bearish" | "neutral" = "neutral";

  if (sma20 !== null && lastPrice !== undefined) {
    const deviation = (lastPrice - sma20) / sma20;
    if (deviation >  0.005) trend = "bullish";
    if (deviation < -0.005) trend = "bearish";
  }

  return { rsi, sma20, trend };
}
