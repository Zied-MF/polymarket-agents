/**
 * Polymarket CLOB API client
 *
 * Gère l'authentification ECDSA, la signature EIP-712 des ordres,
 * et tous les appels à https://clob.polymarket.com.
 *
 * Prérequis avant d'activer REAL_TRADING_ENABLED :
 *   1. POLYGON_PRIVATE_KEY défini dans les env vars Vercel
 *   2. Le wallet doit avoir été enregistré sur polymarket.com (KYC / ToS)
 *   3. Le wallet doit avoir du USDC sur Polygon (via le proxy Polymarket)
 *   4. L'allowance CTF Exchange doit être approuvée (depuis polymarket.com)
 *
 * Dépendances : viem (déjà installé), node:crypto (Node.js built-in)
 */

import { createHmac }                                          from "crypto";
import { privateKeyToAccount }                                  from "viem/accounts";
import { createPublicClient, createWalletClient, http }         from "viem";
import { polygon }                                              from "viem/chains";

// ---------------------------------------------------------------------------
// Constantes réseau Polygon / Polymarket
// ---------------------------------------------------------------------------

const CLOB_BASE           = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID    = 137;
const USDC_DECIMALS       = 1_000_000;   // 10^6
const POLYGON_GAS_FEE     = 0.01;        // ~0.01 USDC par transaction (Polygon = très cheap)

/** Contrat CTF Exchange standard (marchés binaires Yes/No). */
const CTF_EXCHANGE          = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
/** Contrat pour les marchés negRisk (multi-choix). */
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const;
/** USDC natif sur Polygon (utilisé par Polymarket). */
const USDC_ADDRESS          = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as `0x${string}`;
/** uint256 max — allowance illimitée. */
const MAX_UINT256           = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

