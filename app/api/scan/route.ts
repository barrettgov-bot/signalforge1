import { NextResponse } from "next/server";

type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

type Alert = {
  severity: Severity;
  score: number;
  token: string;
  chain: string;
  signal: string;
  detail: string;
  source: string;
  time: string;
};

type Pair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  baseToken?: { symbol?: string; name?: string; address?: string };
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
};

const recentEmails = new Map<string, number>();

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function severityFor(score: number): Severity {
  if (score >= 90) return "CRITICAL";
  if (score >= 65) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}

function pairScore(pair: Pair) {
  const p15 = num(pair.priceChange?.m5);
  const p1h = num(pair.priceChange?.h1);
  const volume1h = num(pair.volume?.h1);
  const volume24h = num(pair.volume?.h24);
  const liquidity = num(pair.liquidity?.usd);
  const buys = num(pair.txns?.h1?.buys);
  const sells = num(pair.txns?.h1?.sells);
  const txns = buys + sells;

  let score = 0;
  const signals: string[] = [];

  if (p15 >= 3) {
    score += 20;
    signals.push(`+${p15.toFixed(1)}% in 5m`);
  } else if (p15 <= -8) {
    score += 18;
    signals.push(`${p15.toFixed(1)}% in 5m`);
  }

  if (p1h >= 7) {
    score += 25;
    signals.push(`+${p1h.toFixed(1)}% in 1h`);
  } else if (p1h <= -15) {
    score += 22;
    signals.push(`${p1h.toFixed(1)}% in 1h`);
  }

  if (volume1h > 0 && volume24h > 0) {
    const hourlyShare = volume1h / (volume24h / 24);
    if (hourlyShare >= 3) {
      score += 25;
      signals.push(`${hourlyShare.toFixed(1)}x hourly volume`);
    } else if (hourlyShare >= 2) {
      score += 15;
      signals.push(`${hourlyShare.toFixed(1)}x hourly volume`);
    }
  }

  if (txns >= 50 && buys > sells * 1.8) {
    score += 15;
    signals.push(`buy pressure ${buys}/${sells}`);
  } else if (txns >= 50 && sells > buys * 1.8) {
    score += 12;
    signals.push(`sell pressure ${sells}/${buys}`);
  }

  if (liquidity > 0 && liquidity < 25000) {
    score += 10;
    signals.push("thin liquidity");
  }

  return { score: Math.min(score, 100), signals };
}

async function sendAlertEmail(alert: Alert) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  const from = process.env.RESEND_FROM || "SignalForge <onboarding@resend.dev>";

  if (!apiKey || !to) return { sent: false, reason: "email_not_configured" };

  const minimum = process.env.ALERT_MIN_SEVERITY || "LOW";
  const order: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  if (order.indexOf(alert.severity) < order.indexOf(minimum as Severity)) {
    return { sent: false, reason: "below_minimum_severity" };
  }

  const key = `${alert.chain}:${alert.token}:${alert.signal}`;
  const now = Date.now();
  const cooldown = Number(process.env.ALERT_COOLDOWN_SECONDS || 60) * 1000;
  const previous = recentEmails.get(key);

  if (previous && now - previous < cooldown) {
    return { sent: false, reason: "cooldown" };
  }

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
        <div style="font-family:Arial,sans-serif;line-height:1.5;max-width:680px">
          <h2>🚨 SignalForge Market Alert</h2>
          <p><strong>Severity:</strong> ${alert.severity} (${alert.score}/100)</p>
          <p><strong>Token:</strong> ${alert.token}</p>
          <p><strong>Chain:</strong> ${alert.chain}</p>
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
    console.error("Resend alert failed:", await response.text());
    return { sent: false, reason: "send_failed" };
  }

  recentEmails.set(key, now);
  return { sent: true };
}

async function fetchBoostedPairs(): Promise<Pair[]> {
  const response = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
    cache: "no-store",
  });

  if (!response.ok) return [];

  const boosts = await response.json();
  const unique = new Map<string, { chainId: string; address: string }>();

  for (const item of Array.isArray(boosts) ? boosts.slice(0, 30) : []) {
    if (item?.chainId && item?.tokenAddress) {
      unique.set(`${item.chainId}:${item.tokenAddress}`, {
        chainId: String(item.chainId),
        address: String(item.tokenAddress),
      });
    }
  }

  const pairs: Pair[] = [];

  for (const item of unique.values()) {
    try {
      const r = await fetch(
        `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(item.chainId)}/${encodeURIComponent(item.address)}`,
        { cache: "no-store" },
      );
      if (!r.ok) continue;

      const data = await r.json();
      if (Array.isArray(data)) {
        pairs.push(...data.slice(0, 3));
      }
    } catch {
      // Keep scanning other tokens if one market endpoint fails.
    }
  }

  return pairs;
}

export async function GET() {
  const scannedAt = new Date().toISOString();
  const alerts: Alert[] = [];

  try {
    const pairs = await fetchBoostedPairs();
    const seen = new Set<string>();

    for (const pair of pairs) {
      const address = pair.baseToken?.address || "";
      const symbol = pair.baseToken?.symbol || "TOKEN";
      const key = `${pair.chainId}:${address}`;

      if (!address || seen.has(key)) continue;
      seen.add(key);

      const analysis = pairScore(pair);
      if (analysis.score < 20) continue;

      const signal =
        analysis.score >= 65
          ? "Multiple market signals"
          : analysis.score >= 40
            ? "Unusual market activity"
            : "Emerging market activity";

      alerts.push({
        severity: severityFor(analysis.score),
        score: analysis.score,
        token: symbol.toUpperCase(),
        chain: pair.chainId || "unknown",
        signal,
        detail: analysis.signals.join(" • ") || "DEX activity detected",
        source: pair.dexId ? `DexScreener / ${pair.dexId}` : "DexScreener",
        time: scannedAt,
      });
    }
  } catch (error) {
    console.error("Market scan failed:", error);
  }

  alerts.sort((a, b) => b.score - a.score);
  const selected = alerts.slice(0, 25);

  const emailResults = [];
  for (const alert of selected) {
    emailResults.push(await sendAlertEmail(alert));
  }

  return NextResponse.json({
    ok: true,
    scannedAt,
    alerts: selected,
    counts: {
      total: selected.length,
      critical: selected.filter((a) => a.severity === "CRITICAL").length,
      high: selected.filter((a) => a.severity === "HIGH").length,
      medium: selected.filter((a) => a.severity === "MEDIUM").length,
      low: selected.filter((a) => a.severity === "LOW").length,
    },
    email: {
      configured: Boolean(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL),
      results: emailResults,
    },
  });
}
