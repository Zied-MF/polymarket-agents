import { NextResponse }                    from "next/server";
import { getOpenOrderIds, cancelAllOrders } from "@/lib/polymarket/clob-api";
import { getClient }                        from "@/lib/db/supabase";
import { sendDiscordAlert }                 from "@/lib/utils/discord";

/**
 * POST /api/cancel-all-orders
 *
 * 1. Récupère les IDs des ordres ouverts sur le CLOB (avant annulation)
 * 2. Annule tous les ordres sur le CLOB (cancelAll)
 * 3. Trouve les positions DB dont clob_order_id est dans la liste
 * 4. Marque ces positions comme "sold" avec sell_pnl=0 (ordre jamais rempli)
 * 5. Zéroïse le potential_pnl des paper_trades associés (retirés du Today P&L)
 */
export async function POST() {
  try {
    const db  = getClient();
    const now = new Date().toISOString();

    // ── 1. Lire les ordres ouverts avant annulation ──────────────────────────
    let openOrderIds: string[] = [];
    try {
      openOrderIds = await getOpenOrderIds();
      console.log(`[cancel-all-orders] ${openOrderIds.length} ordre(s) ouvert(s) trouvé(s) sur CLOB`);
    } catch (err) {
      console.warn("[cancel-all-orders] getOpenOrderIds failed (continuing):", err instanceof Error ? err.message : err);
    }

    // ── 2. Annuler sur le CLOB ───────────────────────────────────────────────
    const { cancelled } = await cancelAllOrders();
    console.log(`[cancel-all-orders] CLOB: ${cancelled} ordre(s) annulé(s)`);

    // ── 3. Trouver les positions DB correspondantes ──────────────────────────
    let dbCleaned = 0;

    if (openOrderIds.length > 0) {
      // Positions réelles dont l'ordre CLOB était encore ouvert (jamais rempli)
      const { data: stalePositions, error: posErr } = await db
        .from("positions")
        .select("id, paper_trade_id, clob_order_id, market_id, outcome")
        .is("sold_at", null)
        .eq("is_real", true)
        .in("clob_order_id", openOrderIds);

      if (posErr) {
        console.warn("[cancel-all-orders] DB query error:", posErr.message);
      } else if (stalePositions && stalePositions.length > 0) {
        const positionIds   = stalePositions.map((p) => p.id);
        const paperTradeIds = stalePositions.map((p) => p.paper_trade_id).filter(Boolean) as string[];

        // ── 4. Fermer les positions (pnl=0, raison=cancelled) ────────────────
        const { error: closeErr } = await db
          .from("positions")
          .update({
            status:              "sold",
            sell_reason:         "cancelled_unfilled_order",
            sold_at:             now,
            sell_signal_at:      now,
            sell_price:          null,
            sell_pnl:            0,
          })
          .in("id", positionIds);

        if (closeErr) console.warn("[cancel-all-orders] closePositions error:", closeErr.message);

        // ── 5. Zéroïser le potential_pnl des paper_trades (retirés du P&L) ──
        if (paperTradeIds.length > 0) {
          const { error: ptErr } = await db
            .from("paper_trades")
            .update({
              potential_pnl: 0,
              won:           false,
            })
            .in("id", paperTradeIds);

          if (ptErr) console.warn("[cancel-all-orders] updatePaperTrades error:", ptErr.message);
        }

        dbCleaned = stalePositions.length;
        console.log(`[cancel-all-orders] DB: ${dbCleaned} position(s) stale fermée(s), ${paperTradeIds.length} paper_trade(s) zéroïsé(s)`);
      }
    } else {
      // Fallback : pas d'order IDs disponibles — fermer toutes les positions réelles ouvertes
      console.warn("[cancel-all-orders] No order IDs — closing all open real positions as fallback");

      const { data: allRealOpen } = await db
        .from("positions")
        .select("id, paper_trade_id")
        .is("sold_at", null)
        .eq("is_real", true);

      if (allRealOpen && allRealOpen.length > 0) {
        const positionIds   = allRealOpen.map((p) => p.id);
        const paperTradeIds = allRealOpen.map((p) => p.paper_trade_id).filter(Boolean) as string[];

        await db.from("positions").update({
          status:         "sold",
          sell_reason:    "cancelled_unfilled_order",
          sold_at:        now,
          sell_signal_at: now,
          sell_pnl:       0,
        }).in("id", positionIds);

        if (paperTradeIds.length > 0) {
          await db.from("paper_trades").update({
            potential_pnl: 0,
            won:           false,
          }).in("id", paperTradeIds);
        }

        dbCleaned = allRealOpen.length;
      }
    }

    // ── 6. Notification Discord ──────────────────────────────────────────────
    const msg =
      `🧹 Cancelled ${cancelled} stale CLOB order(s)` +
      (dbCleaned > 0 ? ` · ${dbCleaned} DB position(s) closed (P&L zeroed)` : "");
    console.log(`[cancel-all-orders] ${msg}`);
    await sendDiscordAlert(msg).catch(() => {});

    return NextResponse.json({ ok: true, cancelled, dbCleaned, message: msg });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cancel-all-orders] ✗", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
