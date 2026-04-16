/**
 * Cron endpoint - scan marchés météo daily
 *
 * GET /api/scan-markets
 *
 * Pipeline :
 *   1. Fetch tous les marchés météo actifs via l'API Gamma
 *   2. Pour chaque marché, récupère la prévision Open-Meteo de la station
 *   3. Analyse via le Weather Agent (distribution gaussienne)
 *   4. Retourne les opportunités (edge >= 7.98%) et les marchés ignorés
 *
 * Aucun ordre n'est passé — détection uniquement.
 */

import { NextResponse } from "next/server";
import { fetchAllWeatherMarkets, fetchStockMarkets } from "@/lib/polymarket/gamma-api";
import { fetchForecastForStation } from "@/lib/data-sources/weather-sources";
import {
  fetchStockData,
  fetchPreMarketData,
  calculateTechnicals,
} from "@/lib/data-sources/finance-sources";
import { analyzeMarket } from "@/lib/agents/weather-agent";
import { analyzeStockMarket } from "@/lib/agents/finance-agent";
import { sendDiscordNotification } from "@/lib/utils/discord";
import { calculateHalfKelly, BANKROLL } from "@/lib/utils/kelly";
import {
  saveOpportunity,
  getRecentOpportunities,
  incrementDailyOpportunities,
  savePaperTrade,
} from "@/lib/db/supabase";
import { openPosition } from "@/lib/db/positions";
import type { WeatherMarket, StockMarket } from "@/lib/polymarket/gamma-api";
import type { Outcome } from "@/types";

// ---------------------------------------------------------------------------
// Types de la réponse
// ---------------------------------------------------------------------------

interface OpportunityResult {
  marketId: string;
  question: string;
  city: string;
  stationCode: string;
  targetDate: string;
  outcome: string;
  marketPrice: number;
  estimatedProbability: number;
  edge: number;
  multiplier: number;
  suggestedBet: number;
  confidence: "high" | "medium" | "low" | undefined;
  agent: "weather" | "finance";
}

interface SkippedMarket {
  marketId: string;
  question: string;
  reason: string;
  agent: "weather" | "finance";
}

