"use client";

import { useState, useEffect, useCallback } from "react";
import type { PositionsStatsResponse, PositionStats } from "@/app/api/positions-stats/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(v: number, sign = true) {
  return `${sign && v > 0 ? "+" : ""}${v.toFixed(2)}€`;
}

function pnlColor(v: number | null) {
  if (v === null) return "text-gray-400";
  return v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-gray-300";
}

function deltaProb(entry: number, current: number | null) {
  if (current === null) return null;
  return current - entry;
}

// ---------------------------------------------------------------------------
// Sous-composants
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  color = "text-white",
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <p className="text-gray-400 text-sm mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-gray-500 text-xs mt-1">{sub}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: PositionStats["status"] }) {
  switch (status) {
    case "open":
      return <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400 whitespace-nowrap">⬤ Open</span>;
    case "hold":
      return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400 whitespace-nowrap">✓ HOLD</span>;
    case "sell_signal":
      return <span className="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400 whitespace-nowrap font-semibold">⚠ SELL</span>;
    case "sold":
      return <span className="px-2 py-0.5 text-xs rounded-full bg-orange-500/20 text-orange-400 whitespace-nowrap">✗ Sold</span>;
    case "resolved":
      return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-700 text-gray-400 whitespace-nowrap">✔ Résolu</span>;
  }
}

function AgentBadge({ agent }: { agent: "weather" | "finance" | "crypto" }) {
  if (agent === "finance") return <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400">📈 Finance</span>;
  if (agent === "crypto")  return <span className="px-2 py-0.5 text-xs rounded-full bg-purple-500/20 text-purple-400">₿ Crypto</span>;
  return <span className="px-2 py-0.5 text-xs rounded-full bg-cyan-500/20 text-cyan-400">🌡 Météo</span>;
}

// ---------------------------------------------------------------------------
// Tableau — Positions ouvertes
// ---------------------------------------------------------------------------

