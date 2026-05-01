"use client";

interface Stats {
  tradesToday:      number;
  totalTrades:      number;
  winRate:          string;
  pnlToday:         string;
  totalPnl:         string;
  openPositions:    number;
  currentBankroll?: string;
  initialBankroll?: number;
  roi?:             string;
}

interface LiveStatsProps {
  stats:      Stats | null;
  viewMode?:  "real" | "paper";
}

export function LiveStats({ stats, viewMode = "paper" }: LiveStatsProps) {
  const isReal = viewMode === "real";

  const cards = [
    {
      label:    isReal ? "Real Bankroll" : "Paper Bankroll",
      value:    stats?.currentBankroll ? `${stats.currentBankroll}$` : "—",
      icon:     isReal ? "💎" : "💵",
      color:    stats?.currentBankroll && parseFloat(stats.currentBankroll) > (stats.initialBankroll ?? 10)
                  ? "text-green-400"
                  : "text-gray-400",
      subtitle: stats?.roi ? `ROI: ${parseFloat(stats.roi) >= 0 ? "+" : ""}${stats.roi}%` : undefined,
    },
    {
      label: "Win Rate",
      value: stats ? `${stats.winRate}%` : "—",
      icon:  "🎯",
      color: stats && parseFloat(stats.winRate) >= 55 ? "text-green-400" : "text-yellow-400",
    },
    {
      label: "Total P&L",
      value: stats
        ? `${parseFloat(stats.totalPnl) >= 0 ? "+" : ""}${stats.totalPnl}$`
        : "—",
      icon:  "💰",
      color: stats && parseFloat(stats.totalPnl) >= 0 ? "text-green-400" : "text-red-400",
    },
    {
      label: "Today P&L",
      value: stats
        ? `${parseFloat(stats.pnlToday) >= 0 ? "+" : ""}${stats.pnlToday}$`
        : "—",
      icon:  "📅",
      color: stats && parseFloat(stats.pnlToday) >= 0 ? "text-green-400" : "text-red-400",
    },
    {
      label: "Total Trades",
      value: stats ? String(stats.totalTrades) : "—",
      icon:  "📊",
      color: "text-blue-400",
    },
    {
      label: "Today Trades",
      value: stats ? String(stats.tradesToday) : "—",
      icon:  "⚡",
      color: "text-purple-400",
    },
    {
      label: "Open Positions",
      value: stats ? String(stats.openPositions) : "—",
      icon:  "📈",
      color: "text-cyan-400",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-4">
      {cards.map((card) => (
        <div key={card.label} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-base">{card.icon}</span>
            <span className="text-xs text-gray-400">{card.label}</span>
          </div>
          <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
          {"subtitle" in card && card.subtitle && (
            <div className="text-xs text-gray-500 mt-1">{card.subtitle}</div>
          )}
        </div>
      ))}
    </div>
  );
}