/** ABI minimal ERC-20 pour lire/écrire l'allowance et la balance. */
const ERC20_ABI = [
  {
    name: "allowance", type: "function", stateMutability: "view",
    inputs:  [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Polygon RPC public (override via POLYGON_RPC_URL). */
const POLYGON_RPC = () => process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";

/**
 * Liste de RPCs publics Polygon — essayés dans l'ordre si le primaire échoue.
 * Keeps the env-override first so users can pin their own RPC.
 */
const POLYGON_RPC_FALLBACKS = () => [
  POLYGON_RPC(),
  "https://rpc.ankr.com/polygon",
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
];

/**
 * Polymarket Proxy Wallet Factory (Polygon mainnet).
 * Chaque EOA Polymarket possède un Safe proxy où l'USDC de trading est déposé.
 * Source : https://docs.polymarket.com/developer-resources/contracts
 */
const PROXY_FACTORY_ADDRESS = "0xaB45c5A4B0c941a2F231C6058491B37517764437" as `0x${string}`;

const PROXY_FACTORY_ABI = [
  {
    name:            "getProxyWallet",
    type:            "function",
    stateMutability: "view",
    inputs:          [{ name: "_user", type: "address" }],
    outputs:         [{ type: "address" }],
  },
] as const;

/** Types EIP-712 pour la signature d'un ordre CTF Exchange. */
const ORDER_EIP712_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "taker",         type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "expiration",    type: "uint256" },
    { name: "nonce",         type: "uint256" },
    { name: "feeRateBps",    type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
  ],
} as const;

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface ClobCredentials {
  apiKey:     string;
  secret:     string;
  passphrase: string;
  address:    string;   // wallet address (checksummed)
}

/** Token CLOB pour un outcome (Yes/No). Récupéré via getClobMarket(). */
export interface ClobToken {
  tokenId: string;   // numeric string, ex: "12345678..."
  outcome: string;   // "Yes" ou "No"
  price:   number;   // prix courant (0-1)
}

export interface ClobMarket {
  conditionId: string;
  tokens:      ClobToken[];
  negRisk:     boolean;
  active:      boolean;
}

export interface PlaceOrderParams {
  tokenId:     string;   // CTF token ID de l'outcome à acheter
  side:        "BUY" | "SELL";
  amountUsdc:  number;   // montant en USDC (ex: 0.50)
  price:       number;   // prix limite (0-1), ex: 0.30
  negRisk:     boolean;  // déduit depuis ClobMarket.negRisk
  dryRun?:     boolean;  // si true, signe mais n'envoie pas
}

export interface PlacedOrder {
  orderId:     string;
  status:      string;
  tokenId:     string;
  side:        "BUY" | "SELL";
  price:       number;
  amountUsdc:  number;
  gasFeeUsdc:  number;   // POLYGON_GAS_FEE estimé
  dryRun:      boolean;
  orderHash?:  string;   // hash EIP-712 (utile pour debug)
}

export interface OrderBookLevel {
  price:  number;
  size:   number;
}

export interface OrderBook {
  tokenId: string;
  bids:    OrderBookLevel[];
  asks:    OrderBookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  spread:  number | null;
}

// ---------------------------------------------------------------------------
// Gestion du compte viem
// ---------------------------------------------------------------------------

function normalizePrivateKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

function getAccount(privateKey: string) {
  return privateKeyToAccount(normalizePrivateKey(privateKey));
}

// ---------------------------------------------------------------------------
// Cache des credentials (singleton par process)
// ---------------------------------------------------------------------------

let _cachedCreds: ClobCredentials | null = null;

export function clearCredentialsCache(): void {
  _cachedCreds = null;
}

// ---------------------------------------------------------------------------
// L1 Auth — signature du message Polymarket pour dériver les clés API
// ---------------------------------------------------------------------------

/**
 * Construit les headers L1 (EIP-712 typed data) pour les endpoints d'auth.
 *
 * Signature EIP-712 — domaine ClobAuthDomain, type ClobAuth :
 *   { address, timestamp, nonce, message: "This message attests that I control the given wallet" }
 *
 * Ref: https://docs.polymarket.com/api-reference/authentication
 */
async function buildL1Headers(
  account: ReturnType<typeof getAccount>,
  nonce = 0
): Promise<HeadersInit> {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const signature = await account.signTypedData({
    domain: {
      name:    "ClobAuthDomain",
      version: "1",
      chainId: POLYGON_CHAIN_ID,
    },
    types: {
      ClobAuth: [
        { name: "address",   type: "address" },
        { name: "timestamp", type: "string"  },
        { name: "nonce",     type: "uint256" },
        { name: "message",   type: "string"  },
      ],
    },
    primaryType: "ClobAuth",
    message: {
      address:   account.address,
      timestamp,
      nonce:     BigInt(nonce),
      message:   "This message attests that I control the given wallet",
    },
  });

  return {
    "POLY_ADDRESS":   account.address,
    "POLY_SIGNATURE": signature,
    "POLY_TIMESTAMP": timestamp,
    "POLY_NONCE":     String(nonce),
    "Content-Type":   "application/json",
  };
}

// ---------------------------------------------------------------------------
// API Key Auth — HMAC-SHA256 pour les endpoints de trading
// ---------------------------------------------------------------------------

/** Construit les headers d'authentification HMAC pour un appel API signé. */
function buildApiHeaders(
  creds:  ClobCredentials,
  method: string,
  path:   string,
  body    = ""
): HeadersInit {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = "0";
  const msg       = timestamp + method.toUpperCase() + path + body;

  const signature = createHmac("sha256", creds.secret)
    .update(msg)
    .digest("base64");

  return {
    "POLY_ADDRESS":    creds.address,
    "POLY_SIGNATURE":  signature,
    "POLY_TIMESTAMP":  timestamp,
    "POLY_NONCE":      nonce,
    "POLY_API_KEY":    creds.apiKey,
    "POLY_PASSPHRASE": creds.passphrase,
    "Content-Type":    "application/json",
  };
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn:         () => Promise<T>,
  label:      string,
  maxRetries  = 3,
  delayMs     = 1500
): Promise<T> {
  let lastErr: Error = new Error("unknown");
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        console.warn(`[clob] ${label} — tentative ${attempt}/${maxRetries} échouée: ${lastErr.message}`);
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw new Error(`[clob] ${label} — toutes les tentatives ont échoué: ${lastErr.message}`);
}

// ---------------------------------------------------------------------------
// deriveClobCredentials
// ---------------------------------------------------------------------------

/**
 * Dérive les credentials API Polymarket depuis la clé privée.
 * Résultat déterministe (nonce=0) — ne change pas entre les appels.
 * Met en cache le résultat en mémoire.
 */
export async function deriveClobCredentials(privateKey?: string): Promise<ClobCredentials> {
  if (_cachedCreds) return _cachedCreds;

  const key = privateKey ?? process.env.POLYGON_PRIVATE_KEY;
  if (!key) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(key);
  const headers = await buildL1Headers(account, 0);

  const res = await withRetry(
    () => fetch(`${CLOB_BASE}/auth/derive-api-key`, {
      method:  "GET",   // doc officielle : GET (POST → 405)
      headers,
    }),
    "deriveClobCredentials"
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[clob] derive-api-key HTTP ${res.status}: ${body}`);
  }

  const data = await res.json() as { apiKey: string; secret: string; passphrase: string };

  _cachedCreds = {
    apiKey:     data.apiKey,
    secret:     data.secret,
    passphrase: data.passphrase,
    address:    account.address,
  };

  console.log(`[clob] ✅ Credentials dérivés pour ${account.address}`);
  return _cachedCreds;
}

// ---------------------------------------------------------------------------
// getClobMarket
// ---------------------------------------------------------------------------

/**
 * Récupère les token IDs et les métadonnées CLOB d'un marché.
 * Le conditionId est l'ID de marché Polymarket (ex: "0xabc...").
 */
export async function getClobMarket(conditionId: string): Promise<ClobMarket | null> {
  try {
    const res = await withRetry(
      () => fetch(`${CLOB_BASE}/markets/${encodeURIComponent(conditionId)}`, {
        headers: { Accept: "application/json" },
      }),
      `getClobMarket(${conditionId.slice(0, 10)})`
    );

    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[clob] getClobMarket HTTP ${res.status} pour ${conditionId}`);
      return null;
    }

    const raw = await res.json() as {
      condition_id: string;
      tokens?: Array<{ token_id: string; outcome: string; price: number }>;
      neg_risk?: boolean;
      active?: boolean;
    };

    const tokens: ClobToken[] = (raw.tokens ?? []).map((t) => ({
      tokenId: t.token_id,
      outcome: t.outcome,
      price:   t.price,
    }));

    return {
      conditionId: raw.condition_id,
      tokens,
      negRisk: raw.neg_risk ?? false,
      active:  raw.active  ?? true,
    };
  } catch (err) {
    console.error("[clob] getClobMarket:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signature EIP-712 d'un ordre
// ---------------------------------------------------------------------------

function generateSalt(): bigint {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return BigInt("0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""));
}

interface SignedOrderBundle {
  order: {
    salt:          string;
    maker:         string;
    signer:        string;
    taker:         string;
    tokenId:       string;
    makerAmount:   string;
    takerAmount:   string;
    expiration:    string;
    nonce:         string;
    feeRateBps:    string;
    side:          number;
    signatureType: number;
  };
  signature: string;
  owner:     string;
  orderType: "GTC";
}

// ---------------------------------------------------------------------------
// detectTradingMode
// ---------------------------------------------------------------------------

export type TradingModeId = "A_PROXY" | "B_EOA" | "UNKNOWN";

export interface TradingModeDetection {
  selectedMode:       TradingModeId;
  eoaAddress:         string;
  proxyAddress:       string | null;
  proxyResolutionMethod: "clob_api" | "factory_contract" | "not_found";
  /** allowance(EOA, CTF_EXCHANGE) en USDC */
  eoaAllowanceCTF:    string;
  /** allowance(EOA, NegRisk CTF Exchange) en USDC */
  eoaAllowanceNegRisk: string;
  /** allowance(proxy, CTF_EXCHANGE) en USDC — null si proxy non trouvé */
  proxyAllowanceCTF:  string | null;
  /** allowance(proxy, NegRisk CTF Exchange) en USDC — null si proxy non trouvé */
  proxyAllowanceNegRisk: string | null;
  rpcUsed:            string | null;
  error:              string | null;
}

/**
 * Détecte automatiquement le mode de trading Polymarket du wallet :
 *
 *   Mode A_PROXY (signatureType=1) :
 *     - Le wallet a un proxy Polymarket Safe
 *     - Le proxy a une allowance CTF Exchange > 0
 *     - maker = proxy, signer = EOA
 *
 *   Mode B_EOA (signatureType=0) :
 *     - Pas de proxy, ou proxy sans allowance
 *     - L'EOA a directement une allowance CTF Exchange > 0
 *     - maker = signer = EOA
 *
 *   UNKNOWN :
 *     - Ni le proxy ni l'EOA n'a d'allowance
 *     - Appeler /api/approve-ctf?execute=true pour débloquer
 */
export async function detectTradingMode(
  eoa: `0x${string}`
): Promise<TradingModeDetection> {
  const result: TradingModeDetection = {
    selectedMode:            "UNKNOWN",
    eoaAddress:              eoa,
    proxyAddress:            null,
    proxyResolutionMethod:   "not_found",
    eoaAllowanceCTF:         "0",
    eoaAllowanceNegRisk:     "0",
    proxyAllowanceCTF:       null,
    proxyAllowanceNegRisk:   null,
    rpcUsed:                 null,
    error:                   null,
  };

  for (const rpc of POLYGON_RPC_FALLBACKS()) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });
      result.rpcUsed = rpc;

      // ── 1. Résoudre l'adresse proxy (best-effort) ─────────────────────────
      const { proxy, debug } = await resolveProxyWithDebug(eoa, client);
      result.proxyAddress          = proxy;
      result.proxyResolutionMethod = debug.method;

      // ── 2. Lire les allowances EOA ────────────────────────────────────────
      const readAllowance = async (owner: `0x${string}`, spender: `0x${string}`) => {
        const raw = await client.readContract({
          address:      USDC_ADDRESS,
          abi:          ERC20_ABI,
          functionName: "allowance",
          args:         [owner, spender],
        }) as bigint;
        return raw;
      };

      const eoaCTF      = await readAllowance(eoa, CTF_EXCHANGE);
      const eoaNegRisk  = await readAllowance(eoa, NEG_RISK_CTF_EXCHANGE);
      result.eoaAllowanceCTF     = (Number(eoaCTF)     / USDC_DECIMALS).toFixed(6);
      result.eoaAllowanceNegRisk = (Number(eoaNegRisk) / USDC_DECIMALS).toFixed(6);

      // ── 3. Lire les allowances proxy (si proxy trouvé) ────────────────────
      if (proxy) {
        const proxyCTF      = await readAllowance(proxy, CTF_EXCHANGE);
        const proxyNegRisk  = await readAllowance(proxy, NEG_RISK_CTF_EXCHANGE);
        result.proxyAllowanceCTF     = (Number(proxyCTF)     / USDC_DECIMALS).toFixed(6);
        result.proxyAllowanceNegRisk = (Number(proxyNegRisk) / USDC_DECIMALS).toFixed(6);

        if (proxyCTF > BigInt(0) || proxyNegRisk > BigInt(0)) {
          result.selectedMode = "A_PROXY";
          console.log(
            `[clob] detectTradingMode: Mode A_PROXY — proxy=${proxy} ` +
            `CTF=${result.proxyAllowanceCTF} NegRisk=${result.proxyAllowanceNegRisk}`
          );
          return result;
        }
      }

      // ── 4. Check EOA allowance ─────────────────────────────────────────────
      if (eoaCTF > BigInt(0) || eoaNegRisk > BigInt(0)) {
        result.selectedMode = "B_EOA";
        console.log(
          `[clob] detectTradingMode: Mode B_EOA — EOA=${eoa} ` +
          `CTF=${result.eoaAllowanceCTF} NegRisk=${result.eoaAllowanceNegRisk}`
        );
        return result;
      }

      // ── 5. Aucune allowance trouvée ───────────────────────────────────────
      result.selectedMode = "UNKNOWN";
      console.warn(
        `[clob] detectTradingMode: UNKNOWN — ni proxy ni EOA n'a d'allowance CTF. ` +
        `Appeler /api/approve-ctf?execute=true`
      );
      return result;

    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.warn(`[clob] detectTradingMode RPC ${rpc} failed: ${result.error}`);
    }
  }

  result.error = "All RPCs failed";
  return result;
}

