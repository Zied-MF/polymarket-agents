/**
 * Notifications Discord via webhook
 *
 * Envoie des embeds formatés vers un canal Discord via webhook entrant.
 * Les opportunités sont groupées en messages de 10 embeds maximum
 * (limite de l'API Discord).
 *
 * Variables d'environnement requises :
 *   DISCORD_WEBHOOK_URL — URL complète du webhook Discord
 */

// ---------------------------------------------------------------------------
// Types Discord (subset de l'API webhook)
// ---------------------------------------------------------------------------

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  color: number; // entier RGB 24-bit
  fields: DiscordField[];
  footer: { text: string };
}

interface DiscordWebhookPayload {
  username?: string;
  embeds: DiscordEmbed[];
}

// ---------------------------------------------------------------------------
// Couleurs
// ---------------------------------------------------------------------------

/** Vert vif : edge > 20% */
const COLOR_GREEN = 0x2ecc71;
/** Orange : edge > 10% */
const COLOR_ORANGE = 0xe67e22;
/** Rouge : edge <= 10% mais >= 7.98% */
const COLOR_RED = 0xe74c3c;

function embedColor(edge: number): number {
  if (edge > 0.2) return COLOR_GREEN;
  if (edge > 0.1) return COLOR_ORANGE;
  return COLOR_RED;
}

// ---------------------------------------------------------------------------
// Type d'entrée (sous-ensemble de OpportunityResult pour éviter le couplage)
// ---------------------------------------------------------------------------

