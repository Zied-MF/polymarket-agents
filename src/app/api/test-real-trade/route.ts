/**
 * Test Real Trade endpoint
 *
 * GET /api/test-real-trade               → dry_run=true (défaut) : signe, ne soumet pas
 * GET /api/test-real-trade?dry_run=false → soumet un ordre live de $0.50 via placeOrder()
 *                                          + vérifie en DB que clob_order_id est bien persisté
 *
 * Diagnostics retournés :
 *   - wallet address + balance USDC
 *   - marché météo le moins cher trouvé sur Gamma
 *   - tokenId CLOB résolu
 *   - signature EIP-712 (toujours effectuée)
 *   - orderId si soumis en live
 *   - dbVerification : { positionId, clobOrderIdInDb, isRealInDb, ok } si dry_run=false
 */

import { NextRequest, NextResponse } from "next/server";
import {
  deriveClobCredentials,
  getClobMarket,
  placeOrder,
  getAccountBalance,
  checkCTFAllowance,
  debugAllowances,
  detectTradingMode,
}                                    from "@/lib/polymarket/clob-api";
import { executeBuy, isRealTradingEnabled, resetAllowanceCache } from "@/lib/trade-executor";
import { getPositionByPaperTradeId }                            from "@/lib/db/positions";

// ---------------------------------------------------------------------------
// Gamma — recherche d'un marché pour test d'exécution
// ---------------------------------------------------------------------------

const GAMMA_BASE = "https://gamma-api.polymarket.com";

const GAMMA_HEADERS: HeadersInit = {
  Accept:       "application/json",
  "User-Agent": "polymarket-agents/test",
};

/** Mots-clés météo — match si au moins un est dans la question (case-insensitive). */
const WEATHER_KEYWORDS = ["temperature", "rain", "snow", "weather", "heat", "cold", "wind", "storm"];

interface GammaRawMarket {
  id:             string;
  conditionId?:   string;
  question?:      string;
  outcomes?:      string | string[];
  outcomePrices?: string | string[];
  active?:        boolean;
  closed?:        boolean;
  endDate?:       string;
  liquidity?:     string | number;
  volume?:        string | number;
}

interface GammaEvent {
  id:      string;
  title?:  string;
  endDate?: string;
  active?:  boolean;
  closed?:  boolean;
  markets?: GammaRawMarket[];
}

function parseJsonField<T>(raw: string | T[] | undefined): T[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as T[]; } catch { return []; }
}

export interface FoundMarket {
  gammaId:      string;
  conditionId:  string;
  question:     string;
  yesPrice:     number;
  liquidity:    number;
  hoursToClose: number;
  matchReason:  string;  // quelle passe a sélectionné ce marché (debug)
}

export interface MarketSearchDiag {
  eventsFromGamma:      number;
  marketsExtracted:     number;  // tous les marchés dans tous les events
  marketsActive:        number;
  weatherMarketsFound:  number;  // passent filtre keyword + 7j + liq>100
  fallbackMarketsFound: number;  // si weatherMarketsFound=0, any market 30j liq>100
  sampleQuestions:      string[];
  selectedMarket:       FoundMarket | null;
}

/**
 * Cherche un marché pour test d'exécution, en 3 passes de plus en plus larges.
 *
 * Passe 1 — météo stricte :
 *   keyword météo + endDate < 7j + yesPrice 1-99% + liquidity > 100
 * Passe 2 — n'importe quel actif :
 *   endDate < 30j + yesPrice 1-99% + liquidity > 100
 *
 * Source : /events?tag_slug=weather (même endpoint que le bot)
 * + fallback /markets?active=true pour la passe 2 si besoin.
 */
