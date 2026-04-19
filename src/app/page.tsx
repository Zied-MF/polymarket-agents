"use client";

import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TradingMode = "balanced" | "aggressive" | "high_conviction";

interface StatCards {
  markets:     { total: number; parsed: number; forecasted: number };
  claudeAI:    { yes: number; no: number; skip: number };
  liveWeather: Array<{ city: string; tempF: number; tempC: number }>;
  topCities:   Array<{ city: string; liquidity: number }>;
  resolving:   { today: number; tomorrow: number; thisWeek: number };
  bestEdge:    { market: string; edge: number; city: string } | null;
  signals:     number;
  pnl:         number;
  openPositions: number;
}

interface Position {
  id:           string;
  city:         string;
  question:     string;
  outcome:      string;
  entryPrice:   number;
  currentPrice: number;
  pnl:          number;
  pnlPercent:   number;
  age:          string;
}

interface Trade {
  id:      string;
  city:    string;
  outcome: string;
  result:  "WIN" | "LOSS";
  pnl:     number;
  date:    string;
}

interface Opportunity {
  marketId:       string;
  question:       string;
  city:           string;
  targetDate:     string;
  outcome:        string;
  marketPrice:    number;
  ourProbability: number;
  edge:           number;
  models: {
    gfs?:          number;
    ecmwf?:        number;
    ukmo?:         number;
    consensus:     number;
    agreement:     "strong" | "moderate" | "weak";
    spreadDegrees: number;
  };
  claude: {
    decision:   "TRADE" | "SKIP";
    confidence: string;
    size:       number;
    reasoning:  string;
    risks:      string[];
  } | null;
  recommendation:       "STRONG_BUY" | "BUY" | "SKIP";
  recommendationReason: string;
  suggestedBet:         number;
}

interface AnalyzeResult {
  timestamp:  string;
  duration:   string;
  mode:       TradingMode;
  trades:     number;
  decisions:  Array<{ city: string; decision: string; confidence: string; reasoning: string }>;
  summary: {
    totalAnalyzed:    number;
    strongBuy:        number;
    buy:              number;
    skip:             number;
    skippedByFilters: number;
  };
  opportunities: Opportunity[];
}

