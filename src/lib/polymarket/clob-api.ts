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

/** ABI minimal ERC-20 pour lire/écrire l'allowance. */
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
] as const;

/** Polygon RPC public (override via POLYGON_RPC_URL). */
const POLYGON_RPC = () => process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";

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

async function buildAndSignOrder(
  params:  PlaceOrderParams,
  account: ReturnType<typeof getAccount>
): Promise<SignedOrderBundle> {
  const salt = generateSalt();

  // BUY: maker donne USDC, taker donne CTF tokens
  // SELL: maker donne CTF tokens, taker donne USDC
  const makerAmount = BigInt(Math.floor(params.amountUsdc * USDC_DECIMALS));
  const takerAmount = BigInt(Math.floor((params.amountUsdc / params.price) * USDC_DECIMALS));

  const side          = params.side === "BUY" ? 0 : 1;
  const signatureType = 0; // EOA (clé privée directe)

  const verifyingContract = params.negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

  const orderMessage = {
    salt,
    maker:         account.address as `0x${string}`,
    signer:        account.address as `0x${string}`,
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
      maker:         account.address,
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
    owner:     account.address,
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
  const bundle  = await buildAndSignOrder(params, account);

  console.log(
    `[clob] ${params.dryRun ? "DRY-RUN " : ""}placeOrder: ` +
    `${params.side} ${params.amountUsdc}$ @ ${params.price} ` +
    `(tokenId=${params.tokenId.slice(0, 10)}...)`
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

/**
 * Retourne le solde USDC disponible du compte (via le proxy Polymarket).
 * Utile pour vérifier qu'il y a assez de fonds avant de placer un ordre.
 */
export async function getAccountBalance(): Promise<number> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const creds   = await deriveClobCredentials(privateKey);
  const path    = "/balance";
  const headers = buildApiHeaders(creds, "GET", path);

  const res = await withRetry(
    () => fetch(`${CLOB_BASE}${path}`, { headers }),
    "getAccountBalance"
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[clob] getAccountBalance HTTP ${res.status}: ${body}`);
  }

  const data = await res.json() as { balance?: string | number };
  return parseFloat(String(data.balance ?? "0"));
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
 * que le wallet a approuvé le contrat avant de tenter tout trade réel.
 *
 * Pré-requis : POLYGON_PRIVATE_KEY défini.
 * Optionnel  : POLYGON_RPC_URL (fallback : https://polygon-rpc.com).
 */
export async function checkCTFAllowance(): Promise<AllowanceResult> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(privateKey);
  const client  = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC()) });

  const allowance = await client.readContract({
    address:      USDC_ADDRESS,
    abi:          ERC20_ABI,
    functionName: "allowance",
    args:         [account.address, CTF_EXCHANGE],
  }) as bigint;

  // Seuil : 1 000 USDC en micro-USDC
  const sufficient = allowance > BigInt(1_000 * USDC_DECIMALS);

  console.log(
    `[clob] checkCTFAllowance: ${account.address} → CTF_EXCHANGE ` +
    `allowance=${(Number(allowance) / USDC_DECIMALS).toFixed(2)} USDC ` +
    `(${sufficient ? "✅ sufficient" : "❌ INSUFFICIENT"})`
  );

  return { allowance, sufficient, owner: account.address, spender: CTF_EXCHANGE };
}

// ---------------------------------------------------------------------------
// approveCTF
// ---------------------------------------------------------------------------

/**
 * Soumet une transaction `approve(CTF_EXCHANGE, MAX_UINT256)` sur le contrat USDC.
 *
 * À n'appeler qu'une seule fois, manuellement, avant d'activer le real trading.
 * Retourne le hash de la transaction.
 *
 * ⚠️  Nécessite que le wallet ait du MATIC pour payer le gas Polygon (~0.001$).
 */
export async function approveCTF(): Promise<string> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account      = getAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain:     polygon,
    transport: http(POLYGON_RPC()),
  });

  console.log(`[clob] approveCTF: approve(${CTF_EXCHANGE}, MAX_UINT256) depuis ${account.address}`);

  const txHash = await walletClient.writeContract({
    address:      USDC_ADDRESS,
    abi:          ERC20_ABI,
    functionName: "approve",
    args:         [CTF_EXCHANGE, MAX_UINT256],
  });

  console.log(`[clob] ✅ Approval soumise: txHash=${txHash}`);
  return txHash;
}
