# Architecture — Polymarket WeatherBot

> Dernière mise à jour : 2026-04-23  
> Stack : Next.js 15 · React 19 · TypeScript 5 · Supabase · Tailwind CSS 4 · Claude Sonnet 4.6

---

## Contexte — Historique des décisions

| Date | Décision | Raison |
|------|----------|--------|
| 2026-04-18 | Crypto désactivé | WR 26.4%, P&L −87€ |
| 2026-04-18 | Finance en shadow mode | WR ~38% |
| 2026-04-18 | Seuils relevés, volume réduit | Paper trading catastrophique (WR 39.8%, P&L −85€) |
| 2026-04-20 | Finance retiré du registre | Shadow mode insuffisant — trades pollution |
| 2026-04-20 | Dashboard WeatherBot + bot state DB | Contrôle manuel du bot via UI |
| 2026-04-23 | Mode lu depuis bot_state (DB) | process.env.TRADING_MODE ignoré pour les scans |
| 2026-04-23 | Multi-model forecasting (GFS+ECMWF+UKMO+Ensemble) | Précision accrue |
| 2026-04-23 | Filtre liquidité supprimé | Alignement WeatherBot.finance |
| 2026-04-23 | Bet size cap 5% liquidité | Éviter le slippage |
| 2026-04-23 | Tri marchés par horizon de résolution | Forecasts plus fiables en premier |

---

## Vue d'ensemble

```
Vercel Crons
  ├── /api/scan-markets      (*/15 min)   ← pipeline principal
  ├── /api/monitor-positions (*/5 min)    ← exit system 6 couches
  ├── /api/check-results     (08h00 UTC)  ← résolution des trades
  └── /api/post-mortem       (*/6h)       ← analyse post-trade Claude
```

---

## Structure des fichiers

```
src/
├── app/
│   ├── page.tsx                     Dashboard WeatherBot (polling /api/bot/status toutes les 5s)
│   ├── layout.tsx
│   ├── results/page.tsx             Historique des trades résolus
│   ├── positions/page.tsx           Positions ouvertes
│   └── api/
│       ├── bot/
│       │   ├── start/route.ts       POST — démarre le bot (bot_state.is_running=true)
│       │   ├── stop/route.ts        POST — arrête le bot
│       │   └── status/route.ts      GET  — état + stats live (win rate, P&L, positions)
│       ├── settings/
│       │   └── mode/route.ts        POST — change bot_state.mode en DB
│       ├── scan-markets/route.ts    GET  — pipeline de scan complet (cron */15min)
│       ├── monitor-positions/route.ts GET — évalue les positions ouvertes (cron */5min)
│       ├── check-results/route.ts   GET  — résolution Polymarket (cron 8h)
│       ├── post-mortem/route.ts     GET  — analyse post-trade (cron */6h)
│       ├── analyze-top/route.ts     POST — analyse ad-hoc top marchés
│       ├── dashboard-stats/route.ts GET  — stats dashboard (legacy)
│       ├── positions/route.ts       GET  — positions ouvertes (JSON)
│       ├── trades/recent/route.ts   GET  — derniers 20 trades
│       ├── logs/recent/route.ts     GET  — derniers 50 logs activité
│       └── debug-filters/route.ts   GET  — diagnostic filtres + liquidité cap
│
├── components/
│   └── dashboard/
│       ├── BotControls.tsx          Start/Stop + indicateur statut + last scan
│       ├── TradingModeSelector.tsx  3 modes (désactivé si bot running)
│       ├── LiveStats.tsx            6 KPI cards (win rate, P&L, trades, positions)
│       ├── PositionsTable.tsx       Positions ouvertes (refresh 10s)
│       ├── RecentTrades.tsx         Derniers trades WIN/LOSS/Pending (refresh 10s)
│       └── ActivityLog.tsx          Log activité coloré scan/trade/skip/error (refresh 5s)
│
└── lib/
    ├── agents/
    │   ├── orchestrator.ts           Gestion agents, circuit breaker, shadow mode
    │   ├── weather-agent.ts          Probabilité gaussienne/ensemble, parseOutcomeForMarket
    │   ├── claude-analyst.ts         Appel Claude Sonnet avec MarketContext complet
    │   ├── post-mortem-agent.ts      Génère leçons post-trade via Claude
    │   ├── finance-agent.ts          Scoring momentum actions (non enregistré)
    │   ├── crypto-agent.ts           Désactivé — WR 26.4%, P&L −87€
    │   └── adapters/
    │       ├── weather-adapter.ts    Agent actif — pipeline complet avec Claude + multi-model
    │       ├── finance-adapter.ts    Non enregistré dans scan depuis 2026-04-20
    │       └── crypto-adapter.ts    Import commenté depuis 2026-04-18
    ├── bot/
    │   └── bot-state.ts              CRUD bot_state Supabase (getBotState/startBot/stopBot/setMode)
    ├── config/
    │   └── trading-modes.ts          3 modes + seuils, isConfidenceAtLeast()
    ├── data/
    │   ├── airport-stations.ts       Ville → ICAO, lat, lon (getAirportStation)
    │   └── station-mapping.ts        Mapping codes stations météo
    ├── data-sources/
    │   ├── weather-sources.ts        Open-Meteo GFS + cache mémoire 10min
    │   ├── multi-model-weather.ts    GFS + ECMWF + UKMO + Ensemble (cache 15min)
    │   ├── finance-sources.ts        Finnhub API
    │   ├── crypto-sources.ts         CoinGecko API
    │   └── geocoding.ts              Géocodage 3 couches (mémoire → Supabase → API)
    ├── db/
    │   ├── supabase.ts               Singleton getClient() exporté + CRUD
    │   ├── positions.ts              CRUD table positions
    │   └── lessons.ts                CRUD lessons, calibration, performances
    ├── logger.ts                     logActivity(type, message) → table activity_logs
    ├── positions/
    │   └── position-manager.ts       evaluatePosition() — exit system 6 couches (logique pure)
    ├── polymarket/
    │   ├── gamma-api.ts              fetchAllWeatherMarkets() + fetchMarketSnapshot()
    │   └── clob-api.ts               Ordres réels (non actif en paper trading)
    └── utils/
        ├── kelly.ts                  BANKROLL + calculateHalfKelly()
        ├── sizing.ts                 calculateBetSize() — cap 5% liquidité
        └── discord.ts                Notifications webhook Discord
```

