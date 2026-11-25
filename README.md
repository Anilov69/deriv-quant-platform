# Deriv Quant Platform

A Next.js 15 App Router workspace for synthetic-index analytics, payout-aware signals, risk previews, and guarded trade execution. The dashboard runs in deterministic simulation mode by default and can connect directly to Deriv through the browser WebSocket API.

## Run locally

```bash
npm ci
npm run dev
```

The development server runs at `http://127.0.0.1:3100`.

```bash
npm test
npm run typecheck
npm run build
```

For the GitHub Pages static export, set the repository base path before building:

```bash
PAGES_BASE_PATH=/deriv-quant-platform npm run build
```

The exported site is written to `out/`.

## Deriv connection and credentials

- Simulation mode is the default and does not require a token.
- Live mode asks for a Deriv personal access token and an optional App ID; the default App ID is `1089`.
- The token is held only in the `DerivClient` instance's memory and is sent directly to `wss://ws.derivws.com/websockets/v3`.
- The token is not written to `localStorage`, cookies, server requests, analytics, or logs. Authorization errors redact it, and `clearCredentials()` removes it from the client.
- Real-account trades require explicit confirmation. Automatic trading is disabled on real accounts.

## Source layout

- `src/app/` - App Router shell, metadata, and global styles
- `src/components/` - dashboard, chart, signal, execution, analytics, and trade UI
- `src/engines/` - continuous, step, and jump analysis engines
- `src/hooks/useQuantPlatform.ts` - client state, simulation, live subscriptions, and trade flow
- `src/risk/martingale.ts` - EV, Kelly, progression, and kill-switch calculations
- `src/services/derivApi.ts` - authenticated Deriv WebSocket client
- `src/types/index.ts` - shared domain types
- `tests/` - Vitest coverage for engines, risk math, and API boundaries

## Deployment

`.github/workflows/deploy.yml` installs dependencies, runs the tests, builds with `PAGES_BASE_PATH=/deriv-quant-platform`, and publishes `out/` to the `gh-pages` branch. It runs on every push to `main` and can also be started manually from the Actions tab.

Production URL: https://anilov69.github.io/deriv-quant-platform/