interface SigningMode {
  signatureType: 0 | 1;
  makerAddress:  `0x${string}`;
  proxyAddress:  `0x${string}` | null;
  detection:     TradingModeDetection;
}

async function resolveSigningMode(
  account: ReturnType<typeof getAccount>
): Promise<SigningMode> {
  const detection = await detectTradingMode(account.address);

  if (detection.selectedMode === "A_PROXY" && detection.proxyAddress) {
    return {
      signatureType: 1,
      makerAddress:  detection.proxyAddress as `0x${string}`,
      proxyAddress:  detection.proxyAddress as `0x${string}`,
      detection,
    };
  }

  // Mode B_EOA ou UNKNOWN (on tente quand même — le CLOB rejettera si aucune allowance)
  return {
    signatureType: 0,
    makerAddress:  account.address,
    proxyAddress:  null,
    detection,
  };
}

async function buildAndSignOrder(
  params:  PlaceOrderParams,
  account: ReturnType<typeof getAccount>,
  mode:    SigningMode
): Promise<SignedOrderBundle> {
  const salt = generateSalt();

  // BUY: maker donne USDC, taker donne CTF tokens
  // SELL: maker donne CTF tokens, taker donne USDC
  const makerAmount = BigInt(Math.floor(params.amountUsdc * USDC_DECIMALS));
  const takerAmount = BigInt(Math.floor((params.amountUsdc / params.price) * USDC_DECIMALS));

  const side              = params.side === "BUY" ? 0 : 1;
  const { signatureType, makerAddress } = mode;
  const verifyingContract = params.negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

  const orderMessage = {
    salt,
    maker:         makerAddress,
    signer:        account.address as `0x${string}`,  // toujours l'EOA qui signe
    taker:         "0x0000000000000000000000000000000000000000" as `0x${string}`,
    tokenId:       BigInt(params.tokenId),
    makerAmount,
    takerAmount,
    expiration:    BigInt(0),
    nonce:         BigInt(0),
    feeRateBps:    BigInt(0),
    side,
    signatureType,
  };

  const signature = await account.signTypedData({
    domain: {
      name:              "CTF Exchange",
      version:           "1",
      chainId:           POLYGON_CHAIN_ID,
      verifyingContract,
    },
    types:       ORDER_EIP712_TYPES,
    primaryType: "Order",
    message:     orderMessage,
  });

  return {
    order: {
      salt:          salt.toString(),
      maker:         makerAddress,
      signer:        account.address,
      taker:         "0x0000000000000000000000000000000000000000",
      tokenId:       params.tokenId,
      makerAmount:   makerAmount.toString(),
      takerAmount:   takerAmount.toString(),
      expiration:    "0",
      nonce:         "0",
      feeRateBps:    "0",
      side,
      signatureType,
    },
    signature,
    owner:     makerAddress,   // proxy ou EOA — indique au CLOB d'où viennent les fonds
    orderType: "GTC",
  };
}

