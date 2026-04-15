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
  agent?: "weather" | "finance";
}

interface ScanResult {
  scannedAt: string;
  total_markets: number;
  opportunities: Opportunity[];
  skipped: { marketId: string; question: string; reason: string }[];
  saved_to_db: number;
  errors: any[];
}

export default function Dashboard() {
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/scan-markets");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError("Erreur lors du chargement des données");
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
    return "text-red-400";
  };

  const getAgentBadge = (agent?: "weather" | "finance") => {
    if (agent === "finance") {
      return <span className="px-2 py-1 text-xs rounded-full bg-blue-500/20 text-blue-400">📈 Finance</span>;
    }
    return <span className="px-2 py-1 text-xs rounded-full bg-cyan-500/20 text-cyan-400">🌡️ Météo</span>;
  };

  const getConfidenceBadge = (confidence?: string) => {
    switch (confidence) {
      case "high":
        return <span className="px-2 py-1 text-xs rounded-full bg-green-500/20 text-green-400">HIGH</span>;
      case "medium":
        return <span className="px-2 py-1 text-xs rounded-full bg-yellow-500/20 text-yellow-400">MEDIUM</span>;
      case "low":
        return <span className="px-2 py-1 text-xs rounded-full bg-red-500/20 text-red-400">LOW</span>;
      default:
        return null;
    }
  };

  const avgEdge = data?.opportunities.length
    ? (data.opportunities.reduce((acc, o) => acc + o.edge, 0) / data.opportunities.length * 100).toFixed(1)
    : "0";

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      {/* Header */}
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-3">
              📊 Polymarket Trading Agent
            </h1>
            <p className="text-gray-400 mt-1">
              {data?.scannedAt
                ? `Dernière mise à jour : ${new Date(data.scannedAt).toLocaleString("fr-FR")}`
                : "Chargement..."}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></span>
              <span className="text-green-400">Running</span>
            </div>
            <a
              href="/results"
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg font-medium transition text-sm"
            >
              📊 Results
            </a>
            <button
              onClick={fetchData}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium disabled:opacity-50 transition"
            >
              {loading ? "⏳ Chargement..." : "🔄 Rafraîchir"}
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Marchés scannés</p>
            <p className="text-2xl font-bold">{data?.total_markets ?? "-"}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Opportunités</p>
            <p className="text-2xl font-bold text-green-400">{data?.opportunities.length ?? "-"}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Edge moyen</p>
            <p className="text-2xl font-bold text-yellow-400">{avgEdge}%</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Sauvegardés DB</p>
            <p className="text-2xl font-bold text-blue-400">{data?.saved_to_db ?? "-"}</p>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-4 mb-8 text-red-400">
            {error}
          </div>
        )}

        {/* Opportunities */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            🎯 Opportunités détectées
            <span className="text-sm font-normal text-gray-400">
              ({data?.opportunities.length ?? 0})
            </span>
          </h2>

          {data?.opportunities.length === 0 && !loading && (
            <div className="bg-gray-900 rounded-xl p-8 text-center text-gray-400 border border-gray-800">
              Aucune opportunité détectée pour le moment
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {data?.opportunities.map((opp, i) => (
              <div key={i} className="bg-gray-900 rounded-xl p-5 border border-gray-800 hover:border-gray-700 transition">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-lg">{opp.city || "Unknown"}</h3>
                    <p className="text-gray-400 text-sm truncate max-w-[200px]">{opp.question}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {getAgentBadge(opp.agent)}
                    {getConfidenceBadge(opp.confidence)}
                  </div>
                </div>

                <div className="mb-3">
                  <p className="text-sm text-gray-400 mb-1">Outcome prédit</p>
                  <p className="font-mono text-lg">{opp.outcome}</p>
                </div>

                <div className="mb-3">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-400">Marché: {(opp.marketPrice * 100).toFixed(0)}%</span>
                    <span className="text-blue-400">Notre: {(opp.estimatedProbability * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-red-500 via-yellow-500 to-green-500"
                      style={{ width: `${opp.estimatedProbability * 100}%` }}
                    ></div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-gray-800">
                  <div>
                    <span className="text-gray-400 text-sm">Edge: </span>
                    <span className={`font-bold ${getEdgeColor(opp.edge)}`}>
                      +{(opp.edge * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400 text-sm">Mise: </span>
                    <span className="font-bold text-green-400">
                      {opp.suggestedBet?.toFixed(2) ?? "0.00"}€
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400 text-sm">x</span>
                    <span className="font-bold text-purple-400">
                      {opp.multiplier?.toFixed(1)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Skipped Markets */}
        {data?.skipped && data.skipped.length > 0 && (
          <div>
            <button
              onClick={() => setShowSkipped(!showSkipped)}
              className="flex items-center gap-2 text-gray-400 hover:text-white transition mb-4"
            >
              <span>{showSkipped ? "▼" : "▶"}</span>
              <span>Marchés ignorés ({data.skipped.length})</span>
            </button>

            {showSkipped && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-800">
                    <tr>
                      <th className="text-left p-3 text-gray-400">Marché</th>
                      <th className="text-left p-3 text-gray-400">Raison</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.skipped.map((s, i) => (
                      <tr key={i} className="border-t border-gray-800">
                        <td className="p-3 truncate max-w-[300px]">{s.question}</td>
                        <td className="p-3 text-gray-400">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="mt-12 text-center text-gray-500 text-sm">
          <p>Polymarket Trading Agent v1.0 — Cron toutes les 15 minutes</p>
          <p>Weather + Finance Agents | Budget: 10€ | Kelly Criterion: Half-Kelly</p>
        </div>
      </div>
    </div>
  );
}
