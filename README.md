# Deriv Quant Platform

100% client-side quantitative workspace for Deriv synthetic indices — volatility (continuous), step, and jump families.
Built with Vite + React + TypeScript + Tailwind CSS and deployed to GitHub Pages. No backend, no server-side secrets.

**Live:** https://anilov69.github.io/deriv-quant-platform/

## Why the connection layer looks like this

Earlier builds shipped `wss://ws.derivws.com/websockets/v3?app_id=...` plus a `{"authorize": token}` frame.
Deriv's current platform rejects personal access tokens and alphanumeric App IDs on that path, so this app uses the
REST + OTP handshake instead:

```
1. GET  https://api.derivws.com/trading/v1/options/accounts
        Authorization: Bearer <PAT>
        Deriv-App-ID: <ALPHANUMERIC_APP_ID>
   -> demo/real account list

2. POST https://api.derivws.com/trading/v1/options/accounts/{accountId}/otp
   -> { data: { url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=..." } }

3. new WebSocket(url)      // already authenticated: no authorize frame, no app_id query string
```

OTP URLs are single-use and short-lived, so switching accounts (or reconnecting) requests a fresh one.
The accounts endpoint answers CORS preflights for this origin, which is what keeps the app fully static.

**New API field names are not the Legacy ones.** Requests and responses were verified against the live public socket
(`wss://api.derivws.com/trading/v1/options/ws/public`):

* `proposal` requires `underlying_symbol`; sending Legacy `symbol` fails with *field is not allowed*.
* `active_symbols` returns `underlying_symbol`, `underlying_symbol_name` and `pip_size` — and sending the removed
  `product_type` filter fails with *Input validation failed: product_type*.
* `ticks` still takes a plain symbol string, but its payload carries `pip_size` (2 for `R_100`), so digits are read at
  the quote's real precision rather than a hardcoded 3 decimals.
* `POST …/otp` accepts **no body and no `Content-Type`** header.

### Credentials

* PAT + App ID are entered in the Connection drawer and sent only to Deriv.
* Default storage: `sessionStorage` (cleared when the tab closes). Opt in to `localStorage` with "Remember on this device".
* No token is bundled, committed, logged, or proxied. "Disconnect & return to simulation" wipes stored credentials.

## Markets and analytics

| Family | Symbols | Analysis |
| --- | --- | --- |
| Continuous | `R_10/25/50/75/100`, `1HZ10V/25V/50V/75V/100V` | Digit frequency over 100/300/1000 ticks, z-scores, Shannon entropy, repeat rate, lag-1 autocorrelation, log return and realised volatility, Bollinger z-score, velocity deceleration |
| Step | `stpRNG`, `stpRNG2..5` | First-order transition matrix and counts, observed step sizes, low-probability barrier detection, neighbour probability, streak length and direction, mean-reversion score. **Deriv quotes no digit contracts on step indices** — only CALL/PUT — so digit statistics are analytics only and no digit proposal is ever requested for this family |
| Jump | `JD10/25/50/75/100` | ATR, detected jump magnitudes, jump intensity, hazard rate, ticks since last jump, stabilisation flag, micro-drift |

Signals are converted into ticket-level proposals (`proposal` subscription) and are only actionable when the model
probability clears the payout-implied break-even probability quoted by Deriv. Contract types wired today:
`DIGITMATCH`, `DIGITDIFF`, `CALL`, `PUT` with 1–10 tick durations.

## Risk controls

* Fractional Kelly sizing and stake progression preview (`src/risk/martingale.ts`).
* Daily stop-loss / take-profit, max consecutive losses, kill switch, emergency stop.
* Real-account orders always require explicit confirmation; auto-trade is hard-disabled on real accounts.
* Session starts in a clearly marked simulation mode with a 10,000 unit paper balance.

## Development

```bash
npm install
npm run dev        # http://127.0.0.1:3100
npm run typecheck
npm test
npm run build      # -> dist/
```

`vite.config.ts` uses `base: "./"`, so `dist/` can be served from any subpath, including `/<repo>/` on GitHub Pages.

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main`: install → typecheck → tests → build → publish `dist/`
to the `gh-pages` branch, which GitHub Pages serves. No secrets are required beyond the default `GITHUB_TOKEN`.

## Project layout

```
src/services/derivRest.ts       REST + OTP transport (accounts, single-use socket URLs)
src/services/derivApi.ts        WebSocket session: ticks, proposals, buys, contract tracking, reconnect
src/services/credentialStore.ts session/local credential persistence
src/engines/{continuous,step,jump}.ts   per-family statistics and signal construction
src/hooks/useQuantPlatform.ts   orchestration: data, signals, execution, risk, toasts
src/components/*                dashboard, heatmaps, matrices, chart, execution and risk panels
tests/*                         boundaries for the API layer and the statistical engines
```

## Notes and limits

* Synthetic-index outcomes are generated by Deriv's RNG; statistical edges are estimates, not guarantees. Payouts
  embed a house margin, so a signal only has positive expectation when the model probability beats break-even.
* The UI currently exposes four contract types; Touch/No-Touch, Ends In/Out, Stays In/Goes Out and Over/Under
  contracts are not yet wired to the proposal builder.
* Everything runs in the browser, so nothing survives a cache wipe — re-enter credentials after clearing storage.
