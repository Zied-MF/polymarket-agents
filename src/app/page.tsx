"use client";

import { useState, useEffect, useCallback } from "react";
import { BotControls }          from "@/components/dashboard/BotControls";
import { TradingModeSelector }  from "@/components/dashboard/TradingModeSelector";
import { LiveStats }            from "@/components/dashboard/LiveStats";
import { PositionsTable }       from "@/components/dashboard/PositionsTable";
import { RecentTrades }         from "@/components/dashboard/RecentTrades";
import { ActivityLog }          from "@/components/dashboard/ActivityLog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BotState {
  isRunning:   boolean;
  mode:        string;
  startedAt:   string | null;
  lastScanAt:  string | null;
  tradesToday: number;
}

interface Stats {
  tradesToday:   number;
  totalTrades:   number;
  winRate:       string;
  pnlToday:      string;
  totalPnl:      string;
  openPositions: number;
}

interface TradingInfo {
  realTradingEnabled: boolean;
  balancePUsd:        number | null;
  funderAddress:      string | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [botState, setBotState] = useState<BotState | null>(null);
  const [stats,    setStats]    = useState<Stats | null>(null);
  const [trading,  setTrading]  = useState<TradingInfo | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // ── Fetch status ────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch("/api/bot/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBotState(data.state);
      setStats(data.stats);
      setTrading(data.trading ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleStart = async () => {
    await fetch("/api/bot/start", { method: "POST" });
    fetchStatus();
  };

  const handleStop = async () => {
    await fetch("/api/bot/stop", { method: "POST" });
    fetchStatus();
  };

  const handleModeChange = async (mode: string) => {
    await fetch("/api/settings/mode", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ mode }),
    });
    fetchStatus();
  };

  // ── Loading splash ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500" />
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white">

      {/* ── Sticky header ── */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🌤️</span>
            <div>
              <h1 className="text-lg font-bold leading-none">WeatherBot</h1>
              <span className="text-xs text-gray-500">
                {trading?.realTradingEnabled ? "Real Trading" : "Paper Trading"} · Polymarket
              </span>
            </div>
            {trading?.realTradingEnabled ? (
              <span className="text-xs font-semibold bg-green-900 text-green-300 border border-green-700 px-2 py-1 rounded">
                REAL
              </span>
            ) : (
              <span className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded">
                PAPER
              </span>
            )}
            <span className="hidden sm:inline text-xs text-gray-600 bg-gray-800 px-2 py-1 rounded">
              {botState?.mode ?? "balanced"}
            </span>
            {trading?.balancePUsd !== null && trading?.balancePUsd !== undefined && (
              <span className="hidden md:inline text-xs text-yellow-400 bg-yellow-950 border border-yellow-800 px-2 py-1 rounded">
                {trading.balancePUsd.toFixed(2)} pUSD
              </span>
            )}
          </div>

          {/* Error banner inline */}
          {error && (
            <span className="text-red-400 text-xs hidden md:inline">{error}</span>
          )}

          <BotControls
            isRunning={botState?.isRunning ?? false}
            onStart={handleStart}
            onStop={handleStop}
            lastScan={botState?.lastScanAt ?? null}
          />
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* ── KPI cards ── */}
        <LiveStats stats={stats} />

        {/* ── Trading mode selector ── */}
        <TradingModeSelector
          currentMode={botState?.mode ?? "balanced"}
          onChange={handleModeChange}
          disabled={botState?.isRunning ?? false}
        />

        {/* ── Manual scan button ── */}
        <button
          onClick={async () => {
            setScanning(true);
            try {
              const res  = await fetch("/api/scan-markets");
              const data = await res.json();
              console.log("Scan result:", data);
              fetchStatus();
            } catch (e) {
              console.error("Scan failed:", e);
            } finally {
              setScanning(false);
            }
          }}
          disabled={scanning || !(botState?.isRunning)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
        >
          {scanning
            ? <><span className="animate-spin inline-block">🔄</span> Scanning…</>
            : "🔍 Scanner les marchés"}
        </button>

        {/* ── Positions + Recent trades ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
              📊 Open Positions
              {stats && (
                <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">
                  {stats.openPositions}
                </span>
              )}
            </h2>
            <PositionsTable />
          </div>

          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h2 className="text-base font-semibold mb-4">📈 Recent Trades</h2>
            <RecentTrades />
          </div>
        </div>

        {/* ── Activity log ── */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-base font-semibold mb-4">📝 Activity Log</h2>
          <ActivityLog />
        </div>

      </main>

      <footer className="border-t border-gray-800 py-5 text-center text-gray-600 text-xs">
        Powered by Claude AI · GFS · ECMWF · UKMO
      </footer>
    </div>
  );
}