interface ScanResult {
  scannedAt: string;
  total_markets: number;
  opportunities: OpportunityResult[];
  saved_to_db: number;
  paper_trades_logged: number;
  skipped: SkippedMarket[];
  errors: { marketId: string; question: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Détecte si un marché est en situation de consensus fort (>90%) sur un outcome.
 * Dans ce cas, le marché est peu liquide et peu exploitable — on l'ignore.
 */
function hasStrongConsensus(market: WeatherMarket): boolean {
  return market.outcomePrices.some((p) => p >= 0.9);
}

function outcomeToResult(
  base: { id: string; question: string; city: string; stationCode: string; targetDate: string },
  o: Outcome,
  agent: "weather" | "finance",
  confidenceLevel?: "high" | "medium" | "low"
): OpportunityResult {
  const kelly = calculateHalfKelly(o.estimatedProbability, o.marketPrice, BANKROLL);

  return {
    marketId:             base.id,
    question:             base.question,
    city:                 base.city,
    stationCode:          base.stationCode,
    targetDate:           base.targetDate,
    outcome:              o.outcome,
    marketPrice:          round(o.marketPrice, 4),
    estimatedProbability: round(o.estimatedProbability, 4),
    edge:                 round(o.edge, 4),
    multiplier:           round(o.multiplier, 2),
    suggestedBet:         kelly.betAmount,
    confidence:           confidenceLevel,
    agent,
  };
}

function weatherBase(market: WeatherMarket) {
  return {
    id:          market.id,
    question:    market.question,
    city:        market.city,
    stationCode: market.stationCode,
    targetDate:  market.targetDate.toISOString().slice(0, 10),
  };
}

function stockBase(market: StockMarket) {
  return {
    id:          market.id,
    question:    market.question,
    city:        market.ticker,
    stationCode: market.ticker,
    targetDate:  market.endDate.toISOString().slice(0, 10),
  };
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<ScanResult>> {
  const startedAt = new Date();
  console.log(`[scan-markets] ▶ Démarrage scan — ${startedAt.toISOString()}`);

  const opportunities: OpportunityResult[] = [];
  const skipped: SkippedMarket[] = [];
  const errors: ScanResult["errors"] = [];

  // 1. Récupérer tous les marchés météo actifs
  let markets: WeatherMarket[];
  try {
    markets = await fetchAllWeatherMarkets();
    console.log(`[scan-markets] ${markets.length} marchés météo récupérés depuis Gamma`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scan-markets] ✗ Échec fetchAllWeatherMarkets : ${msg}`);
    return NextResponse.json(
      {
        scannedAt: startedAt.toISOString(),
        total_markets: 0,
        opportunities: [],
        saved_to_db: 0,
        paper_trades_logged: 0,
        skipped: [],
        errors: [{ marketId: "N/A", question: "N/A", error: msg }],
      },
      { status: 502 }
    );
  }

  // 2. Analyser chaque marché
  for (const market of markets) {
    const tag = `[scan-markets][${market.stationCode}][${market.id.slice(0, 8)}]`;

    // 2a. Ignorer les marchés avec liquidité insuffisante (< $100)
    if (market.liquidity < 100) {
      const reason = `Liquidité insuffisante — $${round(market.liquidity, 2)} < $100`;
      console.log(`${tag} ⏭ Ignoré : ${reason} — "${market.question}"`);
      skipped.push({ marketId: market.id, question: market.question, reason, agent: "weather" });
      continue;
    }

    // 2b. Ignorer les marchés avec consensus fort (>90% sur un outcome)
    if (hasStrongConsensus(market)) {
      const dominant = market.outcomePrices.reduce((max, p) => Math.max(max, p), 0);
      const reason = `Consensus fort — prix dominant ${round(dominant * 100, 1)}%`;
      console.log(`${tag} ⏭ Ignoré : ${reason} — "${market.question}"`);
      skipped.push({ marketId: market.id, question: market.question, reason, agent: "weather" });
      continue;
    }

    // 2c. Récupérer la prévision météo
    let forecast;
    try {
      forecast = await fetchForecastForStation(market.stationCode, market.targetDate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} ✗ Erreur prévision : ${msg}`);
      errors.push({ marketId: market.id, question: market.question, error: msg });
      continue;
    }

    // Station inconnue → skipped (pas une erreur, juste non couvert)
    if (!forecast) {
      const reason = `Station inconnue : ${market.stationCode} — ajoutez-la dans station-mapping.ts`;
      console.warn(`${tag} ⏭ ${reason}`);
      skipped.push({ marketId: market.id, question: market.question, reason, agent: "weather" });
      continue;
    }

    console.log(
      `${tag} 🌡 Prévision ${market.city} le ${market.targetDate.toISOString().slice(0, 10)} : ` +
        `high=${forecast.highTemp.toFixed(1)}°C  low=${forecast.lowTemp.toFixed(1)}°C  ` +
        `confidence=${forecast.confidence}`
    );

    // 2d. Analyser avec le Weather Agent
    const marketOpportunities = analyzeMarket(market, forecast);

    if (marketOpportunities.length === 0) {
      console.log(`${tag} — Aucune opportunité (edge < 7.98%) — "${market.question}"`);
    } else {
      for (const opp of marketOpportunities) {
        const pct = (opp.edge * 100).toFixed(2);
        const result = outcomeToResult(weatherBase(market), opp, "weather", forecast.confidenceLevel);
        console.log(
          `[scan-markets] Valid market: ${market.city} ${opp.outcome}, ` +
            `price=${round(opp.marketPrice, 2)}, edge=${round(opp.edge, 2)}`
        );
        console.log(
          `${tag} ✅ OPPORTUNITÉ — outcome="${opp.outcome}"  ` +
            `marketPrice=${round(opp.marketPrice * 100, 1)}%  ` +
            `estimated=${round(opp.estimatedProbability * 100, 1)}%  ` +
            `edge=+${pct}%  multiplier=${round(opp.multiplier, 2)}x  ` +
            `½Kelly=$${result.suggestedBet.toFixed(2)}`
        );
        opportunities.push(result);
      }
    }
  }

  // ── Finance Agent ────────────────────────────────────────────────────────

  let stockMarkets: StockMarket[] = [];
  try {
    stockMarkets = await fetchStockMarkets();
    console.log(`[scan-markets] ${stockMarkets.length} marchés finance récupérés depuis Gamma`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scan-markets] ✗ Échec fetchStockMarkets : ${msg}`);
  }

  for (const market of stockMarkets) {
    const tag = `[scan-markets][finance][${market.ticker}][${market.id.slice(0, 8)}]`;

    if (market.liquidity < 100) {
      const reason = `Liquidité insuffisante — $${round(market.liquidity, 2)} < $100`;
      console.log(`${tag} ⏭ Ignoré : ${reason} — "${market.question}"`);
      skipped.push({ marketId: market.id, question: market.question, reason, agent: "finance" });
      continue;
    }

    if (market.outcomePrices.some((p) => p >= 0.95)) {
      const dominant = market.outcomePrices.reduce((max, p) => Math.max(max, p), 0);
      const reason = `Consensus fort — prix dominant ${round(dominant * 100, 1)}%`;
      console.log(
        `[finance-agent] ${market.ticker}: consensus ${round(dominant * 100, 1)}% → skipped`
      );
      skipped.push({ marketId: market.id, question: market.question, reason, agent: "finance" });
      continue;
    }

    const upPct   = round(market.outcomePrices[0] * 100, 1);
    const downPct = round((market.outcomePrices[1] ?? 1 - market.outcomePrices[0]) * 100, 1);
    console.log(
      `[finance-agent] ${market.ticker}: Up=${upPct}%, Down=${downPct}% → analyzing...`
    );

    let stockData, preMarket, technicals;
    try {
      [stockData, preMarket] = await Promise.all([
        fetchStockData(market.ticker),
        fetchPreMarketData(market.ticker),
      ]);
      technicals = calculateTechnicals(stockData.priceHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} ✗ Erreur données finance : ${msg}`);
      errors.push({ marketId: market.id, question: market.question, error: msg });
      continue;
    }

