"use client";

import { useState } from "react";

interface Opportunity {
  marketId:             string;
  question:             string;
  city?:                string;
  ticker?:              string;
  token?:               string;
  outcome:              string;
  marketPrice:          number;
  estimatedProbability: number;
  edge:                 number;
  suggestedBet:         number;
  confidence?:          string;
  agent?:               "weather" | "finance" | "crypto";
}

interface AgentStats {
  scanned:       number;
  opportunities: number;
}

interface ScanResult {
  scannedAt:      string;
  duration:       string;
  byAgent:        Record<string, AgentStats>;
  opportunities:  number;
  saved:          number;
  skipped:        number;
  details:        Opportunity[];
  skippedDetails: { marketId: string; question: string; reason: string; agent: string }[];
  errors:         { marketId: string; question: string; error: string }[];
}

export default function Dashboard() {
  const [data, setData]             = useState<ScanResult | null>(null);
  const [scanning, setScanning]     = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  const runScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch("/api/scan-markets");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur lors du scan");
    } finally {
      setScanning(false);
    }
  };

  const getEdgeColor = (edge: number) => {
    if (edge >= 0.15) return "text-green-400";
    if (edge >= 0.10) return "text-yellow-400";
    return "text-red-400";
  };

  const getAgentBadge = (agent?: "weather" | "finance" | "crypto") => {
    if (agent === "finance") {
      return <span className="px-2 py-1 text-xs rounded-full bg-blue-500/20 text-blue-400">📈 Finance</span>;
    }
    if (agent === "crypto") {
      return <span className="px-2 py-1 text-xs rounded-full bg-purple-500/20 text-purple-400">₿ Crypto</span>;
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

  const avgEdge = data?.details?.length
    ? (data.details.reduce((acc, o) => acc + o.edge, 0) / data.details.length * 100).toFixed(1)
    : null;

  const totalScanned = data?.byAgent
    ? Object.values(data.byAgent).reduce((acc, s) => acc + s.scanned, 0)
    : null;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">📊 Polymarket Trading Agent</h1>
            <p className="text-gray-400 mt-1">
              {data?.scannedAt
                ? `Scan du ${new Date(data.scannedAt).toLocaleString("fr-FR")} — ${data.duration}`
                : "Aucun scan effectué — cliquez sur Lancer le scan"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/results"
              className="px-3 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition"
            >
              📊 Résultats
            </a>
            <a
              href="/positions"
              className="px-3 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition"
            >
              📍 Positions
            </a>
            <button
              onClick={runScan}
              disabled={scanning}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium disabled:opacity-50 transition flex items-center gap-2"
            >
              {scanning
                ? <><span className="animate-spin">⏳</span> Scan en cours…</>
                : "🔍 Lancer le scan"}
            </button>
          </div>
        </div>

        {/* Scan en cours — bannière */}
        {scanning && (
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 mb-6 flex items-center gap-3">
            <span className="animate-spin text-xl">⏳</span>
            <div>
              <p className="font-medium text-blue-300">Scan en cours…</p>
              <p className="text-blue-400/70 text-sm">Weather + Finance + Crypto agents actifs. Peut prendre 30–90 secondes.</p>
            </div>
          </div>
        )}

        {/* Erreur */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-4 mb-6 text-red-400">
            {error}
          </div>
        )}

        {/* Stats — toujours visibles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Marchés scannés</p>
            <p className="text-2xl font-bold">{totalScanned ?? "—"}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Opportunités</p>
            <p className="text-2xl font-bold text-green-400">{data?.opportunities ?? "—"}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Edge moyen</p>
            <p className="text-2xl font-bold text-yellow-400">{avgEdge != null ? `${avgEdge}%` : "—"}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Sauvegardés</p>
            <p className="text-2xl font-bold text-blue-400">{data?.saved ?? "—"}</p>
          </div>
        </div>

        {/* Par agent */}
        {data?.byAgent && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            {Object.entries(data.byAgent).map(([agent, stats]) => (
              <div key={agent} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <p className="text-gray-400 text-sm capitalize">{agent}</p>
                <p className="text-lg font-bold">
                  {stats.opportunities} <span className="text-sm text-gray-500">/ {stats.scanned} marchés</span>
                </p>
              </div>
            ))}
          </div>
        )}

        {/* État initial — avant le premier scan */}
        {!data && !scanning && (
          <div className="bg-gray-900 rounded-xl p-12 text-center border border-gray-800 border-dashed">
            <p className="text-4xl mb-4">🔍</p>
            <p className="text-xl text-gray-300 mb-2">Aucun scan effectué</p>
            <p className="text-gray-500 mb-6">Cliquez sur "Lancer le scan" pour analyser les marchés.</p>
            <button
              onClick={runScan}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition"
            >
              🔍 Lancer le scan
            </button>
          </div>
        )}

        {/* Opportunités */}
        {data && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              🎯 Opportunités détectées
              <span className="text-sm font-normal text-gray-400">({data.opportunities})</span>
            </h2>

            {data.opportunities === 0 && (
              <div className="bg-gray-900 rounded-xl p-8 text-center text-gray-400 border border-gray-800">
                Aucune opportunité détectée pour ce scan
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {data.details.map((opp, i) => (
                <div key={i} className="bg-gray-900 rounded-xl p-5 border border-gray-800 hover:border-gray-700 transition">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-lg">{opp.city ?? opp.ticker ?? opp.token ?? "Unknown"}</h3>
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
                      />
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
                        {opp.marketPrice > 0 ? (1 / opp.marketPrice).toFixed(1) : "—"}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Marchés ignorés */}
        {data?.skippedDetails && data.skippedDetails.length > 0 && (
          <div className="mb-8">
            <button
              onClick={() => setShowSkipped(!showSkipped)}
              className="flex items-center gap-2 text-gray-400 hover:text-white transition mb-4"
            >
              <span>{showSkipped ? "▼" : "▶"}</span>
              <span>Marchés ignorés ({data.skipped})</span>
            </button>

            {showSkipped && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-800">
                    <tr>
                      <th className="text-left p-3 text-gray-400">Marché</th>
                      <th className="text-left p-3 text-gray-400">Agent</th>
                      <th className="text-left p-3 text-gray-400">Raison</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.skippedDetails.map((s, i) => (
                      <tr key={i} className="border-t border-gray-800">
                        <td className="p-3 truncate max-w-[280px]">{s.question}</td>
                        <td className="p-3 text-gray-500 capitalize">{s.agent}</td>
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
        <div className="mt-12 text-center text-gray-600 text-sm">
          <p>Polymarket Trading Agent — Weather · Finance · Crypto</p>
          <p>Budget: 10 USDC · Half-Kelly · Déduplication 24h</p>
        </div>
      </div>
    </div>
  );
}
