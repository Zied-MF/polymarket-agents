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
}                                    from "@/lib/polymarket/clob-api";
import { executeBuy }                from "@/lib/trade-executor";
import { getPositionByPaperTradeId } from "@/lib/db/positions";

// ---------------------------------------------------------------------------
// Gamma — cherche un marché météo ouvert peu cher
// ---------------------------------------------------------------------------

const GAMMA_BASE = "https://gamma-api.polymarket.com";

interface GammaMarket {
  id:             string;
  conditionId?:   string;
  question?:      string;
  outcomes?:      string | string[];
  outcomePrices?: string | string[];
  active?:        boolean;
  closed?:        boolean;
  endDate?:       string;
}

function parseJsonField<T>(raw: string | T[] | undefined): T[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as T[]; } catch { return []; }
}

/** Retourne un marché météo ouvert avec le prix "Yes" le plus bas (mais > 0.05). */
async function findCheapWeatherMarket(): Promise<{
  gammaId:     string;
  conditionId: string;
  question:    string;
  yesPrice:    number;
} | null> {
  try {
    const url = `${GAMMA_BASE}/markets?tag=weather&active=true&closed=false&limit=50`;
    const res = await fetch(url, {
      headers: {
        Accept:       "application/json",
        "User-Agent": "polymarket-agents/test",
      },
    });
    if (!res.ok) return null;

    const markets: GammaMarket[] = await res.json();
    let best: { gammaId: string; conditionId: string; question: string; yesPrice: number } | null = null;

    for (const m of markets) {
      if (!m.active || m.closed) continue;
      const conditionId = m.conditionId ?? m.id;
      const outcomes    = parseJsonField<string>(m.outcomes);
      const prices      = parseJsonField<string>(m.outcomePrices).map(Number);
      const yesIdx      = outcomes.findIndex((o) => o.toLowerCase() === "yes");
      if (yesIdx < 0 || prices.length !== outcomes.length) continue;
      const yesPrice = prices[yesIdx];
      if (yesPrice < 0.05 || yesPrice > 0.95) continue;
      if (!best || yesPrice < best.yesPrice) {
        best = { gammaId: m.id, conditionId, question: m.question ?? m.id, yesPrice };
      }
    }

    return best;
  } catch {
    return null;
  }
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

  // 4. Trouver un marché météo
  const market = await findCheapWeatherMarket();
  if (!market) {
    return NextResponse.json(
      { ...diag, error: "Aucun marché météo ouvert trouvé sur Gamma" },
      { status: 404 }
    );
  }
  diag.market = {
    gammaId:     market.gammaId,
    conditionId: market.conditionId,
    question:    market.question,
    yesPrice:    market.yesPrice,
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

  // ── LIVE ORDER — passe par executeBuy() pour tester la persistance en DB ──
  // executeBuy() appelle patchRealPosition() qui doit écrire clob_order_id.
  // On vérifie ensuite directement en DB que le champ est bien rempli.
  const BET_USDC = 0.50;

  let buyResult: Awaited<ReturnType<typeof executeBuy>>;
  try {
    // Force REAL_TRADING_ENABLED pour ce test, quelle que soit l'env var
    process.env.REAL_TRADING_ENABLED = "true";
    buyResult = await executeBuy({
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
  } catch (err) {
    return NextResponse.json(
      { ...diag, error: `executeBuy: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }

  diag.order = {
    paperTradeId: buyResult.paperTradeId,
    positionId:   buyResult.positionId,
    orderId:      buyResult.orderId ?? null,
    isReal:       buyResult.isReal,
    gasFeeUsdc:   buyResult.gasFeeUsdc ?? null,
    submitted:    true,
  };

  // ── Vérification DB : clob_order_id et is_real bien persistés ─────────────
  let dbVerification: Record<string, unknown> = { checked: false };
  try {
    const positionRow = await getPositionByPaperTradeId(buyResult.paperTradeId);

    if (!positionRow) {
      dbVerification = {
        checked: false,
        error:   `Position introuvable pour paperTradeId=${buyResult.paperTradeId}`,
        ok:      false,
      };
    } else {
      const clobOrderIdInDb = positionRow.clob_order_id;
      const isRealInDb      = positionRow.is_real;
      const clobMatchesApi  = clobOrderIdInDb === (buyResult.orderId ?? null);
      const ok              = isRealInDb === true && clobOrderIdInDb !== null && clobMatchesApi;

      dbVerification = {
        checked:         true,
        positionId:      positionRow.id,
        isRealInDb,
        clobOrderIdInDb,
        clobOrderIdFromApi: buyResult.orderId ?? null,
        clobMatchesApi,
        ok,
        // Verdict lisible
        verdict: ok
          ? "✅ clob_order_id et is_real correctement persistés"
          : [
              !isRealInDb           ? "❌ is_real est false ou null en DB"               : null,
              clobOrderIdInDb === null ? "❌ clob_order_id est NULL en DB (bug critique)" : null,
              !clobMatchesApi       ? "❌ clob_order_id ne correspond pas à l'orderId API" : null,
            ].filter(Boolean).join(" | "),
      };
    }
  } catch (err) {
    dbVerification = {
      checked: false,
      error:   err instanceof Error ? err.message : String(err),
      ok:      false,
    };
  }

  diag.dbVerification = dbVerification;
  diag.status = (dbVerification as { ok?: boolean }).ok
    ? "LIVE_ORDER_PLACED_AND_DB_VERIFIED"
    : "LIVE_ORDER_PLACED_BUT_DB_VERIFICATION_FAILED";

  return NextResponse.json(
    diag,
    { status: (dbVerification as { ok?: boolean }).ok ? 200 : 500 }
  );
}
