"use client";

import { useState, useEffect } from "react";

interface Opportunity {
  marketId: string;
  question: string;
  city: string;
  outcome: string;
  marketPrice: number;
  estimatedProbability: number;
  edge: number;
  multiplier: number;
  suggestedBet: number;
  confidence?: string;
}

interface ScanResult {
  scannedAt: string;
  total_markets: number;
  opportunities: Opportunity[];
  skipped: { marketId: string; question: string; reason: string }[];
  saved_to_db: number;
  errors: { marketId: string; question: string; error: string }[];
}

export default function Dashboard() {
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/scan-markets");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur lors du chargement des données");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const getEdgeColor = (edge: number) => {
    if (edge >= 0.15) return "text-green-400";
    if (edge >= 0.10) return "text-yellow-400";
    return "text-orange-400";
  };

  const getEdgeBg = (edge: number) => {
    if (edge >= 0.15) return "border-green-500/30 bg-green-500/5";
    if (edge >= 0.10) return "border-yellow-500/30 bg-yellow-500/5";
    return "border-orange-500/30 bg-orange-500/5";
  };

  const getConfidenceBadge = (confidence?: string) => {
    switch (confidence) {
      case "high":
        return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400 border border-green-500/30">HIGH</span>;
      case "medium":
        return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">MED</span>;
      case "low":
        return <span className="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400 border border-red-500/30">LOW</span>;
      default:
        return null;
    }
  };

  const avgEdge = data?.opportunities.length
    ? (data.opportunities.reduce((acc, o) => acc + o.edge, 0) / data.opportunities.length * 100).toFixed(1)
    : "0.0";

  const totalBet = data?.opportunities.reduce((acc, o) => acc + (o.suggestedBet ?? 0), 0) ?? 0;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              🌡️ Polymarket Weather Agent
            </h1>
            <p className="text-gray-400 mt-1 text-sm">
              {data?.scannedAt
                ? `Dernier scan : ${new Date(data.scannedAt).toLocaleString("fr-FR", { timeZone: "UTC", timeZoneName: "short" })}`
                : "En attente du premier scan…"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/20">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-green-400 text-sm">Running</span>
            </div>
            <button
              onClick={fetchData}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {loading ? "⏳ Chargement…" : "🔄 Rafraîchir"}
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {[
            { label: "Marchés scannés",  value: data?.total_markets ?? "—",              color: "text-white" },
            { label: "Opportunités",     value: data?.opportunities.length ?? "—",        color: "text-green-400" },
            { label: "Edge moyen",       value: `${avgEdge}%`,                            color: "text-yellow-400" },
            { label: "Mise totale",      value: `${totalBet.toFixed(2)}€`,                color: "text-blue-400" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">{label}</p>
              <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Error banner */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6 text-red-400 text-sm">
            ⚠️ {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-5 animate-pulse">
                <div className="h-5 bg-gray-800 rounded w-1/2 mb-3" />
                <div className="h-3 bg-gray-800 rounded w-3/4 mb-6" />
                <div className="h-2 bg-gray-800 rounded mb-4" />
                <div className="h-8 bg-gray-800 rounded" />
              </div>
            ))}
          </div>
        )}

        {/* Opportunities */}
        {!loading && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              🎯 Opportunités détectées
              <span className="text-sm font-normal text-gray-500">({data?.opportunities.length ?? 0})</span>
            </h2>

            {data?.opportunities.length === 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center text-gray-500">
                <p className="text-4xl mb-3">🔍</p>
                <p>Aucune opportunité détectée pour le moment.</p>
                <p className="text-sm mt-1">Le scan tourne toutes les 15 minutes.</p>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {data?.opportunities.map((opp, i) => (
                <div
                  key={i}
                  className={`rounded-xl p-5 border transition-colors hover:brightness-110 ${getEdgeBg(opp.edge)}`}
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-lg leading-tight">{opp.city || "—"}</h3>
                      <p className="text-gray-400 text-xs mt-0.5 truncate" title={opp.question}>
                        {opp.question}
                      </p>
                    </div>
                    <div className="ml-2 flex-shrink-0">
                      {getConfidenceBadge(opp.confidence)}
                    </div>
                  </div>

                  {/* Outcome */}
                  <div className="bg-gray-800/60 rounded-lg px-3 py-2 mb-3">
                    <p className="text-gray-400 text-xs mb-0.5">Outcome prédit</p>
                    <p className="font-mono font-semibold">{opp.outcome}</p>
                  </div>

                  {/* Probability bar */}
                  <div className="mb-3">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-400">Marché <span className="text-white font-medium">{(opp.marketPrice * 100).toFixed(0)}%</span></span>
                      <span className="text-blue-400">Estimé <span className="text-white font-medium">{(opp.estimatedProbability * 100).toFixed(0)}%</span></span>
                    </div>
                    <div className="relative h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      {/* Market price */}
                      <div
                        className="absolute top-0 left-0 h-full bg-gray-500 rounded-full"
                        style={{ width: `${opp.marketPrice * 100}%` }}
                      />
                      {/* Estimated */}
                      <div
                        className="absolute top-0 left-0 h-full bg-blue-400 rounded-full opacity-70"
                        style={{ width: `${opp.estimatedProbability * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* Metrics */}
                  <div className="flex items-center justify-between pt-3 border-t border-gray-700/50 text-sm">
                    <div className="text-center">
                      <p className="text-gray-500 text-xs">Edge</p>
                      <p className={`font-bold ${getEdgeColor(opp.edge)}`}>+{(opp.edge * 100).toFixed(1)}%</p>
                    </div>
                    <div className="text-center">
                      <p className="text-gray-500 text-xs">Mult.</p>
                      <p className="font-bold text-purple-400">×{opp.multiplier?.toFixed(2)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-gray-500 text-xs">½ Kelly</p>
                      <p className="font-bold text-green-400">{opp.suggestedBet?.toFixed(2) ?? "0.00"}€</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Skipped */}
        {!loading && (data?.skipped.length ?? 0) > 0 && (
          <div className="mb-6">
            <button
              onClick={() => setShowSkipped(!showSkipped)}
              className="flex items-center gap-2 text-gray-400 hover:text-gray-200 transition-colors text-sm mb-3"
            >
              <span className="text-xs">{showSkipped ? "▼" : "▶"}</span>
              Marchés ignorés ({data!.skipped.length})
            </button>
            {showSkipped && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden text-sm">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-800/50 text-gray-400 text-xs uppercase tracking-wide">
                      <th className="text-left px-4 py-2">Marché</th>
                      <th className="text-left px-4 py-2">Raison</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.skipped.map((s, i) => (
                      <tr key={i} className="border-t border-gray-800">
                        <td className="px-4 py-2 text-gray-300 max-w-xs truncate" title={s.question}>{s.question}</td>
                        <td className="px-4 py-2 text-gray-500">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Errors */}
        {!loading && (data?.errors.length ?? 0) > 0 && (
          <div className="mb-6">
            <button
              onClick={() => setShowErrors(!showErrors)}
              className="flex items-center gap-2 text-red-400 hover:text-red-300 transition-colors text-sm mb-3"
            >
              <span className="text-xs">{showErrors ? "▼" : "▶"}</span>
              Erreurs ({data!.errors.length})
            </button>
            {showErrors && (
              <div className="bg-red-500/5 border border-red-500/20 rounded-xl overflow-hidden text-sm">
                <table className="w-full">
                  <thead>
                    <tr className="bg-red-500/10 text-gray-400 text-xs uppercase tracking-wide">
                      <th className="text-left px-4 py-2">Marché</th>
                      <th className="text-left px-4 py-2">Erreur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.errors.map((e, i) => (
                      <tr key={i} className="border-t border-red-500/10">
                        <td className="px-4 py-2 text-gray-300 max-w-xs truncate" title={e.question}>{e.question}</td>
                        <td className="px-4 py-2 text-red-400 font-mono text-xs">{e.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="mt-12 pt-6 border-t border-gray-800 flex items-center justify-between text-gray-600 text-xs">
          <span>Polymarket Weather Agent v1.0</span>
          <span>Cron toutes les 15 min · Budget 10€ · Half-Kelly</span>
        </div>
      </div>
    </div>
  );
}