---

## Pipeline de scan (`/api/scan-markets`)

```
GET /api/scan-markets
  │
  ├─ getBotState()
  │     is_running === false → return { skipped: true }
  │
  ├─ setWeatherAdapterMode(botState.mode)   ← mode depuis DB, PAS process.env
  ├─ logActivity('scan', 'Scan started (mode: X)')
  ├─ acquireScanLock()                      ← anti-double exécution
  │
  ├─ orchestrator.scanAllMarkets()
  │     │
  │     ├─ [CIRCUIT BREAKER]
  │     │     getAgentPerformance24h() → auto-shadow si WR < 40% ou P&L < −15€
  │     │
  │     └─ weatherAdapter (seul agent enregistré)
  │           a. fetchMarkets()
  │                fetchAllWeatherMarkets() via Gamma API
  │                filtre consensus fort (≥ 90%)
  │                tri ASC par endDate (résolution la plus proche en premier)
  │           b. fetchData(market)
  │                fetchForecastForStation()      GFS Open-Meteo (cache 10min)
  │                fetchEnsembleForecast()        GFS Ensemble (si ville connue)
  │                fetchMultiModelForecast()      GFS+ECMWF+UKMO+Ensemble (cache 15min)
  │           c. analyze(market, data)
  │                ① Date invalide → skip
  │                ② Horizon < 1h → skip
  │                   balanced > 24h → skip
  │                   tout mode > 48h → skip
  │                ③ Anti-favori > 70% → skip
  │                ④ Multi-model agreement "weak" → skip
  │                ⑤ analyzeMarket() → probabilité gaussienne/ensemble
  │                ⑥ Multi-model override si écart > 2%
  │                ⑦ Edge bonus: ≤6h ×1.2 | ≤12h ×1.1
  │                ⑧ [scan-debug log] city, edge, net edge, yesPrice, noPrice, prob, liq, hours
  │                ⑨ Anti-churn: hasRecentTradeForCityDate() → skip
  │                ⑩ Filtre YES/NO price (mode-based) + log activité SKIP
  │                ⑪ Filtre edge net = gross − spread (mode-based) + log activité SKIP
  │                ⑫ Claude AI (MarketContext: multi-model, lessons, calibration, perfs)
  │                   SKIP → log activité SKIP avec raison Claude
  │                ⑬ Filtre confiance Claude (mode-based) + log activité SKIP
  │                ⑭ calculateBetSize(kelly, liquidity, bankroll, maxBetPercent)
  │
  ├─ déduplication DB (getRecentOpportunities 24h)
  ├─ pour chaque opportunité weather :
  │     saveOpportunity() + savePaperTrade() + openPosition()
  │     logActivity('trade', 'TRADE: city outcome @ price (edge, bet, conf)')
  ├─ logActivity('skip', ...) pour skips orchestrateur
  ├─ logActivity('info', 'Scan complete: X trades, Y saved, Z skipped')
  ├─ sendDiscordNotification()     fire-and-forget
  ├─ updateLastScan()
  └─ releaseScanLock()
```

---

## Trading Modes

