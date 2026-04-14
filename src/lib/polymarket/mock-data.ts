/**
 * Données mock pour tests et développement local
 *
 * 5 marchés météo fictifs couvrant NYC, London, Tokyo, Paris et Sydney.
 * Activé via USE_MOCK_DATA=true dans .env.local.
 *
 * Les prix ont été calibrés pour exercer tous les chemins du Weather Agent :
 *
 *   NYC   → 1 opportunité attendue sur "65 - 69°F" (market sous-pricé)
 *   London → consensus >90% → ignoré par scan-markets
 *   Tokyo  → 1 opportunité attendue sur "17 - 19°C" (market sous-pricé)
 *   Paris  → aucune opportunité (prix proches des vraies probas)
 *   Sydney → 1 opportunité attendue sur "20 - 22°C" (market sur-pricé, edge négatif ignoré)
 *            + 1 opportunité sur "Below 20" (market sous-pricé)
 *
 * Ces prédictions supposent une prévision Open-Meteo proche de :
 *   NYC    → ~17°C (62.6°F), sigma_eff ≈ 4.5°F
 *   London → ~13°C, sigma_eff ≈ 3.1°C
 *   Tokyo  → ~19°C, sigma_eff ≈ 3.1°C
 *   Paris  → ~16°C, sigma_eff ≈ 3.1°C
 *   Sydney → ~21°C (automne), sigma_eff ≈ 3.1°C
 */

import type { WeatherMarket } from "@/lib/polymarket/gamma-api";

/** Date cible commune à tous les marchés mock : 15 avril 2026 */
const TARGET_DATE = new Date("2026-04-15T12:00:00Z");
const END_DATE = new Date("2026-04-15T23:59:00Z");

// ---------------------------------------------------------------------------
// 1. NYC — KLGA — multi-outcome — °F — high temp
//    Prix calibrés pour que "65 - 69" ait un edge ~+9%
// ---------------------------------------------------------------------------
const NYC_MARKET: WeatherMarket = {
  id: "mock-nyc-klga-20260415",
  question: "What will be the high temperature at KLGA on April 15, 2026?",
  slug: "high-temp-klga-april-15-2026",
  category: "weather",
  outcomes: ["Above 70", "65 - 69", "60 - 64", "Below 60"],
  //                          ↑ marché sous-estime cette range (~18% vs ~27% estimé)
  outcomePrices: [0.08, 0.18, 0.50, 0.24],
  volume: 18420,
  liquidity: 4200,
  endDate: END_DATE,
  stationCode: "KLGA",
  wundergroundUrl:
    "https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA/date/2026-04-15",
  unit: "F",
  measureType: "high",
  targetDate: TARGET_DATE,
  city: "New York City",
};

// ---------------------------------------------------------------------------
// 2. London — EGLC — binaire — °C — high temp
//    Prix dominant à 92% → sera ignoré (consensus fort)
// ---------------------------------------------------------------------------
const LONDON_MARKET: WeatherMarket = {
  id: "mock-london-eglc-20260415",
  question: "Will the high temperature at EGLC exceed 20°C on April 15, 2026?",
  slug: "high-temp-eglc-above-20-april-15-2026",
  category: "weather",
  outcomes: ["Yes", "No"],
  //                 ↑ 92% sur "No" → consensus fort → ignoré par scan-markets
  outcomePrices: [0.08, 0.92],
  volume: 6100,
  liquidity: 980,
  endDate: END_DATE,
  stationCode: "EGLC",
  wundergroundUrl:
    "https://www.wunderground.com/history/daily/gb/london/EGLC/date/2026-04-15",
  unit: "C",
  measureType: "high",
  targetDate: TARGET_DATE,
  city: "London",
};

// ---------------------------------------------------------------------------
// 3. Tokyo — RJTT — multi-outcome — °C — high temp
//    Prix calibrés pour que "17 - 19" ait un edge ~+11%
// ---------------------------------------------------------------------------
const TOKYO_MARKET: WeatherMarket = {
  id: "mock-tokyo-rjtt-20260415",
  question: "What will be the high temperature at RJTT on April 15, 2026?",
  slug: "high-temp-rjtt-april-15-2026",
  category: "weather",
  outcomes: ["Above 22", "20 - 22", "17 - 19", "Below 17"],
  //                                    ↑ marché sous-estime cette range (~22% vs ~38% estimé)
  outcomePrices: [0.12, 0.38, 0.22, 0.28],
  volume: 9870,
  liquidity: 2300,
  endDate: END_DATE,
  stationCode: "RJTT",
  wundergroundUrl:
    "https://www.wunderground.com/history/daily/jp/tokyo/RJTT/date/2026-04-15",
  unit: "C",
  measureType: "high",
  targetDate: TARGET_DATE,
  city: "Tokyo",
};

// ---------------------------------------------------------------------------
// 4. Paris — LFPO — binaire — °C — high temp
//    Prix proches des vraies probas → aucune opportunité attendue
// ---------------------------------------------------------------------------
const PARIS_MARKET: WeatherMarket = {
  id: "mock-paris-lfpo-20260415",
  question: "Will the high temperature at LFPO exceed 18°C on April 15, 2026?",
  slug: "high-temp-lfpo-above-18-april-15-2026",
  category: "weather",
  outcomes: ["Yes", "No"],
  //          ↑↑ prix proches de la vérité (~40%/60%) → edge < 7.98%
  outcomePrices: [0.39, 0.61],
  volume: 7340,
  liquidity: 1650,
  endDate: END_DATE,
  stationCode: "LFPO",
  wundergroundUrl:
    "https://www.wunderground.com/history/daily/fr/paris/LFPO/date/2026-04-15",
  unit: "C",
  measureType: "high",
  targetDate: TARGET_DATE,
  city: "Paris",
};

// ---------------------------------------------------------------------------
// 5. Sydney — YSSY — multi-outcome — °C — high temp (automne austral)
//    "Below 20" sous-pricé par le marché → opportunité attendue ~+10%
// ---------------------------------------------------------------------------
const SYDNEY_MARKET: WeatherMarket = {
  id: "mock-sydney-yssy-20260415",
  question: "What will be the high temperature at YSSY on April 15, 2026?",
  slug: "high-temp-yssy-april-15-2026",
  category: "weather",
  outcomes: ["Above 25", "23 - 25", "20 - 22", "Below 20"],
  //                                              ↑ automne : ~21°C prévu,
  //                                              marché sous-estime "Below 20" (8% vs ~18%)
  outcomePrices: [0.10, 0.35, 0.47, 0.08],
  volume: 5560,
  liquidity: 1100,
  endDate: END_DATE,
  stationCode: "YSSY",
  wundergroundUrl:
    "https://www.wunderground.com/history/daily/au/sydney/YSSY/date/2026-04-15",
  unit: "C",
  measureType: "high",
  targetDate: TARGET_DATE,
  city: "Sydney",
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const MOCK_WEATHER_MARKETS: WeatherMarket[] = [
  NYC_MARKET,
  LONDON_MARKET,
  TOKYO_MARKET,
  PARIS_MARKET,
  SYDNEY_MARKET,
];
