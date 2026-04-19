/**
 * Multi-Model Weather Forecasting
 *
 * 4 modèles indépendants avec pondération basée sur leur précision historique :
 *   GFS (NOAA)    — modèle américain, 16 jours, fort sur l'Amérique du Nord
 *   ECMWF         — modèle européen, le plus précis globalement (poids max)
 *   UKMO          — modèle britannique, fort sur l'Europe
 *   GFS Ensemble  — 31 membres, donne la distribution de probabilités
 *
 * Tous fournis GRATUITEMENT par Open-Meteo.
 *
 * La probabilité finale utilise en priorité les membres d'ensemble (comptage direct)
 * et se replie sur une distribution gaussienne du consensus si l'ensemble est indisponible.
 */

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface ModelForecast {
  model:       "gfs" | "ecmwf" | "ukmo" | "gfs_ensemble";
  temperature: number;
  confidence:  number;
  available:   boolean;
  error?:      string;
}

export interface MultiModelForecast {
  models: ModelForecast[];
  consensus: {
    temperature:   number;
    stdDev:        number;
    agreement:     "strong" | "moderate" | "weak";
    spreadDegrees: number;
  };
  ensemble: {
    members: number[];
    mean:    number;
    min:     number;
    max:     number;
    stdDev:  number;
  } | null;
  bestModel: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Poids historiques basés sur la précision des modèles (ECMWF gold standard). */
const MODEL_WEIGHTS: Record<string, number> = {
  ecmwf:        0.40,
  gfs:          0.30,
  ukmo:         0.20,
  gfs_ensemble: 0.10,
};

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const MULTI_MODEL_CACHE = new Map<string, { data: MultiModelForecast; timestamp: number }>();

// ---------------------------------------------------------------------------
// Fetch principal
// ---------------------------------------------------------------------------

/**
 * Récupère les prévisions des 4 modèles en parallèle et calcule le consensus pondéré.
 * Retourne les données cachées si disponibles (TTL = 15 min).
 *
 * @param lat        Latitude de la station (de préférence aéroport)
 * @param lon        Longitude de la station
 * @param targetDate Date cible au format YYYY-MM-DD
 */
export async function fetchMultiModelForecast(
  lat:        number,
  lon:        number,
  targetDate: string
): Promise<MultiModelForecast> {
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)},${targetDate}`;

  const cached = MULTI_MODEL_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[multi-model] Cache hit: ${cacheKey}`);
    return cached.data;
  }

  console.log(`[multi-model] Fetching 4 models for (${lat.toFixed(2)}, ${lon.toFixed(2)}) on ${targetDate}`);

  const [gfs, ecmwf, ukmo, ensembleResult] = await Promise.all([
    fetchGFS(lat, lon, targetDate),
    fetchECMWF(lat, lon, targetDate),
    fetchUKMO(lat, lon, targetDate),
    fetchGFSEnsemble(lat, lon, targetDate),
  ]);

  // --- Consensus pondéré ---
  const deterministicModels: ModelForecast[] = [gfs, ecmwf, ukmo];
  const available = deterministicModels.filter((m) => m.available);

  let weightedSum  = 0;
  let totalWeight  = 0;

  for (const m of available) {
    const w = MODEL_WEIGHTS[m.model] ?? 0.25;
    weightedSum += m.temperature * w;
    totalWeight += w;
  }

  if (ensembleResult.available) {
    const w = MODEL_WEIGHTS.gfs_ensemble;
    weightedSum += ensembleResult.temperature * w;
    totalWeight += w;
  }

  const consensusTemp = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // --- Écart-type inter-modèles ---
  const temps: number[] = available.map((m) => m.temperature);
  if (ensembleResult.available) temps.push(ensembleResult.temperature);

  const variance     = temps.length > 0
    ? temps.reduce((s, t) => s + (t - consensusTemp) ** 2, 0) / temps.length
    : 0;
  const stdDev       = Math.sqrt(variance);
  const spreadDegrees = temps.length > 1
    ? Math.max(...temps) - Math.min(...temps)
    : 0;

  const agreement: "strong" | "moderate" | "weak" =
    stdDev < 1.0 ? "strong" :
    stdDev < 2.0 ? "moderate" :
    "weak";

  const bestModel = ecmwf.available ? "ecmwf" : gfs.available ? "gfs" : "ukmo";

  const result: MultiModelForecast = {
    models: [...deterministicModels, { ...ensembleResult }],
    consensus: {
      temperature:   Math.round(consensusTemp * 10) / 10,
      stdDev:        Math.round(stdDev * 100) / 100,
      agreement,
      spreadDegrees: Math.round(spreadDegrees * 10) / 10,
    },
    ensemble: ensembleResult.available && ensembleResult.members.length > 0
      ? {
          members: ensembleResult.members,
          mean:    ensembleResult.temperature,
          min:     Math.min(...ensembleResult.members),
          max:     Math.max(...ensembleResult.members),
          stdDev:  ensembleResult.ensembleStdDev,
        }
      : null,
    bestModel,
    timestamp: new Date().toISOString(),
  };

  console.log(
    `[multi-model] Consensus: ${consensusTemp.toFixed(1)}°C ` +
    `(σ=${stdDev.toFixed(2)}°C, agreement=${agreement}) | ` +
    `GFS=${gfs.available ? gfs.temperature.toFixed(1) : "N/A"}°C, ` +
    `ECMWF=${ecmwf.available ? ecmwf.temperature.toFixed(1) : "N/A"}°C, ` +
    `UKMO=${ukmo.available ? ukmo.temperature.toFixed(1) : "N/A"}°C`
  );

  MULTI_MODEL_CACHE.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