Stocké dans `bot_state.mode` (Supabase). Lu dans `scan-markets` puis propagé via `setWeatherAdapterMode()`.  
**Ne jamais utiliser `process.env.TRADING_MODE` pour les scans** — c'est uniquement un fallback si bot_state est absent.

| Mode | YES max | edge min | confiance min | bet max |
|------|---------|----------|---------------|---------|
| `balanced` | 15¢ | 10% | MEDIUM | 5% bankroll |
| `aggressive` | 50¢ | 8% | LOW | 10% bankroll |
| `high_conviction` | 15¢ | 15% | VERY_HIGH | 5% bankroll |

**Horizon par mode :**
- `balanced` : 1h–24h (même jour uniquement)
- `aggressive` / `high_conviction` : 1h–48h

---

## Bet Sizing

Pas de filtre liquidité strict — la liquidité module uniquement la mise.

```
kellyBet      = BANKROLL × (claudeSize/10) × mode.maxBetPercent
liquidityCap  = market.liquidity × 0.05      // 5% de la liquidité disponible
bankrollCap   = BANKROLL × mode.maxBetPercent
finalBet      = min(kellyBet, liquidityCap, bankrollCap)
finalBet      = max(0.10$, round(finalBet, 2))
```

`claudeSize` = 1–10 fourni par Claude dans MarketContext.

---

## Multi-Model Weather

Source : Open-Meteo (gratuit, sans clé API).

| Modèle | Poids consensus |
|--------|----------------|
| ECMWF | 40% |
| GFS | 30% |
| UKMO | 20% |
| GFS Ensemble | 10% |

**Accord des modèles :**
- `strong` : spread < 1°C — trade autorisé
- `moderate` : spread < 2°C — trade autorisé
- `weak` : spread ≥ 2°C — **skip systématique**

**Calcul probabilité :**
- ≥ 20 membres ensemble → comptage direct des membres
- < 20 membres → Gaussienne sur consensus pondéré

**Cache :** 15 min en mémoire par (lat, lon, date).

**Coordonnées :** uniquement via `getAirportStation(city)` — WeatherMarket n'a pas de lat/lon.

---

## Edge Bonus Horizon

Les marchés proches ont des forecasts plus fiables :

| Délai résolution | Multiplicateur edge |
|------------------|---------------------|
| ≤ 6h | ×1.2 (+20%) |
| ≤ 12h | ×1.1 (+10%) |
| > 12h | ×1.0 (pas de bonus) |

Appliqué après le multi-model override, avant les filtres de mode.

---

## Position Exit System (6 couches)

Évalué par `/api/monitor-positions` (cron */5 min) via `evaluatePosition()` :

| Layer | Condition | Urgence |
|-------|-----------|---------|
| 1 | Grace period < 5 min | HOLD (toujours) |
| 2 | P&L ≤ −50% | critical |
| 3 | P&L ≤ −25% après 15 min | high |
| 4 | Prix ≥ 80% edge capturé ET résolution < 2h | medium |
| 5 | Trailing stop : peak ≥ +30% puis chute −15% | medium |
| 6 | Time decay : résolution < 1h ET P&L < −10% | high |

