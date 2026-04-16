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

  private readonly maxPositionsPerAgent  = 15;
  private readonly maxPositionsPerSector = 5;   // anti-corrélation
  private readonly minEdge               = 0.0798; // 7.98 %
  private readonly batchSize             = 10;

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
   * Chaque agent tourne simultanément ; les marchés d'un même agent
   * sont analysés par batches de 10 en parallèle.
   */
  async scanAllMarkets(agentTypes?: AgentType[]): Promise<ScanResult> {
    const agentsToRun = agentTypes
      ? this.agents.filter((a) => agentTypes.includes(a.type))
      : this.agents;

    console.log(`[orchestrator] Starting PARALLEL scan with ${agentsToRun.length} agents...`);

    // Exécuter tous les agents EN PARALLÈLE
    const results = await Promise.all(
      agentsToRun.map(async (agent) => {
        console.log(`[orchestrator] Starting ${agent.name}...`);
        const startTime = Date.now();

        try {
          const markets = await agent.fetchMarkets();
          const opportunities: Opportunity[] = [];
          const skipped:       SkippedMarket[] = [];

          // Analyser par batch de batchSize en parallèle
          for (let i = 0; i < markets.length; i += this.batchSize) {
            const batch = markets.slice(i, i + this.batchSize);
            const batchResults = await Promise.all(
              batch.map((market) => this.analyzeMarket(agent, market))
            );
            for (const r of batchResults) {
              if (r.opportunity) opportunities.push(r.opportunity);
              if (r.skipped)     skipped.push(r.skipped);
            }
          }

          console.log(
            `[orchestrator] ${agent.name} done in ${Date.now() - startTime}ms: ` +
            `${opportunities.length} opportunities from ${markets.length} markets`
          );
          return { agent: agent.type, opportunities, skipped, scanned: markets.length };
        } catch (err) {
          console.error(`[orchestrator] ${agent.name} failed:`, err instanceof Error ? err.message : err);
          return { agent: agent.type, opportunities: [], skipped: [], scanned: 0 };
        }
      })
    );

    // Combiner les résultats
    const allOpportunities = results.flatMap((r) => r.opportunities);
    const allSkipped       = results.flatMap((r) => r.skipped);
    const byAgent: Record<string, AgentStats> = Object.fromEntries(
      results.map((r) => [r.agent, { scanned: r.scanned, opportunities: r.opportunities.length }])
    );

    // Appliquer les limites de risque
    const beforeCount = allOpportunities.length;
    const filtered    = this.applyRiskLimits(allOpportunities);

    if (beforeCount > filtered.length) {
      console.log(
        `[orchestrator] Risk limits applied: ${beforeCount} → ${filtered.length} opportunities`
      );
    }

    const avgEdge = filtered.length > 0
      ? Math.round(filtered.reduce((s, o) => s + o.edge, 0) / filtered.length * 1000) / 10
      : 0;

    console.log(`[orchestrator] Scan complete:`);
    console.log(`  - Total opportunities: ${filtered.length} (${avgEdge}% avg edge)`);
    console.log(`  - By agent:`, byAgent);

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

      if (result?.dominated && result.dominated.edge >= this.minEdge) {
        return { opportunity: { ...result.dominated, agent: agent.type } };
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
   * Tri par edge décroissant + limites par agent et par secteur.
   *
   * Secteurs :
   *   crypto  → tous les tokens forment un seul secteur (corrélés entre eux)
   *   stocks  → toutes les actions forment un seul secteur
   *   weather → une ville = un secteur (pas de corrélation entre villes)
   */
  private applyRiskLimits(opps: Opportunity[]): Opportunity[] {
    const sorted = [...opps].sort((a, b) => b.edge - a.edge);
    const countByAgent:  Record<string, number> = {};
    const countBySector: Record<string, number> = {};

    return sorted.filter((opp) => {
      // Limite par agent
      const agentCount = countByAgent[opp.agent] ?? 0;
      if (agentCount >= this.maxPositionsPerAgent) {
        console.log(
          `[orchestrator] Risk limit (agent): skipping ${opp.agent} opportunity ` +
          `(max ${this.maxPositionsPerAgent} reached)`
        );
        return false;
      }

      // Limite par secteur (anti-corrélation)
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
  }

  private getSector(opp: Opportunity): string {
    if (opp.agent === "crypto")   return "crypto";          // tous corrélés
    if (opp.agent === "finance")  return "stocks";          // toutes actions corrélées
    if (opp.agent === "weather")  return `weather_${opp.city ?? "unknown"}`; // par ville
    return "other";
  }
}

// Singleton partagé par toute l'application
export const orchestrator = new Orchestrator();
