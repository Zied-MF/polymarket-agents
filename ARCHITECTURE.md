# Architecture — Polymarket Trading Agents

> Dernière mise à jour : 2026-04-18 (v3)  
> Stack : Next.js 16 · React 19 · TypeScript 5 · Supabase · Tailwind CSS 4

---

## Contexte — Réforme après paper trading catastrophique

| Métrique | Résultat |
|---|---|
| P&L total | −85 € |
| Win rate global | 39.8% |
| Win rate Crypto | 26.4% |
| Win rate Finance | ~38% |
| Décision | Crypto désactivé, Finance + Crypto en shadow mode |

**Changements majeurs (2026-04-18) :**
- Crypto Agent **désactivé** du registre (import commenté)
- Finance + Crypto placés en **shadow mode** — analysent sans créer de trades
- Seuils Weather relevés : liquidité $1k→$5k, edge 7.98%→12%, net edge 5%→8%
- Volume réduit : max 3 positions/agent (était 15)
- Circuit breaker automatique par `getAgentPerformance24h`
- Cron `monitor-positions` **supprimé** — HOLD > SELL confirmé (+43€)

---

## Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Next.js 16 App                             │
│                                                                     │
│  Pages UI            API Routes (cron)          Lib                 │
│  ──────────          ─────────────────          ───                 │
│  /               →   /api/scan-markets     →   Orchestrator         │
│  /results        →   /api/check-results    →   Agents               │
│  /positions                                →   Kelly                │
│                      /api/results              Supabase             │
│                      /api/positions-stats                           │
└─────────────────────────────────────────────────────────────────────┘
```

**Crons Vercel actifs :**

| Cron | Schedule | Description |
|---|---|---|
| `/api/scan-markets` | `*/15 * * * *` | Scan toutes les 15 min |
| `/api/check-results` | `0 8 * * *` | Résolution à 8h chaque jour |
| ~~`/api/monitor-positions`~~ | ~~supprimé~~ | Supprimé — HOLD > SELL |

---

## Structure des fichiers

```
src/
├── app/
│   ├── page.tsx                      # Dashboard — scan manuel (bouton)
│   ├── results/page.tsx              # Historique paper trades + P&L
│   ├── positions/page.tsx            # Positions ouvertes
│   └── api/
│       ├── scan-markets/route.ts     # Cron principal — détecte les opportunités
│       ├── check-results/route.ts    # Cron résolution — calcule les vrais P&L
│       ├── monitor-positions/route.ts# Disponible mais PLUS dans vercel.json
│       ├── results/route.ts          # Lecture paper trades (dashboard)
│       └── positions-stats/route.ts  # Stats positions (dashboard)
│
├── lib/
│   ├── agents/
│   │   ├── orchestrator.ts           # Chef d'orchestre — shadow mode + circuit breaker
│   │   ├── weather-agent.ts          # Logique gaussienne météo
│   │   ├── finance-agent.ts          # Scoring momentum actions (shadow mode)
│   │   ├── crypto-agent.ts           # Scoring momentum crypto (désactivé)
│   │   ├── adapters/
│   │   │   ├── weather-adapter.ts    # Seuils relevés — seul agent actif
│   │   │   ├── finance-adapter.ts    # Shadow mode (analyse sans trades)
│   │   │   └── crypto-adapter.ts    # Import commenté dans scan-markets
│   │   ├── timing-agent.ts           # (non utilisé en prod)
│   │   └── post-mortem-agent.ts      # (non utilisé en prod)
│   │
│   ├── data-sources/
│   │   ├── weather-sources.ts        # Open-Meteo API + cache mémoire 10 min
│   │   ├── finance-sources.ts        # Finnhub API /quote
│   │   ├── crypto-sources.ts         # CoinGecko API /simple/price
│   │   └── geocoding.ts              # 3 couches : mémoire → Supabase → API
│   │
│   ├── polymarket/
│   │   ├── gamma-api.ts              # fetchWeather/Stock/CryptoMarkets
│   │   ├── clob-api.ts               # Ordres réels (non actif en paper)
│   │   └── mock-data.ts              # Données de test (dev)
│   │
│   ├── db/
│   │   ├── supabase.ts               # Client singleton + CRUD + circuit breaker
│   │   ├── positions.ts              # CRUD table positions + getPositionByPaperTradeId
│   │   └── schema.sql                # Schéma SQL de référence
│   │
│   ├── positions/
│   │   └── position-manager.ts       # evaluatePosition() — logique pure
│   │
│   ├── utils/
│   │   ├── kelly.ts                  # calculateHalfKelly()
│   │   └── discord.ts                # Notifications webhook
│   │
│   └── data/
│       └── station-mapping.ts        # Codes ICAO → (lat, lon, timezone, city)
│
└── types/
    └── index.ts                      # Market, Outcome, WeatherForecast…