`evaluatePosition()` est une fonction pure (pas d'I/O) dans `position-manager.ts`.

---

## Agents

| Agent | Statut | Depuis | Raison |
|-------|--------|--------|--------|
| Weather | Actif | — | Pipeline principal |
| Finance | Non enregistré | 2026-04-20 | Créait des trades non désirés |
| Crypto | Import commenté | 2026-04-18 | WR 26.4%, P&L −87€ |

**Circuit breaker** (orchestrator) : auto-shadow si WR < 40% sur ≥ 10 trades OU P&L < −15€/24h.  
**Promotion shadow → actif** : WR > 55% + P&L théorique > 0 sur ≥ 20 trades shadow.

---

## Bot State — Dashboard

`page.tsx` est un client React qui poll `/api/bot/status` toutes les 5s.

| Action | Endpoint | Effet |
|--------|----------|-------|
| Start Bot | `POST /api/bot/start` | `bot_state.is_running = true` |
| Stop Bot | `POST /api/bot/stop` | `bot_state.is_running = false` |
| Changer mode | `POST /api/settings/mode` | `bot_state.mode = X` |
| Scanner | `GET /api/scan-markets` | Lance scan si bot running |

**Contrainte UI :** mode selector désactivé si bot running. Scan button désactivé si bot stopped.

---

## Supabase — Tables

| Table | Usage |
|-------|-------|
| `bot_state` | État du bot — 1 ligne `id='default'` (is_running, mode, last_scan_at) |
| `paper_trades` | Trades weather uniquement (finance/crypto exclus depuis 2026-04-20) |
| `positions` | Positions ouvertes (`sold_at IS NULL` = ouvert) |
| `opportunities` | Toutes les opportunités avec déduplication 24h |
| `activity_logs` | Logs scan/trade/skip/error — purge après 24h |
| `lessons` | Post-mortems Claude — calibration confiance par ville |
| `daily_stats` | Métriques journalières agrégées |
| `scan_locks` | Anti-double exécution (timeout 5 min) |

**Tables requises créées manuellement (pas dans le code) :**
```sql
CREATE TABLE IF NOT EXISTS bot_state (
  id            TEXT PRIMARY KEY DEFAULT 'default',
  is_running    BOOLEAN DEFAULT false,
  mode          TEXT DEFAULT 'balanced',
  started_at    TIMESTAMPTZ,
  last_scan_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO bot_state (id) VALUES ('default') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS activity_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       TEXT NOT NULL,         -- scan|trade|skip|error|info|exit
  message    TEXT NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_activity_logs_created ON activity_logs(created_at DESC);
```

---

## Activity Logs — Format

| Type | Format message |
|------|---------------|
| `scan` | `Scan started (mode: aggressive)` |
| `info` | `SCAN: London edge=11.4% net=8.4% \| Yes @ 23¢ prob=34.5% \| liq=$4200 18.3h` |
| `skip` | `SKIP: London - Edge net 8.4% < 10% (mode: balanced) (edge=8.4%, price=23¢)` |
| `skip` | `SKIP: Paris - Claude SKIP: reason (edge=X%, price=Y¢)` |
| `trade` | `TRADE: NYC Yes @ 12¢ (edge=14.3%, bet=$0.34, conf=high)` |
| `info` | `Scan complete: 2 trades, 2 saved, 47 skipped` |

---

## Claude AI — MarketContext

```typescript
interface MarketContext {
  question, city, targetDate, outcomes, prices
  forecasts: { gfs, ensemble: { mean, min, max, stdDev, members } }
  multiModel: { consensus, agreement, spreadDegrees, gfs?, ecmwf?, ukmo?, method, probability }
  gaussianEdge, measureType
  recentPerformance: { cityWinRate, overallWinRate, last7DaysPnL }
  lessons:               string[]   // dernières 20 leçons post-mortem
  confidenceCalibration: object     // calibration par niveau de confiance
}
```

Claude retourne : `{ decision: "TRADE"|"SKIP", confidence: "VERY_HIGH"|"HIGH"|"MEDIUM"|"LOW", size: 1-10, reason, risks[], edgeEstimate? }`

---

## Variables d'environnement

```env
NEXT_PUBLIC_SUPABASE_URL      URL projet Supabase
SUPABASE_SERVICE_ROLE_KEY     Clé service (server-side uniquement, bypass RLS)
ANTHROPIC_API_KEY             Claude Sonnet 4.6
DISCORD_WEBHOOK_URL           Notifications (optionnel)
TRADING_MODE                  Fallback uniquement si bot_state absent (défaut: balanced)
FINNHUB_API_KEY               Finance agent (shadow mode, optionnel)
```

---

## Constantes clés

| Constante | Valeur | Fichier |
|-----------|--------|---------|
| `BANKROLL` | 10 USDC | `kelly.ts` |
| `MAX_RESOLUTION_HOURS` | 48h | `weather-adapter.ts` |
| Filtre consensus | ≥ 90% | `weather-adapter.ts` (fetchMarkets) |
| Anti-favori | > 70% | `weather-adapter.ts` (analyze) |
| Liquidity cap | 5% de la liquidité | `sizing.ts` |
| Multi-model cache TTL | 15 min | `multi-model-weather.ts` |
| Weather cache TTL | 10 min | `weather-sources.ts` |
| Scan lock timeout | 5 min | `supabase.ts` |
| Grace period | 5 min | `position-manager.ts` |
| `maxPositionsPerAgent` | 3 | `orchestrator.ts` |
| `maxPositionsPerSector` | 8 | `orchestrator.ts` |
| `batchSize` | 5 | `orchestrator.ts` |
| Circuit breaker WR | < 40% / ≥ 10 trades | `orchestrator.ts` |
| Circuit breaker P&L | < −15€/24h | `orchestrator.ts` |

---

## API externes

| API | Usage | Auth | Limite |
|-----|-------|------|--------|
| Open-Meteo Forecast | GFS + ECMWF + UKMO + Ensemble | — | Gratuit |
| Open-Meteo Archive | Températures réelles (check-results) | — | Gratuit |
| Open-Meteo Geocoding | Ville → coords | — | Gratuit |
| Polymarket Gamma API | Marchés météo, outcomes, résolutions | — | Non documentée |
| Anthropic API | Claude Sonnet 4.6 (analyse + post-mortem) | `ANTHROPIC_API_KEY` | Pay-per-use |
| Discord Webhook | Notifications | `DISCORD_WEBHOOK_URL` | — |
| Finnhub | Prix actions (finance, shadow) | `FINNHUB_API_KEY` | 60 req/min |