export interface OpportunityNotification {
  city: string;
  outcome: string;
  marketPrice: number;
  estimatedProbability: number;
  edge: number;
  multiplier: number;
  /** Montant suggéré par Half-Kelly en USDC. */
  suggestedBet: number;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildEmbed(opp: OpportunityNotification, scannedAt: Date): DiscordEmbed {
  const marketPct = (opp.marketPrice * 100).toFixed(1);
  const estimatedPct = (opp.estimatedProbability * 100).toFixed(1);
  const edgePct = (opp.edge * 100).toFixed(2);
  const multiplier = opp.multiplier.toFixed(2);

  return {
    title: `🌡️ ${opp.city} — ${opp.outcome}`,
    color: embedColor(opp.edge),
    fields: [
      {
        name: "💰 Prix marché",
        value: `${marketPct}%`,
        inline: true,
      },
      {
        name: "🎯 Notre estimation",
        value: `${estimatedPct}%`,
        inline: true,
      },
      {
        name: "📈 Edge",
        value: `+${edgePct}%`,
        inline: true,
      },
      {
        name: "🎰 Multiplicateur",
        value: `x${multiplier}`,
        inline: true,
      },
      {
        name: "💵 Mise suggérée",
        value: opp.suggestedBet > 0 ? `${opp.suggestedBet.toFixed(2)}€` : "—",
        inline: true,
      },
    ],
    footer: {
      text: `Scanné à ${scannedAt.toLocaleString("fr-FR", { timeZone: "UTC", timeZoneName: "short" })}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Envoi HTTP
// ---------------------------------------------------------------------------

/**
 * Envoie un message texte brut (contenu Markdown).
 * Utilisé par trade-executor pour les alertes d'erreur real-trading.
 */
export async function sendDiscordAlert(content: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ username: "WeatherBot", content }),
  });
}

/** Envoie un seul payload webhook. Throw si Discord répond avec une erreur. */
async function postWebhook(
  webhookUrl: string,
  payload: DiscordWebhookPayload
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Discord webhook error ${res.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Fonction publique
// ---------------------------------------------------------------------------

/**
 * Envoie une notification Discord pour une liste d'opportunités détectées.
 *
 * Les embeds sont groupés par lots de 10 (limite Discord) pour ne pas
 * fragmenter inutilement les messages. Si la liste est vide, aucun message
 * n'est envoyé.
 *
 * Si DISCORD_WEBHOOK_URL n'est pas défini, log un avertissement et retourne
 * silencieusement (ne bloque pas le scan).
 *
 * @param opportunities  Liste des opportunités à notifier
 * @param scannedAt      Horodatage du scan (affiché dans le footer)
 */
// ---------------------------------------------------------------------------
// Résumé des résultats (check-results)
// ---------------------------------------------------------------------------

export interface ResultDetail {
  city: string;
  date: string;
  outcome: string;
  actual: number;
  unit: "F" | "C";
  result: "WIN" | "LOSS";
  pnl: number;
}

export interface ResultsSummary {
  checked: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  details: ResultDetail[];
}

/**
 * Envoie un embed Discord récapitulatif des résultats vérifiés.
 * Un seul message avec un embed global + les détails ligne par ligne.
 */
export async function sendResultsSummary(
  summary: ResultsSummary,
  checkedAt: Date
): Promise<void> {
  if (summary.checked === 0) return;

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[discord] DISCORD_WEBHOOK_URL non défini — résumé résultats ignoré");
    return;
  }

  const pnlSign = summary.totalPnL >= 0 ? "+" : "";
  const winRatePct = (summary.winRate * 100).toFixed(1);

  // Embed récapitulatif
  const summaryEmbed: DiscordEmbed = {
    title: `📊 Résultats — ${summary.checked} marché(s) vérifié(s)`,
    color: summary.totalPnL >= 0 ? COLOR_GREEN : COLOR_RED,
    fields: [
      { name: "✅ Wins",       value: String(summary.wins),                  inline: true },
      { name: "❌ Losses",     value: String(summary.losses),                inline: true },
      { name: "🎯 Win Rate",   value: `${winRatePct}%`,                      inline: true },
      { name: "💰 P&L Total",  value: `${pnlSign}${summary.totalPnL.toFixed(2)}€`, inline: false },
    ],
    footer: {
      text: `Vérifié le ${checkedAt.toLocaleString("fr-FR", { timeZone: "UTC", timeZoneName: "short" })}`,
    },
  };

  // Embeds détail (un par résultat, max 9 pour rester sous la limite de 10 avec le summary)
  const detailEmbeds: DiscordEmbed[] = summary.details.slice(0, 9).map((d) => {
    const tempStr = `${d.actual.toFixed(1)}°${d.unit}`;
    const pnlStr  = d.pnl >= 0 ? `+${d.pnl.toFixed(2)}€` : `${d.pnl.toFixed(2)}€`;
    return {
      title: `${d.result === "WIN" ? "✅" : "❌"} ${d.city} — ${d.date}`,
      color: d.result === "WIN" ? COLOR_GREEN : COLOR_RED,
      fields: [
        { name: "Outcome prédit", value: d.outcome,  inline: true },
        { name: "Temp réelle",    value: tempStr,    inline: true },
        { name: "P&L",            value: pnlStr,     inline: true },
      ],
      footer: { text: "" },
    };
  });

  const payload: DiscordWebhookPayload = {
    username: "Polymarket Weather Agent",
    embeds: [summaryEmbed, ...detailEmbeds],
  };

  try {
    await postWebhook(webhookUrl, payload);
    console.log(`[discord] ✅ Résumé résultats envoyé (${summary.checked} marchés)`);
  } catch (err) {
    console.error("[discord] ✗ Échec envoi résumé résultats :", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Sell signals (monitor-positions)
// ---------------------------------------------------------------------------

export interface SellSignalNotification {
  question: string;
  outcome: string;
  agent: "weather" | "finance" | "crypto";
  action: "SELL" | "SWITCH";
  reason: string;
  entryPrice: number;
  currentPrice: number;
  potentialPnl: number;
  suggestedBet: number;
  switchToOutcome?: string;
}

/**
 * Envoie une notification Discord pour les sell signals détectés.
 * Un embed par signal, groupés en messages de 10.
 */
export async function sendSellSignals(
  signals: SellSignalNotification[],
  checkedAt: Date
): Promise<void> {
  if (signals.length === 0) return;

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[discord] DISCORD_WEBHOOK_URL non défini — sell signals ignorés");
    return;
  }

  const COLOR_SELL   = 0xe74c3c; // rouge
  const COLOR_SWITCH = 0xf39c12; // orange

  const embeds: DiscordEmbed[] = signals.map((s) => {
    const pnlStr   = s.potentialPnl >= 0 ? `+${s.potentialPnl.toFixed(2)}€` : `${s.potentialPnl.toFixed(2)}€`;
    const priceStr = `${(s.entryPrice * 100).toFixed(1)}% → ${(s.currentPrice * 100).toFixed(1)}%`;
    const fields: DiscordField[] = [
      { name: "🎯 Outcome", value: s.outcome, inline: true },
      { name: "📉 Prix", value: priceStr, inline: true },
      { name: "💰 P&L potentiel", value: pnlStr, inline: true },
      { name: "💵 Mise", value: `${s.suggestedBet.toFixed(2)}€`, inline: true },
      { name: "📋 Raison", value: s.reason, inline: false },
    ];
    if (s.action === "SWITCH" && s.switchToOutcome) {
      fields.push({ name: "🔄 Switcher vers", value: s.switchToOutcome, inline: true });
    }
    return {
      title: `${s.action === "SELL" ? "🔴 SELL" : "🔄 SWITCH"} — ${s.question.slice(0, 60)}`,
      color: s.action === "SELL" ? COLOR_SELL : COLOR_SWITCH,
      fields,
      footer: {
        text: `[${s.agent}] Vérifié à ${checkedAt.toLocaleString("fr-FR", { timeZone: "UTC", timeZoneName: "short" })}`,
      },
    };
  });

  const CHUNK_SIZE = 10;
  for (let i = 0; i < embeds.length; i += CHUNK_SIZE) {
    const payload: DiscordWebhookPayload = {
      username: "Polymarket Position Manager",
      embeds: embeds.slice(i, i + CHUNK_SIZE),
    };
    try {
      await postWebhook(webhookUrl, payload);
      console.log(`[discord] ✅ Sell signals envoyés (${Math.min(CHUNK_SIZE, embeds.length - i)} signal(s))`);
    } catch (err) {
      console.error("[discord] ✗ Échec envoi sell signals :", err instanceof Error ? err.message : err);
    }
    if (i + CHUNK_SIZE < embeds.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Real trade buy notification
// ---------------------------------------------------------------------------

export interface RealTradeBuyNotification {
  question:    string;
  outcome:     string;
  agent:       "weather" | "finance" | "crypto";
  marketPrice: number;
  amountUsdc:  number;
  orderId:     string;
  gasFeeUsdc:  number;
}

/**
 * Envoie un embed Discord vert pour confirmer un trade réel exécuté avec succès.
 * Fire-and-forget depuis trade-executor — ne bloque pas le scan.
 */
export async function sendRealTradeBuy(
  trade:     RealTradeBuyNotification,
  placedAt:  Date
): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const embed: DiscordEmbed = {
    title: `✅ REAL TRADE — ${trade.question.slice(0, 60)}`,
    color: 0x2ecc71, // vert
    fields: [
      { name: "🎯 Outcome",    value: trade.outcome,                                      inline: true  },
      { name: "🤖 Agent",      value: trade.agent,                                        inline: true  },
      { name: "💰 Prix",       value: `${(trade.marketPrice * 100).toFixed(1)}%`,         inline: true  },
      { name: "💵 Mise",       value: `${trade.amountUsdc.toFixed(2)} USDC`,              inline: true  },
      { name: "⛽ Gas",        value: `${trade.gasFeeUsdc.toFixed(3)} USDC`,              inline: true  },
      { name: "🔑 Order ID",   value: `\`${trade.orderId.slice(0, 20)}…\``,               inline: false },
    ],
    footer: {
      text: `Ordre placé à ${placedAt.toLocaleString("fr-FR", { timeZone: "UTC", timeZoneName: "short" })}`,
    },
  };