```

---

## Pipeline complet — scan-markets

```
GET /api/scan-markets
        │
        ├─ acquireScanLock()                     # verrou anti-double exécution
        │
        ├─ ensureAgentsRegistered()
        │       weatherAdapter  ✅ ACTIF
        │       financeAdapter  👻 shadow mode
        │       cryptoAdapter   ✗  import commenté (désactivé 2026-04-18)
        │
        ├─ orchestrator.scanAllMarkets()
        │       │
        │       ├─ [CIRCUIT BREAKER — séquentiel]
        │       │   pour chaque agent enregistré :
        │       │     getAgentPerformance24h(agent.type)
        │       │     si WR < 40% sur ≥ 10 trades → shadowModeAgents.add()
        │       │     si P&L < −15€ sur 24h       → shadowModeAgents.add()
        │       │
        │       ├─ [SCAN PARALLÈLE — Promise.all]
        │       │   ├─ weatherAdapter.fetchMarkets()  → WeatherMarket[]
        │       │   │  weatherAdapter.fetchData(m)    → WeatherForecast
        │       │   │  weatherAdapter.analyze(m, f)   → { dominated | skipReason }
        │       │   │
        │       │   └─ financeAdapter.fetchMarkets()  → StockMarket[]
        │       │      financeAdapter.fetchData(m)    → StockData
        │       │      financeAdapter.analyze(m, d)   → { dominated | skipReason }
        │       │      [SHADOW] → opportunités loggées, NON retournées
        │       │
        │       ├─ [LOG ÉTAT AGENTS]
        │       │   ✅ ACTIF  weather  — X marchés, Y opportunités enregistrées
        │       │   👻 SHADOW finance  — X marchés, Y détectées (non enregistrées)
        │       │
        │       └─ applyRiskLimits()
        │               ├─ tri par edge décroissant
        │               ├─ déduplication market_id
        │               ├─ max 3 positions par agent
        │               └─ max 8 positions par secteur
        │
        ├─ déduplication DB (getRecentOpportunities 24h)
        │
        ├─ pour chaque opportunité nouvelle :
        │       ├─ saveOpportunity()   → table opportunities
        │       ├─ savePaperTrade()    → table paper_trades
        │       └─ openPosition()     → table positions (status='open')
        │
        ├─ sendDiscordNotification()   # fire-and-forget
        ├─ incrementDailyOpportunities()
        └─ releaseScanLock()
