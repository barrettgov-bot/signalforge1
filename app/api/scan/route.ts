import { NextResponse } from "next/server";

type Alert = {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  token: string;
  signal: string;
  detail: string;
  source: string;
  time: string;
};

const recentEmails = new Map<string, number>();

async function sendAlertEmail(alert: Alert) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  const from = process.env.RESEND_FROM || "SignalForge <onboarding@resend.dev>";

  if (!apiKey || !to) return { sent: false, reason: "email_not_configured" };

  const key = `${alert.token}:${alert.signal}`;
  const now = Date.now();
  const cooldown = Number(process.env.ALERT_COOLDOWN_SECONDS || 60) * 1000;
  const previous = recentEmails.get(key);
  if (previous && now - previous < cooldown) return { sent: false, reason: "cooldown" };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `🚨 SignalForge ${alert.severity}: ${alert.token} — ${alert.signal}`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5">
          <h2>🚨 SignalForge Alert</h2>
          <p><strong>Severity:</strong> ${alert.severity}</p>
          <p><strong>Token:</strong> ${alert.token}</p>
          <p><strong>Signal:</strong> ${alert.signal}</p>
          <p><strong>Detail:</strong> ${alert.detail}</p>
          <p><strong>Source:</strong> ${alert.source}</p>
          <p><strong>Detected:</strong> ${alert.time}</p>
          <hr>
          <p>Informational market-intelligence alert. No trade was executed.</p>
        </div>`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Resend alert failed:", error);
    return { sent: false, reason: "send_failed" };
  }

  recentEmails.set(key, now);
  return { sent: true };
}

export async function GET() {
  const alerts: Alert[] = [];

  try {
    const r = await fetch("https://api.dexscreener.com/token-boosts/top/v1", { cache: "no-store" });
    if (r.ok) {
      const tokens = await r.json();
      for (const t of (Array.isArray(tokens) ? tokens.slice(0, 5) : [])) {
        alerts.push({
          severity: "LOW",
          token: t?.tokenAddress ? String(t.tokenAddress).slice(0, 8).toUpperCase() : "TOKEN",
          signal: "Boosted / trending token",
          detail: "Detected by public DEX market-discovery feed",
          source: "DexScreener",
          time: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    console.error("DexScreener scan failed:", error);
  }

  const emailResults = [];
  for (const alert of alerts) {
    emailResults.push(await sendAlertEmail(alert));
  }

  return NextResponse.json({
    ok: true,
    scannedAt: new Date().toISOString(),
    alerts,
    email: {
      configured: Boolean(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL),
      results: emailResults,
    },
  });
}
