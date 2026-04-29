/**
 * Monitor Positions endpoint
 *
 * GET /api/monitor-positions
 *
 * Pipeline :
 *   1. Récupère toutes les positions ouvertes (status = 'open' | 'hold')
 *   2. Pour chaque position, fetch les prix actuels via l'API Gamma
 *   3. Évalue avec evaluatePosition()
 *   4. Sell signal → recordSellSignal() + notification Discord
 *   5. Pas de signal → updatePosition() (mise à jour du prix courant)
 *   6. Retourne le résumé complet
 */

import { NextResponse }                          from "next/server";
import { evaluatePosition, type MarketSnapshot } from "@/lib/positions/position-manager";
import { getOpenPositions, updatePosition, markPaperTradeSold } from "@/lib/db/positions";
import { executeSell } from "@/lib/trade-executor";
import { sendSellSignals, type SellSignalNotification } from "@/lib/utils/discord";

// ---------------------------------------------------------------------------
// Gamma API — fetch prix actuel d'un marché
// ---------------------------------------------------------------------------

const GAMMA_BASE = "https://gamma-api.polymarket.com";

const GAMMA_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface GammaMarket {
  id: string;
  question?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  active?: boolean;
  closed?: boolean;
}

function parseJsonField<T>(raw: string | T[] | undefined): T[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as T[]; } catch { return []; }
}

