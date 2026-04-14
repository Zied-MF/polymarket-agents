/**
 * Sources finance - Yahoo Finance, données pré-marché
 *
 * Agrège les données financières nécessaires à l'agent finance :
 *   - Yahoo Finance (yfinance-compatible) : cours OHLCV, données historiques,
 *     informations fondamentales (P/E, market cap…)
 *   - Données pré-marché / après-clôture : futures sur indices, ADR
 *   - Options : implied volatility, put/call ratio (source CBOE ou Yahoo)
 *   - Calendrier économique : annonces Fed, publications de résultats
 * Retourne des structures normalisées permettant à l'agent finance de
 * calculer ses probabilités directionnelles.
 */

export {};