function OpenPositionsTable({ positions }: { positions: PositionStats[] }) {
  const open = positions.filter((p) => p.status === "open" || p.status === "hold");

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-sm">
        <thead className="bg-gray-800 text-gray-400">
          <tr>
            <th className="text-left px-4 py-3">Agent</th>
            <th className="text-left px-4 py-3 max-w-[200px]">Marché</th>
            <th className="text-left px-4 py-3 whitespace-nowrap">Outcome</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">Entrée</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">Actuel</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">Δ Prob</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">P&L latent</th>
            <th className="text-center px-4 py-3">Statut</th>
            <th className="text-left px-4 py-3 whitespace-nowrap">Résolution</th>
          </tr>
        </thead>
        <tbody>
          {open.map((p) => {
            const delta = deltaProb(p.entryProbability, p.currentProbability);
            const deltaStr = delta !== null
              ? `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts`
              : "—";
            const deltaColor = delta === null ? "text-gray-400"
              : delta >= 0.05 ? "text-green-400"
              : delta <= -0.05 ? "text-red-400"
              : "text-gray-300";

            return (
              <tr key={p.id} className="border-t border-gray-800 hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3"><AgentBadge agent={p.agent} /></td>
                <td className="px-4 py-3 max-w-[200px]">
                  <p className="font-medium text-gray-200 truncate" title={p.question}>
                    {p.city ?? p.ticker ?? "—"}
                  </p>
                  <p className="text-xs text-gray-500 truncate" title={p.question}>{p.question}</p>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-gray-300 whitespace-nowrap">{p.outcome}</td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                  {(p.entryPrice * 100).toFixed(1)}%
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                  {p.currentPrice !== null ? `${(p.currentPrice * 100).toFixed(1)}%` : "—"}
                </td>
                <td className={`px-4 py-3 text-right font-mono text-xs whitespace-nowrap ${deltaColor}`}>
                  {deltaStr}
                </td>
                <td className={`px-4 py-3 text-right font-mono text-xs font-semibold whitespace-nowrap ${pnlColor(p.unrealizedPnl)}`}>
                  {p.unrealizedPnl !== null ? fmt(p.unrealizedPnl) : "—"}
                </td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={p.status} />
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                  {p.resolutionDate ? p.resolutionDate.slice(0, 10) : "—"}
                </td>
              </tr>
            );
          })}

          {open.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-10 text-center text-gray-500">
                Aucune position ouverte
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tableau — Historique des sell signals
// ---------------------------------------------------------------------------

function SellSignalTable({ positions }: { positions: PositionStats[] }) {
  const signals = positions.filter(
    (p) => p.status === "sell_signal" || p.status === "sold"
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-sm">
        <thead className="bg-gray-800 text-gray-400">
          <tr>
            <th className="text-left px-4 py-3 whitespace-nowrap">Date signal</th>
            <th className="text-left px-4 py-3">Agent</th>
            <th className="text-left px-4 py-3 max-w-[200px]">Marché</th>
            <th className="text-left px-4 py-3">Raison</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">Entrée</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">Prix signal</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">P&L signal</th>
            <th className="text-center px-4 py-3">Statut</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((p) => (
            <tr
              key={p.id}
              className="border-t border-gray-800 hover:bg-gray-800/40 transition-colors"
            >
              <td className="px-4 py-3 text-xs text-gray-400 font-mono whitespace-nowrap">
                {p.sellSignalAt ? p.sellSignalAt.slice(0, 16).replace("T", " ") : "—"}
              </td>
              <td className="px-4 py-3"><AgentBadge agent={p.agent} /></td>
              <td className="px-4 py-3 max-w-[180px]">
                <p className="text-gray-200 font-medium truncate" title={p.question}>
                  {p.city ?? p.ticker ?? "—"}
                </p>
                <p className="text-xs text-gray-500 truncate" title={p.question}>{p.question}</p>
              </td>
              <td className="px-4 py-3 text-xs text-gray-400 max-w-[200px]">
                <span className="truncate block" title={p.sellReason ?? ""}>{p.sellReason ?? "—"}</span>
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                {(p.entryPrice * 100).toFixed(1)}%
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                {p.status === "sold" && p.sellPrice !== null
                  ? `${(p.sellPrice * 100).toFixed(1)}%`
                  : p.currentPrice !== null
                  ? `${(p.currentPrice * 100).toFixed(1)}%`
                  : "—"}
              </td>
              <td className={`px-4 py-3 text-right font-mono text-xs font-semibold whitespace-nowrap ${pnlColor(p.pnlIfSold)}`}>
                {p.status === "sold" && p.sellPnl !== null
                  ? fmt(p.sellPnl)
                  : p.pnlIfSold !== null
                  ? fmt(p.pnlIfSold)
                  : "—"}
              </td>
              <td className="px-4 py-3 text-center">
                <StatusBadge status={p.status} />
              </td>
            </tr>
          ))}

          {signals.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                Aucun sell signal émis pour le moment
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section comparaison stratégies
// ---------------------------------------------------------------------------

function ComparisonSection({ comparison }: { comparison: PositionsStatsResponse["comparison"] }) {
  const { totalPnlHold, totalPnlSell, difference, betterStrategy, signalsCount } = comparison;

  const holdColor  = totalPnlHold >= 0 ? "text-green-400" : "text-red-400";
  const sellColor  = totalPnlSell >= 0 ? "text-green-400" : "text-red-400";
  const diffColor  = difference > 0 ? "text-green-400" : difference < 0 ? "text-red-400" : "text-gray-300";
  const betterBg   =
    betterStrategy === "SELL" ? "border-red-500/40 bg-red-500/5"
    : betterStrategy === "HOLD" ? "border-green-500/40 bg-green-500/5"
    : "border-gray-700 bg-gray-900";

  return (
    <div className={`rounded-xl border p-5 ${betterBg}`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">⚖️ Comparaison stratégies</h2>
        <span className="text-xs text-gray-500">
          Sur {signalsCount} position{signalsCount !== 1 ? "s" : ""} avec sell signal
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* P&L HOLD */}
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <p className="text-gray-400 text-sm mb-1">🤝 P&L si HOLD</p>
          <p className={`text-2xl font-bold ${holdColor}`}>
            {signalsCount > 0 ? fmt(totalPnlHold) : "—"}
          </p>
          <p className="text-gray-500 text-xs mt-1">Garder jusqu'à résolution</p>
        </div>

        {/* P&L SELL */}
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <p className="text-gray-400 text-sm mb-1">🔴 P&L si SELL</p>
          <p className={`text-2xl font-bold ${sellColor}`}>
            {signalsCount > 0 ? fmt(totalPnlSell) : "—"}
          </p>
          <p className="text-gray-500 text-xs mt-1">Vendre au prix du signal</p>
        </div>

        {/* Différence */}
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <p className="text-gray-400 text-sm mb-1">
            {betterStrategy === "SELL" ? "🏆 SELL gagne de" : betterStrategy === "HOLD" ? "🏆 HOLD gagne de" : "⚖️ Égalité"}
          </p>
          <p className={`text-2xl font-bold ${diffColor}`}>
            {signalsCount > 0 ? fmt(Math.abs(difference)) : "—"}
          </p>
          <p className="text-gray-500 text-xs mt-1">
            {betterStrategy === "EQUAL" ? "Stratégies équivalentes" : `Avantage ${betterStrategy}`}
          </p>
        </div>
      </div>

      {signalsCount === 0 && (
        <p className="text-center text-gray-500 text-sm mt-4">
          La comparaison sera disponible après le premier sell signal
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page principale
// ---------------------------------------------------------------------------

export default function PositionsPage() {
  const [data, setData]       = useState<PositionsStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/positions-stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: PositionsStatsResponse = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const counts = data?.counts;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-7xl mx-auto">

        {/* ── Header ── */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold">📍 Position Manager</h1>
            <p className="text-gray-400 mt-1 text-sm">
              Suivi en temps réel des positions et sell signals
              {data && (
                <span className="ml-2 text-gray-600">
                  · Mis à jour {new Date(data.fetchedAt).toLocaleString("fr-FR")}
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <a
              href="/"
              className="px-3 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition"
            >
              ← Dashboard
            </a>
            <a
              href="/results"
              className="px-3 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition"
            >
              📊 Results
            </a>
            <button
              onClick={() => fetch("/api/monitor-positions").catch(() => null).then(() => fetchData())}
              disabled={loading}
              className="px-3 py-2 bg-orange-600 hover:bg-orange-700 rounded-lg text-sm font-medium disabled:opacity-50 transition"
              title="Lance le monitoring et rafraîchit"
            >
              {loading ? "⏳" : "🔍"} Monitor
            </button>
            <button
              onClick={fetchData}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium disabled:opacity-50 transition"
            >
              {loading ? "⏳" : "🔄"} Rafraîchir
            </button>
          </div>
        </div>

        {/* ── Erreur ── */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-4 mb-8 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* ── Skeleton ── */}
        {loading && !data && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-gray-900 rounded-xl p-4 border border-gray-800 animate-pulse h-24" />
            ))}
          </div>
        )}

        {data && (
          <>
            {/* ── Stats cards ── */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
              <StatCard
                label="Positions ouvertes"
                value={(counts!.open + counts!.hold)}
                sub={`${counts!.open} open · ${counts!.hold} hold`}
                color="text-blue-400"
              />
              <StatCard
                label="Sell signals"
                value={counts!.sellSignals}
                sub="signaux émis"
                color={counts!.sellSignals > 0 ? "text-red-400" : "text-white"}
              />
              <StatCard
                label="Vendues"
                value={counts!.sold}
                color="text-orange-400"
              />
              <StatCard
                label="Résolues"
                value={counts!.resolved}
                color="text-gray-300"
              />
              <StatCard
                label="Total positions"
                value={counts!.total}
                sub="toutes périodes"
              />
            </div>

            {/* ── Positions ouvertes ── */}
            <section className="mb-8">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                📂 Positions ouvertes
                <span className="text-sm font-normal text-gray-400">
                  ({counts!.open + counts!.hold})
                </span>
              </h2>
              <OpenPositionsTable positions={data.positions} />
            </section>

            {/* ── Historique sell signals ── */}
            <section className="mb-8">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                🔴 Historique des Sell Signals
                <span className="text-sm font-normal text-gray-400">
                  ({counts!.sellSignals + counts!.sold})
                </span>
              </h2>
              <SellSignalTable positions={data.positions} />
            </section>

            {/* ── Comparaison stratégies ── */}
            <section className="mb-8">
              <ComparisonSection comparison={data.comparison} />
            </section>
          </>
        )}

        {/* ── Footer ── */}
        <div className="mt-8 text-center text-gray-600 text-xs">
          <p>Position Manager · Sell signal si Δ prob ≥ −20 pts ou prix ÷ 2</p>
        </div>
      </div>
    </div>
  );
}
