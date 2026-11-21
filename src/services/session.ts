/**
 * App-level orchestration of the two Deriv connections:
 *   • public socket  — active symbols, tick history/stream, contracts_for, quotes
 *   • trading socket — OTP-authenticated (demo or real): balance, buy, open contracts
 * Runs in the browser only.
 */
import { candidateKey, digitSpecs } from "@/engines/shared";
import { decimalsFromPip } from "@/engines/stats";
import { MARKETS, type ContractType } from "@/lib/markets";
import { currentAccount, useStore, type Availability, type TradeRecord } from "@/store/useStore";
import { expectedValue } from "@/utils/evCalculator";
import { getAccounts, getOtpUrl } from "./derivRest";
import { DerivApiError, DerivSocket, PUBLIC_WS_URL, type DerivMessage } from "./derivWs";

const S = () => useStore.getState();
const MAX_TICKS = 1000;

let pub: DerivSocket | null = null;
let trade: DerivSocket | null = null;
let quoteTimer: ReturnType<typeof setTimeout> | null = null;
let quoteGen = 0;

// ---------------------------------------------------------------- public data

export function startPublic() {
  if (pub) return;
  pub = new DerivSocket({
    name: "public",
    url: () => PUBLIC_WS_URL,
    onState: (s) => S().set({ publicConn: s }),
    onLatency: (ms) => S().set({ latency: ms }),
  });
  void pub.connect().then(loadActiveSymbols);
  selectSymbol(S().symbol);
}

async function loadActiveSymbols() {
  try {
    const r = await pub!.request({ active_symbols: "brief" });
    const list = (r.active_symbols as { underlying_symbol?: string; symbol?: string; exchange_is_open?: number }[]) ?? [];
    const allowed = new Set(MARKETS.map((m) => m.symbol));
    S().set({
      activeSymbols: new Set(
        list.map((x) => x.underlying_symbol ?? x.symbol ?? "").filter((s) => allowed.has(s)),
      ),
    });
  } catch {
    /* fall back to the static list */
  }
}

export function selectSymbol(symbol: string) {
  const m = MARKETS.find((x) => x.symbol === symbol);
  if (!m || !pub) return;
  S().set({ symbol, family: m.family, prices: [], times: [], quotes: {}, marketError: undefined });
  // ticks_history + subscribe returns the last 1,000 ticks, then a live stream.
  // On reconnect the subscription is re-sent, which refreshes history and
  // closes any gap left while the market or socket was down.
  pub.subscribe(
    "ticks",
    { ticks_history: symbol, count: MAX_TICKS, end: "latest", style: "ticks" },
    (msg) => onTickMessage(symbol, msg),
    (e) => S().set({ marketError: e.message }),
  );
  void loadAvailability(symbol);
  scheduleQuotes(0);
}

function onTickMessage(symbol: string, msg: DerivMessage) {
  if (S().symbol !== symbol) return;
  if (msg.msg_type === "history") {
    const h = msg.history as { prices: number[]; times: number[] };
    S().set({ prices: h.prices.slice(-MAX_TICKS), times: h.times.slice(-MAX_TICKS), decimals: decimalsFromPip(msg.pip_size as number), marketError: undefined });
  } else if (msg.msg_type === "tick") {
    const t = msg.tick as { quote: number; epoch: number; pip_size: number };
    const { prices, times } = S();
    if (times.length && t.epoch <= times[times.length - 1]) return; // duplicate / out-of-order
    S().set({
      prices: [...prices, t.quote].slice(-MAX_TICKS),
      times: [...times, t.epoch].slice(-MAX_TICKS),
      decimals: decimalsFromPip(t.pip_size),
    });
  }
}

async function loadAvailability(symbol: string) {
  if (S().availability[symbol]) return;
  try {
    const r = await pub!.request({ contracts_for: symbol });
    const av: Availability = {};
    const list = ((r.contracts_for as { available?: unknown[] })?.available ?? []) as {
      contract_type: string;
      expiry_type: string;
      min_contract_duration: string;
      max_contract_duration: string;
    }[];
    for (const c of list) {
      if (c.expiry_type !== "tick") continue;
      const lo = parseInt(c.min_contract_duration);
      const hi = parseInt(c.max_contract_duration);
      const prev = av[c.contract_type];
      av[c.contract_type] = prev ? [Math.min(prev[0], lo), Math.max(prev[1], hi)] : [lo, hi];
    }
    S().set({ availability: { ...S().availability, [symbol]: av } });
  } catch {
    /* unknown → rows stay visible, quotes will surface any error */
  }
}

