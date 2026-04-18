# Architecture — Polymarket Trading Agents

> Dernière mise à jour : 2026-04-16 (v2)  
> Stack : Next.js 16 · React 19 · TypeScript 5 · Supabase · Tailwind CSS 4

---

## Vue d'ensemble

Système d'agents autonomes qui scanne les marchés de prédiction Polymarket, détecte des opportunités à edge positif, simule des bets (paper trading) et évalue les résultats automatiquement.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Next.js 16 App                           │
│                                                                 │
│  Pages UI          API Routes (cron)        Lib                 │
│  ─────────         ─────────────────        ───                 │
│  /             →   /api/scan-markets   →   Orchestrator         │
│  /results      →   /api/check-results  →   Agents               │
│  /positions    →   /api/monitor-pos    →   Kelly                │
│                    /api/results        →   Supabase             │
│                    /api/positions-stats                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Structure des fichiers

```
src/
├── app/
│   ├── page.tsx                      # Dashboard — scan manuel
│   ├── results/page.tsx              # Historique paper trades
│   ├── positions/page.tsx            # Positions ouvertes
│   └── api/
│       ├── scan-markets/route.ts     # Cron principal — détecte les opportunités
│       ├── check-results/route.ts    # Cron résolution — calcule les P&L
│       ├── monitor-positions/route.ts# Cron surveillance — sell signals
│       ├── results/route.ts          # Lecture paper trades (dashboard)
│       └── positions-stats/route.ts  # Stats positions (dashboard)
│
├── lib/
│   ├── agents/
│   │   ├── orchestrator.ts           # Chef d'orchestre — coordination parallèle
│   │   ├── weather-agent.ts          # Logique gaussienne météo
│   │   ├── finance-agent.ts          # Scoring momentum actions
│   │   ├── crypto-agent.ts           # Scoring momentum crypto
│   │   ├── adapters/
│   │   │   ├── weather-adapter.ts    # Pont orchestrator ↔ weather-agent
│   │   │   ├── finance-adapter.ts    # Pont orchestrator ↔ finance-agent
│   │   │   └── crypto-adapter.ts    # Pont orchestrator ↔ crypto-agent
│   │   ├── timing-agent.ts           # (non utilisé en prod — réservé)
│   │   └── post-mortem-agent.ts      # (non utilisé en prod — réservé)
│   │
│   ├── data-sources/
│   │   ├── weather-sources.ts        # Open-Meteo API + cache mémoire 10 min
│   │   ├── finance-sources.ts        # Finnhub API (quote, pre-market)
│   │   ├── crypto-sources.ts         # CoinGecko API (prix, change24h, volume)
│   │   └── geocoding.ts              # Géocodage ville → (lat, lon) — 3 couches
│   │
│   ├── polymarket/
│   │   ├── gamma-api.ts              # API Gamma — fetchWeather/Stock/CryptoMarkets
│   │   ├── clob-api.ts               # API CLOB (ordre réel — non actif en paper)
│   │   └── mock-data.ts              # Données de test (dev)
│   │
│   ├── db/
│   │   ├── supabase.ts               # Client singleton + toutes les fonctions DB
│   │   ├── positions.ts              # CRUD table positions
│   │   └── schema.sql                # Schéma SQL complet (reference)
│   │
│   ├── positions/
│   │   └── position-manager.ts       # Logique pure — evaluatePosition()
│   │
│   ├── utils/
│   │   ├── kelly.ts                  # calculateHalfKelly() + calculateKellyBet()
│   │   └── discord.ts                # Notifications webhook Discord
│   │
│   └── data/
│       └── station-mapping.ts        # Codes ICAO → (lat, lon, timezone, city)
│
└── types/
    └── index.ts                      # Interfaces partagées (Market, Outcome, WeatherForecast…)
```

---

## Pipeline complet — scan-markets