// ---------------------------------------------------------------------------
// Fetch modèles individuels
// ---------------------------------------------------------------------------

async function fetchGFS(lat: number, lon: number, targetDate: string): Promise<ModelForecast> {
  try {
    const url =
      `https://api.open-meteo.com/v1/gfs?` +
      `latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max&timezone=UTC&forecast_days=16`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as { daily?: { time?: string[]; temperature_2m_max?: (number | null)[] } };
    const idx  = data.daily?.time?.findIndex((d) => d === targetDate) ?? -1;

    if (idx === -1 || data.daily?.temperature_2m_max?.[idx] == null) {
      return { model: "gfs", temperature: 0, confidence: 0, available: false, error: "Date not found" };
    }

    const temp = data.daily.temperature_2m_max[idx]!;
    return { model: "gfs", temperature: temp, confidence: idx <= 5 ? 0.85 : idx <= 10 ? 0.70 : 0.50, available: true };
  } catch (err) {
    return { model: "gfs", temperature: 0, confidence: 0, available: false, error: String(err) };
  }
}

async function fetchECMWF(lat: number, lon: number, targetDate: string): Promise<ModelForecast> {
  try {
    const url =
      `https://api.open-meteo.com/v1/ecmwf?` +
      `latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max&timezone=UTC&forecast_days=10`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as { daily?: { time?: string[]; temperature_2m_max?: (number | null)[] } };
    const idx  = data.daily?.time?.findIndex((d) => d === targetDate) ?? -1;

    if (idx === -1 || data.daily?.temperature_2m_max?.[idx] == null) {
      return { model: "ecmwf", temperature: 0, confidence: 0, available: false, error: "Date not found" };
    }

    const temp = data.daily.temperature_2m_max[idx]!;
    return { model: "ecmwf", temperature: temp, confidence: idx <= 3 ? 0.90 : idx <= 7 ? 0.75 : 0.60, available: true };
  } catch (err) {
    return { model: "ecmwf", temperature: 0, confidence: 0, available: false, error: String(err) };
  }
}

async function fetchUKMO(lat: number, lon: number, targetDate: string): Promise<ModelForecast> {
  try {
    const url =
      `https://api.open-meteo.com/v1/ukmo?` +
      `latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max&timezone=UTC&forecast_days=7`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as { daily?: { time?: string[]; temperature_2m_max?: (number | null)[] } };
    const idx  = data.daily?.time?.findIndex((d) => d === targetDate) ?? -1;

    if (idx === -1 || data.daily?.temperature_2m_max?.[idx] == null) {
      return { model: "ukmo", temperature: 0, confidence: 0, available: false, error: "Date not found" };
    }

    const temp = data.daily.temperature_2m_max[idx]!;
    return { model: "ukmo", temperature: temp, confidence: idx <= 3 ? 0.85 : idx <= 5 ? 0.70 : 0.55, available: true };
  } catch (err) {
    return { model: "ukmo", temperature: 0, confidence: 0, available: false, error: String(err) };
  }
}

// Résultat étendu pour l'ensemble (champs internes uniquement)
interface GFSEnsembleResult extends ModelForecast {
  model:           "gfs_ensemble";
  members:         number[];
  ensembleStdDev:  number;
}