async function fetchMarketSnapshot(marketId: string): Promise<MarketSnapshot | null> {
  try {
    const url = `${GAMMA_BASE}/markets/${encodeURIComponent(marketId)}`;
    const res  = await fetch(url, { headers: GAMMA_HEADERS });

    if (!res.ok) {
      console.warn(`[monitor-positions] Gamma HTTP ${res.status} pour market ${marketId}`);
      return null;
    }

    const raw: GammaMarket = await res.json();
    const outcomes      = parseJsonField<string>(raw.outcomes);
    const pricesStrings = parseJsonField<string>(raw.outcomePrices);
    const outcomePrices = pricesStrings.map(Number);

    if (outcomes.length === 0 || outcomes.length !== outcomePrices.length) return null;

    return { marketId, outcomes, outcomePrices };
  } catch (err) {
    console.warn(
      `[monitor-positions] Erreur fetch market ${marketId} :`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types de réponse
// ---------------------------------------------------------------------------

interface PositionSummary {
  id: string;
  question: string;
  outcome: string;
  agent: string;
  entryPrice: number;
  currentPrice: number | null;
  status: string;
  action: "SELL" | "SWITCH" | "HOLD" | "NO_DATA";
  reason: string | null;
  potentialPnl: number | null;
}

interface MonitorResult {
  checkedAt: string;
  totalOpen: number;
  sellSignals: number;
  switchSignals: number;
  holds: number;
  noData: number;
  positions: PositionSummary[];
  errors: { positionId: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Âge minimum d'une position avant qu'elle soit éligible à la vente.
 *  Évite de vendre immédiatement après l'ouverture quand entry_price ≈ current_price. */
const MIN_POSITION_AGE_MS = 30 * 60 * 1000; // 30 minutes

/** Variation minimale du prix pour déclencher une évaluation.
 *  En dessous, le marché n'a pas bougé significativement. */
const MIN_PRICE_CHANGE_RATIO = 0.01; // 1%

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<MonitorResult>> {
  const checkedAt = new Date();
  console.log(`[monitor-positions] ▶ Démarrage — ${checkedAt.toISOString()}`);

  const errors: MonitorResult["errors"] = [];
  const positionSummaries: PositionSummary[] = [];
  const discordSignals: SellSignalNotification[] = [];

  // 1. Récupérer les positions ouvertes
  let positions;
  try {
    positions = await getOpenPositions();
    console.log(`[monitor-positions] ${positions.length} position(s) ouverte(s)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[monitor-positions] ✗ getOpenPositions : ${msg}`);
    return NextResponse.json(
      {
        checkedAt: checkedAt.toISOString(),
        totalOpen: 0, sellSignals: 0, switchSignals: 0, holds: 0, noData: 0,
        positions: [],
        errors: [{ positionId: "N/A", error: msg }],
      },
      { status: 502 }
    );
  }

  // Filtrer les positions trop récentes (< 30 min) — évite les ventes immédiates
  const now = Date.now();
  const eligiblePositions = positions.filter((p) => {
    const ageMs = now - new Date(p.openedAt).getTime();
    if (ageMs < MIN_POSITION_AGE_MS) {
      console.log(
        `[monitor-positions] ⏭ ${p.id.slice(0, 8)} (${p.agent}) trop récente ` +
        `(${Math.round(ageMs / 1000 / 60)}min < 30min) — ignorée`
      );
      return false;
    }
    return true;
  });
  console.log(`[monitor-positions] ${eligiblePositions.length}/${positions.length} position(s) éligible(s)`);

  // 2. Évaluer chaque position éligible
  for (const position of eligiblePositions) {
    const tag = `[monitor-positions][${position.agent}][${position.id.slice(0, 8)}]`;

    // 2a. Fetch snapshot de marché
    const snapshot = await fetchMarketSnapshot(position.marketId);

    if (!snapshot) {
      console.warn(`${tag} Impossible de récupérer les prix pour market ${position.marketId}`);
      positionSummaries.push({
        id:           position.id,
        question:     position.question,
        outcome:      position.outcome,
        agent:        position.agent,
        entryPrice:   position.entryPrice,
        currentPrice: null,
        status:       position.status,
        action:       "NO_DATA",
        reason:       "Marché introuvable dans l'API Gamma",
        potentialPnl: null,
      });
      continue;
    }

    // 2b. Trouver le prix actuel de l'outcome de la position
    const outcomeIdx   = snapshot.outcomes.findIndex(
      (o) => o.toLowerCase() === position.outcome.toLowerCase()
    );
    const currentPrice = outcomeIdx >= 0 ? snapshot.outcomePrices[outcomeIdx] : null;

    // Log de debug : âge, variation prix, variation proba
    const ageMin      = Math.round((Date.now() - new Date(position.openedAt).getTime()) / 1000 / 60);
    const priceChange = currentPrice !== null
      ? Math.abs(currentPrice - position.entryPrice) / position.entryPrice
      : 0;
    const probChange  = currentPrice !== null
      ? position.entryProbability - currentPrice
      : 0;

    console.log(
      `${tag} age=${ageMin}min, priceChange=${(priceChange * 100).toFixed(2)}%, ` +
      `probChange=${(probChange * 100).toFixed(1)}pts ` +
      `(entry=${position.entryPrice.toFixed(3)}, current=${currentPrice?.toFixed(3) ?? "N/A"})`
    );

    // Guard : ne pas évaluer si le prix n'a pas bougé significativement (< 1%)
    if (currentPrice !== null && priceChange < MIN_PRICE_CHANGE_RATIO) {
      console.log(`${tag} ⏭ Prix quasi-inchangé (${(priceChange * 100).toFixed(2)}% < 1%) — HOLD sans évaluation`);
      try {
        await updatePosition(position.id, {
          currentPrice,
          currentProbability: currentPrice,
          status: "hold",
        });
      } catch (err) {
        console.error(`${tag} ✗ updatePosition (no-change) :`, err instanceof Error ? err.message : err);
      }
      positionSummaries.push({
        id:           position.id,
        question:     position.question,
        outcome:      position.outcome,
        agent:        position.agent,
        entryPrice:   position.entryPrice,
        currentPrice,
        status:       "hold",
        action:       "HOLD",
        reason:       `Prix inchangé (${(priceChange * 100).toFixed(2)}% < 1%)`,
        potentialPnl: Math.round((currentPrice - position.entryPrice) * position.suggestedBet * 100) / 100,
      });
      continue;
    }

    // Mettre à jour currentPrice/currentProbability dans la position pour l'évaluation
    const positionWithCurrent = {
      ...position,
      currentPrice:       currentPrice,
      currentProbability: currentPrice,
    };

    // 2c. Évaluer
    const signal = evaluatePosition(positionWithCurrent, snapshot);

    if (signal && (signal.suggestedAction === "SELL" || signal.suggestedAction === "SWITCH")) {
      // Sell ou Switch signal
      console.log(
        `${tag} ${signal.suggestedAction} — "${signal.reason}" ` +
        `(entry=${position.entryPrice.toFixed(3)}, current=${signal.currentPrice.toFixed(3)}, ` +
        `potentialPnl=${signal.potentialPnl >= 0 ? "+" : ""}${signal.potentialPnl.toFixed(2)})`
      );

      try {
        const sellPnl = await executeSell(
          position,
          signal.currentPrice,
          signal.reason
        );

        const label = position.city ?? position.ticker ?? position.question;
        console.log(
          `[monitor-positions] SELL executed: ${label}, ` +
          `entry=${position.entryPrice.toFixed(3)}, sell=${signal.currentPrice.toFixed(3)}, ` +
          `pnl=${sellPnl >= 0 ? "+" : ""}${sellPnl.toFixed(3)}€`
        );

        // Marquer le paper trade associé comme vendu pour éviter une double résolution
        if (position.paperTradeId) {
          await markPaperTradeSold(position.paperTradeId, sellPnl).catch((err) =>
            console.error(`${tag} ✗ markPaperTradeSold : ${err instanceof Error ? err.message : err}`)
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ✗ executeSell : ${msg}`);
        errors.push({ positionId: position.id, error: msg });
      }

      discordSignals.push({
        question:     position.question,
        outcome:      position.outcome,
        agent:        position.agent,
        action:       "SELL",
        reason:       signal.reason,
        entryPrice:   signal.entryPrice,
        currentPrice: signal.currentPrice,
        potentialPnl: signal.potentialPnl,
        suggestedBet: position.suggestedBet,
      });

      positionSummaries.push({
        id:           position.id,
        question:     position.question,
        outcome:      position.outcome,
        agent:        position.agent,
        entryPrice:   position.entryPrice,
        currentPrice: signal.currentPrice,
        status:       "sold",
        action:       signal.suggestedAction,
        reason:       signal.reason,
        potentialPnl: signal.potentialPnl,
      });

    } else {
      // HOLD — mise à jour du prix courant seulement
      if (currentPrice !== null) {
        try {
          await updatePosition(position.id, {
            currentPrice,
            currentProbability: currentPrice,
            status: "hold",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${tag} ✗ updatePosition : ${msg}`);
          errors.push({ positionId: position.id, error: msg });
        }
      }

      console.log(
        `${tag} HOLD — entry=${position.entryPrice.toFixed(3)}, ` +
        `current=${currentPrice?.toFixed(3) ?? "N/A"}`
      );

      positionSummaries.push({
        id:           position.id,
        question:     position.question,
        outcome:      position.outcome,
        agent:        position.agent,
        entryPrice:   position.entryPrice,
        currentPrice: currentPrice,
        status:       "hold",
        action:       "HOLD",
        reason:       null,
        potentialPnl: currentPrice !== null
          ? Math.round((currentPrice - position.entryPrice) * position.suggestedBet * 100) / 100
          : null,
      });
    }
  }

  // 3. Notification Discord (fire-and-forget)
  if (discordSignals.length > 0) {
    sendSellSignals(discordSignals, checkedAt).catch((err) =>
      console.error(
        "[monitor-positions] ✗ sendSellSignals :",
        err instanceof Error ? err.message : err
      )
    );
  }

  // 4. Résumé
  const sellSignals   = positionSummaries.filter((p) => p.action === "SELL").length;
  const switchSignals = positionSummaries.filter((p) => p.action === "SWITCH").length;
  const holds         = positionSummaries.filter((p) => p.action === "HOLD").length;
  const noData        = positionSummaries.filter((p) => p.action === "NO_DATA").length;

  console.log(
    `[monitor-positions] ■ Terminé — ${positions.length} positions : ` +
    `${sellSignals} SELL, ${switchSignals} SWITCH, ${holds} HOLD, ${noData} NO_DATA, ${errors.length} erreurs`
  );

  return NextResponse.json({
    checkedAt:    checkedAt.toISOString(),
    totalOpen:    positions.length,
    sellSignals,
    switchSignals,
    holds,
    noData,
    positions:    positionSummaries,
    errors,
  });
}
