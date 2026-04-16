/**
 * Crypto data sources — CoinGecko (gratuit, sans clé API)
 *
 * Expose une fonction publique :
 *   - fetchCryptoData(token) : prix actuel, variation 24h, volume 24h
 *
 * Endpoint CoinGecko utilisé :
 *   GET /api/v3/simple/price?ids={id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true
 *   → { bitcoin: { usd: 69500, usd_24h_change: 2.5, usd_24h_vol: 28000000000 } }
 *
 * Rate limit : ~30 req/min sur le plan gratuit → délai 200ms entre requêtes.
 */

// ---------------------------------------------------------------------------
// Mapping token → CoinGecko ID
// ---------------------------------------------------------------------------

const TOKEN_MAP: Record<string, string> = {
  BTC:   "bitcoin",
  ETH:   "ethereum",
  SOL:   "solana",
  DOGE:  "dogecoin",
  XRP:   "ripple",
  ADA:   "cardano",
  MATIC: "matic-network",
  POL:   "matic-network",
  AVAX:  "avalanche-2",
  DOT:   "polkadot",
  LINK:  "chainlink",
  UNI:   "uniswap",
  LTC:   "litecoin",
  BCH:   "bitcoin-cash",
  ATOM:  "cosmos",
  FIL:   "filecoin",
  NEAR:  "near",
  APT:   "aptos",
  ARB:   "arbitrum",
  OP:    "optimism",
  SUI:   "sui",
  INJ:   "injective-protocol",
  TIA:   "celestia",
  PEPE:  "pepe",
  SHIB:  "shiba-inu",
  WIF:   "dogwifcoin",
  BONK:  "bonk",
  JUP:   "jupiter-exchange-solana",
  TRUMP: "official-trump",
};

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface CryptoData {
  /** Token Polymarket, ex: "BTC". */
  token: string;
  /** CoinGecko ID résolu, ex: "bitcoin". */
  coinGeckoId: string;
  /** Prix actuel en USD. */
  price: number;
  /** Variation 24h en % (ex: 2.5 = +2.5%). */
  change24h: number;
  /** Volume 24h en USD. */
  volume24h: number;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const COINGECKO_BASE      = "https://api.coingecko.com/api/v3";
const INTER_REQUEST_DELAY = 200; // ms — plan gratuit ~30 req/min
const MAX_RETRIES         = 3;

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
  url:        string,
  options?:   RequestInit,
  maxRetries  = MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);

      if (res.status === 429) {
        const delay = Math.pow(2, attempt) * 1_000;
        console.log(`[crypto-sources] Rate limited (429), retry in ${delay}ms…`);
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
        console.log(`[crypto-sources] Error: ${lastError.message}, retry in ${delay}ms…`);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

// ---------------------------------------------------------------------------
// Résolution du CoinGecko ID depuis un token string
// ---------------------------------------------------------------------------

/**
 * Résout le CoinGecko ID depuis un token extrait d'une question Polymarket.
 * Essaie plusieurs normalisations (majuscule, sans tiret, etc.).
 * Retourne null si le token est inconnu.
 */
export function resolveTokenId(raw: string): { token: string; id: string } | null {
  const upper = raw.toUpperCase().trim();

  // Correspondance directe
  if (TOKEN_MAP[upper]) return { token: upper, id: TOKEN_MAP[upper] };

  // Essai sans caractères spéciaux (ex: "BTC/USD" → "BTC")
  const stripped = upper.replace(/[^A-Z]/g, "");
  if (TOKEN_MAP[stripped]) return { token: stripped, id: TOKEN_MAP[stripped] };

  return null;
}

// ---------------------------------------------------------------------------
// Fonction publique
// ---------------------------------------------------------------------------

/**
 * Récupère le prix actuel, la variation 24h et le volume 24h d'un token.
 * @param token  Symbole du token, ex: "BTC", "ETH"
 * @throws si le token est inconnu ou si CoinGecko est indisponible.
 */
export async function fetchCryptoData(token: string): Promise<CryptoData> {
  await sleep(INTER_REQUEST_DELAY);

  const resolved = resolveTokenId(token);
  if (!resolved) {
    throw new Error(`Token inconnu : "${token}" — non présent dans TOKEN_MAP`);
  }

  const { id } = resolved;
  const url =
    `${COINGECKO_BASE}/simple/price` +
    `?ids=${id}&vs_currencies=usd` +
    `&include_24hr_change=true&include_24hr_vol=true`;

  const data = await fetchWithRetry<Record<string, { usd: number; usd_24h_change: number; usd_24h_vol: number }>>(
    url,
    { headers: { Accept: "application/json" } }
  );

  const entry = data[id];
  if (!entry || !entry.usd) {
    throw new Error(`CoinGecko: réponse vide ou invalide pour "${id}"`);
  }

  return {
    token:       resolved.token,
    coinGeckoId: id,
    price:       entry.usd,
    change24h:   Math.round(entry.usd_24h_change * 100) / 100,
    volume24h:   Math.round(entry.usd_24h_vol),
  };
}