```
GET /api/scan-markets
        │
        ├─ acquireScanLock()           # verrou anti-double exécution (table scan_locks)
        │
        ├─ orchestrator.scanAllMarkets()
        │       │
        │       ├─ [PARALLÈLE] weatherAdapter.fetchMarkets()  → WeatherMarket[]
        │       │              weatherAdapter.fetchData(m)    → WeatherForecast
        │       │              weatherAdapter.analyze(m, f)   → { dominated | skipReason }
        │       │
        │       ├─ [PARALLÈLE] financeAdapter.fetchMarkets()  → StockMarket[]
        │       │              financeAdapter.fetchData(m)    → StockData
        │       │              financeAdapter.analyze(m, d)   → { dominated | skipReason }
        │       │
        │       ├─ [PARALLÈLE] cryptoAdapter.fetchMarkets()   → CryptoMarket[]
        │       │              cryptoAdapter.fetchData(m)     → CryptoData
        │       │              cryptoAdapter.analyze(m, d)    → { dominated | skipReason }
        │       │
        │       └─ applyRiskLimits()
        │               ├─ tri par edge décroissant
        │               ├─ déduplication market_id (même marché sur 2 agents)
        │               ├─ max 15 positions par agent
        │               └─ max 8 positions par secteur granulaire
        │
        ├─ déduplication DB (getRecentOpportunities 24h)
        │
        ├─ pour chaque opportunité nouvelle :
        │       ├─ saveOpportunity()     → table opportunities
        │       ├─ savePaperTrade()      → table paper_trades  (suggested_bet, potential_pnl)
        │       └─ openPosition()        → table positions      (status='open')
        │
        ├─ sendDiscordNotification()      # fire-and-forget
        ├─ incrementDailyOpportunities()  # fire-and-forget
        └─ releaseScanLock()
```

### Batching interne de l'orchestrateur

- Chaque agent analyse ses marchés par **batches de 5** en parallèle (`Promise.all`)
- **200 ms de pause** entre chaque batch (éviter 429 sur APIs externes)
- Les 3 agents tournent en **parallèle** (`Promise.all` de agents)

---

## Agents — logique métier

### Weather Agent (`weather-agent.ts`)

**Source de données :** Open-Meteo (gratuit, sans clé)

**Modèle probabiliste :**

| Type d'outcome | Formule |
|---|---|
| `exact` / `range` | PDF gaussien : `exp(-0.5 × ((target − forecast) / σ)²)` |
| `above X` | CDF : `1 − Φ((X − forecast) / σ)` |
| `below X` | CDF : `Φ((X − forecast) / σ)` |
| `Yes/No` binaire | Résolution sémantique de la question → type ci-dessus |

**Sigma dynamique (Open-Meteo standard) :**

| Délai | σ (°C) | Confiance |
|---|---|---|
| J+1 | 1.5 | high |
| J+2 | 2.5 | medium |
| J+3+ | 3.5 | low |

**Fat tails :** `σ_final = σ × (1 + |forecast − 15°C| / 10 × 0.2)`  
Augmente l'incertitude quand la température prévue s'éloigne de la normale.

**Unité (°C / °F) :** Hiérarchie de détection : symbole dans question → symbole dans outcomes → code ICAO (K… = US = °F) → ville US connue → fallback `market.unit`.

**Cache prévisions :** `Map<"lat,lon,date", WeatherForecast>` avec TTL 10 min — plusieurs marchés pour la même ville (NYC 80°F, 81°F, 82°F) partagent un seul appel HTTP.

---

### Finance Agent (`finance-agent.ts`)

**Source de données :** Finnhub `/quote` (60 req/min gratuit, clé `FINNHUB_API_KEY`)

**Scoring :**

| Signal | UP | DOWN |
|---|---|---|
| changePercent ≥ 2% | +25 | — |
| changePercent ≥ 1% | +15 | — |
| changePercent ≥ 0.5% | +10 | — |
| changePercent ≤ −0.5% | — | +10 |
| changePercent ≤ −1% | — | +15 |
| changePercent ≤ −2% | — | +25 |
| Position > 70% du range | +10 | — |
| Position < 30% du range | — | +10 |

**Mean-reversion penalty :** Si `change > 2%` ET `marketPrice > 75%` → score × 0.5 (momentum déjà pricé).

**Probabilité estimée :** `clamp(0.55 + (upScore − downScore) / 100, 0.55, 0.85)`