```

### Batching interne

- Chaque agent analyse par **batches de 5** en parallèle (`Promise.all`)
- **200 ms** entre chaque batch (éviter 429 sur APIs externes)
- Les agents actifs tournent en **parallèle** entre eux

---

## Shadow Mode

Les agents en shadow mode font tourner l'**analyse complète** (fetchMarkets → fetchData → analyze), mais leurs opportunités sont jetées avant d'être retournées à `scan-markets`.

**Utilité :** mesurer en continu la qualité du signal sans risque capital. Quand le WR remonte durablement > 50%, on retire l'agent du set `shadowModeAgents`.

```typescript
// orchestrator.ts
private shadowModeAgents: Set<AgentType> = new Set(["crypto", "finance"]);
```

**Log de monitoring :**
```
[orchestrator] 👻 SHADOW MODE: Finance Agent — 2 opportunités détectées (non enregistrées) en 1240ms
[orchestrator][shadow]   "Will NVDA close above $900 on April 19?…" edge=13.2%
```

---

## Circuit Breaker

Avant chaque scan, `getAgentPerformance24h(agentType)` interroge les `paper_trades` des dernières 24h pour chaque agent enregistré.

**Règles de désactivation automatique :**

| Condition | Action |
|---|---|
| ≥ 10 trades ET WR < 40% | `shadowModeAgents.add(agent.type)` |
| P&L < −15€ sur 24h | `shadowModeAgents.add(agent.type)` |

Best-effort : si l'appel DB échoue, le scan continue normalement.

```typescript
// supabase.ts
export async function getAgentPerformance24h(agentType: string): Promise<AgentPerformance> {
  // SELECT won, potential_pnl FROM paper_trades
  // WHERE agent = agentType AND created_at >= yesterday AND won IS NOT NULL
  // → { trades, wins, winRate, pnl }
}
```

---

## Agents — logique métier

### Weather Agent — seul agent actif

**Source :** Open-Meteo (gratuit, sans clé)

**Seuils (relevés le 2026-04-18) :**

| Paramètre | Avant | Après |
|---|---|---|
| `MIN_LIQUIDITY` | $1 000 | $5 000 |
| `MIN_EDGE` (gross) | 7.98% | **12%** |
| `NET_EDGE_MIN` (après spread) | 5% | **8%** |
| Filtre consensus | ≥ 90% | ≥ 90% (fetchMarkets) |
| Filtre anti-favori | — | **> 70%** (analyze) |

**Modèle probabiliste :**

| Type d'outcome | Formule |
|---|---|
| `exact` / `range` | PDF gaussien : `exp(−0.5 × ((target − forecast) / σ)²)` |
| `above X` | CDF : `1 − Φ((X − forecast) / σ)` |
| `below X` | CDF : `Φ((X − forecast) / σ)` |
| `Yes/No` binaire | Résolution sémantique → type ci-dessus |

**Sigma dynamique :**

| Délai | σ (°C) | Confiance |
|---|---|---|
| J+1 | 1.5 | high |
| J+2 | 2.5 | medium |
| J+3+ | 3.5 | low |

**Fat tails :** `σ_final = σ × (1 + |forecast − 15°C| / 10 × 0.2)`

**Unité °C/°F :** Hiérarchie : question → outcomes → code ICAO (K… = US = °F) → ville US → `market.unit`.

**Cache prévisions :** `Map<"lat,lon,date", WeatherForecast>` TTL 10 min.

**Pipeline analyze() :**
```
1. Filtre anti-favori : outcomePrices.some(p > 0.70) → skip
2. analyzeMarket() → outcomes triés par edge
3. best.edge < 12%  → skip (gross edge insuffisant)
4. edgeNet = best.edge − spread < 8% → skip
5. calculateHalfKelly() → betAmount = 0 → skip
6. → { dominated }
```

---

### Finance Agent — shadow mode

**Source :** Finnhub `/quote` (60 req/min, `FINNHUB_API_KEY`)

**Scoring :** changePercent + position dans le range du jour → score UP/DOWN  
**Mean-reversion penalty :** change > 2% ET marketPrice > 75% → score × 0.5  
**Probabilité :** `clamp(0.5 + (up−down)/100, 0.55, 0.85)`

Analyse complète à chaque scan — aucun trade créé tant qu'en shadow mode.

---

### Crypto Agent — désactivé

Import commenté dans `scan-markets/route.ts` depuis le 2026-04-18.  
Raison : WR 26.4%, P&L −87€. Le modèle momentum pur ne fonctionne pas sur Polymarket.

```typescript
// import { cryptoAdapter } from "@/lib/agents/adapters/crypto-adapter"; // DÉSACTIVÉ 2026-04-18
// TODO: stratégie mean-reversion ou event-driven
```

---

## Kelly Criterion

`calculateHalfKelly(probability, marketPrice, bankroll, spreadEstimate)`

```
Bankroll        = 10 USDC
GAS_FEE         = 0.01 USDC
PLATFORM_FEE    = 2%
MIN_BET_AMOUNT  = 0.10 USDC
MAX_BET_PERCENT = 10%  (plafond = 1 USDC)

Pipeline :
  1. effectiveProbability = probability − spreadEstimate
  2. grossOdds = 1/marketPrice − 1
  3. netOdds   = grossOdds × (1 − 0.02)
  4. kellyFraction = (p_eff × netOdds − (1−p_eff)) / netOdds
  5. halfKelly  = kellyFraction / 2
  6. fraction   = min(halfKelly, 0.10)
  7. betAmount  = fraction × bankroll − GAS_FEE
  8. betAmount < 0.10 → 0  ← adapters: return { skipReason }
