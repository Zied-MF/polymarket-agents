/**
 * Weather Observed — températures réellement observées aujourd'hui (pas de prévision)
 *
 * Utilise l'API Open-Meteo avec past_days=1 pour récupérer les données horaires
 * des dernières 24h. Ces données sont quasi-observées (reanalyse ERA5 récente,
 * délai ~1h) — bien plus fiables que les prévisions pour l'arbitrage de résolution.
 *
 * Cas d'usage : quand le marché expire dans < 4h, on sait déjà quelle est la
 * température max/min de la journée. Si elle dépasse clairement le seuil, on
 * achète l'outcome gagnant sans dépendre d'un modèle de prévision.
 */

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

export interface ObservedDayTemps {
  date:          string;  // "YYYY-MM-DD" — date locale de la ville
  maxSoFar:      number;  // température max observée depuis minuit local (°C)
  minSoFar:      number;  // température min observée depuis minuit local (°C)
  currentTemp:   number;  // dernière lecture horaire disponible (°C)
  localHour:     number;  // heure locale courante (0-23) dans la ville
  hoursWithData: number;  // nombre d'heures de données disponibles aujourd'hui
}

/**
 * Récupère les températures observées aujourd'hui pour une ville (lat/lon).
 * Retourne null si les données ne sont pas disponibles.
 *
 * @param lat      Latitude de la ville
 * @param lon      Longitude de la ville
 * @param dateStr  Date cible "YYYY-MM-DD" (date locale de la ville)
 */
export async function fetchObservedDayTemps(
  lat:      number,
  lon:      number,
  dateStr:  string
): Promise<ObservedDayTemps | null> {
  try {
    const url = new URL(OPEN_METEO_BASE);
    url.searchParams.set("latitude",    String(lat));
    url.searchParams.set("longitude",   String(lon));
    url.searchParams.set("hourly",      "temperature_2m");
    url.searchParams.set("past_days",   "1");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("timezone",    "auto");

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.warn(`[weather-observed] HTTP ${res.status} pour (${lat},${lon})`);
      return null;
    }

    const data = await res.json() as {
      hourly?: {
        time?:            string[];
        temperature_2m?:  (number | null)[];
      };
    };

    const times  = data.hourly?.time  ?? [];
    const temps  = data.hourly?.temperature_2m ?? [];

    // Filtrer uniquement les heures de la date cible
    const todayReadings: { hour: number; temp: number }[] = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (!t || temps[i] == null) continue;
      // Format: "2026-05-14T13:00"
      const [datePart, timePart] = t.split("T");
      if (datePart !== dateStr) continue;
      const hour = parseInt(timePart?.slice(0, 2) ?? "0", 10);
      todayReadings.push({ hour, temp: temps[i] as number });
    }

    if (todayReadings.length === 0) {
      console.warn(`[weather-observed] Aucune donnée pour ${dateStr} à (${lat},${lon})`);
      return null;
    }

    // Heure locale courante : dernière heure avec données disponibles
    const lastReading  = todayReadings[todayReadings.length - 1];
    const allTemps     = todayReadings.map((r) => r.temp);
    const maxSoFar     = Math.max(...allTemps);
    const minSoFar     = Math.min(...allTemps);

    console.log(
      `[weather-observed] ${dateStr} @${lat},${lon} — ` +
      `max=${maxSoFar.toFixed(1)}°C min=${minSoFar.toFixed(1)}°C ` +
      `current=${lastReading.temp.toFixed(1)}°C localHour=${lastReading.hour} ` +
      `(${todayReadings.length}h de données)`
    );

    return {
      date:          dateStr,
      maxSoFar,
      minSoFar,
      currentTemp:   lastReading.temp,
      localHour:     lastReading.hour,
      hoursWithData: todayReadings.length,
    };
  } catch (err) {
    console.warn(
      `[weather-observed] Erreur (${lat},${lon}) ${dateStr}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
