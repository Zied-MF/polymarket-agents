/**
 * Orchestrator — chef des agents Weather, Finance et Crypto
 *
 * Chaque agent s'enregistre avec une interface AgentConfig qui sépare
 * proprement trois responsabilités :
 *   1. fetchMarkets()         : récupère et filtre les marchés éligibles
 *   2. fetchData?(market)     : récupère les données externe (météo, prix…)
 *   3. analyze(market, data?) : évalue le marché et retourne { dominated, skipReason }
 *
 * Pipeline — PARALLÈLE :
 *   Tous les agents s'exécutent en même temps via Promise.all.
 *   À l'intérieur de chaque agent, les marchés sont analysés par batch de 10
 *   (Promise.all par batch) pour éviter de saturer les APIs externes.
 *
 * Risk limits : max 15 positions par agent, triées par edge décroissant.
 */

import { getAgentPerformance24h, getShadowPerformance, saveShadowTrade } from "@/lib/db/supabase";

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export type AgentType = "weather" | "finance" | "crypto";

export interface Opportunity {
  marketId:             string;
  question:             string;
  outcome:              string;
  marketPrice:          number;
  estimatedProbability: number;
  edge:                 number;
  suggestedBet:         number;
  /**
   * Bet basé sur le bankroll paper (composé, non-réel).
   * Présent uniquement en real trading mode, pour créer un trade de comparaison.
   * Absent en paper mode (suggestedBet et paperSuggestedBet seraient identiques).
   */
  paperSuggestedBet?:   number;
  confidence:           "high" | "medium" | "low" | undefined;
  agent:                AgentType;
  /** Nom de la ville (météo). */
  city?:    string;
  /** Ticker boursier (finance) ou symbole token (crypto). */
  ticker?:  string;
  /** Symbole du token CoinGecko (crypto). */
  token?:   string;
  /** Date de résolution (ISO-10). */
  targetDate?: string;
  /** Date+heure de résolution complète (ISO-8601) — pour expected_resolution. */
  targetDateTime?: string;
  /** Contexte du marché au moment du bet — pour post-mortem. */
  marketContext?: Record<string, unknown>;
}

export interface SkippedMarket {
  marketId: string;
  question: string;
  reason:   string;
  agent:    string;
}

/** Retour de analyze() — dominant opportunity ou raison du skip. */
export interface AnalyzeResult {
  dominated?:  Opportunity;
  skipReason?: string;
}

export interface AgentConfig {
  name: string;
  type: AgentType;
  fetchMarkets: () => Promise<unknown[]>;
  analyze: (market: unknown, data?: unknown) => Promise<AnalyzeResult | null>;
  /** Si présent, appelé entre fetchMarkets et analyze pour récupérer les données du marché. */
  fetchData?: (market: unknown) => Promise<unknown>;
}

export interface AgentStats {
  scanned:       number;
  opportunities: number;
}

export interface ScanResult {
  opportunities: Opportunity[];
  skipped:       SkippedMarket[];
  byAgent:       Record<string, AgentStats>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

class Orchestrator {
  private agents: AgentConfig[] = [];

  // Qualité > quantité après paper trading catastrophique (WR 39.8%, -85€)
  private readonly maxPositionsPerAgent  = 3;
  private readonly maxPositionsPerSector = 8;
  private readonly minEdge               = 0.12; // 12% — seuil relevé
  private readonly batchSize             = 5;
  private readonly batchDelayMs          = 200;

  /**
   * Agents en shadow mode : ils scannent et analysent mais ne créent aucun trade.
   * Permet de monitorer la qualité du signal sans risque capital.
   * Pré-peuplé avec crypto et finance (WR < 40% historique).
   */
  private shadowModeAgents: Set<AgentType> = new Set(["crypto", "finance"]);

  /**
   * Enregistre un agent. Idempotent : un même `agent.name` n'est ajouté qu'une fois.
   * Pratique avec le hot-reload Next.js en développement.
   */
  registerAgent(agent: AgentConfig): void {
    if (this.agents.some((a) => a.name === agent.name)) return;
    this.agents.push(agent);
    console.log(`[orchestrator] ✓ Agent registered: ${agent.name}`);
  }

