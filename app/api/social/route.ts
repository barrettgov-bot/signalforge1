import { NextResponse } from "next/server";

const STOP = new Set(["THE","AND","FOR","THIS","THAT","WITH","FROM","HAVE","WILL","JUST","ABOUT","YOUR","YOU","ARE","NOT","BUT","ALL","NEW","NOW","CAN","OUR","OUT","GET","HAS","ITS","MORE","ONE","USD","USDT","USDC"]);

function tokensFrom(text: string) {
  const explicit = [...text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,14})\b/g)].map(m => m[1].toUpperCase());
  const upper = [...text.matchAll(/\b[A-Z][A-Z0-9]{1,9}\b/g)].map(m => m[0]);
  return [...new Set([...explicit, ...upper].filter(t => !STOP.has(t)))].slice(0, 12);
}

async function xGet(path: string, bearer: string) {
  const r = await fetch(`https://api.x.com/2/${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`X API request failed with status ${r.status}`);
  return r.json();
}

export async function GET() {
  const bearer = process.env.X_BEARER_TOKEN;
  const accounts = (process.env.X_WATCH_ACCOUNTS || "")
    .split(",").map(v => v.trim().replace(/^@/, "")).filter(Boolean).slice(0, 25);

  if (!bearer || !accounts.length) {
    return NextResponse.json({ ok: true, configured: false, source: "X", accounts: accounts.length, mentions: [] });
  }

  const mentions: any[] = [];
  const errors: string[] = [];

  for (const username of accounts) {
    try {
      const user = await xGet(`users/by/username/${encodeURIComponent(username)}?user.fields=name,username`, bearer);
      const id = user?.data?.id;
      if (!id) continue;
      const timeline = await xGet(`users/${id}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at`, bearer);
      for (const post of timeline?.data || []) {
        const text = String(post.text || "");
        const tokens = tokensFrom(text);
        if (!tokens.length && !/crypto|bitcoin|ethereum|doge|token|coin|solana|memecoin/i.test(text)) continue;
        mentions.push({
          account: user.data.name || username,
          username,
          text,
          createdAt: post.created_at || new Date().toISOString(),
          tokens,
          url: `https://x.com/${username}/status/${post.id}`,
        });
      }
    } catch (error) {
      errors.push(`${username}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  mentions.sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return NextResponse.json({ ok: true, configured: true, source: "X", accounts: accounts.length, mentions: mentions.slice(0,40), errors: errors.slice(0,5), scannedAt: new Date().toISOString() });
}
