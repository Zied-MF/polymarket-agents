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
import { fetchAllWeatherMarkets } from "@/lib/polymarket/gamma-api";
import { fetchForecastForStation } from "@/lib/data-sources/weather-sources";
import { analyzeMarket } from "@/lib/agents/weather-agent";
import { sendDiscordNotification } from "@/lib/utils/discord";
import { calculateHalfKelly, BANKROLL } from "@/lib/utils/kelly";
import {
  saveOpportunity,
  getRecentOpportunities,
  incrementDailyOpportunities,
} from "@/lib/db/supabase";
import type { WeatherMarket } from "@/lib/polymarket/gamma-api";
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
}

interface SkippedMarket {
  marketId: string;
  question: string;
  reason: string;
}

interface ScanResult {
  scannedAt: string;
  total_markets: number;
  opportunities: OpportunityResult[];
  saved_to_db: number;
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
  market: WeatherMarket,
  o: Outcome,
  confidenceLevel?: "high" | "medium" | "low"
): OpportunityResult {
  const kelly = calculateHalfKelly(o.estimatedProbability, o.marketPrice, BANKROLL);

  return {
    marketId: market.id,
    question: market.question,
    city: market.city,
    stationCode: market.stationCode,
    targetDate: market.targetDate.toISOString().slice(0, 10),
    outcome: o.outcome,
    marketPrice: round(o.marketPrice, 4),
    estimatedProbability: round(o.estimatedProbability, 4),
    edge: round(o.edge, 4),
    multiplier: round(o.multiplier, 2),
    suggestedBet: kelly.betAmount,
    confidence: confidenceLevel,
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
        skipped: [],
        errors: [{ marketId: "N/A", question: "N/A", error: msg }],
      },
      { status: 502 }
    );
  }

  // 2. Analyser chaque marché
  for (const market of markets) {
    const tag = `[scan-markets][${market.stationCode}][${market.id.slice(0, 8)}]`;

    // 2a. Ignorer les marchés avec consensus fort (>90% sur un outcome)
    if (hasStrongConsensus(market)) {
      const dominant = market.outcomePrices.reduce((max, p) => Math.max(max, p), 0);
      const reason = `Consensus fort — prix dominant ${round(dominant * 100, 1)}%`;
      console.log(`${tag} ⏭ Ignoré : ${reason} — "${market.question}"`);
      skipped.push({ marketId: market.id, question: market.question, reason });
      continue;
    }

    // 2b. Récupérer la prévision météo
    let forecast;
    try {
      forecast = await fetchForecastForStation(market.stationCode, market.targetDate);
      console.log(
        `${tag} 🌡 Prévision ${market.city} le ${market.targetDate.toISOString().slice(0, 10)} : ` +
          `high=${forecast.highTemp.toFixed(1)}°C  low=${forecast.lowTemp.toFixed(1)}°C  ` +
          `confidence=${forecast.confidence}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} ✗ Erreur prévision : ${msg}`);
      errors.push({ marketId: market.id, question: market.question, error: msg });
      continue;
    }

    // 2c. Analyser avec le Weather Agent
    const marketOpportunities = analyzeMarket(market, forecast);

    if (marketOpportunities.length === 0) {
      console.log(`${tag} — Aucune opportunité (edge < 7.98%) — "${market.question}"`);
    } else {
      for (const opp of marketOpportunities) {
        const pct = (opp.edge * 100).toFixed(2);
        const result = outcomeToResult(market, opp, forecast.confidenceLevel);
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

  // 3. Trier les opportunités par edge décroissant (meilleures en premier)
  opportunities.sort((a, b) => b.edge - a.edge);

  // 4. Persister dans Supabase — avec déduplication sur market_id + outcome
  let savedToDb = 0;

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
      const saves = toSave.map((opp) =>
        saveOpportunity({
          market_id:             opp.marketId,
          question:              opp.question,
          city:                  opp.city,
          station_code:          opp.stationCode,
          outcome:               opp.outcome,
          market_price:          opp.marketPrice,
          estimated_probability: opp.estimatedProbability,
          edge:                  opp.edge,
          multiplier:            opp.multiplier,
        })
          .then(() => true as const)
          .catch((err) => {
            console.error(
              `[scan-markets] ✗ Supabase saveOpportunity (${opp.marketId}/${opp.outcome}) :`,
              err instanceof Error ? err.message : err
            );
            return false as const;
          })
      );

      const statsUpdate = incrementDailyOpportunities(toSave.length).catch((err) =>
        console.error(
          "[scan-markets] ✗ Supabase incrementDailyOpportunities :",
          err instanceof Error ? err.message : err
        )
      );

      const results = await Promise.all([...saves, statsUpdate]);
      savedToDb = (results as (boolean | void)[]).filter((r) => r === true).length;

      console.log(
        `[scan-markets] 💾 ${savedToDb}/${toSave.length} opportunité(s) sauvegardée(s) dans Supabase`
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
  const elapsed = Date.now() - startedAt.getTime();
  console.log(
    `[scan-markets] ■ Terminé en ${elapsed}ms — ` +
      `${markets.length} marchés, ${opportunities.length} opportunités, ` +
      `${skipped.length} ignorés, ${errors.length} erreurs`
  );

  const result: ScanResult = {
    scannedAt: startedAt.toISOString(),
    total_markets: markets.length,
    opportunities,
    saved_to_db: savedToDb,
    skipped,
    errors,
  };

  return NextResponse.json(result);
}
