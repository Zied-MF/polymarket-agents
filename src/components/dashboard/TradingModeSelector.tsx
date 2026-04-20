"use client";

const MODES = [
  {
    id:          "balanced",
    name:        "Balanced",
    description: "Conservative — YES < 15¢ · edge > 10%",
    icon:        "⚖️",
  },
  {
    id:          "aggressive",
    name:        "Aggressive",
    description: "Higher exposure — YES < 50¢ · edge > 8%",
    icon:        "🔥",
  },
  {
    id:          "high_conviction",
    name:        "High Conviction",
    description: "Very selective — YES < 15¢ · edge > 15%",
    icon:        "🎯",
  },
] as const;

interface TradingModeSelectorProps {
  currentMode: string;
  onChange:    (mode: string) => void;
  disabled?:   boolean;
}

export function TradingModeSelector({ currentMode, onChange, disabled }: TradingModeSelectorProps) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <h2 className="text-base font-semibold mb-1">🎛️ Trading Mode</h2>

      {disabled && (
        <p className="text-yellow-500/80 text-xs mb-3">
          ⚠️ Stop the bot to change trading mode
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        {MODES.map((mode) => {
          const active = currentMode === mode.id;
          return (
            <button
              key={mode.id}
              onClick={() => !disabled && onChange(mode.id)}
              disabled={disabled}
              className={`p-4 rounded-lg border-2 text-left transition ${
                active
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
              } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xl">{mode.icon}</span>
                <span className="font-semibold text-sm">{mode.name}</span>
                {active && (
                  <span className="ml-auto text-xs bg-blue-500 text-white px-2 py-0.5 rounded">
                    Active
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-400">{mode.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
