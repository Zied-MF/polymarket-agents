/**
 * Polymarket CLOB API client — powered by @polymarket/clob-client v5
 *
 * Remplace l'implémentation custom (HMAC + EIP-712 maison) par la lib officielle
 * Polymarket qui gère automatiquement :
 *   - Détection du mode de signature (EOA vs Proxy wallet)
 *   - Construction et signature EIP-712 des ordres
 *   - Auth L1 (dérivation clés API) et L2 (HMAC ordres)
 *
 * On-chain reads (balance, allowance) restent en viem direct — plus fiables
 * que les endpoints CLOB qui nécessitent une auth L2 fonctionnelle.
 *
 * Variables d'environnement :
 *   POLYGON_PRIVATE_KEY  — clé privée EOA (hex, avec ou sans 0x)
 *   POLYGON_RPC_URL      — RPC Polygon (Alchemy recommandé)
 */

import { privateKeyToAccount }                                   from "viem/accounts";
import { createPublicClient, createWalletClient, http }          from "viem";
import { polygon }                                               from "viem/chains";
import {
  ClobClient,
  SignatureTypeV2,
  Side        as ClobSide,
  OrderType   as ClobOrderType,
  Chain       as ClobChain,
}                                                                from "@polymarket/clob-client-v2";

// ---------------------------------------------------------------------------
// Constantes réseau Polygon / Polymarket
// ---------------------------------------------------------------------------

const CLOB_BASE        = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = ClobChain.POLYGON; // 137
const USDC_DECIMALS    = 1_000_000;          // 10^6
const POLYGON_GAS_FEE  = 0.01;              // estimation Polygon (~2 tx)

const CTF_EXCHANGE          = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as `0x${string}`;
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as `0x${string}`;
const USDC_ADDRESS          = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as `0x${string}`;
const PUSD_ADDRESS          = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as `0x${string}`; // Polymarket V2 pUSD
const MAX_UINT256           = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

const PROXY_FACTORY_ADDRESS = "0xaB45c5A4B0c941a2F231C6058491B37517764437" as `0x${string}`;

