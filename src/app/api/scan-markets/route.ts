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
  acquireScanLock,
  releaseScanLock,
  getCurrentBankroll,
}                                          from "@/lib/db/supabase";
import { cleanOldLogs }                    from "@/lib/logger";
import { executeBuy }                      from "@/lib/trade-executor";
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
  const bankroll = await getCurrentBankroll().catch(() => 10);
  console.log(`[scan-markets] ▶ Démarrage scan — ${new Date().toISOString()} (mode: ${scanMode}, bankroll: ${bankroll.toFixed(2)}$)`);
  await logActivity("scan", `Scan started (mode: ${scanMode}, bankroll: ${bankroll.toFixed(2)}$)`);

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

      // 2b. paper_trade + position (+ ordre CLOB réel si REAL_TRADING_ENABLED)
      try {
        const result = await executeBuy({
          marketId:             opp.marketId,
          question:             opp.question,
          city:                 opp.city ?? null,
          ticker:               opp.ticker ?? null,
          agent:                opp.agent,
          outcome:              opp.outcome,
          marketPrice:          opp.marketPrice,
          estimatedProbability: opp.estimatedProbability,
          edge:                 opp.edge,
          suggestedBet:         opp.suggestedBet,
          confidence:           opp.confidence ?? null,
          targetDate:           opp.targetDate,
          targetDateTime:       opp.targetDateTime,
          marketContext:        opp.marketContext ?? null,
          potentialPnl,
        });
        console.log(
          `[scan-markets] 🃏 Trade enregistré : ${opp.marketId}/${opp.outcome} ` +
          `(paperTradeId=${result.paperTradeId.slice(0, 8)}, positionId=${result.positionId.slice(0, 8)}, ` +
          `real=${result.isReal})`
        );

        savedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scan-markets] ✗ executeBuy (${opp.marketId}/${opp.outcome}) :`, msg);
        errors.push({ marketId: opp.marketId, question: opp.question, error: msg });
      }
    }

    console.log(`[scan-markets] 💾 ${savedCount}/${toSave.length} sauvegardé(s)`);

    // Stats journalières (best-effort)
    incrementDailyOpportunities(toSave.length).catch((err) =>
      console.error("[scan-markets] ✗ incrementDailyOpportunities :", err instanceof Error ? err.message : err)
    );

    // 3. Notification Discord — uniquement les nouvelles opportunités (toSave)
    //    Les opportunités déjà en DB (dedup) ne re-notifient PAS Discord.
    if (toSave.length > 0) {
      sendDiscordNotification(
        toSave.map((opp) => ({
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
  }

  // 4. Update bot last-scan timestamp + detailed activity logs (best-effort)
  updateLastScan().catch(() => {});

  // One summary line per scan — no per-skip logs to avoid DB bloat
  if (savedCount > 0) {
    const labels = opps.map((o) => `${o.city ?? o.ticker ?? o.marketId} ${o.outcome}`).join(", ");
    logActivity("trade", `${savedCount} trade(s): ${labels}`).catch(() => {});
  }
  logActivity("info", `Scan complete: ${savedCount} saved, ${skipped.length} skipped`).catch(() => {});

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
    cleanOldLogs().catch(() => {});
    await releaseScanLock();
  }
}
