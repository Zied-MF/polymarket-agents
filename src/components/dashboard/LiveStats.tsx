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

interface BankrollCardSubtitle {
  roi:             number;
  initialBankroll: number;
}

interface LiveStatsProps {
  stats:      Stats | null;
  viewMode?:  "real" | "paper";
}

function BankrollSubtitle({ roi, initialBankroll }: BankrollCardSubtitle) {
  const sign      = roi >= 0 ? "+" : "";
  const color     = roi >= 0 ? "text-green-400" : "text-red-400";
  return (
    <div className="text-xs mt-1 space-y-0.5">
      <span className={`font-semibold ${color}`}>ROI: {sign}{roi.toFixed(1)}%</span>
      <span className="text-gray-500 ml-1">(init: ${initialBankroll.toFixed(2)})</span>
    </div>
  );
}

export function LiveStats({ stats, viewMode = "paper" }: LiveStatsProps) {
  const isReal          = viewMode === "real";
  const initialBankroll = stats?.initialBankroll ?? (isReal ? 61.59 : 10);
  const currentBankroll = stats?.currentBankroll ? parseFloat(stats.currentBankroll) : null;
  const roi             = stats?.roi ? parseFloat(stats.roi) : null;

  const cards = [
    {
      label:      isReal ? "Real Bankroll" : "Paper Bankroll",
      value:      stats?.currentBankroll ? `$${stats.currentBankroll}` : "—",
      icon:       isReal ? "💎" : "💵",
      color:      currentBankroll !== null && currentBankroll > initialBankroll
                    ? "text-green-400"
                    : "text-red-400",
      roiSubtitle: roi !== null ? { roi, initialBankroll } : null,
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
          {"roiSubtitle" in card && card.roiSubtitle && (
            <BankrollSubtitle {...card.roiSubtitle} />
          )}
        </div>
      ))}
    </div>
  );
}