**Tickers suivis :** AAPL, MSFT, GOOGL, META, NVDA, AMZN, TSLA, JPM, BAC, GS, MS, V, MA, ALLY, XOM, CVX, COP, SLB (+ autres)

---

### Crypto Agent (`crypto-agent.ts`)

**Source de données :** CoinGecko `/simple/price` (gratuit, ~30 req/min, 200ms délai)

**Scoring :**

| Signal | UP | DOWN |
|---|---|---|
| change24h ≥ 3% | +25 | — |
| change24h ≥ 1% | +15 | — |
| change24h ≤ −1% | — | +15 |
| change24h ≤ −3% | — | +25 |
| Volume spike + direction | +10 | +10 |

**Volume spike :** BTC/ETH → seuil $5B, autres → $500M.  
**Exhaustion :** Si volume > 3× seuil ET change > 5% → score × 0.3 (mouvement potentiellement épuisé).

**Probabilité estimée :** `score ≤ 20 → 0.55 | score > 20 → clamp(0.65 + (score−20)/100, 0.55, 0.85)`

**Tokens supportés :** BTC, ETH, SOL, DOGE, XRP, ADA, AVAX, DOT, LINK, UNI, ARB, OP, SUI, PEPE, SHIB, WIF, BONK, TRUMP, BNB, HYPE (+ 10 autres)

---

## Kelly Criterion — sizing des mises

Fonction : `calculateHalfKelly(probability, marketPrice, bankroll, spreadEstimate)`

```
Bankroll        = 10 USDC
GAS_FEE         = 0.01 USDC  (gas Polygon par tx)
PLATFORM_FEE    = 2%          (frais Polymarket sur gains nets)
MIN_BET_AMOUNT  = 0.10 USDC   (en dessous → pas rentable)
MAX_BET_PERCENT = 10%         (plafond par bet = 1 USDC max)

Pipeline :
  1. effectiveProbability = probability − spreadEstimate
  2. grossOdds = 1/marketPrice − 1
  3. netOdds   = grossOdds × (1 − 0.02)
  4. kellyFraction = (effectiveProbability × netOdds − (1−effectiveProbability)) / netOdds
  5. halfKelly  = kellyFraction / 2
  6. fraction   = min(halfKelly, 0.10)
  7. betAmount  = fraction × bankroll − GAS_FEE
  8. Si betAmount < 0.10 → retourner { betAmount: 0 }    ← adapters catchent ça
```

**Spread estimé par liquidité (adapters) :**

| Liquidité | Spread estimé |
|---|---|
| < $500 | 8% |
| < $2 000 | 5% |
| < $10 000 | 3% |
| ≥ $10 000 | 1.5% |

**Guard Kelly = 0 (adapters) :** Après le calcul Kelly, si `betAmount === 0` (mise trop faible pour couvrir gas + frais), l'adapter retourne `{ skipReason: "Kelly bet insuffisant" }` au lieu d'un `dominated` avec `suggestedBet: 0`. Le trade n'est jamais sauvegardé.

---

## Filtres de risque — Orchestrateur

```
applyRiskLimits(opportunities[]) :
  1. tri par edge décroissant
  2. seenMarketIds = Set<string>()
     → si market_id déjà vu → skip (même marché sur 2 agents)
  3. countByAgent[agent] ≥ 15  → skip
  4. countBySector[sector] ≥ 8 → skip
```

**Secteurs granulaires :**

| Agent | Secteur | Tokens / Tickers |
|---|---|---|
| crypto | `crypto_l1` | BTC, ETH, SOL, AVAX, ADA, DOT |
| crypto | `crypto_meme` | DOGE, SHIB, PEPE, BONK, WIF, TRUMP |
| crypto | `crypto_defi` | UNI, AAVE, LINK, MKR, CRV, ARB, OP |
| crypto | `crypto_other` | autres |
| finance | `finance_tech` | AAPL, MSFT, GOOGL, META, NVDA, AMZN, TSLA |
| finance | `finance_banks` | JPM, BAC, GS, MS, V, MA, ALLY |
| finance | `finance_energy` | XOM, CVX, COP, SLB |
| finance | `finance_other` | autres |
| weather | `weather_us` | NYC, LA, Chicago, Miami… |
| weather | `weather_eu` | Londres, Paris, Berlin… |
| weather | `weather_asia` | Tokyo, Seoul, Singapore… |
| weather | `weather_other` | autres |

