/**
 * GET /api/sync-positions[?dry_run=true]
 *
 * Synchronise les positions DB avec la réalité on-chain.
 *
 * Pour chaque position is_real=true et non vendue :
 *   1. Résout le tokenId via CLOB API
 *   2. Lit le solde ERC-1155 réel (balanceOf sur le funder)
 *   3. Compare avec le calcul DB (suggested_bet / entry_price)
 *   4. Met à jour shares_filled + entry_price si différent
 *   5. Si realShares=0 et marché fermé → note "needs_redeem"
 *   6. Si realShares=0 et marché ouvert → marque sold (vendu manuellement)
 *
 * dry_run=true (défaut) : log les corrections sans les appliquer.
 * dry_run=false          : applique les corrections en DB.
 *
 * SQL pré-requis :
 *   ALTER TABLE positions ADD COLUMN IF NOT EXISTS shares_filled DECIMAL;
 *   ALTER TABLE positions ADD COLUMN IF NOT EXISTS sync_attempts INTEGER DEFAULT 0;
 *   ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_status_check;
 *   ALTER TABLE positions ADD CONSTRAINT positions_status_check
 *     CHECK (status IN ('open','hold','sell_signal','sold','resolved','sell_failed'));
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@supabase/supabase-js";
import { getClobMarket }             from "@/lib/polymarket/clob-api";
import { getTokenBalance }           from "@/lib/polymarket/clob-api";
import { sendDiscordAlert }          from "@/lib/utils/discord";

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncRecord {
  positionId:     string;
  question:       string;
  outcome:        string;
  status:         string;
  sharesDB:       number;
  sharesOnChain:  number | null;
  entryPriceDB:   number;
  entryPriceReal: number | null;
  action:         "ok" | "corrected" | "zero_open" | "zero_closed" | "clob_not_found" | "balance_error";
  note:           string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const dryRun = req.nextUrl.searchParams.get("dry_run") !== "false";
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS;

  if (!funder) {
    return NextResponse.json({ error: "POLYMARKET_FUNDER_ADDRESS non défini" }, { status: 500 });
  }

  const db = getDb();

  // Fetch all real open positions (including sell_failed)
  const { data: rows, error: dbErr } = await db
    .from("positions")
    .select("id, market_id, question, outcome, entry_price, suggested_bet, shares_filled, status, is_real, sold_at")
    .eq("is_real", true)
    .is("sold_at", null)
    .order("opened_at", { ascending: false });

  if (dbErr) {
    return NextResponse.json({ error: dbErr.message }, { status: 502 });
  }

  const positions = rows ?? [];
  const results: SyncRecord[] = [];
  let correctedCount = 0;

  for (const pos of positions) {
    const sharesDB      = pos.suggested_bet / pos.entry_price;
    const rec: SyncRecord = {
      positionId:     pos.id,
      question:       (pos.question ?? "").slice(0, 80),
      outcome:        pos.outcome,
      status:         pos.status,
      sharesDB:       Math.round(sharesDB * 10000) / 10000,
      sharesOnChain:  null,
      entryPriceDB:   pos.entry_price,
      entryPriceReal: null,
      action:         "ok",
      note:           "",
    };

    // 1. Resolve tokenId via CLOB
    let tokenId: string | null = null;
    let negRisk = false;
    let marketActive = true;
    try {
      const clobMarket = await getClobMarket(pos.market_id);
      if (!clobMarket) {
        rec.action = "clob_not_found";
        rec.note   = "Market not found in CLOB — may be resolved or integer Gamma ID";
        results.push(rec);
        continue;
      }
      negRisk      = clobMarket.negRisk;
      marketActive = clobMarket.active;
      const token  = clobMarket.tokens.find(
        (t) => t.outcome.toLowerCase() === pos.outcome.toLowerCase()
      );
      tokenId = token?.tokenId ?? null;
    } catch (err) {
      rec.action = "clob_not_found";
      rec.note   = `getClobMarket error: ${err instanceof Error ? err.message : String(err)}`;
      results.push(rec);
      continue;
    }

    if (!tokenId) {
      rec.action = "clob_not_found";
      rec.note   = `Token outcome="${pos.outcome}" not found in CLOB market`;
      results.push(rec);
      continue;
    }

    // 2. Read on-chain balance
    let realShares: number | null = null;
    try {
      realShares = await getTokenBalance(funder, tokenId);
      rec.sharesOnChain = Math.round(realShares * 10000) / 10000;
    } catch (err) {
      rec.action = "balance_error";
      rec.note   = `getTokenBalance error: ${err instanceof Error ? err.message : String(err)}`;
      results.push(rec);
      continue;
    }

    // 3. Determine action
    if (realShares < 0.001) {
      if (!marketActive) {
        rec.action = "zero_closed";
        rec.note   = "Market closed + 0 shares → needs redeem (see /api/redeem-positions)";
      } else {
        rec.action = "zero_open";
        rec.note   = "0 shares on-chain, market open → likely sold manually — marking sold in DB";
        if (!dryRun) {
          const now = new Date().toISOString();
          await db.from("positions").update({
            status:          "sold",
            sell_reason:     "sync: 0 shares on-chain (sold manually or FAK 0-filled)",
            sold_at:         now,
            sell_signal_at:  now,
            sell_price:      0,
            sell_pnl:        -(pos.suggested_bet),
            shares_filled:   0,
          }).eq("id", pos.id);
          correctedCount++;
        }
      }
    } else {
      // 4. Compare shares and correct if significantly different (>5% delta)
      const delta = Math.abs(realShares - sharesDB) / Math.max(sharesDB, 0.001);
      rec.entryPriceReal = Math.round(pos.suggested_bet / realShares * 10000) / 10000;

      if (delta > 0.05) {
        rec.action = "corrected";
        rec.note   = `shares: DB ${sharesDB.toFixed(4)} → real ${realShares.toFixed(4)} (${(delta*100).toFixed(1)}% diff); entry_price: ${pos.entry_price} → ${rec.entryPriceReal}`;
        if (!dryRun) {
          await db.from("positions").update({
            shares_filled: realShares,
            entry_price:   rec.entryPriceReal,
          }).eq("id", pos.id);
          correctedCount++;
        }
      } else {
        rec.action = "ok";
        rec.note   = `shares match (${(delta*100).toFixed(1)}% delta < 5%)`;
        // Still store shares_filled if not set
        if (pos.shares_filled === null && !dryRun) {
          await db.from("positions").update({ shares_filled: realShares }).eq("id", pos.id);
        }
      }
    }

    results.push(rec);
  }

  const summary = {
    checkedAt:      new Date().toISOString(),
    dryRun,
    funder:         `${funder.slice(0, 10)}…`,
    totalChecked:   positions.length,
    corrected:      correctedCount,
    byAction: {
      ok:            results.filter(r => r.action === "ok").length,
      corrected:     results.filter(r => r.action === "corrected").length,
      zero_open:     results.filter(r => r.action === "zero_open").length,
      zero_closed:   results.filter(r => r.action === "zero_closed").length,
      clob_not_found: results.filter(r => r.action === "clob_not_found").length,
      balance_error: results.filter(r => r.action === "balance_error").length,
    },
    positions: results,
  };

  // Discord notification if corrections were made
  if (!dryRun && correctedCount > 0) {
    const corrected = results.filter(r => r.action === "corrected" || r.action === "zero_open");
    sendDiscordAlert(
      `🔄 **Sync positions** — ${correctedCount} position(s) corrigée(s)\n` +
      corrected.slice(0, 5).map(r =>
        `\`${r.positionId.slice(0, 8)}\` ${r.outcome} — ${r.note.slice(0, 80)}`
      ).join("\n")
    ).catch(() => {});
  }

  return NextResponse.json(summary);
}
