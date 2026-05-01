"use client";

import { useState, useEffect } from "react";

interface PositionRow {
  id:            string;
  question:      string;
  outcome:       string;
  entry_price:   number;
  current_price?: number | null;
  suggested_bet: number;
  opened_at:     string;
}

function ageLabel(dateStr: string): string {
  const ms  = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60)  return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

interface PositionsTableProps {
  mode?: "real" | "paper";
}

export function PositionsTable({ mode }: PositionsTableProps) {
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    const url = mode ? `/api/positions?mode=${mode}` : "/api/positions";
    const load = async () => {
      try {
        const res  = await fetch(url);
        const data = await res.json();
        setPositions(data.positions ?? []);
      } catch { /* silent */ }
      finally { setLoading(false); }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [mode]);

  if (loading) return <p className="text-gray-500 text-sm py-4">Loading…</p>;

  if (positions.length === 0) {
    return <p className="text-gray-500 text-sm text-center py-8">No open positions</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-400 text-left text-xs border-b border-gray-800">
            <th className="pb-2 pr-4">Market</th>
            <th className="pb-2 pr-4">Side</th>
            <th className="pb-2 pr-4 text-right">Entry</th>
            <th className="pb-2 pr-4 text-right">Size</th>
            <th className="pb-2 text-right">Age</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {positions.map((pos) => {
            const current  = pos.current_price ?? pos.entry_price;
            const pnlPct   = ((current - pos.entry_price) / pos.entry_price) * 100;
            return (
              <tr key={pos.id} className="hover:bg-gray-800/30 transition">
                <td className="py-2 pr-4 max-w-[180px] truncate text-xs">{pos.question}</td>
                <td className={`py-2 pr-4 font-medium ${pos.outcome === "Yes" ? "text-green-400" : "text-red-400"}`}>
                  {pos.outcome}
                </td>
                <td className="py-2 pr-4 text-right font-mono text-xs">
                  {(pos.entry_price * 100).toFixed(0)}¢
                  {pos.current_price != null && (
                    <span className={`ml-1 ${pnlPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                      ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-right text-xs">{pos.suggested_bet.toFixed(2)}$</td>
                <td className="py-2 text-right text-xs text-gray-500">{ageLabel(pos.opened_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