**Filtre edge minimum :** `edge ≥ 7.98%` (orchestrateur) + `edge net ≥ 5%` (adapters, après spread)  
**Filtre edge suspect :** `edge > 50%` → ignoré (erreur de données probable)

---

## Pipeline check-results

```
GET /api/check-results
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
                │         → resolvePaperTrade(won=sell_pnl>=0, potential_pnl=sell_pnl)
                │         → continue  (skip résolution agent-spécifique)
                │       Cas couvert : markPaperTradeSold() avait échoué silencieusement
                │       mais la position est bien vendue dans positions
                │
                ├─ [weather] fetchActualTemperature(city, date)
                │             → API Open-Meteo archive (historical)
                │             selectTemp(outcome, highC, lowC, unit)
                │             resolveOutcome(outcome, actual, question)  → WIN|LOSE
                │
                ├─ [finance] fetchActualStockResult(ticker, date)
                │             → Finnhub /quote  → WIN|LOSE selon direction
                │
                ├─ [crypto]  fetchActualCryptoResult(token, date)
                │             → CoinGecko (résultats passés) → WIN|LOSE
                │
                ├─ fetchPolymarketOutcome(market_id)  # validation officielle
                │       → API Gamma : cherche l'outcome résolu du marché
                │       → outcomeMatch = polymarketOutcome == trade.outcome
                │
                ├─ won = outcomeMatch ?? (ourResult === "WIN")
                ├─ marketPrice  = Number(trade.market_price)   # coercition défensive
                ├─ suggestedBet = Number(trade.suggested_bet)  # coercition défensive
                ├─ pnl = computePnl(won, marketPrice, suggestedBet)
                │       won  → (1/marketPrice − 1) × suggestedBet
                │       lost → −suggestedBet
                │       bet=0 → 0
                │
                └─ resolvePaperTrade(id, { won, potential_pnl: pnl, ... })
```

---

## Pipeline monitor-positions

```
GET /api/monitor-positions
        │
        ├─ getOpenPositions()  (status IN ['open', 'hold'])
        │
        ├─ filtre par âge : positions < 30 min → ignorées (log + skip)
        │       Évite de vendre immédiatement après ouverture (entry ≈ current)
        │
        └─ pour chaque position éligible :
                ├─ fetchMarketSnapshot(market_id)  → prix actuel Gamma
                │
                ├─ calcul priceChange = |current − entry| / entry
                ├─ log debug : age=Xmin, priceChange=X%, probChange=Xpts
                │
                ├─ si priceChange < 1% :
                │       → updatePosition(HOLD) + continue
                │       Prix quasi-inchangé, pas d'évaluation
                │
                ├─ evaluatePosition(position, snapshot)
                │       SELL si probDrop ≥ 25 pts  (entryProb − currentProb)
                │       SELL si priceRatio < 0.5   (currentPrice < entryPrice × 0.5)
                │       HOLD sinon
                │
                ├─ si SELL :
                │       executeSell()         → sell_pnl = (sell−entry)/entry × bet
                │       markPaperTradeSold()  → paper_trades.actual_result = 'sold'
                │
                └─ si HOLD : updatePosition(currentPrice, currentProbability)
```

**Formule `sell_pnl` :** `(sellPrice − entryPrice) / entryPrice × suggestedBet`  
Exemple : entrée 0.40, sortie 0.60, bet 1 USDC → `(0.60−0.40)/0.40 × 1 = +0.50 USDC`  
(Les prix Polymarket sont des probabilités [0,1] — on possède des *shares*, pas des USDC directs.)

---

## Base de données Supabase