  /**
   * Lance le scan PARALLÈLE avec tous les agents enregistrés.
   *
   * Avant le scan :
   *   1. Circuit breaker — désactive automatiquement les agents en difficulté (24h)
   *   2. Shadow mode — les agents désactivés analysent mais ne créent aucun trade
   *
   * Pendant le scan :
   *   - Les agents actifs tournent en parallèle (Promise.all)
   *   - Les marchés d'un même agent sont traités par batches de 5
   */
  async scanAllMarkets(agentTypes?: AgentType[]): Promise<ScanResult> {
    const agentsToRun = agentTypes
      ? this.agents.filter((a) => agentTypes.includes(a.type))
      : this.agents;

    // ── Circuit breaker — séquentiel avant le scan ──────────────────────────
    for (const agent of agentsToRun) {
      try {
        const perf = await getAgentPerformance24h(agent.type);
        if (perf.trades >= 10 && perf.winRate < 40) {
          console.log(
            `[orchestrator] ⛔ AUTO-DISABLE: ${agent.name} ` +
            `(WR ${perf.winRate}% < 40% sur ${perf.trades} trades)`
          );
          this.shadowModeAgents.add(agent.type);
        } else if (perf.pnl < -15) {
          console.log(
            `[orchestrator] ⛔ AUTO-DISABLE: ${agent.name} ` +
            `(P&L ${perf.pnl}€ < −15€ sur 24h)`
          );
          this.shadowModeAgents.add(agent.type);
        }
      } catch (err) {
        console.warn(
          `[orchestrator] circuit breaker check échoué pour ${agent.name} — scan maintenu :`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // ── Promotion shadow → actif ─────────────────────────────────────────────
    for (const agentType of [...this.shadowModeAgents]) {
      try {
        const shadowPerf = await getShadowPerformance(agentType, 20);
        if (shadowPerf.trades >= 20 && shadowPerf.winRate > 55 && shadowPerf.theoreticalPnl > 0) {
          console.log(
            `[orchestrator] 🎉 PROMOTION: ${agentType} réactivé ` +
            `(WR ${shadowPerf.winRate}%, P&L théorique +${shadowPerf.theoreticalPnl}€ sur ${shadowPerf.trades} trades)`
          );
          this.shadowModeAgents.delete(agentType);
        } else if (shadowPerf.trades > 0) {
          console.log(
            `[orchestrator] 👻 ${agentType} reste en shadow ` +
            `(WR ${shadowPerf.winRate}%, P&L ${shadowPerf.theoreticalPnl}€ sur ${shadowPerf.trades}/${20} trades requis)`
          );
        }
      } catch (err) {
        console.warn(
          `[orchestrator] promotion check échoué pour ${agentType}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    console.log(
      `[orchestrator] Starting PARALLEL scan with ${agentsToRun.length} agents ` +
      `(shadow: [${[...this.shadowModeAgents].join(", ")}])…`
    );

    // ── Scan parallèle ───────────────────────────────────────────────────────
    const results = await Promise.all(
      agentsToRun.map(async (agent) => {
        console.log(`[orchestrator] Starting ${agent.name}…`);
        const startTime = Date.now();

        try {
          const markets = await agent.fetchMarkets();
          const opportunities: Opportunity[] = [];
          const skipped:       SkippedMarket[] = [];

          for (let i = 0; i < markets.length; i += this.batchSize) {
            const batch = markets.slice(i, i + this.batchSize);
            const batchResults = await Promise.all(
              batch.map((market) => this.analyzeMarket(agent, market))
            );
            for (const r of batchResults) {
              if (r.opportunity) opportunities.push(r.opportunity);
              if (r.skipped)     skipped.push(r.skipped);
            }
            if (i + this.batchSize < markets.length) {
              await new Promise<void>((r) => setTimeout(r, this.batchDelayMs));
            }
          }

          // ── Shadow mode : analyse complète, sauvegarde shadow, zéro trade réel ──
          if (this.shadowModeAgents.has(agent.type)) {
            console.log(
              `[orchestrator] 👻 SHADOW MODE: ${agent.name} — ` +
              `${opportunities.length} opportunités détectées en ${Date.now() - startTime}ms`
            );

            // Sauvegarder les meilleures opportunités shadow pour tracking (max 5)
            const toSave = opportunities.slice(0, 5);
            await Promise.allSettled(
              toSave.map(async (opp) => {
                const ref   = opp.targetDateTime ?? opp.targetDate;
                const hours = ref
                  ? (new Date(ref).getTime() - Date.now()) / (1000 * 60 * 60)
                  : 0;
                console.log(
                  `[orchestrator][shadow]   "${opp.question.slice(0, 50)}…" ` +
                  `edge=${(opp.edge * 100).toFixed(1)}% horizon=${Math.round(hours)}h`
                );
                await saveShadowTrade({
                  marketId:             opp.marketId,
                  question:             opp.question,
                  agent:                opp.agent,
                  outcome:              opp.outcome,
                  marketPrice:          opp.marketPrice,
                  estimatedProbability: opp.estimatedProbability,
                  edge:                 opp.edge,
                  suggestedBet:         opp.suggestedBet,
                  confidence:           opp.confidence,
                  targetDate:           opp.targetDate,
                  targetDateTime:       opp.targetDateTime,
                  ticker:               opp.ticker,
                  city:                 opp.city,
                  hoursToResolution:    hours,
                  marketContext:        opp.marketContext,
                });
              })
            );

            return {
              agent:          agent.type,
              opportunities:  [],
              skipped,
              scanned:        markets.length,
              shadowMode:     true,
              shadowDetected: opportunities.length,
            };
          }

          console.log(
            `[orchestrator] ${agent.name} done in ${Date.now() - startTime}ms: ` +
            `${opportunities.length} opportunities from ${markets.length} markets`
          );
          return {
            agent:        agent.type,
            opportunities,
            skipped,
            scanned:      markets.length,
            shadowMode:   false,
            shadowDetected: 0,
          };
        } catch (err) {
          console.error(`[orchestrator] ${agent.name} failed:`, err instanceof Error ? err.message : err);
          return {
            agent:        agent.type,
            opportunities: [],
            skipped:      [],
            scanned:      0,
            shadowMode:   false,
            shadowDetected: 0,
          };
        }
      })
    );

    // ── Combiner ─────────────────────────────────────────────────────────────
    const allOpportunities = results.flatMap((r) => r.opportunities);
    const allSkipped       = results.flatMap((r) => r.skipped);
    const byAgent: Record<string, AgentStats> = Object.fromEntries(
      results.map((r) => [r.agent, { scanned: r.scanned, opportunities: r.opportunities.length }])
    );

    const beforeCount = allOpportunities.length;
    const filtered    = this.applyRiskLimits(allOpportunities);
    if (beforeCount > filtered.length) {
      console.log(`[orchestrator] Risk limits applied: ${beforeCount} → ${filtered.length} opportunities`);
    }

    const avgEdge = filtered.length > 0
      ? Math.round(filtered.reduce((s, o) => s + o.edge, 0) / filtered.length * 1000) / 10
      : 0;

    // ── État final des agents ─────────────────────────────────────────────────
    console.log(`[orchestrator] === ÉTAT DES AGENTS ===`);
    for (const r of results) {
      const mode    = r.shadowMode ? "👻 SHADOW" : "✅ ACTIF ";
      const details = r.shadowMode
        ? `${r.shadowDetected} détectées (non enregistrées)`
        : `${r.opportunities.length} opportunités enregistrées`;
      console.log(`[orchestrator]   ${mode} ${r.agent.padEnd(8)} — ${r.scanned} marchés, ${details}`);
    }
    console.log(`[orchestrator] Scan complet : ${filtered.length} trade(s) (edge moy. ${avgEdge}%)`);

    return { opportunities: filtered, skipped: allSkipped, byAgent };
  }

  /**
   * Analyse un seul marché via un agent.
   * Retourne { opportunity } ou { skipped } ou {} (si résultat null).
   */
  private async analyzeMarket(
    agent:  AgentConfig,
    market: unknown
  ): Promise<{ opportunity?: Opportunity; skipped?: SkippedMarket }> {
    const mkt = market as { id: string; question?: string };
    try {
      const data   = agent.fetchData ? await agent.fetchData(market) : undefined;
      const result = await agent.analyze(market, data);

      if (result?.dominated) {
        if (result.dominated.edge >= this.minEdge) {
          return { opportunity: { ...result.dominated, agent: agent.type } };
        }
        // Drop silencieux visible dans les logs
        console.log(
          `[orchestrator] ⬇ DROP edge trop bas: "${(mkt.question ?? "").slice(0, 60)}" ` +
          `edge=${(result.dominated.edge * 100).toFixed(1)}% < ${(this.minEdge * 100).toFixed(0)}%`
        );
        return {
          skipped: {
            marketId: mkt.id,
            question: mkt.question ?? "",
            reason:   `Edge ${(result.dominated.edge * 100).toFixed(1)}% < minEdge ${(this.minEdge * 100).toFixed(0)}%`,
            agent:    agent.type,
          },
        };
      }
      if (result?.skipReason) {
        return {
          skipped: {
            marketId: mkt.id,
            question: mkt.question ?? "",
            reason:   result.skipReason,
            agent:    agent.type,
          },
        };
      }
      return {};
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator] ${agent.name} error on market ${mkt.id}: ${msg}`);
      return {
        skipped: {
          marketId: mkt.id,
          question: mkt.question ?? "",
          reason:   `Erreur: ${msg}`,
          agent:    agent.type,
        },
      };
    }
  }

  /**
   * Tri par edge décroissant + limites par agent, secteur et market_id.
   *
   * Secteurs granulaires :
   *   crypto_l1 / crypto_meme / crypto_defi / crypto_other
   *   finance_tech / finance_banks / finance_energy / finance_other
   *   weather_us / weather_eu / weather_asia / weather_other
   */
  private applyRiskLimits(opps: Opportunity[]): Opportunity[] {
    const sorted = [...opps].sort((a, b) => b.edge - a.edge);
    const countByAgent:  Record<string, number> = {};
    const countBySector: Record<string, number> = {};
    const seenMarketIds = new Set<string>();

    const kept = sorted.filter((opp) => {
      // Dédupliquer le même market_id (deux agents sur le même marché)
      if (seenMarketIds.has(opp.marketId)) {
        console.log(`[orchestrator] Duplicate market ${opp.marketId} — skipping`);
        return false;
      }
      seenMarketIds.add(opp.marketId);

      // Limite par agent
      const agentCount = countByAgent[opp.agent] ?? 0;
      if (agentCount >= this.maxPositionsPerAgent) {
        console.log(
          `[orchestrator] Risk limit (agent): skipping ${opp.agent} opportunity ` +
          `(max ${this.maxPositionsPerAgent} reached)`
        );
        return false;
      }

      // Limite par secteur (anti-corrélation granulaire)
      const sector      = this.getSector(opp);
      const sectorCount = countBySector[sector] ?? 0;
      if (sectorCount >= this.maxPositionsPerSector) {
        console.log(
          `[orchestrator] Risk limit (sector): skipping ${opp.marketId} — ` +
          `sector "${sector}" already at ${this.maxPositionsPerSector} positions`
        );
        return false;
      }

      countByAgent[opp.agent]   = agentCount + 1;
      countBySector[sector]     = sectorCount + 1;
      return true;
    });

    console.log(`[orchestrator] Sector distribution:`, countBySector);

    // Log horizon moyen des opportunités conservées
    if (kept.length > 0) {
      const avgHours = kept.reduce((sum, o) => {
        const ref   = o.targetDateTime ?? o.targetDate;
        const hours = ref
          ? (new Date(ref).getTime() - Date.now()) / (1000 * 60 * 60)
          : 0;
        return sum + hours;
      }, 0) / kept.length;
      console.log(`[orchestrator] 📊 Horizon moyen des ${kept.length} opportunités: ${Math.round(avgHours)}h`);
    }

    return kept;
  }

  private getSector(opp: Opportunity): string {
    if (opp.agent === "crypto") {
      const token = opp.token?.toUpperCase() ?? "";
      const L1    = ["BTC", "ETH", "SOL", "AVAX", "ADA", "DOT"];
      const MEME  = ["DOGE", "SHIB", "PEPE", "BONK", "WIF", "TRUMP"];
      const DEFI  = ["UNI", "AAVE", "LINK", "MKR", "CRV", "ARB", "OP"];
      if (L1.includes(token))   return "crypto_l1";
      if (MEME.includes(token)) return "crypto_meme";
      if (DEFI.includes(token)) return "crypto_defi";
      return "crypto_other";
    }

    if (opp.agent === "finance") {
      const ticker = opp.ticker?.toUpperCase() ?? "";
      const TECH   = ["AAPL", "MSFT", "GOOGL", "META", "NVDA", "AMZN", "TSLA"];
      const BANKS  = ["JPM", "BAC", "GS", "MS", "V", "MA", "ALLY"];
      const ENERGY = ["XOM", "CVX", "COP", "SLB"];
      if (TECH.includes(ticker))   return "finance_tech";
      if (BANKS.includes(ticker))  return "finance_banks";
      if (ENERGY.includes(ticker)) return "finance_energy";
      return "finance_other";
    }

    if (opp.agent === "weather") {
      const city   = (opp.city ?? "").toLowerCase();
      const US     = ["new york", "nyc", "los angeles", "chicago", "houston", "miami", "atlanta", "boston", "san francisco", "seattle", "denver"];
      const EU     = ["london", "paris", "berlin", "madrid", "rome", "amsterdam", "vienna", "zurich", "stockholm", "warsaw", "munich"];
      const ASIA   = ["tokyo", "seoul", "hong kong", "singapore", "shanghai", "beijing", "mumbai", "bangkok", "ankara"];
      if (US.some((c)   => city.includes(c))) return "weather_us";
      if (EU.some((c)   => city.includes(c))) return "weather_eu";
      if (ASIA.some((c) => city.includes(c))) return "weather_asia";
      return "weather_other";
    }

    return "other";
  }
}

// Singleton partagé par toute l'application
export const orchestrator = new Orchestrator();
