import { NextResponse }             from "next/server";
import { stopBot, getBotState }     from "@/lib/bot/bot-state";
import { logActivity }              from "@/lib/logger";

export async function POST() {
  await stopBot();
  await logActivity("info", "Bot stopped");
  const state = await getBotState();
  return NextResponse.json({ success: true, state });
}