// ---------------------------------------------------------------------------
// placeOrder
// ---------------------------------------------------------------------------

/**
 * Construit, signe et place un ordre limit GTC sur le CLOB Polymarket.
 *
 * Si dryRun=true, signe l'ordre mais ne l'envoie pas au serveur.
 * Utile pour valider que la signature est correcte avant de passer en live.
 */
export async function placeOrder(params: PlaceOrderParams): Promise<PlacedOrder> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(privateKey);
  const mode    = await resolveSigningMode(account);
  const bundle  = await buildAndSignOrder(params, account, mode);

  console.log(
    `[clob] ${params.dryRun ? "DRY-RUN " : ""}placeOrder: ` +
    `${params.side} ${params.amountUsdc}$ @ ${params.price} ` +
    `(tokenId=${params.tokenId.slice(0, 10)}...) ` +
    `maker=${mode.makerAddress.slice(0, 10)} sigType=${mode.signatureType}`
  );

  if (params.dryRun) {
    return {
      orderId:    "dry-run",
      status:     "dry_run",
      tokenId:    params.tokenId,
      side:       params.side,
      price:      params.price,
      amountUsdc: params.amountUsdc,
      gasFeeUsdc: POLYGON_GAS_FEE,
      dryRun:     true,
      orderHash:  bundle.signature.slice(0, 20) + "...",
    };
  }

  const creds   = await deriveClobCredentials(privateKey);
  const body    = JSON.stringify(bundle);
  const headers = buildApiHeaders(creds, "POST", "/order", body);

  const res = await withRetry(
    () => fetch(`${CLOB_BASE}/order`, { method: "POST", headers, body }),
    "placeOrder"
  );

  const data = await res.json() as { orderID?: string; status?: string; errorMsg?: string };

  if (!res.ok || data.errorMsg) {
    throw new Error(`[clob] placeOrder HTTP ${res.status}: ${data.errorMsg ?? JSON.stringify(data)}`);
  }

  console.log(`[clob] ✅ Ordre placé: ${data.orderID} (${data.status})`);

  return {
    orderId:    data.orderID ?? "unknown",
    status:     data.status  ?? "placed",
    tokenId:    params.tokenId,
    side:       params.side,
    price:      params.price,
    amountUsdc: params.amountUsdc,
    gasFeeUsdc: POLYGON_GAS_FEE,
    dryRun:     false,
  };
}