const PROXY_FACTORY_ABI = [
  {
    name: "getProxyWallet", type: "function", stateMutability: "view",
    inputs:  [{ name: "_user", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

const ERC20_ABI = [
  { name: "allowance", type: "function", stateMutability: "view",
    inputs:  [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }] },
] as const;

const POLYGON_RPC        = () => process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";
const POLYGON_RPC_FALLBACKS = () => [
  POLYGON_RPC(),
  "https://rpc.ankr.com/polygon",
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
];

const APPROVAL_SPENDERS: Array<{ name: string; address: `0x${string}` }> = [
  { name: "CTF Exchange",         address: CTF_EXCHANGE },
  { name: "NegRisk CTF Exchange", address: NEG_RISK_CTF_EXCHANGE },
];

// ---------------------------------------------------------------------------
// Types publics (interface inchangée pour les callers)
// ---------------------------------------------------------------------------

export interface ClobCredentials {
  apiKey:     string;
  secret:     string;
  passphrase: string;
  address:    string;
}

export interface ClobToken {
  tokenId: string;
  outcome: string;
  price:   number;
}

export interface ClobMarket {
  conditionId: string;
  tokens:      ClobToken[];
  negRisk:     boolean;
  active:      boolean;
}

export interface PlaceOrderParams {
  tokenId:    string;
  side:       "BUY" | "SELL";
  amountUsdc: number;
  price:      number;
  negRisk:    boolean;
  dryRun?:    boolean;
}

export interface PlacedOrder {
  orderId:    string;
  status:     string;
  tokenId:    string;
  side:       "BUY" | "SELL";
  price:      number;
  amountUsdc: number;
  gasFeeUsdc: number;
  dryRun:     boolean;
  orderHash?: string;
}

export interface OrderBookLevel { price: number; size: number; }
export interface OrderBook {
  tokenId: string;
  bids: OrderBookLevel[]; asks: OrderBookLevel[];
  bestBid: number | null; bestAsk: number | null; spread: number | null;
}

export interface AllowanceResult {
  allowance:  bigint;
  sufficient: boolean;
  owner:      string;
  spender:    string;
}

export interface SpenderAllowance {
  name: string; spender: string; allowanceUsdc: number; sufficient: boolean;
}

export interface ApproveCTFResult {
  wallet:    string;
  approvals: Array<{ name: string; spender: string; txHash: string | null; skipped: boolean; }>;
}

// ---------------------------------------------------------------------------
// Helpers viem
// ---------------------------------------------------------------------------

function normalizePrivateKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

function getAccount(privateKey: string) {
  return privateKeyToAccount(normalizePrivateKey(privateKey));
}

// ---------------------------------------------------------------------------
// ClobClient factory — singleton par process
// ---------------------------------------------------------------------------

let _cachedClient:     ClobClient | null = null;
let _cachedClientMode: TradingModeId | null = null;

/** Réinitialise le client (ex. après un approveCTF). */
export function clearCredentialsCache(): void {
  _cachedClient     = null;
  _cachedClientMode = null;
}

/**
 * Retourne un ClobClient initialisé avec le bon mode de signature.
 *
 * Priorité :
 *   1. POLYMARKET_FUNDER_ADDRESS + POLYMARKET_SIGNATURE_TYPE définis → utilisation directe
 *   2. Sinon → détection automatique via detectTradingMode()
 */
async function getClobClient(): Promise<ClobClient> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(privateKey);

  // ── Mode explicite via env vars ──────────────────────────────────────────
  const envFunder  = process.env.POLYMARKET_FUNDER_ADDRESS;
  const envSigType = process.env.POLYMARKET_SIGNATURE_TYPE;

  let sigType: SignatureTypeV2;
  let funder:  string | undefined;
  let modeKey: string;

  if (envFunder && envSigType) {
    const st = parseInt(envSigType, 10) as SignatureTypeV2;
    sigType  = isNaN(st) ? SignatureTypeV2.POLY_GNOSIS_SAFE : st;
    funder   = envFunder;
    modeKey  = `env:${sigType}:${funder}`;
    console.log(`[clob] Mode explicite via env: sigType=${SignatureTypeV2[sigType]} funder=${funder}`);
  } else {
    // ── Détection automatique ────────────────────────────────────────────
    const detection = await detectTradingMode(account.address);
    sigType  = detection.selectedMode === "A_PROXY" ? SignatureTypeV2.POLY_PROXY : SignatureTypeV2.EOA;
    funder   = detection.selectedMode === "A_PROXY" && detection.proxyAddress ? detection.proxyAddress : undefined;
    modeKey  = detection.selectedMode;
  }

  if (_cachedClient && _cachedClientMode === modeKey) return _cachedClient;

  const walletClient = createWalletClient({
    account,
    chain:     polygon,
    transport: http(POLYGON_RPC()),
  });

  // Étape 1 : dériver les clés API (L1 auth via signer)
  const tempClient = new ClobClient({ host: CLOB_BASE, chain: POLYGON_CHAIN_ID, signer: walletClient });
  const creds      = await tempClient.deriveApiKey();

  // Étape 2 : client complet
  _cachedClient = new ClobClient({
    host:          CLOB_BASE,
    chain:         POLYGON_CHAIN_ID,
    signer:        walletClient,
    creds:         { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
    signatureType: sigType,
    funderAddress: funder,
    throwOnError:  true,
  });
  _cachedClientMode = modeKey as TradingModeId;

  console.log(
    `[clob] ✅ ClobClient V2: sigType=${SignatureTypeV2[sigType]}(${sigType}) ` +
    `funder=${funder ?? "none(EOA)"} maker=${funder ?? account.address}`
  );

  return _cachedClient;
}

// ---------------------------------------------------------------------------
// deriveClobCredentials — wrapper pour compatibilité
// ---------------------------------------------------------------------------

let _cachedCreds: ClobCredentials | null = null;

export async function deriveClobCredentials(privateKey?: string): Promise<ClobCredentials> {
  if (_cachedCreds) return _cachedCreds;

  const key = privateKey ?? process.env.POLYGON_PRIVATE_KEY;
  if (!key) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account      = getAccount(key);
  const walletClient = createWalletClient({
    account, chain: polygon, transport: http(POLYGON_RPC()),
  });

  const tmp   = new ClobClient({ host: CLOB_BASE, chain: POLYGON_CHAIN_ID, signer: walletClient });
  const creds = await tmp.deriveApiKey();

  _cachedCreds = {
    apiKey:     creds.key,
    secret:     creds.secret,
    passphrase: creds.passphrase,
    address:    account.address,
  };

  console.log(`[clob] ✅ Credentials dérivés pour ${account.address}`);
  return _cachedCreds;
}

// ---------------------------------------------------------------------------
// getClobMarket
// ---------------------------------------------------------------------------

export async function getClobMarket(conditionId: string): Promise<ClobMarket | null> {
  try {
    const res = await fetch(`${CLOB_BASE}/markets/${encodeURIComponent(conditionId)}`, {
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;

    const raw = await res.json() as {
      condition_id: string;
      tokens?: Array<{ token_id: string; outcome: string; price: number }>;
      neg_risk?: boolean;
      active?: boolean;
    };

    return {
      conditionId: raw.condition_id,
      tokens: (raw.tokens ?? []).map((t) => ({ tokenId: t.token_id, outcome: t.outcome, price: t.price })),
      negRisk: raw.neg_risk ?? false,
      active:  raw.active  ?? true,
    };
  } catch (err) {
    console.error("[clob] getClobMarket:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// placeOrder — utilise ClobClient.createAndPostOrder()
// ---------------------------------------------------------------------------

export async function placeOrder(params: PlaceOrderParams): Promise<PlacedOrder> {
  // Taille en shares : amountUsdc / price
  // Ex: acheter $0.50 @ 0.05 = 10 shares
  const size = params.amountUsdc / params.price;
  const side = params.side === "BUY" ? ClobSide.BUY : ClobSide.SELL;

  console.log(
    `[clob] ${params.dryRun ? "DRY-RUN " : ""}placeOrder: ` +
    `${params.side} ${params.amountUsdc}$ @ ${params.price} = ${size.toFixed(4)} shares ` +
    `(tokenId=${params.tokenId.slice(0, 10)}...)`
  );

  // negRisk: true → order version v2 (NegRiskCTFExchange)
  // negRisk: false/undefined → order version v1 (CTFExchange)
  const orderOptions = { negRisk: params.negRisk };

  if (params.dryRun) {
    // Dry-run : construit et signe l'ordre sans le soumettre
    const client = await getClobClient();
    const signed = await client.createOrder(
      { tokenID: params.tokenId, price: params.price, size, side },
      orderOptions
    );
    return {
      orderId:    "dry-run",
      status:     "dry_run",
      tokenId:    params.tokenId,
      side:       params.side,
      price:      params.price,
      amountUsdc: params.amountUsdc,
      gasFeeUsdc: POLYGON_GAS_FEE,
      dryRun:     true,
      orderHash:  (signed as { orderHash?: string }).orderHash?.slice(0, 20) ?? "signed",
    };
  }

  const client = await getClobClient();
  const orderInput = { tokenID: params.tokenId, price: params.price, size, side };
  console.log("[clob] createAndPostOrder input:", JSON.stringify({ ...orderInput, ...orderOptions }));

  const result = await client.createAndPostOrder(
    orderInput,
    orderOptions,  // ← negRisk flag — détermine la version d'ordre (v1 vs v2)
    ClobOrderType.GTC
  ) as Record<string, unknown>;

  // throwOnError=true → les erreurs HTTP lèvent une exception avec le message Polymarket.
  // Vérification défensive au cas où throwOnError ne couvrirait pas tous les cas.
  if (result && "error" in result) {
    const errMsg = typeof result.error === "string" ? result.error : JSON.stringify(result);
    console.error("[clob] ❌ Polymarket error body:", JSON.stringify(result));
    throw new Error(`[clob] Polymarket rejected order (HTTP ${result.status ?? "?"}): ${errMsg}`);
  }

  // Le résultat peut être { orderID, status } ou { id, status }
  const orderId = (result.orderID ?? result.id ?? "unknown") as string;
  console.log(`[clob] ✅ Ordre placé: ${orderId} (${result.status})`);

  return {
    orderId,
    status:     (result as Record<string, string>).status ?? "placed",
    tokenId:    params.tokenId,
    side:       params.side,
    price:      params.price,
    amountUsdc: params.amountUsdc,
    gasFeeUsdc: POLYGON_GAS_FEE,
    dryRun:     false,
  };
}

// ---------------------------------------------------------------------------
// cancelOrder — utilise ClobClient.cancelOrder()
// ---------------------------------------------------------------------------

export async function cancelOrder(orderId: string): Promise<void> {
  const client = await getClobClient();
  const res    = await client.cancelOrder({ orderID: orderId });
  console.log(`[clob] ✅ Ordre ${orderId} annulé:`, res);
}

// ---------------------------------------------------------------------------
// getOrderBook
// ---------------------------------------------------------------------------

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const res = await fetch(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`[clob] getOrderBook HTTP ${res.status}`);

  const raw = await res.json() as {
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
  };

  const bids = (raw.bids ?? []).map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })).sort((a, b) => b.price - a.price);
  const asks = (raw.asks ?? []).map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;

  return { tokenId, bids, asks, bestBid, bestAsk, spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null };
}

// ---------------------------------------------------------------------------
// Proxy resolution (verbose)
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

async function resolveProxyWithDebug(
  eoa:    `0x${string}`,
  client: ReturnType<typeof createPublicClient>
): Promise<{ proxy: `0x${string}` | null; debug: ProxyResolutionDebug }> {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const url  = `${CLOB_BASE}/proxy-wallet?address=${eoa}`;
  const debug: ProxyResolutionDebug = {
    eoa, proxyAddress: null, method: "not_found",
    clobApiUrl: url, clobApiStatus: null, clobApiBody: null, clobApiError: null,
    factoryAddress: PROXY_FACTORY_ADDRESS, factoryResult: null, factoryError: null,
  };

  try {
    const res  = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await res.text();
    debug.clobApiStatus = res.status;
    debug.clobApiBody   = body.slice(0, 300);
    if (res.ok) {
      const data  = JSON.parse(body) as Record<string, unknown>;
      const proxy = (data.proxy_wallet ?? data.proxyWallet ?? data.address) as string | undefined;
      if (proxy && proxy !== ZERO && proxy.startsWith("0x")) {
        debug.proxyAddress = proxy;
        debug.method       = "clob_api";
        return { proxy: proxy as `0x${string}`, debug };
      }
    }
  } catch (err) {
    debug.clobApiError = err instanceof Error ? err.message : String(err);
  }

  try {
    const result = await client.readContract({
      address: PROXY_FACTORY_ADDRESS, abi: PROXY_FACTORY_ABI, functionName: "getProxyWallet", args: [eoa],
    }) as `0x${string}`;
    debug.factoryResult = result;
    if (result && result !== ZERO && result.startsWith("0x")) {
      debug.proxyAddress = result;
      debug.method       = "factory_contract";
      return { proxy: result, debug };
    }
  } catch (err) {
    debug.factoryError = err instanceof Error ? err.message : String(err);
  }

  return { proxy: null, debug };
}

async function getPolymarketProxyAddress(
  eoa:    `0x${string}`,
  client: ReturnType<typeof createPublicClient>
): Promise<`0x${string}` | null> {
  const { proxy } = await resolveProxyWithDebug(eoa, client);
  return proxy;
}

// ---------------------------------------------------------------------------
// detectTradingMode
// ---------------------------------------------------------------------------

export type TradingModeId = "A_PROXY" | "B_EOA" | "UNKNOWN";

export interface TradingModeDetection {
  selectedMode:            TradingModeId;
  eoaAddress:              string;
  proxyAddress:            string | null;
  proxyResolutionMethod:   "clob_api" | "factory_contract" | "not_found";
  eoaAllowanceCTF:         string;
  eoaAllowanceNegRisk:     string;
  proxyAllowanceCTF:       string | null;
  proxyAllowanceNegRisk:   string | null;
  rpcUsed:                 string | null;
  error:                   string | null;
}

export async function detectTradingMode(
  eoa: `0x${string}`
): Promise<TradingModeDetection> {
  const result: TradingModeDetection = {
    selectedMode: "UNKNOWN", eoaAddress: eoa, proxyAddress: null,
    proxyResolutionMethod: "not_found",
    eoaAllowanceCTF: "0", eoaAllowanceNegRisk: "0",
    proxyAllowanceCTF: null, proxyAllowanceNegRisk: null,
    rpcUsed: null, error: null,
  };

  for (const rpc of POLYGON_RPC_FALLBACKS()) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });
      result.rpcUsed = rpc;

      const { proxy, debug } = await resolveProxyWithDebug(eoa, client);
      result.proxyAddress          = proxy;
      result.proxyResolutionMethod = debug.method;

      const readAllow = async (owner: `0x${string}`, spender: `0x${string}`) =>
        await client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] }) as bigint;

      const eoaCTF      = await readAllow(eoa, CTF_EXCHANGE);
      const eoaNegRisk  = await readAllow(eoa, NEG_RISK_CTF_EXCHANGE);
      result.eoaAllowanceCTF     = (Number(eoaCTF)     / USDC_DECIMALS).toFixed(6);
      result.eoaAllowanceNegRisk = (Number(eoaNegRisk) / USDC_DECIMALS).toFixed(6);

      if (proxy) {
        const proxyCTF      = await readAllow(proxy, CTF_EXCHANGE);
        const proxyNegRisk  = await readAllow(proxy, NEG_RISK_CTF_EXCHANGE);
        result.proxyAllowanceCTF     = (Number(proxyCTF)     / USDC_DECIMALS).toFixed(6);
        result.proxyAllowanceNegRisk = (Number(proxyNegRisk) / USDC_DECIMALS).toFixed(6);

        if (proxyCTF > BigInt(0) || proxyNegRisk > BigInt(0)) {
          result.selectedMode = "A_PROXY";
          console.log(`[clob] detectTradingMode: A_PROXY — proxy=${proxy} CTF=${result.proxyAllowanceCTF}`);
          return result;
        }
      }

      if (eoaCTF > BigInt(0) || eoaNegRisk > BigInt(0)) {
        result.selectedMode = "B_EOA";
        console.log(`[clob] detectTradingMode: B_EOA — EOA CTF=${result.eoaAllowanceCTF}`);
        return result;
      }

      result.selectedMode = "UNKNOWN";
      console.warn(`[clob] detectTradingMode: UNKNOWN — no allowance on EOA or proxy`);
      return result;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
  }

  result.error = "All RPCs failed";
  return result;
}

