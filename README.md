# SignalForge

AI-powered memecoin and market-intelligence alerting dashboard.

## What it does
- Monitors token price, volume, liquidity and DEX activity.
- Scores unusual market movements.
- Tracks a configurable watchlist of public figures and crypto accounts.
- Correlates market signals with public mentions/news when integrations are configured.
- Sends informational alerts; it does not execute trades.

## Coverage
SignalForge is designed for broad public-source coverage, but no service can literally capture every post across every platform. Coverage depends on public APIs, permissions, rate limits, deleted/private content, and platform terms.

## Run locally
```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and configure the services you want to enable.