// ---------------------------------------------------------------------------
// cancelOrder
// ---------------------------------------------------------------------------

/**
 * Annule un ordre ouvert par son ID.
 * Utilisé par le Position Manager pour sortir d'une position réelle.
 */
export async function cancelOrder(orderId: string): Promise<void> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const creds   = await deriveClobCredentials(privateKey);
  const path    = `/order/${orderId}`;
  const headers = buildApiHeaders(creds, "DELETE", path);

  const res = await withRetry(
    () => fetch(`${CLOB_BASE}${path}`, { method: "DELETE", headers }),
    `cancelOrder(${orderId})`
  );

  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`[clob] cancelOrder HTTP ${res.status}: ${body}`);
  }

  console.log(`[clob] ✅ Ordre ${orderId} annulé (status: ${res.status})`);
}

// ---------------------------------------------------------------------------
// getOrderBook
// ---------------------------------------------------------------------------

/**
 * Récupère le carnet d'ordres courant pour un token CLOB.
 * Retourne les meilleurs bids/asks et le spread.
 */
export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const res = await withRetry(
    () => fetch(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`, {
      headers: { Accept: "application/json" },
    }),
    `getOrderBook(${tokenId.slice(0, 10)})`
  );

  if (!res.ok) {
    throw new Error(`[clob] getOrderBook HTTP ${res.status}`);
  }

  const raw = await res.json() as {
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
  };

  const bids: OrderBookLevel[] = (raw.bids ?? [])
    .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
    .sort((a, b) => b.price - a.price);    // décroissant

  const asks: OrderBookLevel[] = (raw.asks ?? [])
    .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .sort((a, b) => a.price - b.price);    // croissant

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread  = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  return { tokenId, bids, asks, bestBid, bestAsk, spread };
}

// ---------------------------------------------------------------------------
// getAccountBalance
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getOnChainUSDCBalance
// ---------------------------------------------------------------------------

/**
 * Lit le solde USDC d'une adresse quelconque directement sur Polygon.
 * Tente les RPCs de POLYGON_RPC_FALLBACKS() dans l'ordre.
 * Retourne null si tous les RPCs échouent (ne throw pas).
 */
export async function getOnChainUSDCBalance(
  address: `0x${string}`
): Promise<number | null> {
  for (const rpc of POLYGON_RPC_FALLBACKS()) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });
      const raw = await client.readContract({
        address:      USDC_ADDRESS,
        abi:          ERC20_ABI,
        functionName: "balanceOf",
        args:         [address],
      }) as bigint;
      const balance = Number(raw) / USDC_DECIMALS;
      console.log(`[clob] getOnChainUSDCBalance(${address.slice(0, 10)}, rpc=${rpc}): ${balance.toFixed(4)} USDC`);
      return balance;
    } catch (err) {
      console.warn(`[clob] RPC ${rpc} failed for balanceOf(${address.slice(0, 10)}): ${err instanceof Error ? err.message : err}`);
    }
  }
  console.error(`[clob] getOnChainUSDCBalance: all ${POLYGON_RPC_FALLBACKS().length} RPCs failed`);
  return null;
}

// ---------------------------------------------------------------------------
// Proxy resolution — verbose (debug info always captured)
// ---------------------------------------------------------------------------

export interface ProxyResolutionDebug {
  eoa:              string;
  proxyAddress:     string | null;
  method:           "clob_api" | "factory_contract" | "not_found";
  clobApiUrl:       string;
  clobApiStatus:    number | null;
  clobApiBody:      string | null;
  clobApiError:     string | null;
  factoryAddress:   string;
  factoryResult:    string | null;
  factoryError:     string | null;
}

/**
 * Résout l'adresse du proxy Polymarket avec debug complet.
 * Essaie CLOB API puis factory contract — capture tout pour diagnostic.
 */
async function resolveProxyWithDebug(
  eoa:    `0x${string}`,
  client: ReturnType<typeof createPublicClient>
): Promise<{ proxy: `0x${string}` | null; debug: ProxyResolutionDebug }> {
  const ZERO  = "0x0000000000000000000000000000000000000000";
  const url   = `${CLOB_BASE}/proxy-wallet?address=${eoa}`;
  const debug: ProxyResolutionDebug = {
    eoa,
    proxyAddress:   null,
    method:         "not_found",
    clobApiUrl:     url,
    clobApiStatus:  null,
    clobApiBody:    null,
    clobApiError:   null,
    factoryAddress: PROXY_FACTORY_ADDRESS,
    factoryResult:  null,
    factoryError:   null,
  };

  // 1. CLOB API — GET /proxy-wallet?address=
  try {
    const res  = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await res.text();
    debug.clobApiStatus = res.status;
    debug.clobApiBody   = body.slice(0, 300); // cap to avoid noise

    if (res.ok) {
      const data = JSON.parse(body) as Record<string, unknown>;
      const proxy = (data.proxy_wallet ?? data.proxyWallet ?? data.address) as string | undefined;
      if (proxy && proxy !== ZERO && proxy.startsWith("0x")) {
        debug.proxyAddress = proxy;
        debug.method       = "clob_api";
        console.log(`[clob] Proxy via CLOB API: ${proxy}`);
        return { proxy: proxy as `0x${string}`, debug };
      }
    }
  } catch (err) {
    debug.clobApiError = err instanceof Error ? err.message : String(err);
  }

  // 2. Factory contract on-chain
  try {
    const result = await client.readContract({
      address:      PROXY_FACTORY_ADDRESS,
      abi:          PROXY_FACTORY_ABI,
      functionName: "getProxyWallet",
      args:         [eoa],
    }) as `0x${string}`;
    debug.factoryResult = result;
    if (result && result !== ZERO && result.startsWith("0x")) {
      debug.proxyAddress = result;
      debug.method       = "factory_contract";
      console.log(`[clob] Proxy via factory contract: ${result}`);
      return { proxy: result, debug };
    }
  } catch (err) {
    debug.factoryError = err instanceof Error ? err.message : String(err);
  }

  console.warn(`[clob] Could not resolve Polymarket proxy for ${eoa}`);
  return { proxy: null, debug };
}

/** Wrapper sans debug pour usage interne. */
async function getPolymarketProxyAddress(
  eoa:    `0x${string}`,
  client: ReturnType<typeof createPublicClient>
): Promise<`0x${string}` | null> {
  const { proxy } = await resolveProxyWithDebug(eoa, client);
  return proxy;
}

// ---------------------------------------------------------------------------
// getAccountBalance
// ---------------------------------------------------------------------------

/**
 * Retourne le solde USDC disponible pour trader, en essayant dans l'ordre :
 *   1. Balance du proxy Polymarket (Safe proxy où l'USDC de trading est déposé)
 *   2. Balance du wallet EOA (cas où les fonds sont encore sur le wallet direct)
 *
 * Utilise POLYGON_RPC_FALLBACKS() pour robustesse (RPC public peu fiable sur Vercel).
 *
 * Retourne null si TOUS les RPCs échouent — le Guard 2 dans trade-executor
 * skippera alors le check avec un warning Discord (Polymarket rejettera l'ordre
 * si balance insuffisante côté CLOB).
 *
 * Ne throw JAMAIS (retourne null au lieu de throw sur erreur réseau).
 */
export async function getAccountBalance(): Promise<number | null> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(privateKey);

  for (const rpc of POLYGON_RPC_FALLBACKS()) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });

      // 1. Proxy Polymarket (là où l'USDC tradable réside réellement)
      const proxyAddress = await getPolymarketProxyAddress(account.address, client);
      if (proxyAddress) {
        const raw     = await client.readContract({
          address:      USDC_ADDRESS,
          abi:          ERC20_ABI,
          functionName: "balanceOf",
          args:         [proxyAddress],
        }) as bigint;
        const balance = Number(raw) / USDC_DECIMALS;
        console.log(
          `[clob] getAccountBalance (proxy, rpc=${rpc}): ` +
          `${balance.toFixed(4)} USDC — proxy=${proxyAddress}`
        );
        return balance;
      }

      // 2. EOA direct (fonds pas encore déposés dans le proxy)
      const raw     = await client.readContract({
        address:      USDC_ADDRESS,
        abi:          ERC20_ABI,
        functionName: "balanceOf",
        args:         [account.address],
      }) as bigint;
      const balance = Number(raw) / USDC_DECIMALS;
      console.log(
        `[clob] getAccountBalance (EOA, rpc=${rpc}): ` +
        `${balance.toFixed(4)} USDC — ${account.address}`
      );
      return balance;
    } catch (err) {
      console.warn(
        `[clob] getAccountBalance RPC ${rpc} failed: ` +
        `${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Tous les RPCs ont échoué — guard skippa avec warning
  console.error("[clob] getAccountBalance: all RPCs failed — returning null");
  return null;
}

// ---------------------------------------------------------------------------
// checkCTFAllowance
// ---------------------------------------------------------------------------

export interface AllowanceResult {
  /** Allowance actuelle en micro-USDC (10^6). */
  allowance:  bigint;
  /** true si allowance > 1 000 USDC (seuil arbitraire "prêt à trader"). */
  sufficient: boolean;
  /** Adresse du wallet vérifié. */
  owner:      string;
  /** Adresse du spender vérifié (CTF Exchange). */
  spender:    string;
}

/**
 * Lit l'allowance USDC accordée au CTF Exchange sur Polygon.
 *
 * À appeler au démarrage du bot (REAL_TRADING_ENABLED=true) pour s'assurer
 * que le wallet a approuvé le CTF Exchange avant tout trade réel.
 *
 * Délègue à checkAllAllowances() — lit CTF Exchange + NegRisk en un seul
 * appel RPC, retourne le résultat sous le format AllowanceResult existant
 * (sufficient = true seulement si LES DEUX spenders sont approuvés).
 */
export async function checkCTFAllowance(): Promise<AllowanceResult> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(privateKey);
  const all     = await checkAllAllowances(); // throws if all RPCs fail

  // sufficient = true seulement si TOUS les spenders sont OK
  const sufficient = all.every((a) => a.sufficient);
  const ctf        = all.find((a) => a.spender === CTF_EXCHANGE);
  const allowance  = ctf
    ? BigInt(Math.floor(ctf.allowanceUsdc * USDC_DECIMALS))
    : BigInt(0);

  if (!sufficient) {
    const missing = all.filter((a) => !a.sufficient).map((a) => a.name).join(", ");
    console.warn(`[clob] checkCTFAllowance: allowance insuffisante pour: ${missing}`);
  }

  return { allowance, sufficient, owner: account.address, spender: CTF_EXCHANGE };
}

// ---------------------------------------------------------------------------
// approveCTF  &  checkAllAllowances
// ---------------------------------------------------------------------------

/**
 * Spenders Polymarket qui ont besoin d'une allowance USDC max.
 *
 * Refs :
 *   - CTF Exchange       : marchés binaires Yes/No standard
 *   - NegRisk CTF Exch.  : marchés multi-outcomes (élections, sports…)
 *
 * Source : https://docs.polymarket.com/developer-resources/contracts
 */
const APPROVAL_SPENDERS: Array<{ name: string; address: `0x${string}` }> = [
  { name: "CTF Exchange",         address: CTF_EXCHANGE },
  { name: "NegRisk CTF Exchange", address: NEG_RISK_CTF_EXCHANGE },
];

export interface SpenderAllowance {
  name:       string;
  spender:    string;
  allowanceUsdc: number;
  sufficient: boolean;
}

/**
 * Lit l'allowance USDC pour tous les spenders Polymarket en un seul appel.
 * Utilise POLYGON_RPC_FALLBACKS() pour la robustesse RPC.
 */
export async function checkAllAllowances(): Promise<SpenderAllowance[]> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account  = getAccount(privateKey);
  let   lastErr: Error = new Error("no RPC tried");

  for (const rpc of POLYGON_RPC_FALLBACKS()) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });

      // Préférer le proxy — c'est là que l'USDC réside après dépôt via l'UI Polymarket.
      // Si pas de proxy, on vérifie l'EOA (mode signatureType=0).
      const proxy   = await getPolymarketProxyAddress(account.address, client);
      const owner   = proxy ?? account.address;
      const ownerLabel = proxy ? `proxy(${proxy.slice(0, 10)})` : `EOA(${account.address.slice(0, 10)})`;

      const results: SpenderAllowance[] = [];

      for (const { name, address: spender } of APPROVAL_SPENDERS) {
        const raw = await client.readContract({
          address:      USDC_ADDRESS,
          abi:          ERC20_ABI,
          functionName: "allowance",
          args:         [owner, spender],
        }) as bigint;

        const allowanceUsdc = Number(raw) / USDC_DECIMALS;
        // sufficient = true si allowance > 1 000 USDC OU si c'est MAX_UINT256-like (> 1e12 USDC)
        const sufficient    = raw > BigInt(1_000 * USDC_DECIMALS);
        results.push({ name, spender, allowanceUsdc, sufficient });

        console.log(
          `[clob] allowance ${ownerLabel} → ${name}: ${allowanceUsdc.toFixed(2)} USDC ` +
          `(${sufficient ? "✅" : "❌ need approve"})`
        );
      }

      return results;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[clob] checkAllAllowances RPC ${rpc} failed: ${lastErr.message}`);
    }
  }

  throw new Error(`[clob] checkAllAllowances: all RPCs failed — ${lastErr.message}`);
}

// ---------------------------------------------------------------------------
// debugAllowances  — expose tout pour diagnostic dans /api/test-real-trade
// ---------------------------------------------------------------------------

export interface AllowanceDebugEntry {
  spenderName:      string;
  spenderAddress:   string;
  owner:            string;        // adresse réellement vérifiée
  allowanceRaw:     string;        // bigint en string
  allowanceFormatted: string;      // en USDC
  sufficient:       boolean;
  rpcUsed:          string;
  error:            string | null;
}

export interface AllowanceDebugResult {
  eoaAddress:            string;
  proxyResolution:       ProxyResolutionDebug;
  ownerChecked:          string;   // proxy ou EOA
  ownerType:             "proxy" | "eoa";
  ctfExchangeAddress:    string;
  negRiskExchangeAddress: string;
  spenders:              AllowanceDebugEntry[];
  rpcAttempts:           string[];
}

/**
 * Version complète avec debug de checkAllAllowances().
 * Expose chaque étape (proxy resolution, RPC tentées, valeurs raw) dans la réponse.
 */
export async function debugAllowances(): Promise<AllowanceDebugResult> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(privateKey);
  const rpcs    = POLYGON_RPC_FALLBACKS();
  const attempted: string[] = [];
  let   proxyDebug: ProxyResolutionDebug | null = null;
  let   owner: `0x${string}` = account.address;
  let   ownerType: "proxy" | "eoa" = "eoa";

  // Résoudre le proxy sur le premier RPC disponible
  for (const rpc of rpcs) {
    attempted.push(rpc);
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });
      const { proxy, debug } = await resolveProxyWithDebug(account.address, client);
      proxyDebug = debug;
      if (proxy) {
        owner     = proxy;
        ownerType = "proxy";
      }
      break; // RPC fonctionne, on s'arrête là
    } catch (err) {
      console.warn(`[clob] debugAllowances RPC ${rpc} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Lire les allowances pour chaque spender
  const spenderResults: AllowanceDebugEntry[] = [];

  for (const { name, address: spender } of APPROVAL_SPENDERS) {
    let entry: AllowanceDebugEntry = {
      spenderName:      name,
      spenderAddress:   spender,
      owner,
      allowanceRaw:     "0",
      allowanceFormatted: "0.000000",
      sufficient:       false,
      rpcUsed:          "",
      error:            null,
    };

    for (const rpc of rpcs) {
      try {
        const client = createPublicClient({ chain: polygon, transport: http(rpc) });
        const raw = await client.readContract({
          address:      USDC_ADDRESS,
          abi:          ERC20_ABI,
          functionName: "allowance",
          args:         [owner, spender],
        }) as bigint;

        const formatted = (Number(raw) / USDC_DECIMALS).toFixed(6);
        entry = {
          ...entry,
          allowanceRaw:       raw.toString(),
          allowanceFormatted: formatted,
          sufficient:         raw > BigInt(1_000 * USDC_DECIMALS),
          rpcUsed:            rpc,
          error:              null,
        };

        console.log(`[clob] debugAllowances: allowance(${owner.slice(0,10)}, ${name}) = ${formatted} USDC`);
        break;
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
    }

    spenderResults.push(entry);
  }

  return {
    eoaAddress:             account.address,
    proxyResolution:        proxyDebug ?? {
      eoa: account.address, proxyAddress: null, method: "not_found",
      clobApiUrl: `${CLOB_BASE}/proxy-wallet?address=${account.address}`,
      clobApiStatus: null, clobApiBody: null, clobApiError: "no RPC succeeded",
      factoryAddress: PROXY_FACTORY_ADDRESS, factoryResult: null, factoryError: null,
    },
    ownerChecked:           owner,
    ownerType,
    ctfExchangeAddress:     CTF_EXCHANGE,
    negRiskExchangeAddress: NEG_RISK_CTF_EXCHANGE,
    spenders:               spenderResults,
    rpcAttempts:            attempted,
  };
}