async function findMarketForTest(): Promise<MarketSearchDiag> {
  const now      = Date.now();
  const H7       = 7  * 24 * 60 * 60 * 1000;
  const H30      = 30 * 24 * 60 * 60 * 1000;
  const MIN_LIQ  = 100;

  const diag: MarketSearchDiag = {
    eventsFromGamma:      0,
    marketsExtracted:     0,
    marketsActive:        0,
    weatherMarketsFound:  0,
    fallbackMarketsFound: 0,
    sampleQuestions:      [],
    selectedMarket:       null,
  };

  // ── Source 1 : /events?tag_slug=weather (même URL que le bot) ─────────────
  let allMarkets: (GammaRawMarket & { _eventTitle?: string })[] = [];

  try {
    const url = `${GAMMA_BASE}/events?tag_slug=weather&active=true&closed=false&order=endDate&ascending=true&limit=100`;
    const res = await fetch(url, { headers: GAMMA_HEADERS });
    if (res.ok) {
      const raw: unknown = await res.json();
      const events: GammaEvent[] = Array.isArray(raw)
        ? (raw as GammaEvent[])
        : (((raw as Record<string, unknown>).data) as GammaEvent[] | undefined) ?? [];

      diag.eventsFromGamma = events.length;

      for (const ev of events) {
        for (const m of (ev.markets ?? [])) {
          allMarkets.push({ ...m, _eventTitle: ev.title });
          diag.marketsExtracted++;
        }
      }
    }
  } catch { /* continue avec fallback */ }

  // ── Source 2 fallback : /markets?active=true si events vides ──────────────
  if (allMarkets.length === 0) {
    try {
      const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=200`;
      const res = await fetch(url, { headers: GAMMA_HEADERS });
      if (res.ok) {
        const raw = await res.json() as GammaRawMarket[];
        allMarkets = raw;
        diag.marketsExtracted = raw.length;
      }
    } catch { /* ignore */ }
  }

  // ── Stats de base ──────────────────────────────────────────────────────────
  const activeMarkets = allMarkets.filter((m) => m.active !== false && !m.closed);
  diag.marketsActive  = activeMarkets.length;
  diag.sampleQuestions = activeMarkets
    .slice(0, 5)
    .map((m) => m.question ?? m._eventTitle ?? m.id);

  // ── Helper : convertir un GammaRawMarket en FoundMarket ───────────────────
  function toFound(m: GammaRawMarket & { _eventTitle?: string }, reason: string): FoundMarket | null {
    const conditionId = m.conditionId ?? m.id;
    const outcomes    = parseJsonField<string>(m.outcomes);
    const prices      = parseJsonField<string>(m.outcomePrices).map(Number);
    const yesIdx      = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    if (yesIdx < 0 || prices.length !== outcomes.length) return null;
    const yesPrice    = prices[yesIdx];
    if (yesPrice <= 0.01 || yesPrice >= 0.99) return null;
    const closeMs     = m.endDate ? new Date(m.endDate).getTime() : NaN;
    const hoursToClose = isNaN(closeMs) ? 999 : (closeMs - now) / 3_600_000;
    const liquidity   = parseFloat(String(m.liquidity ?? "0"));
    return {
      gammaId:      m.id,
      conditionId,
      question:     m.question ?? m._eventTitle ?? m.id,
      yesPrice,
      liquidity,
      hoursToClose: Math.round(hoursToClose * 10) / 10,
      matchReason:  reason,
    };
  }

  // ── Passe 1 : météo keyword + 7j + liq > 100 ──────────────────────────────
  const weatherPass1: FoundMarket[] = [];
  for (const m of activeMarkets) {
    const q   = (m.question ?? m._eventTitle ?? "").toLowerCase();
    const hit = WEATHER_KEYWORDS.some((kw) => q.includes(kw));
    if (!hit) continue;
    const closeMs = m.endDate ? new Date(m.endDate).getTime() : NaN;
    if (!isNaN(closeMs) && (closeMs - now) > H7) continue;
    const liq = parseFloat(String(m.liquidity ?? "0"));
    if (liq < MIN_LIQ) continue;
    const found = toFound(m, `weather-keyword+7d`);
    if (found) weatherPass1.push(found);
  }
  diag.weatherMarketsFound = weatherPass1.length;

  if (weatherPass1.length > 0) {
    weatherPass1.sort((a, b) => b.liquidity - a.liquidity);
    diag.selectedMarket = weatherPass1[0];
    return diag;
  }

  // ── Passe 2 : n'importe quel actif + 30j + liq > 100 ─────────────────────
  const fallbackPass: FoundMarket[] = [];
  for (const m of activeMarkets) {
    const closeMs = m.endDate ? new Date(m.endDate).getTime() : NaN;
    if (!isNaN(closeMs) && (closeMs - now) > H30) continue;
    const liq = parseFloat(String(m.liquidity ?? "0"));
    if (liq < MIN_LIQ) continue;
    const found = toFound(m, `any-market+30d`);
    if (found) fallbackPass.push(found);
  }
  diag.fallbackMarketsFound = fallbackPass.length;

  if (fallbackPass.length > 0) {
    fallbackPass.sort((a, b) => b.liquidity - a.liquidity);
    diag.selectedMarket = fallbackPass[0];
  }

  return diag;
}

// ---------------------------------------------------------------------------
// Geoblock check
// ---------------------------------------------------------------------------

async function checkGeoblock(): Promise<{ blocked: boolean | null; country: string | null; region: string | null; raw: unknown }> {
  const result = { blocked: null as boolean | null, country: null as string | null, region: null as string | null, raw: null as unknown };
  try {
    const res  = await fetch("https://polymarket.com/api/geoblock", {
      headers: { "User-Agent": "polymarket-agents/diagnostic", Accept: "application/json" },
    });
    const body = await res.json() as Record<string, unknown>;
    result.raw     = body;
    result.blocked = (body.blocked ?? body.isBlocked ?? null) as boolean | null;
    result.country = (body.country ?? body.countryCode ?? null) as string | null;
    result.region  = (body.region ?? null) as string | null;
  } catch (err) {
    result.raw = { error: err instanceof Error ? err.message : String(err) };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const dryRunParam = req.nextUrl.searchParams.get("dry_run");
  const dryRun      = dryRunParam !== "false"; // défaut true

  // ── Toujours présent dans la réponse, dry_run ou pas ─────────────────────
  const envVarCheck = {
    REAL_TRADING_ENABLED_raw:      process.env.REAL_TRADING_ENABLED ?? "(not set)",
    REAL_TRADING_ENABLED_isTrue:   process.env.REAL_TRADING_ENABLED === "true",
    POLYGON_PRIVATE_KEY_present:   !!process.env.POLYGON_PRIVATE_KEY,
    POLYGON_PRIVATE_KEY_length:    process.env.POLYGON_PRIVATE_KEY?.length ?? 0,
    DISCORD_WEBHOOK_URL_present:   !!process.env.DISCORD_WEBHOOK_URL,
    NEXT_PUBLIC_SUPABASE_URL_present: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
  };

  // realTradingFlow est muté au fil du handler — toujours inclus dans la réponse
  const realTradingFlow: Record<string, unknown> = {
    attempted:  false,
    step:       "not_started",
    error:      null,
    errorStack: null,
  };

  const diag: Record<string, unknown> = {
    dryRun,
    timestamp:       new Date().toISOString(),
    vercelRegion:    process.env.VERCEL_REGION ?? process.env.AWS_REGION ?? "(local)",
    envVarCheck,
    realTradingFlow, // référence partagée — mutations visibles dans la réponse finale
  };

  // 1. Vérification env vars
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) {
    realTradingFlow.step  = "FAILED_no_private_key";
    realTradingFlow.error = "POLYGON_PRIVATE_KEY manquant dans les variables d'environnement";
    return NextResponse.json(
      { ...diag, error: "POLYGON_PRIVATE_KEY manquant" },
      { status: 500 }
    );
  }
  diag.envCheck = "ok";

  // 2. Dériver les credentials CLOB
  try {
    const creds = await deriveClobCredentials(privateKey);
    diag.wallet  = creds.address;
    diag.apiKey  = creds.apiKey.slice(0, 8) + "…";
  } catch (err) {
    return NextResponse.json(
      { ...diag, error: `deriveClobCredentials: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }

  // 3. Balance USDC (null = tous RPCs ont échoué)
  try {
    const balance = await getAccountBalance();
    diag.balanceUsdc = balance ?? "RPC_FAILURE";
  } catch (err) {
    diag.balanceError = err instanceof Error ? err.message : String(err);
  }

  // 3b. Trading mode detection + allowance debug + geoblock — TOUJOURS dans la réponse.
  const [tradingMode, allowanceDbg, geoBlock] = await Promise.allSettled([
    (async () => {
      const creds = await deriveClobCredentials(privateKey).catch(() => null);
      const eoa   = (creds?.address ?? "") as `0x${string}`;
      return eoa ? detectTradingMode(eoa) : null;
    })(),
    debugAllowances(),
    checkGeoblock(),
  ]);
  diag.tradingModeDetection = tradingMode.status === "fulfilled" ? tradingMode.value : { error: (tradingMode as PromiseRejectedResult).reason?.message };
  diag.allowanceDebug       = allowanceDbg.status === "fulfilled" ? allowanceDbg.value : { error: (allowanceDbg as PromiseRejectedResult).reason?.message };
  diag.geoBlockCheck        = geoBlock.status === "fulfilled" ? geoBlock.value : { error: (geoBlock as PromiseRejectedResult).reason?.message };

  // 4. Chercher un marché (3 passes, de plus en plus larges)
  const searchDiag = await findMarketForTest();
  diag.marketSearch = {
    eventsFromGamma:      searchDiag.eventsFromGamma,
    marketsExtracted:     searchDiag.marketsExtracted,
    marketsActive:        searchDiag.marketsActive,
    weatherMarketsFound:  searchDiag.weatherMarketsFound,
    fallbackMarketsFound: searchDiag.fallbackMarketsFound,
    sampleQuestions:      searchDiag.sampleQuestions,
    selectedMarket:       searchDiag.selectedMarket,
  };

  const market = searchDiag.selectedMarket;
  if (!market) {
    return NextResponse.json(
      {
        ...diag,
        error: `Aucun marché trouvé. Consulter marketSearch pour le diagnostic complet.`,
      },
      { status: 404 }
    );
  }
  diag.market = {
    gammaId:      market.gammaId,
    conditionId:  market.conditionId,
    question:     market.question,
    yesPrice:     market.yesPrice,
    liquidity:    market.liquidity,
    hoursToClose: market.hoursToClose,
    matchReason:  market.matchReason,
  };

  // 5. Résoudre les tokenIds via le CLOB
  const clobMarket = await getClobMarket(market.conditionId);
  if (!clobMarket) {
    return NextResponse.json(
      { ...diag, error: `getClobMarket(${market.conditionId}) introuvable` },
      { status: 404 }
    );
  }
  if (!clobMarket.active) {
    return NextResponse.json(
      { ...diag, error: `Marché CLOB inactif: ${market.conditionId}` },
      { status: 422 }
    );
  }

  const yesToken = clobMarket.tokens.find((t) => t.outcome.toLowerCase() === "yes");
  if (!yesToken) {
    return NextResponse.json(
      { ...diag, error: "Token 'Yes' introuvable dans le CLOB" },
      { status: 404 }
    );
  }
  diag.clobMarket = {
    conditionId: clobMarket.conditionId,
    negRisk:     clobMarket.negRisk,
    yesTokenId:  yesToken.tokenId,
    yesPrice:    yesToken.price,
  };

  // ── DRY RUN ────────────────────────────────────────────────────────────────
  // Signe l'ordre EIP-712 mais ne l'envoie pas et n'écrit rien en DB.
  if (dryRun) {
    try {
      const placed = await placeOrder({
        tokenId:    yesToken.tokenId,
        side:       "BUY",
        amountUsdc: 0.50,
        price:      market.yesPrice,
        negRisk:    clobMarket.negRisk,
        dryRun:     true,
      });

      diag.order = {
        tokenId:    yesToken.tokenId,
        side:       "BUY",
        amountUsdc: 0.50,
        price:      market.yesPrice,
        orderId:    placed.orderId,   // "dry-run"
        gasFeeUsdc: placed.gasFeeUsdc,
        submitted:  false,
      };
    } catch (err) {
      return NextResponse.json(
        { ...diag, error: `placeOrder (dry-run): ${err instanceof Error ? err.message : err}` },
        { status: 500 }
      );
    }

    diag.status = "DRY_RUN_OK";
    return NextResponse.json(diag);
  }

  // ── LIVE ORDER ─────────────────────────────────────────────────────────────
  // On N'utilise PAS executeBuy() ici car il swallow les erreurs en fallback
  // paper. On appelle chaque étape manuellement pour voir exactement où ça casse.

  const BET_USDC = 0.50;

  // ── Step 0 : Force REAL_TRADING_ENABLED pour ce test ─────────────────────
  const envRaw    = process.env.REAL_TRADING_ENABLED;
  process.env.REAL_TRADING_ENABLED = "true";
  resetAllowanceCache();

  realTradingFlow.attempted = true;
  realTradingFlow.envForcedToTrue = true;
  realTradingFlow.REAL_TRADING_ENABLED_before = envRaw ?? "(not set)";
  realTradingFlow.REAL_TRADING_ENABLED_after  = isRealTradingEnabled();

  // ── Step 1 : Balance ───────────────────────────────────────────────────────
  // null = tous les RPCs Polygon ont échoué → on avertit mais on continue
  // (Polymarket rejettera l'ordre côté CLOB si balance insuffisante).
  try {
    realTradingFlow.step = "balance_check";
    const balance     = await getAccountBalance();
    const minRequired = BET_USDC * 1.05;

    if (balance === null) {
      realTradingFlow.step              = "balance_check_skipped";
      realTradingFlow.balanceUsdc       = null;
      realTradingFlow.balanceNote       = "All Polygon RPCs failed — balance unknown, proceeding";
      realTradingFlow.balanceSufficient = null;
    } else {
      realTradingFlow.balanceUsdc       = balance;
      realTradingFlow.balanceMinRequired = minRequired;
      realTradingFlow.balanceSufficient  = balance >= minRequired;
      if (balance < minRequired) {
        realTradingFlow.step  = "FAILED_balance";
        realTradingFlow.error = `Balance insuffisante: ${balance.toFixed(4)} USDC < ${minRequired.toFixed(4)} USDC requis`;
        diag.status = "REAL_FAILED_BALANCE";
        return NextResponse.json(diag, { status: 422 });
      }
      realTradingFlow.step = "balance_check_ok";
    }
  } catch (err) {
    realTradingFlow.step       = "FAILED_balance_error";
    realTradingFlow.error      = err instanceof Error ? err.message : String(err);
    realTradingFlow.errorStack = err instanceof Error ? err.stack?.slice(0, 600) : null;
    diag.status = "REAL_FAILED_BALANCE_ERROR";
    return NextResponse.json(diag, { status: 500 });
  }

  // ── Step 2 : Allowance CTF Exchange ───────────────────────────────────────
  // allowanceDebug (step 3b above) already has full proxy + raw values.
  // Surface key fields here for quick reading alongside the other flow steps.
  try {
    realTradingFlow.step = "allowance_check";

    const ad = diag.allowanceDebug as Record<string, unknown> | null | undefined;
    if (ad && !("error" in (ad as object))) {
      realTradingFlow.allowanceOwnerChecked = (ad as { ownerChecked?: string }).ownerChecked ?? null;
      realTradingFlow.allowanceOwnerType    = (ad as { ownerType?: string }).ownerType ?? null;
      realTradingFlow.proxyResolved         =
        (ad as { proxyResolution?: { proxyAddress?: string } }).proxyResolution?.proxyAddress ?? null;
    }

    const { sufficient, allowance } = await checkCTFAllowance();
    realTradingFlow.allowanceUsdc       = (Number(allowance) / 1_000_000).toFixed(2);
    realTradingFlow.allowanceSufficient = sufficient;
    if (!sufficient) {
      realTradingFlow.step  = "FAILED_allowance";
      realTradingFlow.error = `CTF Exchange allowance insuffisante (${(Number(allowance) / 1_000_000).toFixed(2)} USDC). Appeler /api/approve-ctf?execute=true.`;
      diag.status = "REAL_FAILED_ALLOWANCE";
      return NextResponse.json(diag, { status: 422 });
    }
    realTradingFlow.step = "allowance_check_ok";
  } catch (err) {
    realTradingFlow.step       = "FAILED_allowance_error";
    realTradingFlow.error      = err instanceof Error ? err.message : String(err);
    realTradingFlow.errorStack = err instanceof Error ? err.stack?.slice(0, 600) : null;
    diag.status = "REAL_FAILED_ALLOWANCE_ERROR";
    return NextResponse.json(diag, { status: 500 });
  }

  // ── Step 3 : Signature + soumission ordre CLOB ────────────────────────────
  const orderPayload = {
    tokenId:    yesToken.tokenId,
    side:       "BUY" as const,
    amountUsdc: BET_USDC,
    price:      market.yesPrice,
    size:       BET_USDC / market.yesPrice,
    negRisk:    clobMarket.negRisk,
  };
  realTradingFlow.orderPayload = orderPayload; // toujours visible même en cas d'erreur

  let orderId: string | null = null;
  try {
    realTradingFlow.step = "place_order";
    const placed = await placeOrder({
      ...orderPayload,
      dryRun: false,
    });
    orderId = placed.orderId;
    realTradingFlow.step        = "place_order_ok";
    realTradingFlow.orderId     = placed.orderId;
    realTradingFlow.orderStatus = placed.status;
    realTradingFlow.gasFeeUsdc  = placed.gasFeeUsdc;
    const modeDetected = diag.tradingModeDetection as { selectedMode?: string } | undefined;
    realTradingFlow.selectedTradingMode = modeDetected?.selectedMode ?? "unknown";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    realTradingFlow.step            = "FAILED_place_order";
    realTradingFlow.error           = msg;
    realTradingFlow.errorStack      = err instanceof Error ? err.stack?.slice(0, 800) : null;
    // ApiError from @polymarket/clob-client has .data with the full response
    const apiErr = err as Record<string, unknown>;
    if (apiErr.data) realTradingFlow.polymarketErrorBody = apiErr.data;
    if (msg.includes("403") || msg.includes("Forbidden")) {
      realTradingFlow.hint = `HTTP 403 — geo-block? vercelRegion=${diag.vercelRegion} blocked=${(diag.geoBlockCheck as Record<string,unknown>)?.blocked}`;
    } else if (msg.includes("400") || msg.includes("Bad Request") || msg.includes("invalid")) {
      realTradingFlow.hint =
        `HTTP 400 — format de l'ordre invalide. ` +
        `price=${orderPayload.price} size=${orderPayload.size.toFixed(4)} negRisk=${orderPayload.negRisk}. ` +
        `Vérifier: tick size, price min/max, size minimum.`;
    }
    diag.status = "REAL_FAILED_PLACE_ORDER";
    return NextResponse.json(diag, { status: 500 });
  }

  // ── Step 4 : Persistance DB via executeBuy ─────────────────────────────────
  try {
    realTradingFlow.step = "execute_buy_db";
    const buyResult = await executeBuy({
      marketId:             market.conditionId,
      question:             market.question,
      city:                 null,
      ticker:               null,
      agent:                "weather",
      outcome:              "Yes",
      marketPrice:          market.yesPrice,
      estimatedProbability: market.yesPrice,
      edge:                 0,
      suggestedBet:         BET_USDC,
      confidence:           "test",
      targetDate:           undefined,
      targetDateTime:       undefined,
      marketContext:        null,
      potentialPnl:         0,
    });

    realTradingFlow.step         = "execute_buy_ok";
    realTradingFlow.paperTradeId = buyResult.paperTradeId;
    realTradingFlow.positionId   = buyResult.positionId;
    realTradingFlow.isReal       = buyResult.isReal;
    realTradingFlow.clobOrderId  = buyResult.orderId ?? null;

    // ── Vérification DB ───────────────────────────────────────────────────
    realTradingFlow.step = "db_verify";
    const positionRow = await getPositionByPaperTradeId(buyResult.paperTradeId).catch(() => null);
    if (positionRow) {
      const ok = positionRow.is_real === true && positionRow.clob_order_id !== null;
      realTradingFlow.dbVerification = {
        isRealInDb:      positionRow.is_real,
        clobOrderIdInDb: positionRow.clob_order_id,
        ok,
        verdict: ok
          ? "✅ is_real + clob_order_id persistés"
          : `❌ is_real=${positionRow.is_real} clob_order_id=${positionRow.clob_order_id}`,
      };
      realTradingFlow.step = ok ? "db_verify_ok" : "db_verify_FAILED";
    } else {
      realTradingFlow.step         = "db_verify_no_row";
      realTradingFlow.dbVerification = { verdict: "❌ position introuvable en DB" };
    }
  } catch (err) {
    realTradingFlow.step       = "FAILED_execute_buy_db";
    realTradingFlow.error      = err instanceof Error ? err.message : String(err);
    realTradingFlow.errorStack = err instanceof Error ? err.stack?.slice(0, 600) : null;
    // On ne retourne pas d'erreur ici — le placeOrder (step 3) a réussi
  }

  diag.status = "REAL_TRADE_ATTEMPTED";
  diag.order  = {
    orderId_step3:   orderId,
    orderId_step4:   (realTradingFlow.clobOrderId as string | null) ?? null,
    submittedToClob: true,
  };

  return NextResponse.json(diag);
}
