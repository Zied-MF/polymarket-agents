"use client";

interface BotControlsProps {
  isRunning: boolean;
  onStart:   () => void;
  onStop:    () => void;
  lastScan:  string | null;
}

function formatAgo(date: string | null): string {
  if (!date) return "Never";
  const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 1)  return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function BotControls({ isRunning, onStart, onStop, lastScan }: BotControlsProps) {
  return (
    <div className="flex items-center gap-4">
      {/* Status indicator */}
      <div className="flex items-center gap-2">
        <div
          className={`w-2 h-2 rounded-full ${
            isRunning ? "bg-green-500 animate-pulse" : "bg-red-500"
          }`}
        />
        <span className="text-sm text-gray-400">
          {isRunning ? "Running" : "Stopped"}
        </span>
        {lastScan && (
          <span className="text-xs text-gray-500 hidden sm:inline">
            · Last scan: {formatAgo(lastScan)}
          </span>
        )}
      </div>

      {/* Start / Stop */}
      {isRunning ? (
        <button
          onClick={onStop}
          className="px-4 py-2 bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition font-medium text-sm"
        >
          ⏹ Stop Bot
        </button>
      ) : (
        <button
          onClick={onStart}
          className="px-4 py-2 bg-green-500/20 text-green-400 border border-green-500/30 rounded-lg hover:bg-green-500/30 transition font-medium text-sm"
        >
          ▶ Start Bot
        </button>
      )}
    </div>
  );
}