```

**Spread par liquidité :**

| Liquidité | Spread |
|---|---|
| ≥ $10 000 | 2% |
| ≥ $2 000 | 3% |
| < $2 000 | 4% |

---

## Filtres de risque — Orchestrateur

```
applyRiskLimits(opportunities[]) :
  1. tri par edge décroissant
  2. seenMarketIds Set → déduplique market_id (2 agents sur même marché)
  3. countByAgent[agent] ≥ 3  → skip  (était 15)
  4. countBySector[sector] ≥ 8 → skip
```

**Secteurs granulaires :**

| Agent | Secteur | Tokens / Tickers |
|---|---|---|
| crypto | `crypto_l1` | BTC, ETH, SOL, AVAX, ADA, DOT |
| crypto | `crypto_meme` | DOGE, SHIB, PEPE, BONK, WIF, TRUMP |
| crypto | `crypto_defi` | UNI, AAVE, LINK, MKR, CRV, ARB, OP |
| finance | `finance_tech` | AAPL, MSFT, GOOGL, META, NVDA, AMZN, TSLA |
| finance | `finance_banks` | JPM, BAC, GS, MS, V, MA, ALLY |
| finance | `finance_energy` | XOM, CVX, COP, SLB |
| weather | `weather_us` | NYC, LA, Chicago, Miami… |
| weather | `weather_eu` | Londres, Paris, Berlin… |
| weather | `weather_asia` | Tokyo, Seoul, Singapore… |

---

## Pipeline check-results

```
GET /api/check-results  (cron : 0 8 * * *)
        │
        ├─ getPendingPaperTrades()
        │       WHERE won IS NULL
        │         AND resolution_date < today
        │         AND actual_result != 'sold'
        │
        └─ pour chaque trade :
                │
                ├─ [PRIORITÉ] getPositionByPaperTradeId(trade.id)
                │       Si position.status === 'sold' ET sell_pnl !== null :
                │         → resolvePaperTrade(won=sell_pnl>=0, pnl=sell_pnl)
                │         → continue  (skip résolution normale)
                │
                ├─ [weather] fetchActualTemperature(city, date)
                │             → Open-Meteo Archive (ERA5)
                │             selectTemp → resolveOutcome → WIN|LOSE
                │
                ├─ [finance] fetchActualStockResult(ticker, date) → WIN|LOSE
                ├─ [crypto]  fetchActualCryptoResult(token, date) → WIN|LOSE
                │
                ├─ fetchPolymarketOutcome(market_id)  # validation officielle
                │       outcomeMatch = polymarketOutcome == trade.outcome
                │
                ├─ won         = outcomeMatch ?? (ourResult === "WIN")
                ├─ marketPrice  = Number(trade.market_price)   # coercition défensive
                ├─ suggestedBet = Number(trade.suggested_bet)  # coercition défensive
                ├─ pnl = computePnl(won, marketPrice, suggestedBet)
                │       won  → (1/marketPrice − 1) × suggestedBet
                │       lost → −suggestedBet
                │       bet=0 → 0
                │
                └─ resolvePaperTrade(id, { won, potential_pnl: pnl })
```

---

## Pipeline monitor-positions

> **Cron supprimé de vercel.json.** La route `/api/monitor-positions` existe encore dans le code mais n'est plus exécutée automatiquement. Les positions restent ouvertes jusqu'à `check-results` (HOLD > SELL : +43€ observé).

La route peut être appelée manuellement si nécessaire. Quand elle tourne :

```
GET /api/monitor-positions
        │
        ├─ getOpenPositions()
        ├─ filtre âge < 30 min → ignorées
        └─ pour chaque position éligible :
                ├─ fetchMarketSnapshot(market_id)
                ├─ log : age, priceChange, probChange
                ├─ priceChange < 1% → HOLD sans évaluation
                ├─ evaluatePosition()
                │       SELL si probDrop ≥ 25 pts
                │       SELL si priceRatio < 0.5
                ├─ si SELL : executeSell() + markPaperTradeSold()
                │       sell_pnl = (sell−entry)/entry × suggestedBet
                └─ si HOLD : updatePosition()
