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

## Gap Engine (`#/gap-engine`)

A second page, reached from the header nav, that trades only Rise/Fall on the
three synthetic families. Routing is a `hashchange` listener in `App`, so a
direct load of `/#/gap-engine` works on GitHub Pages with no 404. The page takes
the terminal's `DerivSession` by ref: one socket, one OTP login, one balance
stream, the same Demo/Real account switch.

The signal is the micro-tick gap: the last `N` ticks give `N-1` intervals,
each classified up / flat / down, and the signal needs `|Up% - Down%| >= minGap`
pp. Flat stays in the denominator on purpose, so a stagnant tape cannot fake a
direction. Momentum buys the leading side; mean-reversion fades it. Execution is
a ref-driven state machine (`isRunningRef`, `isExecutingRef`, `inCooldownRef`):
the lock is taken synchronously before the proposal, released only after
`proposal_open_contract.is_sold === 1` and the cooldown, with a 180 s settlement
timeout that stops the bot instead of trading blind. Take-profit / stop-loss are
checked on the settled `profit`; a REAL account needs the confirmation dialog
and the word `REAL`.

## Mesh Hedge (`#/mesh-hedge`)

A third page in the same shell, at `/#/mesh-hedge`, with the same hash routing,
session, balance stream and Demo/Real switch. It keeps one rolling buffer of the
last 300 formatted digits, seeded by `ticks_history count 300` and extended by a
second tick subscription, so the three windows are warm the moment the page opens.

**Digits are read from the formatted quote.** The precision comes from the
symbol's `pip_size`, the quote is rendered with `toFixed(decimalPlaces)` and only
then is the last character taken. Slicing a raw JS number would turn `1234.50`
into `1234.5` and report `5` instead of `0`.

### Three transition meshes

Each of the three SVG circles has an editable lookback (100 / 150 / 200 by
default, 20–300). Nodes show the digit, its count and its share; the live last
digit sits in the centre. Directed lines are drawn only for transitions that were
actually observed, with stroke width proportional to the count, and the lines
leaving the current digit are highlighted. Nodes are coloured green for the
window's hottest digit, blue for the runner-up, pink for the coldest and slate
for everything else.

The consensus banner compares the three leaders: three greens is **triple
alignment**, two greens plus a blue runner-up in the third window is **strong
consensus**, anything else is **divergent**. The optional alignment gate can
require strong or triple before a round, but it defaults to "any" so the hedge is
not silently disabled.

### Hybrid score and the 3-digit bundle

```
S(j) = 0.60 * f_bar_windows(j) + 0.40 * P(d(t+1) = j | d(t))
```

`f_bar` is the digit's share averaged across the three windows and normalised,
`P(next | current)` is the empirical transition row of the largest window. On
step symbols, a digit whose observed transition probability is zero is forced to
score zero, because the step generator cannot reach it from the current digit.
The page shows the top three with their individual probabilities, the combined
`P1 + P2 + P3`, the combined dominance share against the 30% uniform baseline,
and the projected net if any single leg hits (payout multiple read from the last
executed quotes, 8.93x until then).

Stakes follow Deriv's **0.35 minimum per contract**:

| Split | Leg #1 | Leg #2 | Leg #3 | Bundle |
| --- | --- | --- | --- | --- |
| Flat | base | base | base | 3 x base (1.05 at the minimum) |
| Weighted | base | 0.35 | 0.35 | base + 0.70 (0.60 / 0.35 / 0.35 = 1.30) |

All three legs go to `toFixed(2)`. The normal single-quote path paces proposals
320 ms apart for the ladder; the hedge instead calls `quoteBundle`, which sends
the three `proposal` frames as one burst inside the same rate budget, and then
buys them with one `Promise.all`. A buy needs the proposal id and its price, so
the request is `{ buy: <id>, price: <ask> }`, not the legacy parameter block.

A round costs 3 proposals, 3 buys, 3 watches and 3 forgets, so the page keeps a
3 s floor between rounds even when the cooldown is set lower. That holds the
connection at roughly 240 calls/min against Deriv's 360/min budget. A pricing
failure stops the hedge instead of retrying into the limit.