    const marketOpportunities = analyzeStockMarket(market, stockData, preMarket, technicals);

    if (marketOpportunities.length === 0) {
      console.log(`${tag} — Aucune opportunité — "${market.question}"`);
    } else {
      for (const opp of marketOpportunities) {
        const pct    = (opp.edge * 100).toFixed(2);
        console.log(
          `[scan-markets] Valid market: ${market.ticker} ${opp.outcome}, ` +
            `price=${round(opp.marketPrice, 2)}, edge=${round(opp.edge, 2)}`
        );
        const result = outcomeToResult(
          stockBase(market),
          opp,
          "finance",
          opp.estimatedProbability >= 0.70 ? "high" : "medium"
        );
        console.log(
          `${tag} ✅ OPPORTUNITÉ — outcome="${opp.outcome}"  ` +
          `marketPrice=${round(opp.marketPrice * 100, 1)}%  ` +
          `estimated=${round(opp.estimatedProbability * 100, 1)}%  ` +
          `edge=+${pct}%  ½Kelly=$${result.suggestedBet.toFixed(2)}`
        );
        opportunities.push(result);
      }
    }
  }

  // 3. Trier les opportunités par edge décroissant (meilleures en premier)
  opportunities.sort((a, b) => b.edge - a.edge);

  // 4. Persister dans Supabase — avec déduplication sur market_id + outcome
  let savedToDb = 0;
  let paperTradesLogged = 0;

  if (opportunities.length > 0) {
    // 4a. Récupérer les opportunités déjà enregistrées dans les dernières 24h
    //     en une seule requête pour éviter N aller-retours DB.
    let existingKeys = new Set<string>();
    try {
      const recent = await getRecentOpportunities(24);
      existingKeys = new Set(recent.map((r) => `${r.market_id}:${r.outcome}`));
      console.log(
        `[scan-markets] 🔍 ${existingKeys.size} opportunité(s) déjà en DB (24h)`
      );
    } catch (err) {
      // Si la lecture échoue on continue sans déduplication plutôt que de bloquer
      console.warn(
        "[scan-markets] ⚠ Impossible de lire les opportunités récentes, déduplication ignorée :",
        err instanceof Error ? err.message : err
      );
    }

    // 4b. Filtrer les nouvelles opportunités et les insérer en parallèle
    const toSave = opportunities.filter(
      (opp) => !existingKeys.has(`${opp.marketId}:${opp.outcome}`)
    );
    const alreadyKnown = opportunities.length - toSave.length;

    if (alreadyKnown > 0) {
      console.log(
        `[scan-markets] ⏭ ${alreadyKnown} opportunité(s) ignorée(s) (déjà en DB)`
      );
    }

    if (toSave.length > 0) {
      // 4c. Sauvegarder les opportunités dans la table opportunities
      for (const opp of toSave) {
        try {
          await saveOpportunity({
            market_id:             opp.marketId,
            question:              opp.question,
            city:                  opp.city,
            station_code:          opp.stationCode,
            outcome:               opp.outcome,
            market_price:          opp.marketPrice,
            estimated_probability: opp.estimatedProbability,
            edge:                  opp.edge,
            multiplier:            opp.multiplier,
          });
          savedToDb++;
          console.log(`[scan-markets] 💾 Opportunité sauvegardée : ${opp.marketId}/${opp.outcome}`);
        } catch (err) {
          console.error(
            `[scan-markets] ✗ saveOpportunity failed (${opp.marketId}/${opp.outcome}) :`,
            err instanceof Error ? err.message : err
          );
        }
      }

      // 4d. Sauvegarder les paper trades (séquentiellement pour tracer chaque erreur)
      for (const opp of toSave) {
        const potentialPnl = opp.marketPrice > 0
          ? Math.round(opp.suggestedBet * (1 / opp.marketPrice - 1) * 100) / 100
          : 0;
        try {
          const paperTrade = await savePaperTrade({
            market_id:             opp.marketId,
            question:              opp.question,
            city:                  opp.city,
            ticker:                opp.agent === "finance" ? opp.stationCode : null,
            agent:                 opp.agent,
            outcome:               opp.outcome,
            market_price:          opp.marketPrice,
            estimated_probability: opp.estimatedProbability,
            edge:                  opp.edge,
            suggested_bet:         opp.suggestedBet,
            confidence:            opp.confidence ?? null,
            resolution_date:       opp.targetDate,
            potential_pnl:         potentialPnl,
          });
          paperTradesLogged++;
          console.log(`[scan-markets] 🃏 Paper trade sauvegardé : ${opp.marketId}/${opp.outcome}`);

          // Ouvrir une position pour le suivi en temps réel
          try {
            await openPosition({
              paperTradeId:     paperTrade.id,
              marketId:         opp.marketId,
              question:         opp.question,
              city:             opp.city,
              ticker:           opp.agent === "finance" ? opp.stationCode : null,
              agent:            opp.agent,
              outcome:          opp.outcome,
              entryPrice:       opp.marketPrice,
              entryProbability: opp.estimatedProbability,
              suggestedBet:     opp.suggestedBet,
              resolutionDate:   opp.targetDate,
            });
            console.log(`[scan-markets] 📍 Position ouverte : ${opp.marketId}/${opp.outcome}`);
          } catch (err) {
            console.error(
              `[scan-markets] ✗ openPosition failed (${opp.marketId}/${opp.outcome}) :`,
              err instanceof Error ? err.message : err
            );
          }
        } catch (err) {
          console.error(
            `[scan-markets] ✗ savePaperTrade failed (${opp.marketId}/${opp.outcome}) :`,
            err instanceof Error ? err.message : err
          );
        }
      }

      console.log(
        `[scan-markets] 💾 ${savedToDb}/${toSave.length} opportunité(s) sauvegardée(s) dans Supabase`
      );
      console.log(
        `[scan-markets] 🃏 ${paperTradesLogged}/${toSave.length} paper trade(s) logué(s)`
      );

      // 4e. Stats journalières (best-effort, non bloquant)
      incrementDailyOpportunities(toSave.length).catch((err) =>
        console.error(
          "[scan-markets] ✗ incrementDailyOpportunities :",
          err instanceof Error ? err.message : err
        )
      );
    }
  }

  // 5. Notifier Discord si des opportunités ont été trouvées
  if (opportunities.length > 0) {
    console.log(
      `[scan-markets] 📣 Envoi de ${opportunities.length} opportunité(s) sur Discord`
    );
    // Ne pas await : une erreur Discord ne doit pas faire échouer la réponse HTTP
    sendDiscordNotification(
      opportunities.map((opp) => ({
        city:                  opp.city,
        outcome:               opp.outcome,
        marketPrice:           opp.marketPrice,
        estimatedProbability:  opp.estimatedProbability,
        edge:                  opp.edge,
        multiplier:            opp.multiplier,
        suggestedBet:          opp.suggestedBet,
      })),
      startedAt
    ).catch((err) =>
      console.error(
        "[scan-markets] ✗ Erreur notification Discord :",
        err instanceof Error ? err.message : err
      )
    );
  }

  // 6. Résumé
  const totalMarkets = markets.length + stockMarkets.length;
  const elapsed = Date.now() - startedAt.getTime();
  console.log(
    `[scan-markets] ■ Terminé en ${elapsed}ms — ` +
      `${markets.length} météo + ${stockMarkets.length} finance = ${totalMarkets} marchés, ` +
      `${opportunities.length} opportunités, ${paperTradesLogged} paper trades, ` +
      `${skipped.length} ignorés, ${errors.length} erreurs`
  );

  const result: ScanResult = {
    scannedAt: startedAt.toISOString(),
    total_markets: totalMarkets,
    opportunities,
    saved_to_db: savedToDb,
    paper_trades_logged: paperTradesLogged,
    skipped,
    errors,
  };

  return NextResponse.json(result);
}
