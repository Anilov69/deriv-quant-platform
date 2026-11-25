# Digit Edge

A static, client-side research desk for **Deriv synthetic indices**. It does not
predict one outcome and hope. It prices the entire plausible contract ladder on a
symbol against a recency-weighted digit model, then flags only the contracts whose
quoted payout beats the model's break-even probability.

Everything runs in the browser. There is no backend, no database and no server-side
secret: the app talks to Deriv's REST accounts API for a one-time OTP, opens the
socket that OTP unlocks, and streams ticks and quotes directly.

Live: https://anilov69.github.io/deriv-quant-platform/

## The idea

Deriv's digit payouts carry a house margin. A one-tick `DIGITMATCH` paying **8.93x**
on a 1.00 stake implies a break-even of **11.2%**, while a fair ten-sided digit is
**10%**. Buying every one of them loses. So the app does not ask "which digit will
come up". It asks:

> For every contract Deriv will quote on this symbol, does the model's probability
> exceed the break-even implied by that contract's own payout?

That flips the problem from prediction to **pricing comparison**, and the answer is
usually "no", which the interface shows plainly instead of manufacturing a signal.

## The model

All of it is in `src/stats.ts`, small enough to audit:

| Quantity | Estimator |
| --- | --- |
| Digit distribution | Recency-weighted counts with exponential age weights (half-life 80 ticks), smoothed by a Dirichlet prior of 0.5 per digit, normalised |
| Repeat / stay | Jeffreys estimate `(repeats + 0.5) / (pairs + 1)` so short samples cannot claim certainty |
| Momentum | EWMA z-score of the quote against its own EWMA (half-life 60 ticks) |
| Jump intensity | Poisson rate of changes beyond `3x` the trailing mean absolute change |
| Quiet probability | `exp(-lambda * k)` — chance no jump lands in the next `k` ticks |
| Edge | `p * payout - ask` per unit stake; a row is green only when this is positive |

Digits are read at the quote's real precision from `pip_size` (R_100 is quoted to
two decimals today), never from a hardcoded number of places.

## What is actually tradable

Verified with `contracts_for` against the live API, not assumed:

| Family | Symbols | Digit contracts | Rise/Fall |
| --- | --- | --- | --- |
| Continuous | `R_10`…`R_100`, `1HZ10V`…`1HZ100V` | yes | yes |
| Jump | `JD10`, `JD25`, `JD50`, `JD75`, `JD100` | yes | yes |
| Step | `stpRNG`, `stpRNG2..5` | **no** | yes |

Step indices quote only `CALL`, `PUT`, `CALLE`, `PUTE`, `MULTUP`, `MULTDOWN`.
The app therefore never requests a digit quote on a step symbol — it prices
Rise/Fall only, and says so in the table footer.

## Authentication

Written against the New Options API, which differs from the old one in ways that
matter:

1. `GET /trading/v1/options/accounts` with `Authorization: Bearer <token>` and
   `Deriv-App-ID: <app_id>`.
2. `POST /trading/v1/options/accounts/<id>/otp` — **no body, no `Content-Type`**.
3. Open the returned `wss://…?otp=…` URL. The socket is already authenticated, so
   no `authorize` frame is ever sent and no `loginid` is echoed back.

On the socket: `proposal` requires `underlying_symbol` (Legacy `symbol` is rejected),
`active_symbols` must not carry `product_type` (it was removed and now fails
validation), and the response fields are `underlying_symbol`,
`underlying_symbol_name` and `pip_size`.

The App ID is alphanumeric — letters, digits, `-` and `_` — and is never coerced to
digits.

## Credentials

The token is kept in `sessionStorage` by default. Ticking **Remember on this device**
moves it to `localStorage`; **Disconnect** clears both. The token leaves the browser
only in the `Authorization` header to `api.derivws.com`.

Use a token scoped to reading and trading, and revoke it when you are done.

## Local development

```bash
npm install
npm run dev        # http://127.0.0.1:3100
npm run typecheck
npm test           # estimators + transport contract
npm run build
```

`base: "./"` keeps every asset relative, so `dist/` works at any path.

## Deploy

`.github/workflows/deploy.yml` runs `npm install`, typecheck, tests and build, then
publishes `dist/` to the `gh-pages` branch. GitHub Pages serves that branch at `/`.

## Limits, stated plainly

- **No backtest.** Deriv's payout history for synthetic indices is not available
  offline, so the ladder is a live comparison, not a track record. Nothing here
  claims a historical win rate.
- **A positive row is a disagreement, not an edge you can bank.** Payouts move,
  quotes expire in seconds, and the model is a posterior that can be wrong.
- **Not implemented:** Touch/No-Touch, Ends In/Out, Stays In/Goes Out, multipliers.
  The ladder covers digit contracts plus Rise/Fall.
- **Live trading is untested end to end.** The transport is verified against the
  public socket and the request shapes are asserted in tests, but no real-money
  order has been placed from this repo.