### Table `opportunities`

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | PK auto |
| `market_id` | TEXT | ID Polymarket |
| `question` | TEXT | Libellé du marché |
| `city` / `station_code` | TEXT | Météo |
| `outcome` | TEXT | Outcome ciblé |
| `market_price` | DECIMAL | Prix implicite [0,1] |
| `estimated_probability` | DECIMAL | Notre estimation |
| `edge` | DECIMAL | Différence |
| `multiplier` | DECIMAL | 1/market_price |
| `status` | TEXT | detected/bet_placed/won/lost/skipped |
| `detected_at` | TIMESTAMPTZ | Horodatage |

### Table `paper_trades`

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | PK auto |
| `market_id` | TEXT | ID Polymarket |
| `agent` | TEXT | weather/finance/crypto |
| `outcome` | TEXT | Outcome ciblé |
| `market_price` | DECIMAL | Prix d'entrée |
| `suggested_bet` | DECIMAL | Mise Kelly (USDC) |
| `confidence` | TEXT | high/medium/low |
| `resolution_date` | DATE | Date de résolution |
| `won` | BOOLEAN | NULL = en attente |
| `potential_pnl` | DECIMAL | P&L calculé à résolution |
| `actual_result` | TEXT | Description du résultat réel |
| `market_context` | JSONB | Snapshot liquidité/spread/outcomes à l'entrée |
| `expected_resolution` | TIMESTAMPTZ | Horodatage précis de résolution |
| `polymarket_outcome` | TEXT | Outcome officiel Polymarket |
| `outcome_match` | BOOLEAN | Notre prédiction = Polymarket ? |
| `resolved_at` | TIMESTAMPTZ | Horodatage de résolution |

### Table `positions`

| Colonne | Type | Description |
|---|---|---|
| `id` | UUID | PK auto |
| `paper_trade_id` | UUID | FK → paper_trades |
| `market_id` | TEXT | ID Polymarket |
| `entry_price` | DECIMAL | Prix d'entrée |
| `entry_probability` | DECIMAL | Probabilité estimée à l'entrée |
| `current_price` | DECIMAL | Dernière mise à jour |
| `status` | TEXT | open/hold/sell_signal/sold/resolved |
| `sell_reason` | TEXT | Raison du sell signal |
| `sell_price` | DECIMAL | Prix de vente |
| `sell_pnl` | DECIMAL | P&L de vente simulée |

### Table `scan_locks`

| Colonne | Type | Description |
|---|---|---|
| `id` | TEXT | PK = 'scan' (unique) |
| `locked_at` | TIMESTAMPTZ | NULL = verrou libre |
| `locked_by` | TEXT | Identifiant du process |

Timeout du verrou : **5 minutes** (libération automatique si crash).

### Table `city_coordinates` (cache géocodage)

| Colonne | Type | Description |
|---|---|---|
| `city_name` | TEXT | PK — nom normalisé minuscules |
| `latitude` | DECIMAL | |
| `longitude` | DECIMAL | |
| `country` | TEXT | |

### Table `daily_stats`

Agrège par jour : `opportunities_detected`, `bets_placed`, `wins`, `losses`, `total_pnl`.

---

## Géocodage — 3 couches

```
getCoordinates(cityName)
    │
    ├─ 1. Cache mémoire (Map)
    │       pré-peuplé depuis STATION_MAPPING (~60 codes ICAO + villes)
    │       TTL : durée de la session (pas d'expiration)
    │
    ├─ 2. Cache Supabase (table city_coordinates)
    │       persistant entre redémarrages du serveur Next.js
    │
    └─ 3. API Open-Meteo Geocoding
            https://geocoding-api.open-meteo.com/v1/search?name={city}
            → résultat persisté en Supabase pour les prochains démarrages
```

**Normalisations :** "NYC" → "New York City", "LA" → "Los Angeles", etc. (table `ABBREVIATIONS`)

---

## API Polymarket utilisées

### Gamma API (marchés)

```
GET https://gamma-api.polymarket.com/events
    ?tag_slug=weather&active=true&closed=false&order=endDate&ascending=true&limit=100

GET https://gamma-api.polymarket.com/events
    ?tag_slug=crypto&active=true&closed=false&order=startDate&ascending=false&limit=100
    # ascending=false CRITIQUE : retourne les 100 plus récents, pas les plus anciens

GET https://gamma-api.polymarket.com/markets
    ?tag_slug=finance&active=true&closed=false&order=endDate&ascending=true&limit=100
```

