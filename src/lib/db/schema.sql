-- ============================================================
-- Schema Supabase — Polymarket Weather Agents
-- À exécuter dans l'éditeur SQL de Supabase (une seule fois).
-- ============================================================

-- ------------------------------------------------------------
-- Opportunités détectées par les agents
-- Chaque ligne = un outcome d'un marché identifié comme sous-pricé.
-- Une même opportunité peut apparaître plusieurs jours de suite
-- si le marché n'est pas encore résolu (detected_at les distingue).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
  id                   UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  market_id            TEXT         NOT NULL,
  question             TEXT,
  city                 TEXT,
  station_code         TEXT,
  outcome              TEXT         NOT NULL,
  market_price         DECIMAL      NOT NULL,
  estimated_probability DECIMAL     NOT NULL,
  edge                 DECIMAL      NOT NULL,
  multiplier           DECIMAL      NOT NULL,
  detected_at          TIMESTAMPTZ  DEFAULT NOW(),
  -- detected   : trouvée, pas encore de bet
  -- bet_placed : un ordre a été passé
  -- won        : marché résolu en notre faveur
  -- lost       : marché résolu contre nous
  -- skipped    : ignorée volontairement (ex: liquidité insuffisante)
  status               TEXT         DEFAULT 'detected'
    CHECK (status IN ('detected', 'bet_placed', 'won', 'lost', 'skipped')),
  -- Remplis par check-results lors de la résolution du marché
  actual_result        DECIMAL,     -- température réelle observée (°C)
  pnl                  DECIMAL      -- P&L en USDC (positif = gain, négatif = perte)
);

CREATE INDEX IF NOT EXISTS opportunities_market_id_idx  ON opportunities (market_id);
CREATE INDEX IF NOT EXISTS opportunities_detected_at_idx ON opportunities (detected_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_status_idx      ON opportunities (status);

-- Migration : à exécuter si la table opportunities existe déjà sans ces colonnes
-- ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS actual_result DECIMAL;
-- ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS pnl DECIMAL;

-- ------------------------------------------------------------
-- Bets placés sur le CLOB
-- Référence l'opportunité source ; mise à jour à la résolution.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bets (
  id             UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  opportunity_id UUID         REFERENCES opportunities(id) ON DELETE SET NULL,
  amount         DECIMAL      NOT NULL,           -- mise en USDC
  entry_price    DECIMAL      NOT NULL,           -- prix d'entrée [0, 1]
  placed_at      TIMESTAMPTZ  DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  result_price   DECIMAL,                         -- prix final à résolution
  pnl            DECIMAL,                         -- P&L en USDC (positif = gain)
  -- pending : ordre ouvert
  -- won     : résolu gagnant
  -- lost    : résolu perdant
  status         TEXT         DEFAULT 'pending'
    CHECK (status IN ('pending', 'won', 'lost'))
);

CREATE INDEX IF NOT EXISTS bets_opportunity_id_idx ON bets (opportunity_id);
CREATE INDEX IF NOT EXISTS bets_status_idx         ON bets (status);
CREATE INDEX IF NOT EXISTS bets_placed_at_idx      ON bets (placed_at DESC);

-- ------------------------------------------------------------
-- Statistiques agrégées par jour
-- UNIQUE sur date → upsert idempotent depuis le cron.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_stats (
  id                      UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  date                    DATE    UNIQUE NOT NULL,
  opportunities_detected  INT     DEFAULT 0,
  bets_placed             INT     DEFAULT 0,
  wins                    INT     DEFAULT 0,
  losses                  INT     DEFAULT 0,
  total_pnl               DECIMAL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS daily_stats_date_idx ON daily_stats (date DESC);

-- ------------------------------------------------------------
-- Paper trades — bets virtuels pour backtesting / paper mode
-- Chaque ligne = un bet virtuel sur une opportunité détectée.
-- resolved quand won IS NOT NULL.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trades (
  id                    UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  market_id             TEXT         NOT NULL,
  question              TEXT,
  city                  TEXT,
  ticker                TEXT,
  agent                 TEXT         NOT NULL CHECK (agent IN ('weather', 'finance', 'crypto')),
  outcome               TEXT         NOT NULL,
  market_price          DECIMAL      NOT NULL,
  estimated_probability DECIMAL      NOT NULL,
  edge                  DECIMAL      NOT NULL,
  suggested_bet         DECIMAL      NOT NULL,
  confidence            TEXT,
  created_at            TIMESTAMPTZ  DEFAULT NOW(),
  resolution_date       DATE,
  -- Remplis par check-results lors de la résolution
  actual_result         TEXT,        -- ex: "high=22.3°C" ou "close=+1.2%"
  won                   BOOLEAN,
  potential_pnl         DECIMAL,     -- gain potentiel si won (calculé à la création)
  resolved_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS paper_trades_market_id_idx   ON paper_trades (market_id);
CREATE INDEX IF NOT EXISTS paper_trades_created_at_idx  ON paper_trades (created_at DESC);
CREATE INDEX IF NOT EXISTS paper_trades_resolution_idx  ON paper_trades (resolution_date);
CREATE INDEX IF NOT EXISTS paper_trades_agent_idx       ON paper_trades (agent);
CREATE INDEX IF NOT EXISTS paper_trades_won_idx         ON paper_trades (won) WHERE won IS NULL;

-- ------------------------------------------------------------
-- Cache géocodage — coordonnées persistées par nom de ville
-- Évite des appels répétés à l'API Open-Meteo Geocoding.
-- Pré-peuplé automatiquement depuis station-mapping.ts au
-- démarrage de l'application (cache mémoire) ; les nouvelles
-- villes découvertes via l'API sont insérées ici pour survivre
-- aux redémarrages du serveur.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS city_coordinates (
  city_name   TEXT         PRIMARY KEY,   -- nom normalisé en minuscules
  latitude    DECIMAL      NOT NULL,
  longitude   DECIMAL      NOT NULL,
  country     TEXT,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS city_coordinates_created_at_idx ON city_coordinates (created_at DESC);
