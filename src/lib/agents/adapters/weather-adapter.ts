/**
 * Weather Adapter — adaptateur AgentConfig pour le Weather Agent
 *
 * DEUX MODES :
 *
 * 1. ARBITRAGE (< 4h résolution) — stratégie principale
 *    Utilise les températures déjà observées aujourd'hui (pas de prévision).
 *    Si la temp a clairement dépassé le seuil (marge ≥ 5°C), on achète l'outcome
 *    gagnant. Win rate attendu > 80%. Pas de Claude (résultat déterministe).
 *
 * 2. FORECAST (≥ 4h résolution) — stratégie secondaire (filtre strict 35% edge)
 *    GFS + Ensemble + Multi-model (ECMWF/UKMO/GFS) + Claude validation.
 *    Edge calculé sur CLOB bestAsk. Très peu de trades passent ce filtre.
 *
 * Anti-churn : une seule position par ville/date (hasRecentTradeForCityDate).
 */

import { fetchAllWeatherMarkets, type WeatherMarket }                           from "@/lib/polymarket/gamma-api";
import { fetchForecastForStation, fetchEnsembleForecast }                        from "@/lib/data-sources/weather-sources";
import { analyzeMarket, parseOutcomeForMarket }                                  from "@/lib/agents/weather-agent";
import { getCurrentBankroll }                                                    from "@/lib/db/supabase";
import { calculateBetSize, MAX_PCT_LIQUIDITY, MIN_BET_AMOUNT }                    from "@/lib/utils/sizing";
import { getAirportStation, isUSCity }                                           from "@/lib/data/airport-stations";
import { analyzeWithClaude, type MarketContext }                                 from "@/lib/agents/claude-analyst";
import { fetchMultiModelForecast, calculateMultiModelProbability,
         type MultiModelForecast }                                               from "@/lib/data-sources/multi-model-weather";
import { TRADING_MODES, getCurrentMode, isConfidenceAtLeast }                   from "@/lib/config/trading-modes";
import { hasRecentTradeForCityDate }                                             from "@/lib/db/supabase";
import { getClobMarket, getOrderBook }                                           from "@/lib/polymarket/clob-api";
import { fetchObservedDayTemps }                                                 from "@/lib/data-sources/weather-observed";
import {
  getRecentLessons,
  getConfidenceCalibration,
  getCityPerformance,
  getOverallPerformance,
}                                                                                from "@/lib/db/lessons";
import type { AgentConfig, AnalyzeResult }                                       from "@/lib/agents/orchestrator";
import type { WeatherForecast, EnsembleForecast }                                from "@/types";

// ---------------------------------------------------------------------------
// Constantes + mode override
// ---------------------------------------------------------------------------

// Pas de filtre liquidité strict (aligné WeatherBot.finance)
const MAX_RESOLUTION_HOURS = 48;  // Ne prendre que les marchés qui expirent dans 48h max

/**
 * Mode de trading actif pour ce scan.
 * Initialisé à getCurrentMode() (env var) mais peut être overridé par
 * setWeatherAdapterMode() avant chaque scan pour lire depuis bot_state.
 */
let _activeScanMode: ReturnType<typeof getCurrentMode> = getCurrentMode();

/** Appelé depuis scan-markets avant chaque scan pour propager le mode DB. */
export function setWeatherAdapterMode(mode: ReturnType<typeof getCurrentMode>): void {
  _activeScanMode = mode;
  console.log(`[weather-adapter] Mode set: ${mode}`);
}

/**
 * Bankroll réel on-chain (pUSD) injecté par scan-markets avant chaque scan
 * en real trading mode. Remplace le bankroll paper (composé, gonflé) pour le
 * Kelly sizing. null = fallback sur bankroll paper DB.
 */
let _realBankroll: number | null = null;

/**
 * Injecte le solde pUSD on-chain avant le scan.
 * Appelé depuis scan-markets juste après getAccountBalance().
 * En paper mode, passer null pour revenir au bankroll composé DB.
 */
