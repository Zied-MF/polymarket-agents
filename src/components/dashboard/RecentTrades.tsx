"use client";

import { useState, useEffect } from "react";

interface TradeRow {
  id:            string;
  question:      string;
  city?:         string | null;
  outcome:       string;
  market_price:  number;
  suggested_bet: number;
  won:           boolean | null;
  potential_pnl: number;
  created_at:    string;
}

export function RecentTrades() {
  const [trades,  setTrades]  = useState<TradeRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res  = await fetch("/api/trades/recent");
        const data = await res.json();
        setTrades(data.trades ?? []);
      } catch { /* silent */ }
      finally { setLoading(false); }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  if (loading) return <p className="text-gray-500 text-sm py-4">Loading…</p>;

  if (trades.length === 0) {
    return <p className="text-gray-500 text-sm text-center py-8">No trades yet</p>;
  }

  return (
    <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
      {trades.map((trade) => (
        <div
          key={trade.id}
          className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg gap-3"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm truncate">{trade.question}</p>
            <p className="text-xs text-gray-400">
              {trade.outcome} @ {(trade.market_price * 100).toFixed(0)}¢
              {" · "}{trade.suggested_bet.toFixed(2)}$
            </p>
          </div>
          <div className="shrink-0 text-right">
            {trade.won === null ? (
              <span className="text-yellow-400 text-sm">⏳ Pending</span>
            ) : trade.won ? (
              <span className="text-green-400 text-sm">
                ✅ +{Number(trade.potential_pnl).toFixed(2)}$
              </span>
            ) : (
              <span className="text-red-400 text-sm">
                ❌ {Number(trade.potential_pnl).toFixed(2)}$
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
