"use client";

import { useState, useEffect } from "react";

interface LogEntry {
  id:        string;
  type:      string;
  message:   string;
  timestamp: string;
}

const TYPE_STYLE: Record<string, string> = {
  trade: "text-green-400 bg-green-500/10",
  skip:  "text-yellow-400 bg-yellow-500/10",
  error: "text-red-400 bg-red-500/10",
  exit:  "text-purple-400 bg-purple-500/10",
  info:  "text-blue-400 bg-blue-500/10",
  scan:  "text-blue-400 bg-blue-500/10",
};

const TYPE_ICON: Record<string, string> = {
  trade: "✅",
  skip:  "⏭️",
  error: "❌",
  exit:  "📤",
  info:  "ℹ️",
  scan:  "🔍",
};

export function ActivityLog() {
  const [logs,    setLogs]    = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res  = await fetch("/api/logs/recent");
        const data = await res.json();
        setLogs(data.logs ?? []);
      } catch { /* silent */ }
      finally { setLoading(false); }
    };
    load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, []);

  if (loading) return <p className="text-gray-500 text-sm py-4">Loading…</p>;

  if (logs.length === 0) {
    return (
      <p className="text-gray-500 text-sm text-center py-8">
        No activity yet. Start the bot to begin scanning.
      </p>
    );
  }

  return (
    <div className="space-y-1 max-h-[300px] overflow-y-auto font-mono text-xs pr-1">
      {logs.map((log) => (
        <div
          key={log.id}
          className={`flex items-start gap-2 p-2 rounded ${TYPE_STYLE[log.type] ?? "text-gray-400 bg-gray-800/30"}`}
        >
          <span className="shrink-0">{TYPE_ICON[log.type] ?? "•"}</span>
          <span className="text-gray-500 shrink-0">
            {new Date(log.timestamp).toLocaleTimeString()}
          </span>
          <span className="flex-1 break-all">{log.message}</span>
        </div>
      ))}
    </div>
  );
}
