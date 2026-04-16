"use client";

import { useState, useEffect, useCallback } from "react";
import type { ResultsResponse, AgentStats, DailyPnL } from "@/app/api/results/route";

// ---------------------------------------------------------------------------
// Types locaux
// ---------------------------------------------------------------------------

type Period = "7" | "30" | "all";

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
  value: string;
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

function AgentCard({ title, stats, icon }: { title: string; stats: AgentStats; icon: string }) {
  const resolved = stats.wins + stats.losses;
  const pnlColor = stats.pnl >= 0 ? "text-green-400" : "text-red-400";
  const pnlSign  = stats.pnl >= 0 ? "+" : "";

  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
        <span>{icon}</span>
        {title}
      </h3>
      <div className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Trades</span>
          <span className="font-medium">{stats.trades}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Victoires</span>
          <span className="font-medium text-green-400">{stats.wins}W / {stats.losses}L</span>
        </div>
        <div className="flex justify-between text-sm border-t border-gray-800 pt-3">
          <span className="text-gray-400">Win rate</span>
          <span className="font-semibold">
            {resolved > 0 ? `${stats.winRate.toFixed(1)}%` : "—"}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">P&L total</span>
          <span className={`font-bold ${pnlColor}`}>
            {resolved > 0 ? `${pnlSign}${stats.pnl.toFixed(2)}€` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graphique SVG P&L cumulé
// ---------------------------------------------------------------------------

function PnLChart({ data }: { data: DailyPnL[] }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
        Aucun trade résolu — le graphique apparaîtra après la première résolution
      </div>
    );
  }

  // Dimensions internes du viewBox (indépendantes du rendu CSS)
  const W = 800, H = 200;
  const padL = 58, padR = 20, padT = 20, padB = 38;
  const cW   = W - padL - padR;
  const cH   = H - padT - padB;

  const values  = data.map((d) => d.cumulative);
  const rawMin  = Math.min(...values);
  const rawMax  = Math.max(...values);
  const minV    = Math.min(0, rawMin);
  const maxV    = Math.max(0, rawMax);
  const range   = maxV - minV || 1;

  const toX = (i: number) =>
    padL + (data.length === 1 ? cW / 2 : (i / (data.length - 1)) * cW);
  const toY = (v: number) => padT + (1 - (v - minV) / range) * cH;

  const zeroY = toY(0);
  const lastV = values[values.length - 1];

  // Couleurs selon le signe final
  const lineColor   = lastV >= 0 ? "#22c55e" : "#ef4444";
  const fillAbove   = "rgba(34,197,94,0.12)";
  const fillBelow   = "rgba(239,68,68,0.12)";

  // SVG path de la ligne
  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(d.cumulative).toFixed(1)}`)
    .join(" ");

  // Aire sous/sur la ligne, fermée sur la ligne zéro
  const fillPath =
    `${linePath} ` +
    `L ${toX(data.length - 1).toFixed(1)} ${zeroY.toFixed(1)} ` +
    `L ${toX(0).toFixed(1)} ${zeroY.toFixed(1)} Z`;

  // Ticks Y (5 niveaux)
  const yTicks     = 5;
  const yTickVals  = Array.from({ length: yTicks }, (_, k) => minV + (k / (yTicks - 1)) * range);

  // Labels X : max 7, espacés
  const maxLabels = 7;
  const step      = Math.max(1, Math.ceil(data.length / maxLabels));
  const xIndices  = Array.from({ length: data.length }, (_, k) => k).filter(
    (k) => k % step === 0 || k === data.length - 1
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: "220px" }}
      aria-label="Graphique P&L cumulé"
    >
      <defs>
        <clipPath id="chart-clip">
          <rect x={padL} y={padT} width={cW} height={cH} />
        </clipPath>
      </defs>

      {/* Grille horizontale */}
      {yTickVals.map((v, k) => (
        <line
          key={k}
          x1={padL} y1={toY(v).toFixed(1)}
          x2={W - padR} y2={toY(v).toFixed(1)}
          stroke={v === 0 ? "#6b7280" : "#1f2937"}
          strokeWidth={v === 0 ? 1 : 1}
          strokeDasharray={v === 0 ? "4 3" : undefined}
        />
      ))}

      {/* Aire colorée */}
      <path
        d={fillPath}
        fill={lastV >= 0 ? fillAbove : fillBelow}
        clipPath="url(#chart-clip)"
      />

      {/* Ligne principale */}
      <path
        d={linePath}
        fill="none"
        stroke={lineColor}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        clipPath="url(#chart-clip)"
      />

      {/* Points de données (seulement si peu de points) */}
      {data.length <= 40 &&
        data.map((d, i) => (
          <circle
            key={i}
            cx={toX(i).toFixed(1)}
            cy={toY(d.cumulative).toFixed(1)}
            r="3"
            fill={lineColor}
          />
        ))}

      {/* Labels Y */}
      {yTickVals.map((v, k) => (
        <text
          key={k}
          x={padL - 6}
          y={(toY(v) + 4).toFixed(1)}
          textAnchor="end"
          fill="#6b7280"
          fontSize="10"
          fontFamily="monospace"
        >
          {(v >= 0 ? "+" : "") + v.toFixed(2)}
        </text>
      ))}

      {/* Labels X */}
      {xIndices.map((idx) => (
        <text
          key={idx}
          x={toX(idx).toFixed(1)}
          y={(H - padB + 14).toFixed(1)}
          textAnchor="middle"
          fill="#6b7280"
          fontSize="10"
        >
          {data[idx].date.slice(5)} {/* MM-DD */}
        </text>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Tableau des trades
// ---------------------------------------------------------------------------

function TradeTable({ trades }: { trades: ResultsResponse["recentTrades"] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-sm">
        <thead className="bg-gray-800 text-gray-400">
          <tr>
            <th className="text-left px-4 py-3 whitespace-nowrap">Date</th>
            <th className="text-left px-4 py-3">Agent</th>
            <th className="text-left px-4 py-3 max-w-[220px]">Marché</th>
            <th className="text-left px-4 py-3">Outcome</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">Edge</th>
            <th className="text-right px-4 py-3 whitespace-nowrap">Mise</th>
            <th className="text-center px-4 py-3">Résultat</th>
            <th className="text-right px-4 py-3">P&L</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const isWon    = t.won === true;
            const isLost   = t.won === false;
            const isPending = t.won === null;
            const rowCls   = isWon
              ? "bg-green-500/5 hover:bg-green-500/10"
              : isLost
              ? "bg-red-500/5 hover:bg-red-500/10"
              : "hover:bg-gray-800/50";
            const pnlColor = isWon ? "text-green-400" : isLost ? "text-red-400" : "text-gray-400";
            const pnlSign  = isWon && (t.potential_pnl ?? 0) >= 0 ? "+" : "";

            return (
              <tr key={t.id} className={`border-t border-gray-800 transition-colors ${rowCls}`}>
                <td className="px-4 py-3 whitespace-nowrap text-gray-400 font-mono text-xs">
                  {t.created_at.slice(0, 10)}
                </td>
                <td className="px-4 py-3">
                  {t.agent === "finance" ? (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400 whitespace-nowrap">
                      📈 Finance
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-cyan-500/20 text-cyan-400 whitespace-nowrap">
                      🌡 Météo
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 max-w-[220px]">
                  <p className="truncate text-gray-300" title={t.question ?? ""}>
                    {t.city ?? t.ticker ?? t.question ?? "—"}
                  </p>
                  {t.question && (
                    <p className="truncate text-gray-500 text-xs" title={t.question}>
                      {t.question}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-gray-300 whitespace-nowrap">
                  {t.outcome}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-yellow-400 whitespace-nowrap">
                  +{(t.edge * 100).toFixed(1)}%
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                  {t.suggested_bet.toFixed(2)}€
                </td>
                <td className="px-4 py-3 text-center">
                  {isPending ? (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-gray-700 text-gray-400">
                      En attente
                    </span>
                  ) : isWon ? (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">
                      Gagné
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400">
                      Perdu
                    </span>
                  )}
                </td>
                <td className={`px-4 py-3 text-right font-bold font-mono text-xs ${pnlColor} whitespace-nowrap`}>
                  {isPending
                    ? `~${pnlSign}${(t.potential_pnl ?? 0).toFixed(2)}€`
                    : `${pnlSign}${(t.potential_pnl ?? 0).toFixed(2)}€`}
                </td>
              </tr>
            );
          })}

          {trades.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                Aucun trade pour cette période
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page principale
// ---------------------------------------------------------------------------

export default function ResultsPage() {
  const [period, setPeriod]   = useState<Period>("7");
  const [data, setData]       = useState<ResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchData = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/results?period=${p}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ResultsResponse = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(period);
  }, [period, fetchData]);

  const s = data?.stats;

  const pnlColor = (v: number) =>
    v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-white";
  const fmt = (v: number, sign = true) =>
    `${sign && v > 0 ? "+" : ""}${v.toFixed(2)}€`;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto">

        {/* ── Header ── */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold">📊 Paper Trading Results</h1>
            <p className="text-gray-400 mt-1 text-sm">
              Backtesting virtuel — aucun vrai argent engagé
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
              href="/positions"
              className="px-3 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition"
            >
              📍 Positions
            </a>

            {/* Sélecteur de période */}
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as Period)}
              className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-gray-500 cursor-pointer"
            >
              <option value="7">7 jours</option>
              <option value="30">30 jours</option>
              <option value="all">All time</option>
            </select>

            <button
              onClick={() => fetchData(period)}
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

        {/* ── Skeleton loading ── */}
        {loading && !data && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-gray-900 rounded-xl p-4 border border-gray-800 animate-pulse h-24" />
            ))}
          </div>
        )}

        {data && (
          <>
            {/* ── Stats globales ── */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
              <StatCard
                label="Total trades"
                value={String(s!.totalTrades)}
                sub={`${s!.resolved} résolus · ${s!.pending} en attente`}
              />
              <StatCard
                label="Win rate"
                value={s!.resolved > 0 ? `${s!.winRate.toFixed(1)}%` : "—"}
                sub={`${s!.wins}W / ${s!.losses}L`}
                color={s!.winRate >= 50 ? "text-green-400" : "text-red-400"}
              />
              <StatCard
                label="P&L total"
                value={s!.resolved > 0 ? fmt(s!.totalPnl) : "—"}
                color={pnlColor(s!.totalPnl)}
              />
              <StatCard
                label="P&L moyen / trade"
                value={s!.resolved > 0 ? fmt(s!.avgPnl) : "—"}
                color={pnlColor(s!.avgPnl)}
              />
              <StatCard
                label="Meilleur trade"
                value={s!.resolved > 0 ? fmt(s!.bestTrade) : "—"}
                color="text-green-400"
              />
              <StatCard
                label="Pire trade"
                value={s!.resolved > 0 ? fmt(s!.worstTrade) : "—"}
                color="text-red-400"
              />
            </div>

            {/* ── Stats par agent ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              <AgentCard title="Weather Agent" stats={data.byAgent.weather} icon="🌡" />
              <AgentCard title="Finance Agent" stats={data.byAgent.finance} icon="📈" />
            </div>

            {/* ── Graphique P&L cumulé ── */}
            <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 mb-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">📈 P&L cumulé</h2>
                {data.dailyPnl.length > 0 && (
                  <span className={`text-sm font-bold ${pnlColor(data.dailyPnl[data.dailyPnl.length - 1].cumulative)}`}>
                    {fmt(data.dailyPnl[data.dailyPnl.length - 1].cumulative)}
                  </span>
                )}
              </div>
              <PnLChart data={data.dailyPnl} />
            </div>

            {/* ── Tableau des trades ── */}
            <div>
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                🗂 Trades récents
                <span className="text-sm font-normal text-gray-400">
                  ({data.recentTrades.length})
                </span>
              </h2>
              <TradeTable trades={data.recentTrades} />
            </div>
          </>
        )}

        {/* ── Footer ── */}
        <div className="mt-12 text-center text-gray-500 text-xs">
          <p>Paper Trading Mode — les P&L en attente sont estimés (½ Kelly)</p>
        </div>
      </div>
    </div>
  );
}
