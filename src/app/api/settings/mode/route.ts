import { NextResponse }                   from "next/server";
import { setTradingMode, getBotState }    from "@/lib/bot/bot-state";
import { logActivity }                   from "@/lib/logger";
import type { TradingMode }              from "@/lib/config/trading-modes";

const VALID_MODES: TradingMode[] = ["balanced", "aggressive", "high_conviction"];

export async function POST(request: Request) {
  const { mode } = (await request.json()) as { mode: string };

  if (!VALID_MODES.includes(mode as TradingMode)) {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  await setTradingMode(mode as TradingMode);
  await logActivity("info", `Trading mode changed to ${mode}`);
  const state = await getBotState();

  return NextResponse.json({ success: true, state });
}
