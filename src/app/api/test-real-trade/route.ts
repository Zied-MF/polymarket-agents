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
// Handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const dryRunParam = req.nextUrl.searchParams.get("dry_run");
  const dryRun      = dryRunParam !== "false"; // défaut true

  const diag: Record<string, unknown> = {
    dryRun,
    timestamp: new Date().toISOString(),
  };

  // 1. Vérification env vars
  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) {
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

  // 3. Balance USDC
  try {
    const balance = await getAccountBalance();
    diag.balanceUsdc = balance;
  } catch (err) {
    diag.balanceError = err instanceof Error ? err.message : String(err);
  }

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

  // ── Step 0 : Diagnostic variable d'environnement ──────────────────────────
  const envRaw       = process.env.REAL_TRADING_ENABLED;
  const envForced    = "true"; // on force à "true" pour ce test
  process.env.REAL_TRADING_ENABLED = envForced;
  // Reset du cache allowance pour forcer une nouvelle vérification
  resetAllowanceCache();

  diag.envDiag = {
    REAL_TRADING_ENABLED_raw:    envRaw ?? "(not set)",
    REAL_TRADING_ENABLED_forced: envForced,
    isRealTradingEnabled_before: envRaw === "true",
    isRealTradingEnabled_after:  isRealTradingEnabled(),
  };

  const realFlow: Record<string, unknown> = { step: "start" };
  diag.realTradingFlow = realFlow;

  // ── Step 1 : Balance ───────────────────────────────────────────────────────
  let balanceOk = false;
  try {
    realFlow.step = "balance";
    const balance     = await getAccountBalance();
    const minRequired = BET_USDC * 1.05;
    balanceOk = balance >= minRequired;
    realFlow.balanceUsdc    = balance;
    realFlow.minRequired    = minRequired;
    realFlow.balanceSufficient = balanceOk;
    if (!balanceOk) {
      realFlow.step   = "FAILED_balance";
      realFlow.error  = `Balance insuffisante: ${balance.toFixed(4)} USDC < ${minRequired.toFixed(4)} USDC requis`;
      diag.status = "REAL_FAILED_BALANCE";
      return NextResponse.json(diag, { status: 422 });
    }
  } catch (err) {
    realFlow.step  = "FAILED_balance";
    realFlow.error = err instanceof Error ? err.message : String(err);
    realFlow.stack = err instanceof Error ? err.stack?.slice(0, 400) : undefined;
    diag.status = "REAL_FAILED_BALANCE_ERROR";
    return NextResponse.json(diag, { status: 500 });
  }

  // ── Step 2 : Allowance CTF Exchange ───────────────────────────────────────
  try {
    realFlow.step = "allowance";
    const { sufficient, allowance } = await checkCTFAllowance();
    realFlow.allowanceUsdc      = (Number(allowance) / 1_000_000).toFixed(2);
    realFlow.allowanceSufficient = sufficient;
    if (!sufficient) {
      realFlow.step  = "FAILED_allowance";
      realFlow.error = `CTF Exchange allowance insuffisante (${(Number(allowance) / 1_000_000).toFixed(2)} USDC). Appeler approveCTF().`;
      diag.status = "REAL_FAILED_ALLOWANCE";
      return NextResponse.json(diag, { status: 422 });
    }
  } catch (err) {
    realFlow.step  = "FAILED_allowance";
    realFlow.error = err instanceof Error ? err.message : String(err);
    realFlow.stack = err instanceof Error ? err.stack?.slice(0, 400) : undefined;
    diag.status = "REAL_FAILED_ALLOWANCE_ERROR";
    return NextResponse.json(diag, { status: 500 });
  }

  // ── Step 3 : Signature + soumission ordre CLOB ────────────────────────────
  let orderId: string | null = null;
  try {
    realFlow.step = "placeOrder";
    const placed = await placeOrder({
      tokenId:    yesToken.tokenId,
      side:       "BUY",
      amountUsdc: BET_USDC,
      price:      market.yesPrice,
      negRisk:    clobMarket.negRisk,
      dryRun:     false,
    });
    orderId = placed.orderId;
    realFlow.step       = "placeOrder_ok";
    realFlow.orderId    = placed.orderId;
    realFlow.orderStatus = placed.status;
    realFlow.gasFeeUsdc  = placed.gasFeeUsdc;
  } catch (err) {
    realFlow.step  = "FAILED_placeOrder";
    realFlow.error = err instanceof Error ? err.message : String(err);
    realFlow.stack = err instanceof Error ? err.stack?.slice(0, 800) : undefined;
    diag.status = "REAL_FAILED_PLACE_ORDER";
    return NextResponse.json(diag, { status: 500 });
  }

  // ── Step 4 : Persistance DB via executeBuy (paper_trade + position) ────────
  // On appelle executeBuy maintenant qu'on sait que placeOrder fonctionne.
  // executeBuy va re-placer un ordre → on utilise le résultat pour la DB.
  // Note : on accepte 2 ordres (step 3 + step 4) car c'est un test.
  try {
    realFlow.step = "executeBuy_db";
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

    realFlow.step         = "executeBuy_ok";
    realFlow.paperTradeId = buyResult.paperTradeId;
    realFlow.positionId   = buyResult.positionId;
    realFlow.isReal       = buyResult.isReal;
    realFlow.clobOrderId  = buyResult.orderId ?? null;

    // ── Vérification DB ───────────────────────────────────────────────────
    const positionRow = await getPositionByPaperTradeId(buyResult.paperTradeId).catch(() => null);
    if (positionRow) {
      const ok = positionRow.is_real === true && positionRow.clob_order_id !== null;
      realFlow.dbVerification = {
        isRealInDb:      positionRow.is_real,
        clobOrderIdInDb: positionRow.clob_order_id,
        ok,
        verdict: ok
          ? "✅ is_real + clob_order_id persistés"
          : `❌ is_real=${positionRow.is_real} clob_order_id=${positionRow.clob_order_id}`,
      };
    }
  } catch (err) {
    realFlow.step       = "FAILED_executeBuy_db";
    realFlow.dbError    = err instanceof Error ? err.message : String(err);
    // On ne retourne pas d'erreur ici — le placeOrder (step 3) a réussi
  }

  diag.status = "REAL_TRADE_ATTEMPTED";
  diag.order  = {
    orderId_step3:    orderId,
    orderId_step4:    (realFlow.clobOrderId as string | null) ?? null,
    submittedToClob:  true,
  };

  return NextResponse.json(diag);
}