interface LogEntry {
  time:    string;
  message: string;
  type:    "info" | "success" | "warn" | "error";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modeLabel(m: TradingMode) {
  return { balanced: "Balanced", aggressive: "Aggressive", high_conviction: "High Conviction" }[m];
}

function modeDesc(m: TradingMode) {
  return {
    balanced:        "YES < 15¢ · edge > 10% · confidence ≥ MEDIUM",
    aggressive:      "YES < 50¢ · edge > 8%  · confidence ≥ LOW",
    high_conviction: "YES < 15¢ · edge > 15% · confidence ≥ HIGH",
  }[m];
}

function agreementColor(a: string) {
  if (a === "strong")   return "text-green-400";
  if (a === "moderate") return "text-yellow-400";
  return "text-red-400";
}

function recoBadge(r: Opportunity["recommendation"]) {
  if (r === "STRONG_BUY")
    return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-300 font-bold">STRONG BUY</span>;
  if (r === "BUY")
    return <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-300 font-bold">BUY</span>;
  return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-700 text-gray-400">SKIP</span>;
}

function confBadge(c: string) {
  const map: Record<string, string> = {
    VERY_HIGH: "bg-green-500/20 text-green-300",
    HIGH:      "bg-emerald-500/20 text-emerald-300",
    MEDIUM:    "bg-yellow-500/20 text-yellow-300",
    LOW:       "bg-orange-500/20 text-orange-300",
    VERY_LOW:  "bg-red-500/20 text-red-300",
  };
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full ${map[c] ?? "bg-gray-700 text-gray-400"}`}>
      {c}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [stats,      setStats]      = useState<StatCards | null>(null);
  const [positions,  setPositions]  = useState<Position[]>([]);
  const [trades,     setTrades]     = useState<Trade[]>([]);
  const [mode,       setMode]       = useState<TradingMode>("balanced");
  const [analyzing,  setAnalyzing]  = useState(false);
  const [scanning,   setScanning]   = useState(false);
  const [result,     setResult]     = useState<AnalyzeResult | null>(null);
  const [log,        setLog]        = useState<LogEntry[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);

  // ── Log helper ────────────────────────────────────────────────────────────

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    setLog((prev) => [
      { time: new Date().toLocaleTimeString("fr-FR"), message, type },
      ...prev.slice(0, 49),
    ]);
  }, []);

  // ── Load dashboard stats on mount ─────────────────────────────────────────

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard-stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setStats(json.stats);
      setPositions(json.positions ?? []);
      setTrades(json.trades ?? []);
    } catch (e) {
      addLog(`Erreur stats: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      setStatsLoading(false);
    }
  }, [addLog]);

  useEffect(() => { loadStats(); }, [loadStats]);

  // ── Scan markets ──────────────────────────────────────────────────────────

  const handleScan = async () => {
    setScanning(true);
    addLog("Scan des marchés météo lancé…", "info");
    try {
      const res = await fetch("/api/scan-markets");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      addLog(`Scan terminé — ${json.saved ?? 0} trades sauvegardés`, "success");
      await loadStats();
    } catch (e) {
      addLog(`Scan échoué: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      setScanning(false);
    }
  };

  // ── Analyze top markets ───────────────────────────────────────────────────

  const handleAnalyzeTop = async () => {
    setAnalyzing(true);
    setResult(null);
    addLog(`Analyse top marchés — mode ${modeLabel(mode)}…`, "info");
    try {
      const res = await fetch("/api/analyze-top", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: AnalyzeResult = await res.json();
      setResult(json);
      addLog(
        `Analyse terminée en ${json.duration} — ${json.summary.strongBuy} STRONG BUY, ${json.summary.buy} BUY`,
        json.trades > 0 ? "success" : "warn",
      );
      await loadStats();
    } catch (e) {
      addLog(`Analyse échouée: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0a0e17] text-white font-mono">
      {/* ── Header ── */}
      <header className="border-b border-[#1a2035] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🌦️</span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">WeatherBot</h1>
            <p className="text-[#4a5568] text-xs">Polymarket Weather Trading Agent</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-[#4a5568] text-xs">LIVE</span>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">

        {/* ── Top KPI cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Markets */}
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-4">
            <p className="text-[#4a5568] text-xs mb-1">Marchés météo</p>
            <p className="text-3xl font-bold">
              {statsLoading ? "…" : (stats?.markets.total.toLocaleString() ?? "—")}
            </p>
            <p className="text-[#4a5568] text-xs mt-1">
              {stats ? `${stats.markets.forecasted} prévisionnés` : ""}
            </p>
          </div>

          {/* Open positions */}
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-4">
            <p className="text-[#4a5568] text-xs mb-1">Positions ouvertes</p>
            <p className="text-3xl font-bold text-blue-400">
              {statsLoading ? "…" : (stats?.openPositions ?? "—")}
            </p>
            <p className="text-[#4a5568] text-xs mt-1">
              {stats?.resolving ? `${stats.resolving.today} résolution auj.` : ""}
            </p>
          </div>

          {/* P&L */}
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-4">
            <p className="text-[#4a5568] text-xs mb-1">P&L total</p>
            <p className={`text-3xl font-bold ${(stats?.pnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
              {statsLoading ? "…" : (stats != null ? `${stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)}$` : "—")}
            </p>
            <p className="text-[#4a5568] text-xs mt-1">trades résolus</p>
          </div>

          {/* Best edge */}
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-4">
            <p className="text-[#4a5568] text-xs mb-1">Meilleur edge</p>
            <p className="text-3xl font-bold text-yellow-400">
              {statsLoading ? "…" : (stats?.bestEdge ? `${(stats.bestEdge.edge * 100).toFixed(0)}%` : "—")}
            </p>
            <p className="text-[#4a5568] text-xs mt-1 truncate">
              {stats?.bestEdge?.city ?? ""}
            </p>
          </div>
        </div>

        {/* ── Claude AI stats row ── */}
        {stats && (
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-4 text-center">
              <p className="text-[#4a5568] text-xs mb-1">Claude → YES</p>
              <p className="text-2xl font-bold text-green-400">{stats.claudeAI.yes}</p>
            </div>
            <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-4 text-center">
              <p className="text-[#4a5568] text-xs mb-1">Claude → NO</p>
              <p className="text-2xl font-bold text-red-400">{stats.claudeAI.no}</p>
            </div>
            <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-4 text-center">
              <p className="text-[#4a5568] text-xs mb-1">Résolution cette semaine</p>
              <p className="text-2xl font-bold text-blue-400">{stats.resolving.thisWeek}</p>
            </div>
          </div>
        )}

        {/* ── Actions + Mode selector ── */}
        <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-5">
          <h2 className="text-sm text-[#4a5568] uppercase tracking-widest mb-4">Actions</h2>

          {/* Mode selector */}
          <div className="flex gap-2 mb-4 flex-wrap">
            {(["balanced", "aggressive", "high_conviction"] as TradingMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-2 rounded-lg text-sm transition border ${
                  mode === m
                    ? "bg-blue-600/20 border-blue-500/50 text-blue-300"
                    : "border-[#1a2035] text-[#4a5568] hover:text-white hover:border-[#2a3045]"
                }`}
              >
                {modeLabel(m)}
              </button>
            ))}
          </div>
          <p className="text-[#4a5568] text-xs mb-5">{modeDesc(mode)}</p>

          {/* Action buttons */}
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={handleScan}
              disabled={scanning || analyzing}
              className="px-4 py-2 bg-[#1a2035] hover:bg-[#232d45] border border-[#2a3045] rounded-lg text-sm disabled:opacity-40 transition flex items-center gap-2"
            >
              {scanning ? <span className="animate-spin">⏳</span> : "📡"}
              {scanning ? "Scan en cours…" : "Scanner les marchés"}
            </button>

            <button
              onClick={handleAnalyzeTop}
              disabled={analyzing || scanning}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-bold disabled:opacity-40 transition flex items-center gap-2"
            >
              {analyzing ? <span className="animate-spin">⏳</span> : "🧠"}
              {analyzing ? "Analyse en cours…" : `Analyser top marchés (${modeLabel(mode)})`}
            </button>

            <button
              onClick={loadStats}
              disabled={statsLoading}
              className="px-4 py-2 bg-[#1a2035] hover:bg-[#232d45] border border-[#2a3045] rounded-lg text-sm disabled:opacity-40 transition"
            >
              🔄 Rafraîchir
            </button>
          </div>
        </div>

        {/* ── Analyze result ── */}
        {result && (
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-lg">
                Analyse — {modeLabel(result.mode)}
                <span className="text-[#4a5568] text-sm font-normal ml-2">{result.duration}</span>
              </h2>
              <div className="flex gap-3 text-sm">
                <span className="text-green-400 font-bold">{result.summary.strongBuy} STRONG BUY</span>
                <span className="text-blue-400 font-bold">{result.summary.buy} BUY</span>
                <span className="text-[#4a5568]">{result.summary.skippedByFilters} filtrés</span>
              </div>
            </div>

            {result.opportunities.length === 0 ? (
              <p className="text-[#4a5568] text-sm text-center py-6">Aucune opportunité dans ce mode</p>
            ) : (
              <div className="space-y-3">
                {result.opportunities.map((opp) => (
                  <div
                    key={opp.marketId}
                    className={`rounded-lg border p-4 ${
                      opp.recommendation === "STRONG_BUY"
                        ? "border-green-500/30 bg-green-500/5"
                        : "border-[#1a2035] bg-[#0a0e17]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          {recoBadge(opp.recommendation)}
                          <span className="font-bold text-sm">{opp.city}</span>
                          <span className="text-[#4a5568] text-xs">{opp.targetDate}</span>
                        </div>
                        <p className="text-[#8899aa] text-xs truncate">{opp.question}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-yellow-400 font-bold text-lg">+{(opp.edge * 100).toFixed(1)}%</p>
                        <p className="text-[#4a5568] text-xs">edge</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3 text-xs mt-3">
                      <div>
                        <p className="text-[#4a5568] mb-0.5">Outcome</p>
                        <p className="font-bold">{opp.outcome}</p>
                      </div>
                      <div>
                        <p className="text-[#4a5568] mb-0.5">Prix / Notre prob.</p>
                        <p>
                          <span className="text-[#8899aa]">{(opp.marketPrice * 100).toFixed(0)}¢</span>
                          {" → "}
                          <span className="text-blue-400 font-bold">{(opp.ourProbability * 100).toFixed(0)}%</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-[#4a5568] mb-0.5">Mise suggérée</p>
                        <p className="text-green-400 font-bold">${opp.suggestedBet.toFixed(2)}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs mt-2">
                      <div>
                        <p className="text-[#4a5568] mb-0.5">Modèles météo</p>
                        <p className={`${agreementColor(opp.models.agreement)} font-bold`}>
                          {opp.models.agreement.toUpperCase()}
                          <span className="text-[#4a5568] font-normal ml-1">±{opp.models.spreadDegrees.toFixed(1)}°C</span>
                        </p>
                        <p className="text-[#4a5568]">
                          consensus {opp.models.consensus.toFixed(1)}°C
                          {opp.models.gfs   != null && <> · GFS {opp.models.gfs.toFixed(1)}</>}
                          {opp.models.ecmwf != null && <> · ECMWF {opp.models.ecmwf.toFixed(1)}</>}
                          {opp.models.ukmo  != null && <> · UKMO {opp.models.ukmo.toFixed(1)}</>}
                        </p>
                      </div>
                      {opp.claude && (
                        <div>
                          <p className="text-[#4a5568] mb-0.5">Claude</p>
                          <div className="flex items-center gap-1 mb-0.5">
                            {confBadge(opp.claude.confidence)}
                            <span className="text-[#4a5568]">taille {opp.claude.size}/10</span>
                          </div>
                          <p className="text-[#8899aa] line-clamp-2">{opp.claude.reasoning}</p>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Open positions ── */}
        {positions.length > 0 && (
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-5">
            <h2 className="text-sm text-[#4a5568] uppercase tracking-widest mb-4">
              Positions ouvertes ({positions.length})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#4a5568] text-xs border-b border-[#1a2035]">
                    <th className="text-left pb-2">Ville</th>
                    <th className="text-left pb-2">Outcome</th>
                    <th className="text-right pb-2">Entrée</th>
                    <th className="text-right pb-2">Actuel</th>
                    <th className="text-right pb-2">P&L</th>
                    <th className="text-right pb-2">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a2035]">
                  {positions.map((p) => (
                    <tr key={p.id} className="hover:bg-[#1a2035]/30 transition">
                      <td className="py-2 pr-4 font-bold">{p.city}</td>
                      <td className="py-2 pr-4 text-[#8899aa] text-xs max-w-[200px] truncate">{p.outcome}</td>
                      <td className="py-2 pr-4 text-right text-[#8899aa]">{(p.entryPrice * 100).toFixed(0)}¢</td>
                      <td className="py-2 pr-4 text-right">{(p.currentPrice * 100).toFixed(0)}¢</td>
                      <td className={`py-2 pr-4 text-right font-bold ${p.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {p.pnl >= 0 ? "+" : ""}{p.pnl.toFixed(2)}$
                        <span className="text-xs font-normal ml-1">
                          ({p.pnlPercent >= 0 ? "+" : ""}{p.pnlPercent.toFixed(1)}%)
                        </span>
                      </td>
                      <td className="py-2 text-right text-[#4a5568] text-xs">{p.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Bottom row: activity log + trade history ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Activity log */}
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-5">
            <h2 className="text-sm text-[#4a5568] uppercase tracking-widest mb-4">Log d&apos;activité</h2>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {log.length === 0 ? (
                <p className="text-[#4a5568] text-xs text-center py-6">Aucune activité récente</p>
              ) : (
                log.map((entry, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <span className="text-[#4a5568] shrink-0">{entry.time}</span>
                    <span className={
                      entry.type === "success" ? "text-green-400" :
                      entry.type === "error"   ? "text-red-400"   :
                      entry.type === "warn"    ? "text-yellow-400":
                      "text-[#8899aa]"
                    }>
                      {entry.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Trade history */}
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-5">
            <h2 className="text-sm text-[#4a5568] uppercase tracking-widest mb-4">Historique des trades</h2>
            {trades.length === 0 ? (
              <p className="text-[#4a5568] text-xs text-center py-6">Aucun trade résolu</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[#4a5568] border-b border-[#1a2035]">
                      <th className="text-left pb-2">Ville</th>
                      <th className="text-left pb-2">Outcome</th>
                      <th className="text-center pb-2">Résultat</th>
                      <th className="text-right pb-2">P&L</th>
                      <th className="text-right pb-2">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1a2035]">
                    {trades.map((t) => (
                      <tr key={t.id} className="hover:bg-[#1a2035]/30 transition">
                        <td className="py-1.5 pr-3 font-bold">{t.city}</td>
                        <td className="py-1.5 pr-3 text-[#8899aa]">{t.outcome}</td>
                        <td className="py-1.5 pr-3 text-center">
                          {t.result === "WIN"
                            ? <span className="text-green-400 font-bold">WIN</span>
                            : <span className="text-red-400 font-bold">LOSS</span>}
                        </td>
                        <td className={`py-1.5 pr-3 text-right font-bold ${t.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {t.pnl >= 0 ? "+" : ""}{t.pnl.toFixed(2)}$
                        </td>
                        <td className="py-1.5 text-right text-[#4a5568]">{t.date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Top cities ── */}
        {stats?.topCities && stats.topCities.length > 0 && (
          <div className="bg-[#0f1623] border border-[#1a2035] rounded-xl p-5">
            <h2 className="text-sm text-[#4a5568] uppercase tracking-widest mb-4">Top villes (liquidité)</h2>
            <div className="flex gap-4 flex-wrap">
              {stats.topCities.map((c) => (
                <div key={c.city} className="text-center">
                  <p className="font-bold">{c.city}</p>
                  <p className="text-[#4a5568] text-xs">${c.liquidity.toFixed(0)}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <footer className="text-center text-[#2a3045] text-xs pb-4">
          WeatherBot · GFS + ECMWF + UKMO + Ensemble · Claude AI · Polymarket
        </footer>
      </div>
    </div>
  );
}