### Locking and settlement

The bundle lock is a `Set<number>` of live contract ids. Every bought contract is
added before its `proposal_open_contract` subscription starts, removed only when
that contract reports `is_sold === 1`, and the execution lock stays closed until
the set is empty **and** the post-round cooldown has finished. A 30 s timeout
stops the bot and forgets the subscriptions instead of guessing a result; a
partial buy (one or two legs rejected) is recorded as what actually filled, never
as the intended three.

Step indices do not quote `DIGITMATCH` on the live API today, so selecting
`stpRNG` will usually end with all three legs rejected and no position. The page
keeps the family because the spec asks for it, filters unreachable digits, and
says so instead of pretending a contract exists.

Hedging three digits does not create an edge. At a fair 10% per digit the flat
bundle hits 30% of the time; an 8.93x payout on the 1.05 bundle returns about
0.94, so the expected loss is roughly 0.11 per round. A hit does pay (3.13 back
for 1.05 staked), which is exactly what makes the losing rounds look rare. The
mesh changes which digits are chosen; it cannot change the house price.

### Verification

`npm run typecheck`, `npm test` (79 tests across six files, 20 of them for the
mesh maths) and `npm run build` pass locally. The built `dist/` was loaded cold
at `/#/mesh-hedge` and through the nav links; the three circles, the collecting
banner and the empty state render with no console errors, and a seeded 300-tick
buffer produces the expected colours, outgoing arrows and triple-alignment
banner. The execution path is code-reviewed and unit-tested at the maths and
transport layers, but it has not been run against a funded account.

## Auto-trade and martingale

Arming **AUTO-TRADE** turns the ladder from a table into an execution loop:

- **One contract at a time.** The loop only reaches a buy from a state where nothing
  is open, and then awaits `proposal_open_contract` until `is_sold === 1` before it
  can scan again. If settlement never arrives the engine halts; it never assumes a
  trade closed and places another.
- **Cooldown** of N seconds or N ticks runs after settlement, then the scan resumes.
- **Scope** restricts which contract types may be bought (Rise/Fall, Even/Odd,
  Over/Under, Matches/Differs), and the gate is either minimum expected value (%)
  or minimum model win probability.
- **Real accounts** require typing `REAL` into a confirmation dialog before the
  engine arms. Auto-trade is never restored as ON after a reload, and changing the
  account stops it.

Martingale is off by default. When on it has two modes:

| Mode | Next stake |
| --- | --- |
| Payout-adjusted | `(cumulativeLoss + S0 * b) / b`, where `b = payout / stake - 1` is read from the live proposal for the exact contract being bought |
| Fixed multiplier | `S0 * multiplier ^ step` |

Because `b` is a net ratio, the same formula adapts from ~1.95x Rise/Fall to a 1.4x
Over/Under or an 8.9x one-tick match. A win, or reaching the step cap, resets the
ladder to `S0`. The preview table prices the streak at the gate's win rate, and the
daily loss limit / profit target stop the engine and reset the ladder.

Deriv budgets proposal-class calls per connection and rejects *bursts* well before
the per-minute average. So proposals are serialised through one queue with a 320 ms
floor, auto-trade quotes exactly one candidate per cycle, and the manual ladder
refresh stops while auto-trade is armed. A `RateLimit` answer parks the queue and
makes the engine back off (4 s, 8 s, 16 s, 32 s) instead of retrying into the wall.

The maths is pure: `planStake`, `settleBook` and `previewSteps` in
`src/autotrade.ts`, covered by `tests/autotrade.test.ts` — including the lock test
that asserts a second buy cannot happen before settlement.

## Local development

```bash
npm install
npm run dev        # http://127.0.0.1:3100
npm run typecheck
npm test           # estimators, transport contract, auto-trade lock
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
- **Auto-trade never improves the expected value of a contract.** It can only
  execute rows the model already prices above break-even; martingale changes the
  distribution of outcomes, not the sign of the edge, and a losing run grows the
  stake until the step cap or a kill-switch ends it.
