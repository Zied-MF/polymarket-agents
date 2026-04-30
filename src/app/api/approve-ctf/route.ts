/**
 * Approve CTF Exchange endpoint
 *
 * GET /api/approve-ctf          → lit les allowances actuelles (dry-check, ne signe rien)
 * GET /api/approve-ctf?execute=true → soumet approve(MAX_UINT256) pour chaque
 *                                     spender Polymarket non encore approuvé
 *
 * Spenders approuvés :
 *   - CTF Exchange       (0x4bFb41…) — marchés binaires standard
 *   - NegRisk CTF Exch.  (0xC5d563…) — marchés multi-outcomes
 *
 * Coût : ~0.01–0.05 POL de gas par approbation (Polygon très cheap).
 * Opération unique : une fois approuvé, plus besoin de re-passer ici.
 *
 * ⚠️  POLYGON_RPC_URL doit pointer vers un RPC valide (Alchemy).
 * ⚠️  Le wallet doit avoir du POL pour payer le gas.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  checkAllAllowances,
  approveCTF,
  type SpenderAllowance,
} from "@/lib/polymarket/clob-api";

interface ApproveCTFResponse {
  timestamp:   string;
  wallet?:     string;
  execute:     boolean;
  allowances:  SpenderAllowance[];
  allSufficient: boolean;
  approvals?:  Array<{
    name:    string;
    spender: string;
    txHash:  string | null;
    skipped: boolean;
  }>;
  error?:      string;
  errorStack?: string;
}

export async function GET(req: NextRequest): Promise<NextResponse<ApproveCTFResponse>> {
  const execute   = req.nextUrl.searchParams.get("execute") === "true";
  const timestamp = new Date().toISOString();

  // ── 1. Toujours lire les allowances actuelles ───────────────────────────────
  let allowances: SpenderAllowance[];
  try {
    allowances = await checkAllAllowances();
  } catch (err) {
    return NextResponse.json(
      {
        timestamp,
        execute,
        allowances:   [],
        allSufficient: false,
        error:      err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack?.slice(0, 600) : undefined,
      },
      { status: 500 }
    );
  }

  const allSufficient = allowances.every((a) => a.sufficient);

  // ── 2. Dry-check — retourner sans signer ────────────────────────────────────
  if (!execute) {
    return NextResponse.json({
      timestamp,
      execute: false,
      allowances,
      allSufficient,
      note: allSufficient
        ? "✅ Tous les spenders sont approuvés — real trading prêt."
        : "❌ Approvals manquantes. Appeler ?execute=true pour approuver.",
    } as ApproveCTFResponse & { note: string });
  }

  // ── 3. Execute — soumet les approbations manquantes ─────────────────────────
  try {
    const result = await approveCTF();

    // Relire les allowances post-approve pour confirmer
    const postAllowances = await checkAllAllowances().catch(() => allowances);

    return NextResponse.json({
      timestamp,
      wallet:       result.wallet,
      execute:      true,
      allowances:   postAllowances,
      allSufficient: postAllowances.every((a) => a.sufficient),
      approvals:    result.approvals,
    });
  } catch (err) {
    return NextResponse.json(
      {
        timestamp,
        execute:      true,
        allowances,
        allSufficient,
        error:      err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
      },
      { status: 500 }
    );
  }
}
