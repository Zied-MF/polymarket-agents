/**
 * Types TypeScript partagés
 *
 * Centralise toutes les interfaces et types utilisés à travers le système.
 * Importer depuis "@/types" dans tous les modules qui en ont besoin.
 */

/** Représentation d'un marché Polymarket tel que retourné par l'API Gamma. */
export interface Market {
  id: string;
  question: string;
  slug: string;
  category: string;
  /** Liste des outcomes possibles, ex: ["Yes", "No"] ou options multiples. */
  outcomes: string[];
  /** Prix de marché (probabilité implicite) pour chaque outcome, dans le même
   *  ordre que `outcomes`. Valeurs entre 0 et 1. */
  outcomePrices: number[];
  /** Volume total échangé sur ce marché (en USDC). */
  volume: number;
  /** Liquidité disponible dans le carnet d'ordres (en USDC). */
  liquidity: number;
  /** Date de résolution du marché. */
  endDate: Date;
}

/** Outcome analysé par un agent : contient le prix de marché, la probabilité
 *  estimée par l'agent, et les métriques de valeur attendue. */
export interface Outcome {
  market: Market;
  /** Libellé de l'outcome ciblé, ex: "Yes" ou "No". */
  outcome: string;
  /** Probabilité implicite du marché (issue de `outcomePrices`). */
  marketPrice: number;
  /** Probabilité estimée par l'agent à partir de ses sources de données. */
  estimatedProbability: number;
  /** Edge = estimatedProbability - marketPrice. Positif = valeur identifiée. */
  edge: number;
  /** Multiplicateur de gain potentiel = 1 / marketPrice. */
  multiplier: number;
  /** Agent ayant produit cet outcome. */
  agent?: "weather" | "finance" | "crypto";
}

/** Recommandation de pari émise par un agent spécialisé. */
export interface BetRecommendation {
  outcome: Outcome;
  /** Niveau de confiance de l'agent dans sa recommandation. */
  confidence: "high" | "medium" | "low";
  /** Montant suggéré à miser (en USDC), calculé via Kelly Criterion. */
  suggestedAmount: number;
  /** Explication en langage naturel du raisonnement derrière la recommandation. */
  reasoning: string;
  /** Identifiant de l'agent ayant émis la recommandation, ex: "weather-agent". */
  agent: string;
}

/** Températures prévues par chaque modèle météo (°C). */
export interface ModelTemps {
  gfs?: number;
  ecmwf?: number;
  icon?: number;
}

/** Prévision météo normalisée, indépendante de la source de données. */
export interface WeatherForecast {
  city: string;
  country: string;
  /** Température maximale prévue — moyenne des modèles disponibles (°C). */
  highTemp: number;
  /** Température minimale prévue — moyenne des modèles disponibles (°C). */
  lowTemp: number;
  /** Confiance numérique [0, 1] basée sur le délai de prévision. */
  confidence: number;
  /** Accord des modèles : "high" < 1°C, "medium" 1–3°C, "low" > 3°C. */
  confidenceLevel: "high" | "medium" | "low";
  /** Sigma dynamique en °C, combinant écart des modèles et délai temporel. */
  dynamicSigma: number;
  /** Écart maximal entre les modèles pour highTemp (°C). */
  modelSpread: number;
  /** Températures max de chaque modèle (°C), pour traçabilité. */
  modelHighTemps: ModelTemps;
  /** Fournisseur de données utilisé. */
  source: string;
  /** Horodatage de la récupération des données. */
  fetchedAt: Date;
}

/** Résultat complet de l'analyse d'un agent pour un marché donné. */
export interface AgentAnalysis {
  /** Identifiant de l'agent, ex: "weather-agent", "finance-agent". */
  agent: string;
  market: Market;
  /** Liste des recommandations de pari émises, triées par edge décroissant. */
  recommendations: BetRecommendation[];
  /** Horodatage de l'analyse. */
  timestamp: Date;
}