interface QuoteSpec {
  key: string;
  contract_type: ContractType;
  barrier?: string;
  duration: number;
}

function quoteSpecs(): QuoteSpec[] {
  const { settings, availability, symbol } = S();
  const av = availability[symbol];
  const offered = (t: string, d: number) => !av || (av[t] && d >= av[t][0] && d <= av[t][1]);
  const specs: QuoteSpec[] = [];
  for (const d of settings.riseFallDurations)
    for (const t of ["CALL", "PUT"] as const) if (offered(t, d)) specs.push({ key: candidateKey(t, d), contract_type: t, duration: d });
  const dd = settings.digitDuration;
  for (const s of digitSpecs())
    if (offered(s.type, dd)) specs.push({ key: candidateKey(s.type, dd, s.barrier), contract_type: s.type, barrier: s.barrier?.toString(), duration: dd });
  return specs;
}

/**
 * Live payout refresh. Each candidate is priced with a one-shot `proposal`
 * every ~30 s (≈40 requests/min — well inside the 360/min pricing budget);
 * digit payouts on synthetics are static per contract, and every trade is
 * re-priced on the trading socket right before `buy`.
 */
function scheduleQuotes(delay: number) {
  if (quoteTimer) clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => void refreshQuotes(), delay);
}

async function refreshQuotes() {
  const gen = ++quoteGen;
  const symbol = S().symbol;
  if (!pub || S().halted) return scheduleQuotes(30_000);
  for (const spec of quoteSpecs()) {
    if (gen !== quoteGen || S().symbol !== symbol) return;
    const stake = S().guardrails.quoteStake;
    try {
      const r = await pub.request(proposalRequest(symbol, spec, stake, S().currency), 10_000);
      const p = r.proposal as { ask_price: number; payout: number; spot_time?: number };
      setQuote(symbol, spec.key, { stake: p.ask_price, payout: p.payout, at: p.spot_time ?? Date.now() / 1000 });
    } catch (e) {
      setQuote(symbol, spec.key, { stake, payout: 0, at: Date.now() / 1000, error: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (gen === quoteGen) scheduleQuotes(30_000);
}

function setQuote(symbol: string, key: string, q: { stake: number; payout: number; at: number; error?: string }) {
  if (S().symbol !== symbol) return;
  S().set({ quotes: { ...S().quotes, [key]: q } });
}

export function requoteNow() {
  scheduleQuotes(0);
}

function proposalRequest(symbol: string, spec: Omit<QuoteSpec, "key">, stake: number, currency: string) {
  return {
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: spec.contract_type,
    currency,
    duration: spec.duration,
    duration_unit: "t",
    underlying_symbol: symbol,
    ...(spec.barrier !== undefined ? { barrier: spec.barrier } : {}),
  };
}

// ---------------------------------------------------------------- auth & accounts

export async function signIn(token: string, appId: string) {
  S().set({ authStatus: "validating", authError: undefined });
  try {
    const accounts = (await getAccounts(token, appId)).filter((a) => a.status === "active");
    if (!accounts.length) throw new Error("No active Options accounts found for this token.");
    // Always start on Demo when one exists.
    const first = accounts.find((a) => a.account_type === "demo") ?? accounts[0];
    S().set({ token, appId, accounts, authStatus: "signed-in" });
    await switchAccount(first.account_id);
    S().notify("success", `Signed in — ${first.account_type.toUpperCase()} account ${first.account_id}`);
  } catch (e) {
    S().set({ token: null, authStatus: "error", authError: (e as Error).message, accounts: [] });
  }
}

export function signOut() {
  trade?.close();
  trade = null;
  S().set({
    token: null,
    authStatus: "signed-out",
    accounts: [],
    accountId: null,
    balance: null,
    loginId: null,
    tradeConn: "idle",
    autoMode: false,
    realConfirmed: null,
  });
}

export async function switchAccount(accountId: string) {
  const { token, accounts } = S();
  const acct = accounts.find((a) => a.account_id === accountId);
  if (!token || !acct) return;
  trade?.close();
  S().set({
    accountId,
    balance: acct.balance,
    currency: acct.currency || "USD",
    loginId: null,
    autoMode: false,
    realConfirmed: acct.account_type === "real" ? S().realConfirmed : null,
  });
  const sock = new DerivSocket({
    name: acct.account_type,
    // Fresh one-time URL on every (re)connect — OTPs are single use.
    url: () => getOtpUrl(S().token ?? "", S().appId, accountId),
    onState: (s) => S().set({ tradeConn: s }),
    onFatal: (e) => S().notify("error", `Trading connection failed: ${e.message}`),
  });
  trade = sock;
  sock.subscribe("balance", { balance: 1 }, (m) => {
    const b = m.balance as { balance: number; currency: string; loginid: string };
    if (trade === sock) S().set({ balance: b.balance, currency: b.currency || S().currency, loginId: b.loginid });
  });
  await sock.connect();
  // Re-attach to any of this account's contracts that are still open.
  for (const t of S().trades) if (t.accountId === accountId && t.contractId && (t.status === "open" || t.status === "pending")) watchContract(t.id, t.contractId);
  requoteNow();
}

// ---------------------------------------------------------------- execution

export interface TradeIntent {
  contractType: ContractType;
  barrier?: string;
  duration: number;
  stake: number;
  pModel: number;
  auto: boolean;
}

/** Returns a reason string if guardrails block trading, else null. */
export function guardrailBlock(): string | null {
  const s = S();
  const acct = currentAccount(s);
  if (s.halted) return "Emergency stop is active";
  if (!acct || s.authStatus !== "signed-in") return "Sign in with your PAT first";
  if (s.tradeConn !== "open") return "Trading connection is not open";
  if (acct.account_type === "real" && s.realConfirmed !== acct.account_id) return "Real account trading not confirmed";
  const mine = s.trades.filter((t) => t.accountId === acct.account_id);
  const today = new Date().toDateString();
  const dayPnl = mine
    .filter((t) => new Date(t.boughtAt * 1000).toDateString() === today && t.profit !== undefined)
    .reduce((a, t) => a + (t.profit ?? 0), 0);
  if (dayPnl <= -Math.abs(s.guardrails.maxDailyLoss)) return `Daily loss limit reached (${dayPnl.toFixed(2)})`;
  let streak = 0;
  for (const t of mine) {
    if (t.status === "lost") streak++;
    else if (t.status === "won" || t.status === "sold") break;
  }
  if (streak >= s.guardrails.maxConsecutiveLosses) return `${streak} consecutive losses — stop rule hit`;
  if (mine.some((t) => t.status === "pending" || t.status === "unknown")) return "A previous order is still being confirmed";
  return null;
}

export async function executeTrade(intent: TradeIntent): Promise<void> {
  const block = guardrailBlock();
  if (block) return S().notify("error", block);
  const s = S();
  const acct = currentAccount(s)!;
  if (!(intent.stake >= 0.35)) return S().notify("error", "Stake must be at least 0.35");
  if (s.balance !== null && intent.stake > s.balance) return S().notify("error", "Stake exceeds balance");
  const sock = trade!;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  S().set({ busy: true });

  // 1) Fresh live proposal on the account socket.
  let prop: { id: string; ask_price: number; payout: number };
  try {
    const r = await sock.request(proposalRequest(s.symbol, { contract_type: intent.contractType, barrier: intent.barrier, duration: intent.duration }, intent.stake, s.currency), 10_000);
    prop = r.proposal as typeof prop;
  } catch (e) {
    S().set({ busy: false });
    return S().notify("error", `Quote failed: ${(e as Error).message}`);
  }
  const ev = expectedValue(intent.pModel, prop.ask_price, prop.payout);
  if (intent.auto && ev / prop.ask_price < s.guardrails.minEv) {
    S().set({ busy: false });
    return S().notify("info", "Auto trade skipped: payout moved and EV fell below minimum");
  }

  const base: TradeRecord = {
    id,
    symbol: s.symbol,
    contractType: intent.contractType,
    barrier: intent.barrier,
    duration: intent.duration,
    stake: prop.ask_price,
    payout: prop.payout,
    pModel: intent.pModel,
    ev,
    accountId: acct.account_id,
    accountType: acct.account_type,
    currency: s.currency,
    boughtAt: Math.floor(Date.now() / 1000),
    status: "pending",
    auto: intent.auto,
  };
  S().upsertTrade(base);

  // 2) Buy by proposal id, capped at the quoted ask. Never auto-retried: a
  //    lost reply could mean the contract was bought (duplicate risk).
  try {
    const r = await sock.request({ buy: prop.id, price: prop.ask_price }, 20_000, 0);
    const b = r.buy as { contract_id: number; transaction_id: number; buy_price: number; payout: number; balance_after: number };
    S().upsertTrade({ id, contractId: b.contract_id, transactionId: b.transaction_id, stake: b.buy_price, payout: b.payout, status: "open" });
    S().set({ balance: b.balance_after });
    watchContract(id, b.contract_id);
    S().notify("success", `Bought ${intent.contractType} — contract ${b.contract_id}`);
  } catch (e) {
    const err = e as DerivApiError;
    if (err.code === "Timeout" || err.code === "Disconnected") {
      S().upsertTrade({ id, status: "unknown", note: "No reply — checking statement" });
      void reconcile(id, base.boughtAt, prop.ask_price);
    } else {
      S().upsertTrade({ id, status: "failed", note: err.message });
      S().notify("error", `Buy rejected: ${err.message}`);
    }
  } finally {
    S().set({ busy: false });
  }
}

/** After an uncertain buy, look the purchase up in `statement` instead of retrying. */
async function reconcile(id: string, sentAt: number, price: number) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const r = await trade!.request({ statement: 1, action_type: "buy", limit: 10, date_from: sentAt - 5 });
      const txs = ((r.statement as { transactions?: unknown[] })?.transactions ?? []) as {
        contract_id?: number;
        transaction_id?: number;
        amount?: number;
        transaction_time?: number;
      }[];
      const known = new Set(S().trades.map((t) => t.contractId));
      const hit = txs.find((t) => t.contract_id && !known.has(t.contract_id) && Math.abs(Math.abs(t.amount ?? 0) - price) < 0.01);
      if (hit?.contract_id) {
        S().upsertTrade({ id, contractId: hit.contract_id, transactionId: hit.transaction_id, status: "open", note: "Confirmed via statement" });
        watchContract(id, hit.contract_id);
        return;
      }
      S().upsertTrade({ id, status: "failed", note: "Not found in statement — no contract was bought" });
      return;
    } catch {
      /* socket still reconnecting — try again */
    }
  }
  S().upsertTrade({ id, note: "Could not verify — check your Deriv statement before trading again" });
}

function watchContract(id: string, contractId: number) {
  trade?.subscribe(`poc-${contractId}`, { proposal_open_contract: 1, contract_id: contractId }, (m) => {
    const c = m.proposal_open_contract as {
      status?: string;
      is_sold?: number;
      profit?: string | number;
      entry_spot?: string;
      exit_spot?: string;
    };
    if (!c) return;
    const done = c.is_sold === 1 || (c.status && c.status !== "open");
    S().upsertTrade({
      id,
      status: done ? ((c.status as TradeRecord["status"]) ?? "sold") : "open",
      profit: c.profit !== undefined ? Number(c.profit) : undefined,
      entrySpot: c.entry_spot ?? undefined,
      exitSpot: c.exit_spot ?? undefined,
    });
    if (done) trade?.forgetKey(`poc-${contractId}`);
  });
}

/** Emergency stop: halt all execution, disable auto mode, try to sell anything sellable. */
export async function stopAll() {
  S().set({ halted: true, autoMode: false });
  if (quoteTimer) clearTimeout(quoteTimer);
  const open = S().trades.filter((t) => t.status === "open" && t.contractId);
  await Promise.all(
    open.map((t) =>
      trade
        ?.request({ sell: t.contractId, price: 0 }, 10_000, 0)
        .then(() => S().upsertTrade({ id: t.id, note: "Sold by Stop All" }))
        .catch((e: Error) => S().upsertTrade({ id: t.id, note: `Not sellable: ${e.message}` })),
    ),
  );
  S().notify("info", "Emergency stop engaged — all trading halted");
}

export function resume() {
  S().set({ halted: false });
  requoteNow();
}
