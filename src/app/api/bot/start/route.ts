import { NextResponse }             from "next/server";
import { startBot, getBotState }    from "@/lib/bot/bot-state";
import { logActivity }              from "@/lib/logger";

export async function POST() {
  await startBot();
  await logActivity("info", "Bot started");
  const state = await getBotState();
  return NextResponse.json({ success: true, state });
}