export function setRealBankroll(balance: number | null): void {
  _realBankroll = balance;
  if (balance !== null) {
    console.log(`[weather-adapter] Real bankroll set: $${balance.toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number, d: number): number {
  return Math.round(n * 10 ** d) / 10 ** d;
}

function estimateSpread(liquidity: number): number {
  if (liquidity >= 10_000) return 0.02;
  if (liquidity >= 2_000)  return 0.03;
  return 0.04;
}

// ---------------------------------------------------------------------------
// Arbitrage — seuils de confiance basés sur la marge temp vs seuil
// ---------------------------------------------------------------------------

/** Marge minimale (°C) entre temp observée et seuil pour trader. */
const ARB_MIN_MARGIN_C = 5.0;

/** Heure locale minimale pour valider que le max journalier est établi. */
const ARB_MIN_LOCAL_HOUR_FOR_HIGH = 15;  // 15h00 local = max généralement établi
const ARB_MIN_LOCAL_HOUR_FOR_LOW  = 8;   // 08h00 local = min overnight établi

/** Edge minimum en mode arbitrage (plus bas que forecast car proba ~0.95). */
const ARB_MIN_EDGE = 0.10;

/**
 * Analyse une opportunité d'arbitrage de résolution.
 * Retourne un AnalyzeResult si l'outcome est clair, null sinon.
 *
 * Logique :
 *   - Fetch les températures observées aujourd'hui (Open-Meteo near-real-time)
 *   - Si max_so_far > seuil + ARB_MIN_MARGIN_C → outcome YES très probable
 *   - Si max_so_far < seuil − ARB_MIN_MARGIN_C et heure > 15h → outcome NO très probable
 *   - Edge calculé sur CLOB bestAsk
 */
async function analyzeArbitrage(
  m:                  WeatherMarket,
  hoursToResolution:  number
): Promise<AnalyzeResult> {
  const tag = `[arb] ${m.city}`;

  const airportStation = getAirportStation(m.city);
  if (!airportStation) {
    return { skipReason: `${tag} Coordonnées inconnues` };
  }

  const targetDateStr = m.targetDate.toISOString().slice(0, 10);
  const observed = await fetchObservedDayTemps(airportStation.lat, airportStation.lon, targetDateStr);

  if (!observed) {
    return { skipReason: `${tag} Données observées non disponibles` };
  }

  // Déterminer quel outcome est gagnant pour chaque outcome du marché
  for (let i = 0; i < m.outcomes.length; i++) {
    const outcomeLabel = m.outcomes[i];
    const marketPrice  = m.outcomePrices[i];

    if (marketPrice < 0.01 || marketPrice > 0.99) continue;

    const parsed = parseOutcomeForMarket(m.question, outcomeLabel);
    if (!parsed || parsed.type === "unknown") continue;

    // Convertir le seuil du marché en °C (Open-Meteo retourne toujours °C)
    const toC = (v: number) => isUSCity(m.city) || m.unit === "F" ? (v - 32) * 5 / 9 : v;

    let observedRef: number;  // valeur de référence à comparer (max ou min)
    let thresholdC:  number;
    let isHighMeasure: boolean;

    if (m.measureType === "high") {
      observedRef   = observed.maxSoFar;
      isHighMeasure = true;
    } else {
      observedRef   = observed.minSoFar;
      isHighMeasure = false;
    }

    // Vérifier que l'heure locale est suffisamment avancée
    const minHour = isHighMeasure ? ARB_MIN_LOCAL_HOUR_FOR_HIGH : ARB_MIN_LOCAL_HOUR_FOR_LOW;
    if (observed.localHour < minHour) {
      console.log(`${tag} ⏭ Trop tôt (${observed.localHour}h < ${minHour}h) pour ${isHighMeasure ? "high" : "low"}`);
      return { skipReason: `${tag} Heure locale ${observed.localHour}h < ${minHour}h — max journalier pas encore établi` };
    }

    let estimatedProbability: number | null = null;
    let winnerOutcome: string | null = null;

    if (parsed.type === "above" && parsed.threshold != null) {
      thresholdC = toC(parsed.threshold);
      const margin = observedRef - thresholdC;
      if (margin >= ARB_MIN_MARGIN_C) {
        // Clearly above threshold → this outcome wins
        estimatedProbability = 0.96;
        winnerOutcome        = outcomeLabel;
        console.log(`${tag} 🎯 ABOVE WIN: obs=${observedRef.toFixed(1)}°C > seuil=${thresholdC.toFixed(1)}°C (marge=+${margin.toFixed(1)}°C)`);
      } else if (-margin >= ARB_MIN_MARGIN_C) {
        // Clearly below threshold → this outcome loses, skip (the other outcome wins)
        console.log(`${tag} ⏭ ABOVE LOSS: obs=${observedRef.toFixed(1)}°C << seuil=${thresholdC.toFixed(1)}°C (marge=${margin.toFixed(1)}°C)`);
        continue;
      } else {
        console.log(`${tag} ⏭ Marge insuffisante: obs=${observedRef.toFixed(1)}°C vs seuil=${thresholdC.toFixed(1)}°C (marge=${margin.toFixed(1)}°C < ${ARB_MIN_MARGIN_C}°C)`);
        return { skipReason: `Marge ${margin.toFixed(1)}°C insuffisante (< ${ARB_MIN_MARGIN_C}°C)` };
      }
    } else if (parsed.type === "below" && parsed.threshold != null) {
      thresholdC = toC(parsed.threshold);
      const margin = thresholdC - observedRef;
      if (margin >= ARB_MIN_MARGIN_C) {
        estimatedProbability = 0.96;
        winnerOutcome        = outcomeLabel;
        console.log(`${tag} 🎯 BELOW WIN: obs=${observedRef.toFixed(1)}°C < seuil=${thresholdC.toFixed(1)}°C (marge=+${margin.toFixed(1)}°C)`);
      } else if (-margin >= ARB_MIN_MARGIN_C) {
        console.log(`${tag} ⏭ BELOW LOSS: obs=${observedRef.toFixed(1)}°C >> seuil=${thresholdC.toFixed(1)}°C`);
        continue;
      } else {
        console.log(`${tag} ⏭ Marge insuffisante BELOW: ${margin.toFixed(1)}°C < ${ARB_MIN_MARGIN_C}°C`);
        return { skipReason: `Marge below ${margin.toFixed(1)}°C insuffisante` };
      }
    } else {
      // range / exact / unknown — trop complexe pour l'arbitrage
      continue;
    }

    if (estimatedProbability === null || winnerOutcome === null) continue;

    // Anti-churn
    try {
      const alreadyOpen = await hasRecentTradeForCityDate(m.city, targetDateStr);
      if (alreadyOpen) {
        return { skipReason: `Anti-churn: position déjà ouverte pour ${m.city} le ${targetDateStr}` };
      }
    } catch { /* non-bloquant */ }

    // CLOB bestAsk — vrai prix d'achat
    let realBuyPrice = marketPrice;
    let clobTokenId: string | null = null;
    if (m.id.startsWith("0x")) {
      try {
        const clobMkt = await getClobMarket(m.id);
        const clobTok = clobMkt?.tokens.find(
          (t) => t.outcome.toLowerCase() === winnerOutcome!.toLowerCase()
        );
        if (clobTok) {
          clobTokenId = clobTok.tokenId;
          const book  = await getOrderBook(clobTok.tokenId);
          if (book.bestAsk !== null) {
            realBuyPrice = book.bestAsk;
            console.log(`${tag} 📒 CLOB bestAsk=${book.bestAsk.toFixed(3)} (Gamma mid=${marketPrice.toFixed(3)})`);
          }
        }
      } catch (err) {
        console.warn(`${tag} ⚠️ CLOB fetch échoué:`, err instanceof Error ? err.message : err);
      }
    }

    const edge    = round(estimatedProbability - realBuyPrice, 4);
    const spread  = estimateSpread(m.liquidity);
    const edgeNet = round(edge - spread, 4);

    console.log(`${tag} edge ARBITRAGE: gross=${(edge * 100).toFixed(1)}% net=${(edgeNet * 100).toFixed(1)}% buy@${(realBuyPrice * 100).toFixed(0)}¢`);

    if (edgeNet < ARB_MIN_EDGE) {
      return { skipReason: `Arbitrage edge net ${(edgeNet * 100).toFixed(1)}% < ${(ARB_MIN_EDGE * 100).toFixed(0)}% (marché déjà pricé, buy@${(realBuyPrice * 100).toFixed(0)}¢)` };
    }

    // Sizing
    const currentModeName = _activeScanMode;
    const mode            = TRADING_MODES[currentModeName];
    const paperBankroll   = await getCurrentBankroll();
    const bankroll        = _realBankroll ?? paperBankroll;
    const inRealMode      = _realBankroll !== null;
    const sizePercent     = (5 / 10) * mode.maxBetPercent; // taille fixe 5/10 pour arbitrage
    const kellyBet        = bankroll * sizePercent;
    const adjustedBet     = calculateBetSize(kellyBet, m.liquidity, bankroll, mode.maxBetPercent);

    if (adjustedBet < MIN_BET_AMOUNT) {
      return { skipReason: `Bet trop petit: $${adjustedBet.toFixed(2)} < min $${MIN_BET_AMOUNT}` };
    }

    console.log(
      `${tag} ✅ ARBITRAGE TRADE: ${winnerOutcome} @${(realBuyPrice * 100).toFixed(0)}¢ ` +
      `prob=${(estimatedProbability * 100).toFixed(0)}% edge=${(edgeNet * 100).toFixed(1)}% ` +
      `bet=$${adjustedBet.toFixed(2)} (${hoursToResolution.toFixed(1)}h to resolution)`
    );

    let paperSuggestedBet: number | undefined;
    if (inRealMode && paperBankroll > bankroll) {
      const paperAdjusted = calculateBetSize(paperBankroll * sizePercent, m.liquidity, paperBankroll, mode.maxBetPercent);
      if (paperAdjusted >= MIN_BET_AMOUNT) paperSuggestedBet = Math.round(paperAdjusted * 100) / 100;
    }

    return {
      dominated: {
        marketId:             m.id,
        question:             m.question,
        outcome:              winnerOutcome,
        marketPrice:          round(realBuyPrice, 4),
        estimatedProbability: estimatedProbability,
        edge:                 round(edgeNet, 4),
        suggestedBet:         Math.round(adjustedBet * 100) / 100,
        paperSuggestedBet,
        confidence:           "high",
        agent:                "weather",
        city:                 m.city,
        targetDate:           targetDateStr,
        targetDateTime:       m.targetDate.toISOString(),
        marketContext: {
          liquidity:          m.liquidity,
          spread_estimate:    round(spread, 4),
          edge_net:           round(edgeNet, 4),
          gamma_mid_price:    round(marketPrice, 4),
          clob_best_ask:      round(realBuyPrice, 4),
          clob_token_id:      clobTokenId,
          all_outcomes:       m.outcomes,
          all_prices:         m.outcomePrices,
          station_code:       m.stationCode,
          measure_type:       m.measureType,
          unit:               m.unit,
          timestamp:          new Date().toISOString(),
          arbitrage_mode:     true,
          observed_max:       observed.maxSoFar,
          observed_min:       observed.minSoFar,
          observed_local_hour: observed.localHour,
          data_source: {
            provider:      "open-meteo-observed",
            high_temp:     observed.maxSoFar,
            low_temp:      observed.minSoFar,
            confidence:    "high",
            dynamic_sigma: null,
          },
        },
      },
    };
  }

  return { skipReason: `${tag} Aucun outcome clairement gagnant (marge insuffisante ou type non supporté)` };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const weatherAdapter: AgentConfig = {
  name: "Weather Agent",
  type: "weather",

  async fetchMarkets(): Promise<WeatherMarket[]> {
    const markets = await fetchAllWeatherMarkets();

    const filtered = markets.filter((m) => {
      // Filtre consensus fort uniquement (pas de filtre liquidité — WeatherBot.finance)
      if (m.outcomePrices.some((p) => p >= 0.9)) {
        const dominant = Math.max(...m.outcomePrices);
        console.log(`[weather-adapter] ⏭ Consensus fort (${round(dominant * 100, 1)}%) — "${m.question.slice(0, 60)}"`);
        return false;
      }
      return true;
    });

    // Trier par horizon de résolution — les plus proches en premier (forecast plus fiable)
    const now = Date.now();
    filtered.sort((a, b) =>
      (a.endDate.getTime() - now) - (b.endDate.getTime() - now)
    );

    console.log(`[weather-adapter] ${filtered.length}/${markets.length} marchés après filtre consensus (triés par horizon)`);
    return filtered;
  },

  async fetchData(market: unknown): Promise<{ forecast: WeatherForecast | null; ensemble: EnsembleForecast | null; multiModel: MultiModelForecast | null }> {
    const m              = market as WeatherMarket;
    const targetDateStr  = m.targetDate.toISOString().slice(0, 10);
    const airportStation = getAirportStation(m.city);

    const [forecast, ensemble, multiModel] = await Promise.all([
      fetchForecastForStation(m.stationCode, m.targetDate),
      airportStation
        ? fetchEnsembleForecast(airportStation.lat, airportStation.lon, targetDateStr)
        : Promise.resolve(null),
      airportStation
        ? fetchMultiModelForecast(airportStation.lat, airportStation.lon, targetDateStr)
            .catch((err) => {
              console.warn(`[weather-adapter] ⚠️ Multi-model fetch failed for ${m.city}: ${err instanceof Error ? err.message : err}`);
              return null;
            })
        : Promise.resolve(null),
    ]);

    if (ensemble) {
      console.log(`[weather-adapter] ✈️ Ensemble ${m.city} (${airportStation!.icao}): mean=${ensemble.mean}°C spread=${ensemble.spread}°C`);
    } else {
      console.log(`[weather-adapter] ⚠️ Pas d'ensemble pour ${m.city} — fallback gaussienne`);
    }

    if (multiModel) {
      console.log(
        `[weather-adapter] 🌐 Multi-model ${m.city}: ` +
        `consensus=${multiModel.consensus.temperature}°C ` +
        `agreement=${multiModel.consensus.agreement} ` +
        `(${multiModel.models.filter((mm) => mm.available).length}/4 models)`
      );
    }

    return { forecast, ensemble, multiModel };
  },

  async analyze(market: unknown, data: unknown): Promise<AnalyzeResult | null> {
    const m = market as WeatherMarket;
    const { forecast, ensemble, multiModel } = data as {
      forecast:   WeatherForecast   | null;
      ensemble:   EnsembleForecast  | null;
      multiModel: MultiModelForecast | null;
    };

    // Filtre horizon : ne pas bloquer les slots avec des trades longs
    if (isNaN(m.endDate.getTime())) {
      console.log(`[weather-adapter] ⚠️ Date invalide pour ${m.id}, skip`);
      return { skipReason: "Date de résolution invalide" };
    }
    const hoursToResolution = (m.endDate.getTime() - Date.now()) / (1000 * 60 * 60);
    console.log(`[weather-adapter] ${m.city}: ${hoursToResolution.toFixed(1)}h to resolution`);

    if (hoursToResolution < 1) {
      console.log(`[weather-adapter] ⏭ Résolution trop proche: ${Math.round(hoursToResolution * 60)}min — ${m.city}`);
      return { skipReason: "Too close to resolution (< 1h)" };
    }

    // ── MODE ARBITRAGE (< 4h résolution) ────────────────────────────────────
    // Stratégie principale : températures déjà observées → outcome déterministe.
    // Pas de prévision, pas de Claude. Win rate attendu > 80%.
    if (hoursToResolution <= 4) {
      console.log(`[weather-adapter] 🔍 MODE ARBITRAGE: ${m.city} (${hoursToResolution.toFixed(1)}h to resolution)`);
      return analyzeArbitrage(m, hoursToResolution);
    }

    // Mode-dependent horizon cap
    const currentModeName = _activeScanMode;
    if (currentModeName === "balanced" && hoursToResolution > 24) {
      console.log(`[weather-adapter] ⏭ ${m.city}: ${hoursToResolution.toFixed(1)}h > 24h (balanced prefers same-day)`);
      return { skipReason: `Resolution > 24h (balanced mode prefers same-day)` };
    }
    if (hoursToResolution > MAX_RESOLUTION_HOURS) {
      console.log(`[weather-adapter] ⏭ Résolution trop lointaine: ${Math.round(hoursToResolution)}h > ${MAX_RESOLUTION_HOURS}h — ${m.city}`);
      return { skipReason: `Resolution > ${MAX_RESOLUTION_HOURS}h (forecast unreliable)` };
    }

    if (!forecast) {
      return { skipReason: `Station inconnue : ${m.stationCode}` };
    }

    // Filtre anti-favori : si un outcome dépasse 70%, le marché est trop consensuel
    if (m.outcomePrices.some((p) => p > 0.70)) {
      const dominant = Math.max(...m.outcomePrices);
      console.log(`[weather-adapter] ⏭ Anti-favori (${(dominant * 100).toFixed(0)}% > 70%) — "${m.question.slice(0, 60)}"`);
      return { skipReason: `Prix dominant ${(dominant * 100).toFixed(0)}% > 70% (favori évident)` };
    }

    // Filtre accord des modèles : si weak → trop incertain, skip
    if (multiModel && multiModel.consensus.agreement === "weak") {
      console.log(
        `[weather-adapter] ⏭ Désaccord des modèles trop élevé : ` +
        `spread=${multiModel.consensus.spreadDegrees}°C (σ=${multiModel.consensus.stdDev}°C) — ${m.city}`
      );
      return { skipReason: `Modèles en désaccord (spread=${multiModel.consensus.spreadDegrees}°C > 2°C σ)` };
    }

    const outcomes = analyzeMarket(m, forecast, ensemble ?? undefined);
    if (outcomes.length === 0) {
      return { skipReason: "Aucun edge suffisant (filtres gaussien/ensemble)" };
    }

    const best = outcomes[0];

    // Amélioration multi-modèle : recalculer la probabilité avec le consensus pondéré
    // (ECMWF×0.4 + GFS×0.3 + UKMO×0.2 + Ensemble×0.1) si disponible et agreement = strong/moderate.
    if (multiModel) {
      const parsed = parseOutcomeForMarket(m.question, best.outcome);
      if (parsed && parsed.type !== "unknown") {
        // Convertir les seuils vers °C (multi-model travaille toujours en °C)
        const toC = (v: number) => isUSCity(m.city) || m.unit === "F" ? (v - 32) * 5 / 9 : v;

        let thresholdC: number;
        let rangeMaxC:  number | undefined;

        if (parsed.type === "above" || parsed.type === "below") {
          thresholdC = toC(parsed.threshold!);
        } else if (parsed.type === "range") {
          thresholdC = toC(parsed.lo ?? parsed.target! - 1);
          rangeMaxC  = toC(parsed.hi ?? parsed.target! + 1);
        } else {
          thresholdC = toC(parsed.target!);
        }

        const probResult = calculateMultiModelProbability(
          multiModel,
          thresholdC,
          parsed.type as "exact" | "above" | "below" | "range",
          rangeMaxC
        );

        const multiProb = probResult.probability;
        const multiEdge = multiProb - best.marketPrice;

        // N'overrider que si l'écart est > 2% (évite le bruit)
        if (Math.abs(multiProb - best.estimatedProbability) > 0.02) {
          console.log(
            `[weather-adapter] 🌐 Multi-model override: ` +
            `gaussienne=${(best.estimatedProbability * 100).toFixed(1)}% → ` +
            `multi-model=${(multiProb * 100).toFixed(1)}% ` +
            `(method=${probResult.method}, agreement=${probResult.confidence})`
          );
          best.estimatedProbability = multiProb;
          best.edge                 = multiEdge;
        }
      }
    }

    // Bonus edge pour les marchés proches de résolution (forecast plus fiable)
    let edgeMultiplier = 1.0;
    if (hoursToResolution <= 6)       edgeMultiplier = 1.2;   // +20 % confiance
    else if (hoursToResolution <= 12) edgeMultiplier = 1.1;   // +10 % confiance
    if (edgeMultiplier > 1.0) {
      const rawEdge = best.edge;
      best.edge               = round(best.edge * edgeMultiplier, 4);
      best.estimatedProbability = round(best.marketPrice + best.edge, 4);
      console.log(
        `[weather-adapter] ⏰ Edge bonus ×${edgeMultiplier} (${hoursToResolution.toFixed(1)}h): ` +
        `${(rawEdge * 100).toFixed(1)}% → ${(best.edge * 100).toFixed(1)}%`
      );
    }

    // === TRADING MODE (WeatherBot.finance alignement) ===
    const mode    = TRADING_MODES[currentModeName];
    const yesPrice = m.outcomePrices[0];

    // Anti-churn : une seule position par ville/date
    const targetDateStr  = m.targetDate.toISOString().slice(0, 10);
    try {
      const alreadyOpen = await hasRecentTradeForCityDate(m.city, targetDateStr);
      if (alreadyOpen) {
        console.log(`[weather-adapter] ⏭ Anti-churn: position déjà ouverte pour ${m.city} le ${targetDateStr}`);
        return { skipReason: `Already have position for ${m.city} on ${targetDateStr}` };
      }
    } catch (err) {
      console.warn(`[weather-adapter] hasRecentTradeForCityDate échoué (non-bloquant):`, err instanceof Error ? err.message : err);
    }

    // ── scan-debug : marché qui passe tous les filtres de base ──────────────
    const noPrice       = 1 - yesPrice;
    const spreadEstimate = estimateSpread(m.liquidity);
    const edgeNet        = best.edge - spreadEstimate;
    const debugPrefix    = `[scan-debug] ${m.city}`;
    console.log(
      `${debugPrefix}: edge=${(best.edge * 100).toFixed(1)}% net=${(edgeNet * 100).toFixed(1)}%` +
      ` yesPrice=${(yesPrice * 100).toFixed(0)}¢ noPrice=${(noPrice * 100).toFixed(0)}¢` +
      ` outcome=${best.outcome} prob=${(best.estimatedProbability * 100).toFixed(1)}%` +
      ` liq=$${m.liquidity} ${hoursToResolution.toFixed(1)}h`
    );
    // Filtre YES price (mode-based)
    if (best.outcome === "Yes" && best.marketPrice > mode.yesMaxPrice) {
      const reason = `YES ${(best.marketPrice * 100).toFixed(0)}¢ > ${(mode.yesMaxPrice * 100).toFixed(0)}¢ (mode: ${mode.name})`;
      console.log(`${debugPrefix}: SKIP: ${reason}`);
      return { skipReason: reason };
    }

    // Filtre NO price (mode-based)
    if (best.outcome === "No" && yesPrice < mode.noMinYesPrice) {
      const reason = `NO not worth: YES only ${(yesPrice * 100).toFixed(0)}¢ < ${(mode.noMinYesPrice * 100).toFixed(0)}¢`;
      console.log(`${debugPrefix}: SKIP: ${reason}`);
      return { skipReason: reason };
    }

    // Filet de sécurité : prix max 70¢ pour tout outcome
    if (best.marketPrice > 0.70) {
      const reason = `Price ${(best.marketPrice * 100).toFixed(0)}¢ > 70¢ (favori évident)`;
      console.log(`${debugPrefix}: SKIP: ${reason}`);
      return { skipReason: reason };
    }

    // === CLOB bestAsk — prix réel d'achat (remplace le mid-price Gamma pour l'edge) ===
    // Le bestAsk CLOB est ce qu'on paie réellement. Gamma mid-price est ~2× trop bas.
    let realBuyPrice = best.marketPrice;  // fallback mid-price Gamma
    let realSpread   = spreadEstimate;    // fallback spread estimé
    let clobTokenId: string | null = null;
    if (m.id.startsWith("0x")) {
      try {
        const clobMkt = await getClobMarket(m.id);
        const clobTok = clobMkt?.tokens.find(
          (t) => t.outcome.toLowerCase() === best.outcome.toLowerCase()
        );
        if (clobTok) {
          clobTokenId = clobTok.tokenId;
          const book = await getOrderBook(clobTok.tokenId);
          if (book.bestAsk !== null) {
            realBuyPrice = book.bestAsk;
            if (book.spread !== null) realSpread = book.spread;
            console.log(
              `${debugPrefix}: 📒 CLOB bestAsk=${book.bestAsk.toFixed(3)} ` +
              `bid=${book.bestBid?.toFixed(3) ?? "N/A"} spread=${book.spread?.toFixed(3) ?? "N/A"} ` +
              `(Gamma mid=${best.marketPrice.toFixed(3)})`
            );
          } else {
            console.warn(`${debugPrefix}: ⚠️ CLOB orderbook vide (pas d'ask), fallback Gamma mid`);
          }
        }
      } catch (err) {
        console.warn(`${debugPrefix}: ⚠️ CLOB orderbook échoué, fallback Gamma mid: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Edge calculé sur le vrai prix d'achat CLOB (bestAsk)
    const realEdge    = round(best.estimatedProbability - realBuyPrice, 4);
    const realEdgeNet = round(realEdge - realSpread, 4);
    console.log(
      `${debugPrefix}: edge CLOB: gross=${(realEdge * 100).toFixed(1)}% net=${(realEdgeNet * 100).toFixed(1)}%` +
      ` (buy@${(realBuyPrice * 100).toFixed(0)}¢, prob=${(best.estimatedProbability * 100).toFixed(1)}%)`
    );

    // Forte conviction sur YES cheap (< 20¢, forecast > 70%) → STRONG BUY
    let confidenceOverride: "high" | "medium" | "low" | undefined = forecast.confidenceLevel;
    if (best.outcome === "Yes" && realBuyPrice < 0.20 && best.estimatedProbability > 0.70) {
      console.log(
        `${debugPrefix}: 🎯 STRONG BUY: YES à ${(realBuyPrice * 100).toFixed(0)}¢ ` +
        `avec forecast ${(best.estimatedProbability * 100).toFixed(0)}%`
      );
      confidenceOverride = "high";
    }

    // Filtre edge avec prix CLOB réel (mode-based)
    if (realEdgeNet < mode.minEdge) {
      const reason = `Edge CLOB net ${(realEdgeNet * 100).toFixed(1)}% < ${(mode.minEdge * 100).toFixed(0)}% (mode: ${mode.name})`;
      console.log(`${debugPrefix}: SKIP: ${reason} (gross=${(realEdge * 100).toFixed(1)}% buy@${(realBuyPrice * 100).toFixed(0)}¢)`);
      return { skipReason: reason };
    }

    // === CLAUDE AI — validation finale ===
    // Appelé uniquement sur les trades qui ont passé tous les filtres mécaniques.
    const forecastTemp = m.measureType === "high" ? forecast.highTemp : forecast.lowTemp;
    const [lessons, calibration, cityPerf, overallPerf] = await Promise.all([
      getRecentLessons(20),
      getConfidenceCalibration(),
      getCityPerformance(m.city),
      getOverallPerformance(),
    ]);

    // Préparer les données multi-modèle pour Claude (si disponibles)
    let multiModelCtx: MarketContext["multiModel"] | undefined;
    if (multiModel) {
      const parsed = parseOutcomeForMarket(m.question, best.outcome);
      let multiProb = best.estimatedProbability; // déjà overridé si écart > 2%
      let method    = "gaussian_consensus";

      if (parsed && parsed.type !== "unknown") {
        const toC = (v: number) => isUSCity(m.city) || m.unit === "F" ? (v - 32) * 5 / 9 : v;
        let thresholdC: number;
        let rangeMaxC:  number | undefined;

        if (parsed.type === "above" || parsed.type === "below") {
          thresholdC = toC(parsed.threshold!);
        } else if (parsed.type === "range") {
          thresholdC = toC(parsed.lo ?? parsed.target! - 1);
          rangeMaxC  = toC(parsed.hi ?? parsed.target! + 1);
        } else {
          thresholdC = toC(parsed.target!);
        }

        const pr = calculateMultiModelProbability(
          multiModel, thresholdC,
          parsed.type as "exact" | "above" | "below" | "range",
          rangeMaxC
        );
        multiProb = pr.probability;
        method    = pr.method;
      }

      const gfsModel   = multiModel.models.find((mm) => mm.model === "gfs");
      const ecmwfModel = multiModel.models.find((mm) => mm.model === "ecmwf");
      const ukmoModel  = multiModel.models.find((mm) => mm.model === "ukmo");

      multiModelCtx = {
        consensus:     multiModel.consensus.temperature,
        agreement:     multiModel.consensus.agreement,
        spreadDegrees: multiModel.consensus.spreadDegrees,
        gfs:           gfsModel?.available   ? gfsModel.temperature   : undefined,
        ecmwf:         ecmwfModel?.available ? ecmwfModel.temperature : undefined,
        ukmo:          ukmoModel?.available  ? ukmoModel.temperature  : undefined,
        method,
        probability:   multiProb,
      };
    }

    const context: MarketContext = {
      question:   m.question,
      city:       m.city,
      targetDate: m.targetDate.toISOString().slice(0, 10),
      outcomes:   m.outcomes,
      prices:     m.outcomePrices,
      forecasts: {
        gfs:      forecastTemp,
        ensemble: ensemble
          ? {
              mean:    ensemble.mean,
              min:     Math.min(...ensemble.membersMax),
              max:     Math.max(...ensemble.membersMax),
              stdDev:  ensemble.stdDev,
              members: ensemble.membersMax,
            }
          : { mean: forecastTemp, min: forecastTemp, max: forecastTemp, stdDev: 0, members: [] },
      },
      multiModel: multiModelCtx,
      gaussianEdge: best.edge,
      measureType:  m.measureType,
      recentPerformance: {
        cityWinRate:    cityPerf.winRate,
        overallWinRate: overallPerf.winRate,
        last7DaysPnL:   overallPerf.pnl7d,
      },
      lessons:               lessons.map((l) => l.lesson),
      confidenceCalibration: calibration,
    };

    const claudeAnalysis = await analyzeWithClaude(context);

    if (claudeAnalysis.decision === "SKIP") {
      const reason = `Claude SKIP: ${claudeAnalysis.reason}`;
      console.log(`[scan-debug] ${m.city}: SKIP: ${reason} (edge=${(edgeNet * 100).toFixed(1)}%, price=${(best.marketPrice * 100).toFixed(0)}¢)`);
      return { skipReason: reason };
    }

    // Filtre confiance Claude (mode-based)
    if (!isConfidenceAtLeast(claudeAnalysis.confidence, mode.minConfidence)) {
      const reason = `Confidence ${claudeAnalysis.confidence} < ${mode.minConfidence} (mode: ${mode.name})`;
      console.log(`[scan-debug] ${m.city}: SKIP: ${reason} (edge=${(edgeNet * 100).toFixed(1)}%, price=${(best.marketPrice * 100).toFixed(0)}¢)`);
      return { skipReason: reason };
    }

    // Kelly sizing dynamique (mode-based) — Claude size 1-10 → % du bankroll
    // En real mode : utilise le solde pUSD on-chain (_realBankroll, injecté par
    // scan-markets) pour éviter d'utiliser le bankroll paper gonflé (~$230) qui
    // produirait des bets trop grands. En paper mode : bankroll composé DB normal.
    const paperBankroll = await getCurrentBankroll();
    const bankroll      = _realBankroll ?? paperBankroll;
    const inRealMode    = _realBankroll !== null;
    const claudeSize    = claudeAnalysis.size ?? 5;
    const sizePercent   = (claudeSize / 10) * mode.maxBetPercent;
    const kellyBet      = bankroll * sizePercent;

    // ── Étape 1 : cap Gamma (market.liquidity × 5%) ─────────────────────────
    const maxByGammaLiq = m.liquidity * MAX_PCT_LIQUIDITY;
    let   adjustedBet   = calculateBetSize(kellyBet, m.liquidity, bankroll, mode.maxBetPercent);

    // Liquidity Gamma trop basse pour le minimum Polymarket — skip
    if (adjustedBet === 0) {
      const reason = `Liquidity $${m.liquidity} too low (${(MAX_PCT_LIQUIDITY * 100).toFixed(0)}% = $${maxByGammaLiq.toFixed(2)} < min $${MIN_BET_AMOUNT})`;
      console.log(`[weather-adapter] ⏭️ Skip ${m.city}: ${reason}`);
      return { skipReason: reason };
    }

    // ── Bet paper (comparaison) — calculé sur le bankroll paper DB ──────────
    // Seulement en real mode : permet de créer un trade de comparaison paper
    // avec la même stratégie mais sizé sur le bankroll composé, pour valider
    // la stratégie en parallèle du real trading.
    let paperSuggestedBet: number | undefined;
    if (inRealMode && paperBankroll > bankroll) {
      const paperKellyBet  = paperBankroll * sizePercent;
      const paperAdjusted  = calculateBetSize(paperKellyBet, m.liquidity, paperBankroll, mode.maxBetPercent);
      if (paperAdjusted >= MIN_BET_AMOUNT) {
        paperSuggestedBet = Math.round(paperAdjusted * 100) / 100;
      }
    }

    const targetOutcome = claudeAnalysis.outcome ?? best.outcome;

    // Log si bet réduit par Gamma
    if (adjustedBet < kellyBet && adjustedBet < bankroll * mode.maxBetPercent) {
      console.log(
        `[weather-adapter] ⚠️ Bet réduit par liquidité Gamma: $${kellyBet.toFixed(2)} → $${adjustedBet.toFixed(2)} ` +
        `(${(MAX_PCT_LIQUIDITY * 100).toFixed(0)}% de $${m.liquidity})`
      );
    }

    console.log(
      `[weather-adapter] 💰 Sizing: bankroll=$${bankroll.toFixed(2)}${inRealMode ? "(real)" : "(paper)"} ` +
      `Claude=${claudeSize}/10 Kelly=$${kellyBet.toFixed(2)} ` +
      `Gamma=$${m.liquidity} (${(MAX_PCT_LIQUIDITY * 100).toFixed(0)}%=$${maxByGammaLiq.toFixed(2)}) ` +
      `→ Real=$${adjustedBet.toFixed(2)}${paperSuggestedBet ? ` Paper=$${paperSuggestedBet.toFixed(2)}(paper-bankroll=$${paperBankroll.toFixed(2)})` : ""} ` +
      `(mode: ${mode.name})`
    );

    // Confiance : VERY_HIGH → high, HIGH → high, MEDIUM → medium, LOW → low
    const claudeConfidence = claudeAnalysis.confidence === "VERY_HIGH" || claudeAnalysis.confidence === "HIGH"
      ? "high"
      : claudeAnalysis.confidence === "MEDIUM"
        ? "medium"
        : "low";
    confidenceOverride = claudeConfidence;

    // Probabilité estimée : préférer l'edge de Claude si fourni (calculé sur realBuyPrice)
    const finalEdge  = claudeAnalysis.edgeEstimate ?? realEdge;
    const finalProb  = round(realBuyPrice + finalEdge, 4);

    return {
      dominated: {
        marketId:             m.id,
        question:             m.question,
        outcome:              targetOutcome,
        marketPrice:          round(realBuyPrice, 4),   // prix CLOB bestAsk (vrai prix d'achat)
        estimatedProbability: Math.min(0.99, Math.max(0.01, finalProb)),
        edge:                 round(finalEdge, 4),
        suggestedBet:         Math.round(adjustedBet * 100) / 100,
        paperSuggestedBet,
        confidence:           confidenceOverride,
        agent:                "weather",
        city:                 m.city,
        targetDate:           m.targetDate.toISOString().slice(0, 10),
        targetDateTime:       m.targetDate.toISOString(),
        marketContext: {
          liquidity:        m.liquidity,
          spread_estimate:  round(realSpread, 4),       // spread CLOB réel (ou estimé si fallback)
          edge_net:         round(realEdgeNet, 4),      // edge net CLOB
          gamma_mid_price:  round(best.marketPrice, 4), // mid-price Gamma (archivé pour référence)
          clob_best_ask:    round(realBuyPrice, 4),     // vrai prix d'achat CLOB
          clob_token_id:    clobTokenId,                // tokenId pour getOrderBook/executeBuy
          all_outcomes:     m.outcomes,
          all_prices:       m.outcomePrices,
          station_code:     m.stationCode,
          measure_type:     m.measureType,
          unit:             m.unit,
          timestamp:        new Date().toISOString(),
          data_source: {
            provider:      "open-meteo",
            high_temp:     forecast.highTemp,
            low_temp:      forecast.lowTemp,
            confidence:    forecast.confidence,
            dynamic_sigma: forecast.dynamicSigma ?? null,
          },
          multi_model: multiModelCtx
            ? {
                consensus:     multiModelCtx.consensus,
                agreement:     multiModelCtx.agreement,
                spread:        multiModelCtx.spreadDegrees,
                gfs:           multiModelCtx.gfs    ?? null,
                ecmwf:         multiModelCtx.ecmwf  ?? null,
                ukmo:          multiModelCtx.ukmo   ?? null,
                probability:   multiModelCtx.probability,
                method:        multiModelCtx.method,
              }
            : null,
          claude: {
            reason:               claudeAnalysis.reason,
            risks:                claudeAnalysis.risks,
            meteorologicalNotes:  claudeAnalysis.meteorologicalNotes,
            size:                 claudeAnalysis.size,
            edgeEstimate:         claudeAnalysis.edgeEstimate ?? null,
          },
        },
      },
    };
  },
};
