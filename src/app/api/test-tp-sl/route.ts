/**
 * GET /api/test-tp-sl?conditionId=0x...&simulatePrice=0.034[&positionId=uuid]
 *
 * Simule un prix actuel donné sur une position ouverte et évalue chaque
 * layer du système TP/SL — sans rien vendre ni modifier la DB.
 *
 * Params :
 *   conditionId    — market_id hex de la position (filtre si plusieurs positions)
 *   simulatePrice  — prix simulé (0–1) de l'outcome pour tester les seuils
 *   positionId     — (optionnel) UUID exact de la position si plusieurs ouverte
 *
 * Retourne :
 *   - position         : infos de la position trouvée en DB
 *   - simulatedPrice   : prix utilisé pour la simulation
 *   - layers           : résultat de chaque layer (triggered?, condition, values)
 *   - verdict          : "SELL (Layer N) — raison" ou "HOLD"
 *   - note             : avertissements éventuels
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@supabase/supabase-js";
import { evaluatePosition }          from "@/lib/positions/position-manager";
import type { MarketSnapshot }       from "@/lib/positions/position-manager";

// ---------------------------------------------------------------------------
// Supabase direct (pas via positions.ts pour éviter le mapper peakPnlPercent)
// ---------------------------------------------------------------------------

function getDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const params        = req.nextUrl.searchParams;
  const conditionId   = params.get("conditionId");
  const positionIdParam = params.get("positionId");
  const simulatePriceStr = params.get("simulatePrice");

  if (!conditionId) {
    return NextResponse.json({ error: "conditionId requis (param ?conditionId=0x...)" }, { status: 400 });
  }
  if (simulatePriceStr === null) {
    return NextResponse.json({ error: "simulatePrice requis (ex: ?simulatePrice=0.034)" }, { status: 400 });
  }
  const simulatePrice = parseFloat(simulatePriceStr);
  if (isNaN(simulatePrice) || simulatePrice < 0 || simulatePrice > 1) {
    return NextResponse.json({ error: "simulatePrice doit être entre 0 et 1" }, { status: 400 });
  }

  // 1. Fetch position(s) for this conditionId
  const db = getDb();
  let query = db
    .from("positions")
    .select("*")
    .eq("market_id", conditionId)
    .in("status", ["open", "hold"]);

  if (positionIdParam) {
    query = query.eq("id", positionIdParam);
  }

  const { data: rows, error: dbErr } = await query.order("opened_at", { ascending: false }).limit(5);

  if (dbErr) {
    return NextResponse.json({ error: `DB error: ${dbErr.message}` }, { status: 502 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({
      error: `Aucune position ouverte pour conditionId=${conditionId}${positionIdParam ? ` positionId=${positionIdParam}` : ""}`,
      hint: "Vérifiez que la position est en status=open ou hold en DB",
    }, { status: 404 });
  }

  // If multiple, take first (most recent) and warn
  const row = rows[0];
  const multipleWarning = rows.length > 1
    ? `${rows.length} positions trouvées — simulation sur la plus récente (${row.id.slice(0, 8)}). Passez &positionId=UUID pour en cibler une.`
    : null;

  // 2. Map DB row → Position (full mapping including peak_pnl_percent)
  const position = {
    id:                  row.id as string,
    paperTradeId:        (row.paper_trade_id ?? "") as string,
    marketId:            row.market_id as string,
    question:            (row.question ?? "") as string,
    city:                row.city as string | null,
    ticker:              row.ticker as string | null,
    agent:               row.agent as "weather" | "finance" | "crypto",
    outcome:             row.outcome as string,
    entryPrice:          row.entry_price as number,
    entryProbability:    row.entry_probability as number,
    currentPrice:        row.current_price as number | null,
    currentProbability:  row.current_probability as number | null,
    suggestedBet:        row.suggested_bet as number,
    status:              row.status as "open" | "hold",
    sellReason:          row.sell_reason as string | null,
    openedAt:            new Date(row.opened_at as string),
    resolutionDate:      row.resolution_date ? new Date(row.resolution_date as string) : null,
    isReal:              row.is_real as boolean | null,
    clobOrderId:         row.clob_order_id as string | null,
    peakPnlPercent:      (row.peak_pnl_percent ?? null) as number | null,
  };

  // 3. Build simulated snapshot
  const snapshot: MarketSnapshot = {
    marketId:      conditionId,
    outcomes:      [position.outcome],
    outcomePrices: [simulatePrice],
  };

  // 4. Compute individual layer conditions for transparency
  const entryPrice     = position.entryPrice;
  const ageMinutes     = (Date.now() - position.openedAt.getTime()) / (1000 * 60);
  const pnlPercent     = (simulatePrice - entryPrice) / entryPrice;
  const peakPnl        = position.peakPnlPercent ?? null;
  const dropFromPeak   = peakPnl !== null ? peakPnl - pnlPercent : null;
  const profitTarget   = entryPrice + 0.80 * (1 - entryPrice);
  const hoursToRes     = position.resolutionDate
    ? (position.resolutionDate.getTime() - Date.now()) / (1000 * 60 * 60)
    : null;

  const layers = {
    layer1_grace: {
      label:     "Grace period < 5 min → HOLD",
      triggered: ageMinutes < 5,
      values:    { ageMinutes: Math.round(ageMinutes * 10) / 10 },
      condition: "ageMinutes < 5",
    },
    layer2_hard_sl: {
      label:     "Hard stop-loss ≤ −50%",
      triggered: pnlPercent <= -0.50,
      values:    { pnlPercent: `${(pnlPercent * 100).toFixed(2)}%` },
      condition: "pnlPercent <= -0.50",
    },
    layer3_sl: {
      label:     "Stop-loss ≤ −25% after 15 min",
      triggered: pnlPercent <= -0.25 && ageMinutes >= 15,
      values:    { pnlPercent: `${(pnlPercent * 100).toFixed(2)}%`, ageMinutes: Math.round(ageMinutes) },
      condition: "pnlPercent <= -0.25 && ageMinutes >= 15",
    },
    layer4_profit_target: {
      label:     "Profit target 80% edge captured (< 2h to resolution)",
      triggered: hoursToRes !== null && hoursToRes < 2 && simulatePrice >= profitTarget,
      values: {
        simulatePrice,
        profitTarget: Math.round(profitTarget * 10000) / 10000,
        hoursToResolution: hoursToRes !== null ? Math.round(hoursToRes * 10) / 10 : "unknown",
      },
      condition: "simulatePrice >= profitTarget && hoursToResolution < 2",
    },
    layer5_trailing_stop: {
      label:     "Trailing stop: peak ≥ +30% then drops ≥ 15%",
      triggered: peakPnl !== null && peakPnl >= 0.30 && dropFromPeak !== null && dropFromPeak >= 0.15 && ageMinutes >= 15,
      values:    {
        peakPnlPercent:  peakPnl !== null ? `${(peakPnl * 100).toFixed(2)}%` : "null — Layer 5 INACTIVE (peak not tracked yet)",
        currentPnl:      `${(pnlPercent * 100).toFixed(2)}%`,
        dropFromPeak:    dropFromPeak !== null ? `${(dropFromPeak * 100).toFixed(2)}%` : "N/A",
        ageMinutes:      Math.round(ageMinutes),
      },
      condition: "peakPnl >= 0.30 && dropFromPeak >= 0.15 && ageMinutes >= 15",
      warning:   peakPnl === null
        ? "⚠ peakPnlPercent est null en DB — Layer 5 ne peut pas se déclencher. Il sera actif une fois que monitor-positions aura enregistré un premier peak."
        : null,
    },
    layer6_time_decay: {
      label:     "Time decay: < 1h to resolution with P&L < −10%",
      triggered: hoursToRes !== null && hoursToRes < 1 && pnlPercent < -0.10,
      values:    {
        hoursToResolution: hoursToRes !== null ? Math.round(hoursToRes * 10) / 10 : "unknown",
        pnlPercent:        `${(pnlPercent * 100).toFixed(2)}%`,
      },
      condition: "hoursToResolution < 1 && pnlPercent < -0.10",
    },
  };

  // 5. Run the actual evaluatePosition for the definitive verdict
  const signal = evaluatePosition(position, snapshot);

  // 6. Build response
  const triggeredLayers = Object.entries(layers)
    .filter(([, v]) => v.triggered)
    .map(([k, v]) => `${k} (${v.label})`);

  return NextResponse.json({
    simulatedAt:    new Date().toISOString(),
    note:           multipleWarning,
    position: {
      id:             position.id,
      question:       position.question,
      outcome:        position.outcome,
      entryPrice,
      currentPriceInDb: position.currentPrice,
      peakPnlPercent: position.peakPnlPercent,
      suggestedBet:   position.suggestedBet,
      isReal:         position.isReal,
      openedAt:       position.openedAt.toISOString(),
      resolutionDate: position.resolutionDate?.toISOString() ?? null,
      ageMinutes:     Math.round(ageMinutes),
    },
    simulation: {
      simulatedPrice: simulatePrice,
      pnlPercent:     `${(pnlPercent * 100).toFixed(2)}%`,
      pnlUsdc:        Math.round((simulatePrice - entryPrice) / entryPrice * position.suggestedBet * 100) / 100,
    },
    layers,
    triggeredLayers,
    verdict: signal
      ? `SELL — Layer ${signal.layer} — ${signal.reason}`
      : triggeredLayers.length > 0 && triggeredLayers[0].includes("layer1")
        ? "HOLD — grace period actif (< 5 min)"
        : "HOLD — aucun seuil atteint",
    sellSignal: signal ?? null,
  });
}
