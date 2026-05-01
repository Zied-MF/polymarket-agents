import { NextResponse }       from "next/server";
import { cancelAllOrders }    from "@/lib/polymarket/clob-api";
import { sendDiscordAlert }   from "@/lib/utils/discord";

/**
 * POST /api/cancel-all-orders
 *
 * Annule tous les ordres LIMIT ouverts sur le CLOB Polymarket.
 * Utile pour nettoyer les ordres GTC stales avant le passage aux FOK.
 */
export async function POST() {
  try {
    const { cancelled } = await cancelAllOrders();

    const msg = `🧹 Cleaned ${cancelled} stale order(s) from Polymarket CLOB`;
    console.log(`[cancel-all-orders] ${msg}`);
    await sendDiscordAlert(msg).catch(() => {});

    return NextResponse.json({ ok: true, cancelled, message: msg });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cancel-all-orders] ✗", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