  try {
    await postWebhook(webhookUrl, { username: "Polymarket Real Trader", embeds: [embed] });
    console.log(`[discord] ✅ Real trade notification envoyée (${trade.orderId})`);
  } catch (err) {
    console.error("[discord] ✗ Échec real trade notification :", err instanceof Error ? err.message : err);
  }
}

export async function sendDiscordNotification(
  opportunities: OpportunityNotification[],
  scannedAt: Date
): Promise<void> {
  if (opportunities.length === 0) return;

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn(
      "[discord] DISCORD_WEBHOOK_URL non défini — notifications désactivées"
    );
    return;
  }

  // Découper en chunks de 10 (max Discord)
  const CHUNK_SIZE = 10;
  const chunks: OpportunityNotification[][] = [];
  for (let i = 0; i < opportunities.length; i += CHUNK_SIZE) {
    chunks.push(opportunities.slice(i, i + CHUNK_SIZE));
  }

  console.log(
    `[discord] Envoi de ${opportunities.length} opportunité(s) en ${chunks.length} message(s)`
  );

  for (let i = 0; i < chunks.length; i++) {
    const embeds = chunks[i].map((opp) => buildEmbed(opp, scannedAt));
    const payload: DiscordWebhookPayload = {
      username: "Polymarket Weather Agent",
      embeds,
    };

    try {
      await postWebhook(webhookUrl, payload);
      console.log(
        `[discord] ✅ Message ${i + 1}/${chunks.length} envoyé (${embeds.length} embed(s))`
      );
    } catch (err) {
      // On log l'erreur mais on ne bloque pas les autres chunks
      console.error(
        `[discord] ✗ Échec message ${i + 1}/${chunks.length} :`,
        err instanceof Error ? err.message : err
      );
    }

    // Respecter le rate-limit Discord : 30 requêtes / 60s sur les webhooks
    // Un délai de 1s entre les chunks est suffisant dans notre cas d'usage
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