/**
 * Soumet approve(spender, MAX_UINT256) sur USDC pour tous les spenders
 * Polymarket qui n'ont pas encore une allowance suffisante.
 *
 * Opération unique : une fois approuvée, plus besoin de re-approuver.
 * Coût : ~0.01–0.05 POL de gas par transaction (Polygon très cheap).
 *
 * ⚠️  Nécessite que le wallet ait du POL (ex-MATIC) pour le gas.
 * ⚠️  POLYGON_RPC_URL doit pointer vers un RPC valide (Alchemy recommandé).
 */
export interface ApproveCTFResult {
  wallet:      string;
  approvals:   Array<{
    name:    string;
    spender: string;
    txHash:  string | null;   // null si déjà approuvé (skipped)
    skipped: boolean;
  }>;
}

export async function approveCTF(): Promise<ApproveCTFResult> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account      = getAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain:     polygon,
    transport: http(POLYGON_RPC()),
  });

  // Lire les allowances actuelles pour ne pas re-soumettre inutilement
  const current = await checkAllAllowances();
  const result: ApproveCTFResult = { wallet: account.address, approvals: [] };

  for (const { name, address: spender } of APPROVAL_SPENDERS) {
    const existing = current.find((c) => c.spender === spender);

    if (existing?.sufficient) {
      console.log(`[clob] approveCTF: ${name} — déjà approuvé (${existing.allowanceUsdc.toFixed(0)} USDC) ✅ skip`);
      result.approvals.push({ name, spender, txHash: null, skipped: true });
      continue;
    }

    console.log(`[clob] approveCTF: approve(${name}=${spender}, MAX_UINT256) depuis ${account.address}`);

    const txHash = await walletClient.writeContract({
      address:      USDC_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "approve",
      args:         [spender, MAX_UINT256],
    });

    console.log(`[clob] ✅ Approval ${name} soumise: txHash=${txHash}`);
    result.approvals.push({ name, spender, txHash, skipped: false });

    // Laisser Polygon confirmer entre les txs si plusieurs approvals nécessaires
    await new Promise((r) => setTimeout(r, 2000));
  }

  return result;
}
