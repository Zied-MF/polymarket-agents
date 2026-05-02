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
import { sendDiscordNotification } from "@/lib/utils/discord";
import {
  saveOpportunity,
  incrementDailyOpportunities,
  acquireScanLock,
  releaseScanLock,
  getCurrentBankroll,
  getClient as getSupabaseClient,
}                                          from "@/lib/db/supabase";
import { cleanOldLogs }                    from "@/lib/logger";
import { executeBuy, isRealTradingEnabled } from "@/lib/trade-executor";
import { getAccountBalance }               from "@/lib/polymarket/clob-api";
import { MIN_BET_AMOUNT }                  from "@/lib/utils/sizing";

// ---------------------------------------------------------------------------
// Guard : max positions par marché+outcome
// ---------------------------------------------------------------------------

/** Nombre maximum de positions ouvertes autorisées par market_id+outcome. */
const MAX_POSITIONS_PER_MARKET =
  parseInt(process.env.MAX_POSITIONS_PER_MARKET ?? "1", 10);

/**
 * Fraction maximale du bankroll effectif par trade individuel.
 * Ex: 0.05 = 5% max. Configurable via MAX_PCT_BANKROLL_PER_TRADE env var.
 */
const MAX_PCT_BANKROLL_PER_TRADE =
  parseFloat(process.env.MAX_PCT_BANKROLL_PER_TRADE ?? "0.05");

/**
 * Plafond absolu par trade en USDC, indépendant du bankroll.
 * Filet de sécurité ultime si le bankroll réel est inconnu.
 * Default: $5. Configurable via MAX_BET_ABSOLUTE_USDC env var.
 */
const MAX_BET_ABSOLUTE_USDC =
  parseFloat(process.env.MAX_BET_ABSOLUTE_USDC ?? "5");

/**
 * Bankroll initial conservateur utilisé comme fallback lorsque le solde
 * pUSD on-chain n'est pas disponible (RPC KO). Evite d'utiliser le bankroll
 * paper composé (très gonflé) qui rendrait le cap bancroll inopérant.
 */
const INITIAL_BANKROLL_FALLBACK =
  parseFloat(process.env.INITIAL_BANKROLL ?? "10");

/**
 * Retourne le nombre de positions ouvertes (sold_at IS NULL) pour ce couple
 * market_id + outcome. Retourne 0 en cas d'erreur (fail-open).
 */
