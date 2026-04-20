/**
 * Cron endpoint — scan de tous les marchés via l'Orchestrator
 *
 * GET /api/scan-markets
 *
 * Pipeline :
 *   1. L'Orchestrator lance Weather, Finance et Crypto Agents en séquence
 *   2. Chaque agent : fetchMarkets → fetchData → analyze → { dominated, skipReason }
 *   3. Risk limits : max 15 positions par agent, triées par edge décroissant
 *   4. Déduplication DB (opportunités déjà vues dans les dernières 24h)
 *   5. Sauvegarde dans opportunities, paper_trades et positions
 *   6. Notification Discord
 *   7. Retourne le rapport
 */

import { NextResponse }                    from "next/server";
import { orchestrator }                    from "@/lib/agents/orchestrator";
import { weatherAdapter }                  from "@/lib/agents/adapters/weather-adapter";
// Finance Agent — shadow mode (analyse uniquement, pas de trades réels) — 2026-04-20
// import { financeAdapter }               from "@/lib/agents/adapters/finance-adapter";
// import { cryptoAdapter } from "@/lib/agents/adapters/crypto-adapter"; // DÉSACTIVÉ 2026-04-18
import { sendDiscordNotification }         from "@/lib/utils/discord";
import {
  saveOpportunity,
  getRecentOpportunities,
  incrementDailyOpportunities,
  savePaperTrade,
  acquireScanLock,
  releaseScanLock,
}                                          from "@/lib/db/supabase";
import { openPosition }                    from "@/lib/db/positions";
import type { Opportunity, SkippedMarket, AgentStats } from "@/lib/agents/orchestrator";
import { getBotState, updateLastScan }     from "@/lib/bot/bot-state";
import { logActivity }                     from "@/lib/logger";
import { setWeatherAdapterMode }           from "@/lib/agents/adapters/weather-adapter";

// ---------------------------------------------------------------------------
// Enregistrement des agents — idempotent (no-op si déjà enregistré)
// ---------------------------------------------------------------------------

let agentsRegistered = false;

function ensureAgentsRegistered(): void {
  if (agentsRegistered) return;
  orchestrator.registerAgent(weatherAdapter);
  // Finance Agent désactivé — shadow mode, pas de trades réels (2026-04-20)
  // orchestrator.registerAgent(financeAdapter);
  // Crypto Agent désactivé le 2026-04-18
  // Raison: Win rate 26.4%, P&L -87€
  // Le modèle momentum ne fonctionne pas sur les marchés crypto Polymarket
  // TODO: Implémenter une stratégie mean-reversion ou event-driven
  // orchestrator.registerAgent(cryptoAdapter);
  agentsRegistered = true;
  console.log(`[scan-markets] Agents enregistrés: weather only (finance/crypto en shadow mode)`);
}

// ---------------------------------------------------------------------------
// Types de la réponse
// ---------------------------------------------------------------------------

