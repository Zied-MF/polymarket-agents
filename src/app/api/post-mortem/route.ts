/**
 * POST-MORTEM — cron endpoint
 *
 * GET /api/post-mortem
 *
 * Pipeline :
 *   1. Récupère les paper trades résolus sans post-mortem (post_mortem_done=false)
 *   2. Pour chaque trade, génère une leçon via Claude Haiku
 *   3. Persiste la leçon dans lessons_learned
 *   4. Met à jour confidence_calibration
 *   5. Marque le trade comme post_mortem_done=true
 *
 * Cadence recommandée : toutes les 6h (après que check-results ait résolu des trades)
 */

import { NextResponse }            from "next/server";
import { runPostMortemAnalysis }   from "@/lib/agents/post-mortem-agent";
import type { PostMortemReport }   from "@/lib/agents/post-mortem-agent";

export async function GET(): Promise<NextResponse<PostMortemReport & { runAt: string }>> {
  const runAt = new Date().toISOString();
  console.log(`[post-mortem] ▶ Démarrage — ${runAt}`);

  const report = await runPostMortemAnalysis(20);

  console.log(
    `[post-mortem] ■ Terminé — ${report.processed} traité(s), ` +
    `${report.succeeded} réussi(s), ${report.failed} échoué(s)`
  );

  return NextResponse.json({ runAt, ...report });
}
