/**
 * GET /api/test-sell?conditionId=0x...&outcome=Yes&shares=10&dry_run=true
 *
 * Teste un ordre SELL sur une position sans attendre un vrai TP/SL.
 *
 * Params :
 *   conditionId  — condition ID hex du marché (0x...)
 *   outcome      — "Yes" ou "No" (default: "Yes")
 *   shares       — nombre de shares à vendre (default: 1)
 *   dry_run      — "false" pour un vrai ordre (default: true)
 *
 * Retourne :
 *   - orderbook (bestBid, asks depth)
 *   - worstPrice calculé (bestBid × 0.90)
 *   - orderId si dry_run=false
 *   - P&L estimé
 */

import { NextRequest, NextResponse } from "next/server";
import { getClobMarket, getOrderBook, placeOrder } from "@/lib/polymarket/clob-api";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const params       = req.nextUrl.searchParams;
  const conditionId  = params.get("conditionId");
  const outcome      = params.get("outcome") ?? "Yes";
  const shares       = parseFloat(params.get("shares") ?? "1");
  const dryRun       = params.get("dry_run") !== "false";

  const diag: Record<string, unknown> = {
    dryRun,
    conditionId,
    outcome,
    shares,
    timestamp: new Date().toISOString(),
  };

  if (!conditionId) {
    return NextResponse.json({ error: "conditionId requis (param ?conditionId=0x...)" }, { status: 400 });
  }

  // 1. Resolve CLOB market
  const clobMarket = await getClobMarket(conditionId).catch((e) => {
    diag.clobError = e instanceof Error ? e.message : String(e);
    return null;
  });

  if (!clobMarket) {
    return NextResponse.json({ ...diag, error: `getClobMarket(${conditionId}) introuvable` }, { status: 404 });
  }

  diag.negRisk = clobMarket.negRisk;
  diag.tokens  = clobMarket.tokens.map((t) => ({ outcome: t.outcome, tokenId: t.tokenId.slice(0, 16) + "…", price: t.price }));

  const token = clobMarket.tokens.find((t) => t.outcome.toLowerCase() === outcome.toLowerCase());
  if (!token) {
    return NextResponse.json(
      { ...diag, error: `Token "${outcome}" introuvable. Disponibles: ${clobMarket.tokens.map((t) => t.outcome).join(", ")}` },
      { status: 404 }
    );
  }
  diag.tokenId    = token.tokenId.slice(0, 20) + "…";
  diag.clobPrice  = token.price;

  // 2. Orderbook
  const book = await getOrderBook(token.tokenId).catch((e) => {
    diag.orderbookError = e instanceof Error ? e.message : String(e);
    return null;
  });

  if (!book) {
    return NextResponse.json({ ...diag, error: "Impossible de récupérer l'orderbook" }, { status: 502 });
  }

  diag.orderbook = {
    bestBid:   book.bestBid,
    bestAsk:   book.bestAsk,
    spread:    book.spread,
    bidsCount: book.bids.length,
    asksCount: book.asks.length,
    topBids:   book.bids.slice(0, 5).map((b) => ({ price: b.price, size: b.size })),
    topAsks:   book.asks.slice(0, 5).map((a) => ({ price: a.price, size: a.size })),
  };

  if (!book.bestBid) {
    return NextResponse.json(
      { ...diag, error: "Orderbook vide — pas de buyers (bestBid = null). Impossible de vendre." },
      { status: 422 }
    );
  }

  // 3. Calcul estimé
  const worstPrice     = Math.max(Math.round(book.bestBid * 0.90 * 10000) / 10000, 0.01);
  const estimatedUsdc  = Math.round(shares * book.bestBid * 100) / 100;
  diag.estimate = {
    shares,
    bestBid:          book.bestBid,
    worstPrice,
    estimatedUsdc,
    worstCaseUsdc:    Math.round(shares * worstPrice * 100) / 100,
  };

  if (dryRun) {
    diag.status = "DRY_RUN — ordre non soumis. Passer ?dry_run=false pour un vrai SELL.";
    return NextResponse.json(diag);
  }

  // 4. SELL réel
  try {
    const placed = await placeOrder({
      tokenId:     token.tokenId,
      side:        "SELL",
      amountUsdc:  estimatedUsdc,
      sharesCount: shares,
      price:       token.price,
      negRisk:     clobMarket.negRisk,
      dryRun:      false,
    });

    diag.order = {
      orderId:    placed.orderId,
      status:     placed.status,
      worstPrice: placed.price,
      shares,
      estimatedUsdc,
    };
    diag.status = placed.status === "matched" || placed.status === "placed"
      ? "✅ SELL placed"
      : `⚠ SELL status=${placed.status}`;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diag.error  = msg;
    diag.status = "SELL FAILED";
    return NextResponse.json(diag, { status: 500 });
  }

  return NextResponse.json(diag);
}