interface ScanResult {
  scannedAt:      string;
  duration:       string;
  byAgent:        Record<string, AgentStats>;
  opportunities:  number;
  saved:          number;
  skipped:        number;
  details:        Opportunity[];
  skippedDetails: SkippedMarket[];
  errors:         { marketId: string; question: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<ScanResult | { status: string; reason: string }>> {
  ensureAgentsRegistered();

  // Vérifier si le bot est actif
  const botState = await getBotState().catch(() => null);
  if (botState && !botState.isRunning) {
    return NextResponse.json({ status: "skipped", reason: "Bot is stopped", state: botState });
  }

  // Verrou anti-double exécution
  const hasLock = await acquireScanLock();
  if (!hasLock) {
    console.log("[scan-markets] ⏭ Scan already in progress, skipping...");
    return NextResponse.json({ status: "skipped", reason: "Another scan is in progress" }, { status: 409 });
  }

  const startTime = Date.now();
  const scanMode  = botState?.mode ?? "balanced";

  // Propager le mode DB vers le weather-adapter (écrase l'env var TRADING_MODE)
  setWeatherAdapterMode(scanMode);
  console.log(`[scan-markets] ▶ Démarrage scan — ${new Date().toISOString()} (mode: ${scanMode})`);
  await logActivity("scan", `Scan started (mode: ${scanMode})`);

  try {
  const errors: ScanResult["errors"] = [];

  // 1. Scan via l'Orchestrator
  let opps:    Opportunity[]                    = [];
  let skipped: SkippedMarket[]                  = [];
  let byAgent: Record<string, AgentStats>       = {};

  try {
    ({ opportunities: opps, skipped, byAgent } = await orchestrator.scanAllMarkets());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scan-markets] ✗ orchestrator.scanAllMarkets : ${msg}`);
    return NextResponse.json(
      {
        scannedAt:      new Date().toISOString(),
        duration:       `${Date.now() - startTime}ms`,
        byAgent:        {},
        opportunities:  0,
        saved:          0,
        skipped:        0,
        details:        [],
        skippedDetails: [],
        errors:         [{ marketId: "N/A", question: "N/A", error: msg }],
      },
      { status: 502 }
    );
  }

  // 2. Persister dans Supabase — déduplication sur market_id + outcome (24h)
  let savedCount = 0;

  if (opps.length > 0) {
    let existingKeys = new Set<string>();
    try {
      const recent = await getRecentOpportunities(24);
      existingKeys = new Set(recent.map((r) => `${r.market_id}:${r.outcome}`));
      console.log(`[scan-markets] 🔍 ${existingKeys.size} opportunité(s) déjà en DB (24h)`);
    } catch (err) {
      console.warn(
        "[scan-markets] ⚠ Impossible de lire les opportunités récentes, déduplication ignorée :",
        err instanceof Error ? err.message : err
      );
    }

    const toSave     = opps.filter((o) => !existingKeys.has(`${o.marketId}:${o.outcome}`));
    const alreadyKnown = opps.length - toSave.length;

    if (alreadyKnown > 0) {
      console.log(`[scan-markets] ⏭ ${alreadyKnown} opportunité(s) ignorée(s) (déjà en DB)`);
    }

    for (const opp of toSave) {
      // Champs dérivés non stockés dans Opportunity pour garder l'interface propre
      const stationCode  = opp.ticker ?? opp.city ?? "";
      const multiplier   = opp.marketPrice > 0 ? Math.round((1 / opp.marketPrice) * 100) / 100 : 0;
      const potentialPnl = opp.marketPrice > 0
        ? Math.round(opp.suggestedBet * (1 / opp.marketPrice - 1) * 100) / 100
        : 0;

      // 2a. opportunities
      try {
        await saveOpportunity({
          market_id:             opp.marketId,
          question:              opp.question,
          city:                  opp.city ?? null,
          station_code:          stationCode,
          outcome:               opp.outcome,
          market_price:          opp.marketPrice,
          estimated_probability: opp.estimatedProbability,
          edge:                  opp.edge,
          multiplier,
        });
        console.log(`[scan-markets] 💾 Opportunité : ${opp.marketId}/${opp.outcome}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scan-markets] ✗ saveOpportunity (${opp.marketId}/${opp.outcome}) :`, msg);
        errors.push({ marketId: opp.marketId, question: opp.question, error: msg });
      }

      // 2b. paper_trades + positions
      try {
        const paperTrade = await savePaperTrade({
          market_id:             opp.marketId,
          question:              opp.question,
          city:                  opp.city ?? null,
          ticker:                opp.ticker ?? null,
          agent:                 opp.agent,
          outcome:               opp.outcome,
          market_price:          opp.marketPrice,
          estimated_probability: opp.estimatedProbability,
          edge:                  opp.edge,
          suggested_bet:         opp.suggestedBet,
          confidence:            opp.confidence ?? null,
          resolution_date:       opp.targetDate ?? null,
          potential_pnl:         potentialPnl,
          market_context:        opp.marketContext ?? null,
          expected_resolution:   opp.targetDateTime ?? null,
        });
        console.log(`[scan-markets] 🃏 Paper trade : ${opp.marketId}/${opp.outcome}`);

        try {
          await openPosition({
            paperTradeId:     paperTrade.id,
            marketId:         opp.marketId,
            question:         opp.question,
            city:             opp.city ?? null,
            ticker:           opp.ticker ?? null,
            agent:            opp.agent,
            outcome:          opp.outcome,
            entryPrice:       opp.marketPrice,
            entryProbability: opp.estimatedProbability,
            suggestedBet:     opp.suggestedBet,
            resolutionDate:   opp.targetDate ?? null,
          });
          console.log(`[scan-markets] 📍 Position ouverte : ${opp.marketId}/${opp.outcome}`);
        } catch (err) {
          console.error(
            `[scan-markets] ✗ openPosition (${opp.marketId}/${opp.outcome}) :`,
            err instanceof Error ? err.message : err
          );
        }

        savedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scan-markets] ✗ savePaperTrade (${opp.marketId}/${opp.outcome}) :`, msg);
        errors.push({ marketId: opp.marketId, question: opp.question, error: msg });
      }
    }

    console.log(`[scan-markets] 💾 ${savedCount}/${toSave.length} sauvegardé(s)`);

    // Stats journalières (best-effort)
    incrementDailyOpportunities(toSave.length).catch((err) =>
      console.error("[scan-markets] ✗ incrementDailyOpportunities :", err instanceof Error ? err.message : err)
    );
  }

  // 3. Notification Discord (fire-and-forget)
  if (opps.length > 0) {
    sendDiscordNotification(
      opps.map((opp) => ({
        city:                 opp.city ?? opp.ticker ?? opp.token ?? "",
        outcome:              opp.outcome,
        marketPrice:          opp.marketPrice,
        estimatedProbability: opp.estimatedProbability,
        edge:                 opp.edge,
        multiplier:           opp.marketPrice > 0 ? 1 / opp.marketPrice : 0,
        suggestedBet:         opp.suggestedBet,
      })),
      new Date()
    ).catch((err) =>
      console.error("[scan-markets] ✗ Discord :", err instanceof Error ? err.message : err)
    );
  }

  // 4. Update bot last-scan timestamp + detailed activity logs (best-effort)
  updateLastScan().catch(() => {});

  // Log each trade signal with full detail
  for (const opp of opps) {
    const edge  = ((opp.estimatedProbability - opp.marketPrice) * 100).toFixed(1);
    const price = (opp.marketPrice * 100).toFixed(0);
    const label = opp.city ?? opp.ticker ?? opp.token ?? opp.marketId;
    logActivity(
      "trade",
      `TRADE: ${label} ${opp.outcome} @ ${price}¢ (edge=${edge}%, bet=$${opp.suggestedBet.toFixed(2)}, conf=${opp.confidence ?? "?"})`
    ).catch(() => {});
  }

  // Log basic skips from orchestrator (horizon, anti-churn, consensus, etc.)
  // Detailed edge/Claude skips are already logged from inside weather-adapter
  for (const sk of skipped) {
    logActivity(
      "skip",
      `SKIP: ${sk.question.slice(0, 60)} - ${sk.reason}`
    ).catch(() => {});
  }

  logActivity("info", `Scan complete: ${opps.length} trades, ${savedCount} saved, ${skipped.length} skipped`).catch(() => {});

  const duration = `${Date.now() - startTime}ms`;
  console.log(
    `[scan-markets] ■ Terminé en ${duration} — ` +
    `${opps.length} opportunités, ${savedCount} sauvegardé(s), ` +
    `${skipped.length} ignoré(s), ${errors.length} erreur(s)`
  );

  return NextResponse.json({
    scannedAt:      new Date().toISOString(),
    duration,
    byAgent,
    opportunities:  opps.length,
    saved:          savedCount,
    skipped:        skipped.length,
    details:        opps,
    skippedDetails: skipped.slice(0, 20),
    errors,
  });

  } finally {
    await releaseScanLock();
  }
}