**Deux structures de réponse Gamma :**
- `event.markets[]` (nested) → markets dans l'event
- `event` direct sans `markets[]` → l'event lui-même est le marché

### CLOB API (ordres réels)

Non actif en mode paper trading. Utilisé pour les ordres réels via `clob-api.ts`.

---

## Variables d'environnement

```env
NEXT_PUBLIC_SUPABASE_URL     # URL projet Supabase
SUPABASE_SERVICE_ROLE_KEY    # Clé service role (bypass RLS)
FINNHUB_API_KEY              # Clé API Finnhub (gratuit)
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
| `MIN_EDGE` | 7.98% | tous les agents |
| `NET_EDGE_MIN` | 5% | adapters (après spread) |
| `MAX_EDGE_SUSPECT` | 50% | agents (filtre erreurs) |
| `maxPositionsPerAgent` | 15 | orchestrateur |
| `maxPositionsPerSector` | 8 | orchestrateur |
| `batchSize` | 5 | orchestrateur |
| `batchDelayMs` | 200ms | orchestrateur |
| `CACHE_TTL` (météo) | 10 min | `weather-sources.ts` |
| `LOCK_TIMEOUT_MS` | 5 min | `supabase.ts` |
| `AbortSignal.timeout` | 15 000ms | `weather-sources.ts` |
| `MIN_POSITION_AGE_MS` | 30 min | `monitor-positions` |
| `MIN_PRICE_CHANGE_RATIO` | 1% | `monitor-positions` |
| `probDrop` SELL seuil | 25 pts | `position-manager.ts` |
| `priceRatio` SELL seuil | < 0.5× | `position-manager.ts` |

---

## Déduplication et protections

| Mécanisme | Où | Effet |
|---|---|---|
| Verrou `scan_locks` | `scan-markets` | Empêche 2 scans simultanés |
| `getRecentOpportunities(24h)` | `scan-markets` | Ne resauvegarde pas la même opportunité en 24h |
| `seenMarketIds` Set | orchestrateur | Un market_id unique même si 2 agents le voient |
| `kelly.betAmount === 0 → skipReason` | adapters | Pas de trade sauvegardé sans mise valide |
| `Number(trade.market_price/suggested_bet)` | `check-results` | Coercition défensive contre null/undefined JS |
| `getPositionByPaperTradeId` sold-check | `check-results` | Utilise `sell_pnl` réel si vendu par Position Manager |
| `MIN_POSITION_AGE_MS` (30 min) | `monitor-positions` | Pas de vente immédiate après ouverture |
| `MIN_PRICE_CHANGE_RATIO` (1%) | `monitor-positions` | Pas d'évaluation si le prix n'a pas bougé |
| `edge > 50%` → skip | agents | Filtre les erreurs de données |
| `marketPrice < 0.01 \|\| > 0.99` → skip | agents | Filtre les marchés déjà résolus |

---

## Notifications Discord

Envoyées après chaque scan avec opportunités. Payload par opportunité :

```
city/ticker/token | outcome | marketPrice | estimatedProbability | edge | multiplier | suggestedBet
```

Groupées par messages de 10 embeds (limite API Discord). Fire-and-forget (erreurs ignorées).

---

## Pages UI

### `/` — Dashboard scan

- Bouton "Lancer le scan" → `GET /api/scan-markets`
- Stats : marchés scannés, opportunités, edge moyen, sauvegardés
- Breakdown par agent (weather/finance/crypto)
- Cards opportunités avec edge coloré (vert ≥ 15%, jaune ≥ 10%, rouge sinon)
- Table marchés ignorés (repliable)

### `/results` — Historique paper trades

- Liste tous les paper trades (résolus + en attente)
- Filtre par agent, statut, période
- P&L cumulé

### `/positions` — Positions ouvertes

- Positions open/hold/sell_signal
- Prix d'entrée vs prix courant
- Sell signals actifs