// ---------------------------------------------------------------------------
// getOnChainUSDCBalance / getAccountBalance
// ---------------------------------------------------------------------------

export async function getOnChainUSDCBalance(address: `0x${string}`): Promise<number | null> {
  for (const rpc of POLYGON_RPC_FALLBACKS()) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });
      const raw    = await client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }) as bigint;
      return Number(raw) / USDC_DECIMALS;
    } catch { /* try next */ }
  }
  return null;
}

export async function getAccountBalance(): Promise<number | null> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(privateKey);

  // Si POLYMARKET_FUNDER_ADDRESS est défini, c'est là que sont les fonds
  const envFunder = process.env.POLYMARKET_FUNDER_ADDRESS as `0x${string}` | undefined;

  for (const rpc of POLYGON_RPC_FALLBACKS()) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });

      if (envFunder) {
        // Funder Polymarket V2 détient du pUSD (0xC011a7…), pas de l'USDC natif
        const raw     = await client.readContract({ address: PUSD_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [envFunder] }) as bigint;
        const balance = Number(raw) / USDC_DECIMALS; // pUSD = 6 decimals comme USDC
        console.log(`[clob] getAccountBalance funder=${envFunder.slice(0, 10)}… pUSD: ${balance.toFixed(4)}`);
        return balance;
      }

      const proxy  = await getPolymarketProxyAddress(account.address, client);

      if (proxy) {
        const raw     = await client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [proxy] }) as bigint;
        const balance = Number(raw) / USDC_DECIMALS;
        console.log(`[clob] getAccountBalance (proxy): ${balance.toFixed(4)} USDC`);
        return balance;
      }

      const raw     = await client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }) as bigint;
      const balance = Number(raw) / USDC_DECIMALS;
      console.log(`[clob] getAccountBalance (EOA): ${balance.toFixed(4)} USDC`);
      return balance;
    } catch (err) {
      console.warn(`[clob] getAccountBalance RPC ${rpc} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// checkCTFAllowance / checkAllAllowances
// ---------------------------------------------------------------------------

export async function checkAllAllowances(): Promise<SpenderAllowance[]> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account = getAccount(privateKey);
  let   lastErr = new Error("no RPC tried");

  for (const rpc of POLYGON_RPC_FALLBACKS()) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });
      const proxy  = await getPolymarketProxyAddress(account.address, client);
      const owner  = proxy ?? account.address;

      const results: SpenderAllowance[] = [];
      for (const { name, address: spender } of APPROVAL_SPENDERS) {
        const raw           = await client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] }) as bigint;
        const allowanceUsdc = Number(raw) / USDC_DECIMALS;
        const sufficient    = raw > BigInt(1_000 * USDC_DECIMALS);
        results.push({ name, spender, allowanceUsdc, sufficient });
        console.log(`[clob] allowance(${proxy ? "proxy" : "EOA"}, ${name}): ${allowanceUsdc.toFixed(2)} USDC ${sufficient ? "✅" : "❌"}`);
      }
      return results;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new Error(`[clob] checkAllAllowances: all RPCs failed — ${lastErr.message}`);
}

/**
 * Vérifie que le wallet a approuvé le bon spender pour le type de marché.
 *  - negRisk=false → CTF Exchange           (0x4bFb…)
 *  - negRisk=true  → NegRisk CTF Exchange   (0xC5d5…)
 */
export async function checkCTFAllowance(negRisk = false): Promise<AllowanceResult> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account  = getAccount(privateKey);
  const spender  = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;
  const name     = negRisk ? "NegRisk CTF Exchange" : "CTF Exchange";
  const all      = await checkAllAllowances();
  const entry    = all.find((a) => a.spender.toLowerCase() === spender.toLowerCase());
  const sufficient = entry?.sufficient ?? false;
  const allowance  = entry ? BigInt(Math.floor(entry.allowanceUsdc * USDC_DECIMALS)) : BigInt(0);

  if (!sufficient) {
    console.warn(`[clob] checkCTFAllowance(negRisk=${negRisk}): allowance insuffisante pour ${name} (${entry?.allowanceUsdc?.toFixed(2) ?? "0"} USDC)`);
  } else {
    console.log(`[clob] checkCTFAllowance(negRisk=${negRisk}): ✅ ${name} OK (${entry?.allowanceUsdc?.toFixed(2)} USDC)`);
  }
  return { allowance, sufficient, owner: account.address, spender };
}

// ---------------------------------------------------------------------------
// debugAllowances
// ---------------------------------------------------------------------------

export interface AllowanceDebugEntry {
  spenderName: string; spenderAddress: string; owner: string;
  allowanceRaw: string; allowanceFormatted: string; sufficient: boolean;
  rpcUsed: string; error: string | null;
}

export interface AllowanceDebugResult {
  eoaAddress: string;
  proxyResolution: ProxyResolutionDebug;
  ownerChecked: string; ownerType: "proxy" | "eoa";
  ctfExchangeAddress: string; negRiskExchangeAddress: string;
  spenders: AllowanceDebugEntry[];
  rpcAttempts: string[];
}

export async function debugAllowances(): Promise<AllowanceDebugResult> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account    = getAccount(privateKey);
  const rpcs       = POLYGON_RPC_FALLBACKS();
  const attempted: string[] = [];
  let   proxyDebug: ProxyResolutionDebug | null = null;
  let   owner: `0x${string}` = account.address;
  let   ownerType: "proxy" | "eoa" = "eoa";

  for (const rpc of rpcs) {
    attempted.push(rpc);
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpc) });
      const { proxy, debug } = await resolveProxyWithDebug(account.address, client);
      proxyDebug = debug;
      if (proxy) { owner = proxy; ownerType = "proxy"; }
      break;
    } catch { /* try next */ }
  }

  const spenderResults: AllowanceDebugEntry[] = [];
  for (const { name, address: spender } of APPROVAL_SPENDERS) {
    let entry: AllowanceDebugEntry = {
      spenderName: name, spenderAddress: spender, owner,
      allowanceRaw: "0", allowanceFormatted: "0.000000", sufficient: false,
      rpcUsed: "", error: null,
    };
    for (const rpc of rpcs) {
      try {
        const client = createPublicClient({ chain: polygon, transport: http(rpc) });
        const raw    = await client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] }) as bigint;
        entry = { ...entry, allowanceRaw: raw.toString(), allowanceFormatted: (Number(raw) / USDC_DECIMALS).toFixed(6), sufficient: raw > BigInt(1_000 * USDC_DECIMALS), rpcUsed: rpc, error: null };
        break;
      } catch (err) { entry.error = err instanceof Error ? err.message : String(err); }
    }
    spenderResults.push(entry);
  }

  return {
    eoaAddress: account.address,
    proxyResolution: proxyDebug ?? {
      eoa: account.address, proxyAddress: null, method: "not_found",
      clobApiUrl: `${CLOB_BASE}/proxy-wallet?address=${account.address}`,
      clobApiStatus: null, clobApiBody: null, clobApiError: "no RPC",
      factoryAddress: PROXY_FACTORY_ADDRESS, factoryResult: null, factoryError: null,
    },
    ownerChecked: owner, ownerType,
    ctfExchangeAddress: CTF_EXCHANGE, negRiskExchangeAddress: NEG_RISK_CTF_EXCHANGE,
    spenders: spenderResults, rpcAttempts: attempted,
  };
}

// ---------------------------------------------------------------------------
// approveCTF — envoie approve(MAX_UINT256) depuis l'EOA
// ---------------------------------------------------------------------------

export async function approveCTF(): Promise<ApproveCTFResult> {
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) throw new Error("[clob] POLYGON_PRIVATE_KEY non défini");

  const account      = getAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC()) });
  const current      = await checkAllAllowances();
  const result: ApproveCTFResult = { wallet: account.address, approvals: [] };

  for (const { name, address: spender } of APPROVAL_SPENDERS) {
    const existing = current.find((c) => c.spender === spender);
    if (existing?.sufficient) {
      result.approvals.push({ name, spender, txHash: null, skipped: true });
      continue;
    }
    const txHash = await walletClient.writeContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [spender, MAX_UINT256] });
    console.log(`[clob] ✅ Approval ${name}: txHash=${txHash}`);
    result.approvals.push({ name, spender, txHash, skipped: false });
    await new Promise((r) => setTimeout(r, 2000));
  }

  return result;
}

// ---------------------------------------------------------------------------
// resetAllowanceCache — compatibilité trade-executor
// ---------------------------------------------------------------------------

/** Alias de clearCredentialsCache() — réinitialise le cache client ClobClient. */
export const resetAllowanceCache = clearCredentialsCache;
