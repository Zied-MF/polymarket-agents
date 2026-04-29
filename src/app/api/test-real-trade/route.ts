/**
 * Test Real Trade endpoint
 *
 * GET /api/test-real-trade?dry_run=true   → signe l'ordre sans soumettre (défaut)
 * GET /api/test-real-trade?dry_run=false  → soumet un ordre live de $0.50 USDC
 *
 * Diagnostics retournés :
 *   - wallet address + balance USDC
 *   - marché météo le moins cher trouvé sur Gamma
 *   - tokenId CLOB résolu
 *   - signature EIP-712 (toujours effectuée)
 *   - orderId si soumis en live
 */

import { NextRequest, NextResponse } from "next/server";
import {
  deriveClobCredentials,
  getClobMarket,
  placeOrder,
  getAccountBalance,
}                                    from "@/lib/polymarket/clob-api";

// ---------------------------------------------------------------------------
// Gamma — cherche un marché météo ouvert peu cher
// ---------------------------------------------------------------------------

const GAMMA_BASE = "https://gamma-api.polymarket.com";

interface GammaMarket {
  id:            string;
  conditionId?:  string;
  question?:     string;
  outcomes?:     string | string[];
  outcomePrices?: string | string[];
  active?:       boolean;
  closed?:       boolean;
  endDate?:      string;
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
      if (yesPrice < 0.05 || yesPrice > 0.95) continue; // trop extrême → skip
      if (!best || yesPrice < best.yesPrice) {
        best = {
          gammaId:     m.id,
          conditionId,
          question:    m.question ?? m.id,
          yesPrice,
        };
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

  // 6. Signer (et éventuellement soumettre) l'ordre
  const BET_USDC = 0.50;
  try {
    const placed = await placeOrder({
      tokenId:    yesToken.tokenId,
      side:       "BUY",
      amountUsdc: BET_USDC,
      price:      market.yesPrice,
      negRisk:    clobMarket.negRisk,
      dryRun,
    });

    diag.order = {
      tokenId:    yesToken.tokenId,
      side:       "BUY",
      amountUsdc: BET_USDC,
      price:      market.yesPrice,
      orderId:    placed.orderId ?? null,
      gasFeeUsdc: placed.gasFeeUsdc,
      submitted:  !dryRun,
    };
  } catch (err) {
    return NextResponse.json(
      { ...diag, error: `placeOrder: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }

  diag.status = dryRun ? "DRY_RUN_OK" : "LIVE_ORDER_PLACED";
  return NextResponse.json(diag);
}