async function countOpenPositions(marketId: string, outcome: string): Promise<number> {
  try {
    const db = getSupabaseClient();
    const { count, error } = await db
      .from("positions")
      .select("id", { count: "exact", head: true })
      .eq("market_id", marketId)
      .eq("outcome",   outcome)
      .is("sold_at",   null);

    if (error) {
      console.warn(`[scan-markets] countOpenPositions error: ${error.message}`);
      return 0; // fail-open : on ne bloque pas si la requête échoue
    }
    return count ?? 0;
  } catch (e) {
    console.warn(`[scan-markets] countOpenPositions exception:`, e instanceof Error ? e.message : e);
    return 0;
  }
}
import type { Opportunity, SkippedMarket, AgentStats } from "@/lib/agents/orchestrator";
import { getBotState, updateLastScan }     from "@/lib/bot/bot-state";
import { logActivity }                     from "@/lib/logger";
import { setWeatherAdapterMode, setRealBankroll } from "@/lib/agents/adapters/weather-adapter";

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

  // Bankroll effectif : pUSD on-chain si real trading, sinon bankroll paper DB.
  // Utilisé pour le cap MAX_PCT_BANKROLL_PER_TRADE.
  //
  // Fallback conservateur : si pUSD RPC échoue en mode real, on utilise
  // INITIAL_BANKROLL_FALLBACK ($10) et non le bankroll paper composé (gonflé
  // à ~$171 par les gains simulés), ce qui rendrait le cap inopérant.
  let effectiveBankroll: number;
  if (isRealTradingEnabled()) {
    const pUsd = await getAccountBalance().catch(() => null);
    effectiveBankroll = (pUsd !== null && pUsd > 0) ? pUsd : INITIAL_BANKROLL_FALLBACK;
    if (pUsd === null) {
      console.warn(
        `[scan-markets] ⚠ pUSD RPC failed — using conservative fallback $${INITIAL_BANKROLL_FALLBACK} ` +
        `instead of inflated paper bankroll $${bankroll.toFixed(2)}`
      );
    }
    // Injecter le solde réel dans weather-adapter pour que le Kelly sizing
    // utilise les vrais fonds et non le bankroll paper gonflé.
    setRealBankroll(effectiveBankroll);
  } else {
    effectiveBankroll = bankroll; // paper mode : bankroll composé normal
    setRealBankroll(null);        // reset → weather-adapter utilise bankroll paper
  }
  const maxBetByBankroll = effectiveBankroll * MAX_PCT_BANKROLL_PER_TRADE;

  const isReal        = isRealTradingEnabled();
  const modeLabel     = isReal ? "REAL" : "PAPER";
  const logMeta       = {
    is_real_mode:    isReal,
    bankroll_paper:  bankroll,
    bankroll_real:   isReal ? effectiveBankroll : null,
  };

  console.log(
    `[scan-markets] ▶ [${modeLabel}] Démarrage scan — ${new Date().toISOString()} ` +
    `(mode: ${scanMode}, bankroll_paper: ${bankroll.toFixed(2)}$` +
    (isReal ? `, bankroll_real: ${effectiveBankroll.toFixed(2)}$` : "") +
    `, maxBetPerTrade: ${maxBetByBankroll.toFixed(2)}$)`
  );
  await logActivity(
    "scan",
    `[${modeLabel}] Scan started (mode: ${scanMode}, bankroll: $${effectiveBankroll.toFixed(2)})`,
    logMeta
  );

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

  // 2. Persister dans Supabase — déduplication sur paper_trades (trades réellement placés)
  // On utilise paper_trades (pas opportunities) pour éviter de bloquer les marchés dont
  // le scan a détecté une opportunité mais dont le trade n'a jamais été créé.
  // Les trades annulés (won=false AND potential_pnl=0) ne bloquent pas non plus.
  let savedCount = 0;
  let realCount  = 0;

  if (opps.length > 0) {
    let existingKeys = new Set<string>();
    try {
      const db    = getSupabaseClient();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentTrades } = await db
        .from("paper_trades")
        .select("market_id, outcome")
        .gte("created_at", since)
        .or("won.is.null,won.eq.true,and(won.eq.false,potential_pnl.neq.0)");
      existingKeys = new Set(
        (recentTrades ?? []).map((r: { market_id: string; outcome: string }) => `${r.market_id}:${r.outcome}`)
      );
      console.log(`[scan-markets] 🔍 ${existingKeys.size} trade(s) réels en DB (24h, annulés exclus)`);
    } catch (err) {
      console.warn(
        "[scan-markets] ⚠ Impossible de lire les trades récents, déduplication ignorée :",
        err instanceof Error ? err.message : err
      );
    }

    const toSave      = opps.filter((o) => !existingKeys.has(`${o.marketId}:${o.outcome}`));
    const alreadyKnown = opps.length - toSave.length;

    // Log chaque opportunité et son sort (dedup ou passage)
    for (const opp of opps) {
      const label = opp.city ?? opp.ticker ?? opp.marketId;
      const key   = `${opp.marketId}:${opp.outcome}`;
      if (existingKeys.has(key)) {
        console.log(`[scan-markets] ⏭ DEDUP-24H ${label}/${opp.outcome} — trade déjà en DB (market_id=${opp.marketId})`);
      } else {
        console.log(`[scan-markets] ✅ PASS-DEDUP ${label}/${opp.outcome} edge=${(opp.edge * 100).toFixed(1)}%`);
      }
    }

    if (alreadyKnown > 0) {
      console.log(`[scan-markets] ⏭ ${alreadyKnown} opportunité(s) ignorée(s) (trade déjà placé 24h)`);
    }

    // Opps réellement sauvegardées (après caps), utilisées pour Discord notification.
    const savedCappedOpps: Array<{ city: string; outcome: string; marketPrice: number; estimatedProbability: number; edge: number; suggestedBet: number }> = [];

    for (const opp of toSave) {
      // Champs dérivés non stockés dans Opportunity pour garder l'interface propre
      const stationCode = opp.ticker ?? opp.city ?? "";
      const multiplier  = opp.marketPrice > 0 ? Math.round((1 / opp.marketPrice) * 100) / 100 : 0;

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

      // 2b. Cap bankroll par trade + plafond absolu (filet de sécurité)
      const label = opp.city ?? opp.ticker ?? opp.marketId;
      let finalBet = Math.min(opp.suggestedBet, maxBetByBankroll, MAX_BET_ABSOLUTE_USDC);
      finalBet = Math.round(finalBet * 100) / 100;

      if (finalBet < MIN_BET_AMOUNT) {
        console.log(
          `[scan-markets] ⏭ SKIP-BET-TOO-SMALL ${label}/${opp.outcome}: ` +
          `finalBet=$${finalBet.toFixed(2)} < min=$${MIN_BET_AMOUNT} ` +
          `(proposed=$${opp.suggestedBet.toFixed(2)}, bankrollCap=$${maxBetByBankroll.toFixed(2)}, absCap=$${MAX_BET_ABSOLUTE_USDC})`
        );
        continue;
      }
      console.log(`[scan-markets] ✅ PASS-BET ${label}/${opp.outcome} finalBet=$${finalBet.toFixed(2)}`);

      if (finalBet < opp.suggestedBet) {
        console.log(
          `[scan-markets] ⚠ Bet réduit par bankroll cap: $${opp.suggestedBet.toFixed(2)} → $${finalBet.toFixed(2)} ` +
          `(${(MAX_PCT_BANKROLL_PER_TRADE * 100).toFixed(0)}% de $${effectiveBankroll.toFixed(2)})`
        );
      }

      // Override suggestedBet with the capped value for downstream processing
      const cappedOpp = { ...opp, suggestedBet: finalBet };

      // 2d. Guard : max positions ouvertes par marché+outcome
      const openCount = await countOpenPositions(opp.marketId, opp.outcome);
      if (openCount >= MAX_POSITIONS_PER_MARKET) {
        console.log(
          `[scan-markets] ⏭ SKIP-OPEN-POSITION ${label}/${opp.outcome}: ` +
          `${openCount} position(s) déjà ouverte(s) (max=${MAX_POSITIONS_PER_MARKET})`
        );
        continue;
      }
      console.log(`[scan-markets] ✅ PASS-OPEN-POSITION ${label}/${opp.outcome} openCount=${openCount}`);

      // 2e. paper_trade + position (+ ordre CLOB réel si REAL_TRADING_ENABLED)
      // potentialPnl recalculé sur le bet cappé
      const cappedPotentialPnl = cappedOpp.marketPrice > 0
        ? Math.round(cappedOpp.suggestedBet * (1 / cappedOpp.marketPrice - 1) * 100) / 100
        : 0;
      try {
        const result = await executeBuy({
          marketId:             cappedOpp.marketId,
          question:             cappedOpp.question,
          city:                 cappedOpp.city ?? null,
          ticker:               cappedOpp.ticker ?? null,
          agent:                cappedOpp.agent,
          outcome:              cappedOpp.outcome,
          marketPrice:          cappedOpp.marketPrice,
          estimatedProbability: cappedOpp.estimatedProbability,
          edge:                 cappedOpp.edge,
          suggestedBet:         cappedOpp.suggestedBet,
          confidence:           cappedOpp.confidence ?? null,
          targetDate:           cappedOpp.targetDate,
          targetDateTime:       cappedOpp.targetDateTime,
          marketContext:        cappedOpp.marketContext ?? null,
          potentialPnl:         cappedPotentialPnl,
        });

        if (result.isReal) {
          realCount++;
          console.log(
            `[scan-markets] ✅ REAL on-chain : ${cappedOpp.question.slice(0, 60)} / ${cappedOpp.outcome} ` +
            `bet=$${cappedOpp.suggestedBet.toFixed(2)} orderId=${result.orderId?.slice(0, 16)}`
          );
        } else {
          // isReal=false en real mode = real order failed, fallback paper
          const reason = result.realError ? ` — ${result.realError.slice(0, 120)}` : "";
          console.log(
            `[scan-markets] 📝 PAPER only (real order failed${reason}) : ` +
            `${cappedOpp.question.slice(0, 60)} / ${cappedOpp.outcome} ` +
            `bet=$${cappedOpp.suggestedBet.toFixed(2)} ` +
            `(paperTradeId=${result.paperTradeId.slice(0, 8)})`
          );
        }

        savedCappedOpps.push({
          city:                 cappedOpp.city ?? cappedOpp.ticker ?? cappedOpp.marketId,
          outcome:              cappedOpp.outcome,
          marketPrice:          cappedOpp.marketPrice,
          estimatedProbability: cappedOpp.estimatedProbability,
          edge:                 cappedOpp.edge,
          suggestedBet:         cappedOpp.suggestedBet,  // bet réel après cap bankroll
        });
        savedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scan-markets] ✗ executeBuy (${opp.marketId}/${opp.outcome}) :`, msg);
        errors.push({ marketId: opp.marketId, question: opp.question, error: msg });
      }
    }

    console.log(`[scan-markets] 💾 ${savedCount} trade(s) créé(s) (${realCount} on-chain, ${savedCount - realCount} paper)`);

    // Stats journalières (best-effort)
    incrementDailyOpportunities(toSave.length).catch((err) =>
      console.error("[scan-markets] ✗ incrementDailyOpportunities :", err instanceof Error ? err.message : err)
    );

    // 3. Notification Discord — bet réel après cap bankroll (pas l'uncapped orchestrator bet)
    if (savedCappedOpps.length > 0) {
      sendDiscordNotification(
        savedCappedOpps.map((o) => ({
          city:                 o.city,
          outcome:              o.outcome,
          marketPrice:          o.marketPrice,
          estimatedProbability: o.estimatedProbability,
          edge:                 o.edge,
          multiplier:           o.marketPrice > 0 ? 1 / o.marketPrice : 0,
          suggestedBet:         o.suggestedBet,
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
    const onChainSuffix = modeLabel === "REAL"
      ? ` (${realCount} on-chain, ${savedCount - realCount} paper-only)`
      : "";
    logActivity("trade", `[${modeLabel}-MODE] ${savedCount} trade(s)${onChainSuffix}: ${labels}`, logMeta).catch(() => {});
  }
  logActivity("info", `[${modeLabel}] Scan complete: ${savedCount} saved (${realCount} on-chain), ${skipped.length} skipped`, logMeta).catch(() => {});

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