```

---

## Base de données Supabase

### Table `opportunities`

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | PK |
| `market_id` | TEXT | ID Polymarket |
| `question` | TEXT | Libellé |
| `outcome` | TEXT | Outcome ciblé |
| `market_price` | DECIMAL | Prix implicite [0,1] |
| `estimated_probability` | DECIMAL | Notre estimation |
| `edge` | DECIMAL | Différence |
| `multiplier` | DECIMAL | 1/market_price |
| `status` | TEXT | detected/bet_placed/won/lost/skipped |

### Table `paper_trades`

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | PK |
| `market_id` | TEXT | ID Polymarket |
| `agent` | TEXT | weather/finance/crypto |
| `outcome` | TEXT | Outcome ciblé |
| `market_price` | DECIMAL | Prix d'entrée |
| `suggested_bet` | DECIMAL | Mise Kelly (USDC) |
| `confidence` | TEXT | high/medium/low |
| `resolution_date` | DATE | Date de résolution |
| `won` | BOOLEAN | NULL = en attente |
| `potential_pnl` | DECIMAL | P&L réel (mis à jour à résolution) |
| `actual_result` | TEXT | Description du résultat |
| `market_context` | JSONB | Snapshot marché à l'entrée |
| `polymarket_outcome` | TEXT | Outcome officiel Polymarket |
| `outcome_match` | BOOLEAN | Notre prédiction = Polymarket ? |
| `resolved_at` | TIMESTAMPTZ | Horodatage de résolution |

### Table `positions`

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | PK |
| `paper_trade_id` | UUID | FK → paper_trades |
| `market_id` | TEXT | ID Polymarket |
| `entry_price` | DECIMAL | Prix d'entrée |
| `entry_probability` | DECIMAL | Probabilité estimée à l'entrée |
| `current_price` | DECIMAL | Dernière mise à jour |
| `status` | TEXT | open/hold/sell_signal/sold/resolved |
| `sell_price` | DECIMAL | Prix de vente simulée |
| `sell_pnl` | DECIMAL | `(sell−entry)/entry × bet` |
| `sold_at` | TIMESTAMPTZ | Horodatage de vente |

### Table `scan_locks`

Anti-double exécution. `locked_at = NULL` = verrou libre. Timeout 5 min.

### Table `city_coordinates`

Cache géocodage persistant entre redémarrages. PK = `city_name` (minuscules).

### Table `daily_stats`

Agrège par jour : `opportunities_detected`, `wins`, `losses`, `total_pnl`. Upsert idempotent.

---

## Géocodage — 3 couches

```
getCoordinates(cityName)
    │
    ├─ 1. Cache mémoire (Map)   — pré-peuplé depuis STATION_MAPPING
    ├─ 2. Cache Supabase         — persistant entre redémarrages
    └─ 3. Open-Meteo Geocoding   — résultat persisté en Supabase