async function fetchGFSEnsemble(lat: number, lon: number, targetDate: string): Promise<GFSEnsembleResult> {
  const empty: GFSEnsembleResult = {
    model: "gfs_ensemble", temperature: 0, confidence: 0, available: false, members: [], ensembleStdDev: 0,
  };

  try {
    const url =
      `https://ensemble-api.open-meteo.com/v1/ensemble?` +
      `latitude=${lat}&longitude=${lon}` +
      `&models=gfs_seamless&daily=temperature_2m_max&timezone=UTC&forecast_days=7`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as { daily?: Record<string, (number | null)[]> & { time?: string[] } };
    const idx  = data.daily?.time?.findIndex((d) => d === targetDate) ?? -1;

    if (idx === -1) return { ...empty, error: "Date not found" };

    const members: number[] = [];
    for (let i = 0; i < 31; i++) {
      const key = `temperature_2m_max_member${String(i).padStart(2, "0")}`;
      const val = data.daily?.[key]?.[idx];
      if (typeof val === "number") members.push(val);
    }

    if (members.length === 0) return { ...empty, error: "No members" };

    const mean     = members.reduce((a, b) => a + b, 0) / members.length;
    const variance = members.reduce((s, v) => s + (v - mean) ** 2, 0) / members.length;
    const stdDev   = Math.sqrt(variance);

    return {
      model:          "gfs_ensemble",
      temperature:    Math.round(mean * 10) / 10,
      confidence:     stdDev < 1.5 ? 0.80 : stdDev < 2.5 ? 0.65 : 0.50,
      available:      true,
      members,
      ensembleStdDev: Math.round(stdDev * 100) / 100,
    };
  } catch (err) {
    return { ...empty, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Calcul de probabilité multi-modèles
// ---------------------------------------------------------------------------

/**
 * Calcule P(outcome) à partir du consensus multi-modèle.
 *
 * Stratégie :
 *   1. Si ≥ 20 membres d'ensemble disponibles → comptage direct (plus précis)
 *   2. Sinon → distribution gaussienne centrée sur le consensus pondéré
 *
 * Toutes les températures (seuils ET membres) doivent être dans la MÊME UNITÉ (°C).
 *
 * @param forecast          Résultat de fetchMultiModelForecast
 * @param threshold         Seuil principal en °C (borne basse pour "range")
 * @param type              Type d'outcome
 * @param rangeMax          Borne haute pour "range" (en °C)
 * @param toleranceDegrees  Tolérance pour "exact" (défaut 0.5°C)
 */
export function calculateMultiModelProbability(
  forecast:           MultiModelForecast,
  threshold:          number,
  type:               "exact" | "above" | "below" | "range",
  rangeMax?:          number,
  toleranceDegrees:   number = 0.5
): { probability: number; confidence: string; method: string } {

  // Méthode 1 : comptage d'ensemble (prioritaire)
  if (forecast.ensemble && forecast.ensemble.members.length >= 20) {
    const { members } = forecast.ensemble;
    let matching = 0;

    for (const temp of members) {
      let hit = false;
      if      (type === "exact")  hit = Math.abs(temp - threshold) <= toleranceDegrees;
      else if (type === "above")  hit = temp >= threshold;
      else if (type === "below")  hit = temp <  threshold;
      else if (type === "range")  hit = rangeMax !== undefined && temp >= threshold && temp <= rangeMax;
      if (hit) matching++;
    }

    const probability = matching / members.length;
    console.log(`[multi-model-prob] Ensemble: ${matching}/${members.length} = ${(probability * 100).toFixed(1)}%`);

    return {
      probability,
      confidence: forecast.consensus.agreement,
      method: "ensemble_members",
    };
  }

  // Méthode 2 : gaussienne sur le consensus
  const { temperature: mean, stdDev } = forecast.consensus;
  const sigma = Math.max(stdDev, 1.0);

  let probability: number;

  if (type === "exact") {
    const z = (threshold - mean) / sigma;
    probability = Math.exp(-0.5 * z * z) * toleranceDegrees * 2 / (sigma * Math.sqrt(2 * Math.PI));
    probability = Math.min(probability, 0.95);
  } else if (type === "above") {
    probability = 1 - normalCDF((threshold - mean) / sigma);
  } else if (type === "below") {
    probability = normalCDF((threshold - mean) / sigma);
  } else if (type === "range" && rangeMax !== undefined) {
    probability = normalCDF((rangeMax - mean) / sigma) - normalCDF((threshold - mean) / sigma);
  } else {
    probability = 0.5;
  }

  console.log(
    `[multi-model-prob] Gaussian: mean=${mean.toFixed(1)}°C σ=${sigma.toFixed(2)}°C ` +
    `→ ${(probability * 100).toFixed(1)}%`
  );

  return {
    probability: Math.max(0.01, Math.min(0.99, probability)),
    confidence:  forecast.consensus.agreement,
    method:      "gaussian_consensus",
  };
}

// Approximation CDF normale standard (Abramowitz & Stegun 7.1.26)
function normalCDF(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const az   = Math.abs(z) / Math.SQRT2;
  const t    = 1 / (1 + 0.3275911 * az);
  const y    = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t)
                   * Math.exp(-az * az);
  return 0.5 * (1 + sign * y);
}