```

**Normalisations :** "NYC" → "New York City", "LA" → "Los Angeles", etc.

---

## API externes utilisées

| API | Usage | Auth | Limite |
|---|---|---|---|
| Open-Meteo Forecast | Prévisions météo (scan) | — | Gratuit |
| Open-Meteo Archive | Températures réelles (check-results) | — | Gratuit |
| Open-Meteo Geocoding | Résolution ville → coords | — | Gratuit |
| Finnhub `/quote` | Prix actions (scan) | `FINNHUB_API_KEY` | 60 req/min |
| CoinGecko `/simple/price` | Prix crypto (scan) | — | ~30 req/min |
| Polymarket Gamma API | Marchés, outcomes, résolutions | — | Non documentée |
| Polymarket CLOB API | Ordres réels | Non actif | — |
| Discord Webhook | Notifications | `DISCORD_WEBHOOK_URL` | — |

**Gamma API — endpoints utilisés :**
```
/events?tag_slug=weather&active=true&closed=false&order=endDate&ascending=true&limit=100
/events?tag_slug=crypto&active=true&closed=false&order=startDate&ascending=false&limit=100
/markets?tag_slug=finance&active=true&closed=false&order=endDate&ascending=true&limit=100
/markets/{market_id}   ← fetchMarketSnapshot (monitor-positions)
```

**Deux structures de réponse Gamma :** `event.markets[]` (nested) ou `event` direct.

---

## Variables d'environnement

```env
NEXT_PUBLIC_SUPABASE_URL     # URL projet Supabase
SUPABASE_SERVICE_ROLE_KEY    # Clé service role (bypass RLS)
FINNHUB_API_KEY              # Clé API Finnhub
DISCORD_WEBHOOK_URL          # Webhook Discord (optionnel)
```

---

## Seuils et constantes clés

| Constante | Valeur | Fichier |
|---|---|---|
| `BANKROLL` | 10 USDC | `kelly.ts` |
| `GAS_FEE` | 0.01 USDC | `kelly.ts` |
| `PLATFORM_FEE` | 2% | `kelly.ts` |
| `MIN_BET_AMOUNT` | 0.10 USDC | `kelly.ts` |
| `MIN_LIQUIDITY` | **$5 000** | `weather-adapter.ts` |
| `MIN_EDGE` (gross) | **12%** | `weather-adapter.ts` |
| `NET_EDGE_MIN` | **8%** | `weather-adapter.ts` |
| Anti-favori | **> 70%** | `weather-adapter.ts` |
| `MIN_EDGE` orchestrateur | **12%** | `orchestrator.ts` |
| `maxPositionsPerAgent` | **3** | `orchestrator.ts` |
| `maxPositionsPerSector` | 8 | `orchestrator.ts` |
| `batchSize` | 5 | `orchestrator.ts` |
| `batchDelayMs` | 200ms | `orchestrator.ts` |
| Circuit breaker WR seuil | < 40% / ≥ 10 trades | `orchestrator.ts` |
| Circuit breaker P&L seuil | < −15€/24h | `orchestrator.ts` |
| `CACHE_TTL` météo | 10 min | `weather-sources.ts` |
| `LOCK_TIMEOUT_MS` | 5 min | `supabase.ts` |
| `AbortSignal.timeout` | 15 000ms | `weather-sources.ts` |
| `MIN_POSITION_AGE_MS` | 30 min | `monitor-positions` |
| `MIN_PRICE_CHANGE_RATIO` | 1% | `monitor-positions` |
| `probDrop` SELL seuil | 25 pts | `position-manager.ts` |

---

## Protections et déduplication

| Mécanisme | Où | Effet |
|---|---|---|
| Verrou `scan_locks` | `scan-markets` | Empêche 2 scans simultanés |
| `getRecentOpportunities(24h)` | `scan-markets` | Pas de double sauvegarde |
| Shadow mode | orchestrateur | Finance + Crypto scannent sans créer de trades |
| Circuit breaker | orchestrateur | Auto-désactive les agents < WR 40% ou P&L < −15€/24h |
| `seenMarketIds` Set | orchestrateur | market_id unique même si 2 agents le voient |
| `kelly.betAmount === 0 → skipReason` | adapters | Pas de trade sans mise valide |
| Anti-favori > 70% | `weather-adapter` | Pas de bet sur marché déjà décidé |
| Filtre edge brut 12% | `weather-adapter` | Seuil relevé post-bilan |
| `Number(market_price/suggested_bet)` | `check-results` | Coercition défensive null/undefined |
| Sold-check `getPositionByPaperTradeId` | `check-results` | Utilise `sell_pnl` réel si vendu |
| `MIN_POSITION_AGE_MS` 30 min | `monitor-positions` | Pas de vente immédiate après ouverture |
| `MIN_PRICE_CHANGE_RATIO` 1% | `monitor-positions` | Pas d'évaluation si prix inchangé |
| `edge > 50%` → skip | agents | Filtre erreurs de données |
| `marketPrice < 0.01 \|\| > 0.99` | agents | Filtre marchés déjà résolus |

---

## État des agents (résumé)

| Agent | État | Depuis | Raison |
|---|---|---|---|
| Weather | ✅ **ACTIF** | — | WR à améliorer avec nouveaux seuils |
| Finance | 👻 **Shadow mode** | 2026-04-18 | WR ~38%, surveillance sans trades |
| Crypto | ✗ **Désactivé** | 2026-04-18 | WR 26.4%, P&L −87€ — momentum inefficace sur Polymarket |
