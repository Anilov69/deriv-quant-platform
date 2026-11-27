import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { DerivSession, validAppId } from "@/deriv";
import type { Account, Contract, Status, SymbolInfo } from "@/deriv";
import { buildCandidates, rank } from "@/ladder";
import type { Candidate, RankedQuote } from "@/ladder";
import { AutoTrader } from "@/autotrade";
import type { Snapshot } from "@/autotrade";
import AutoTradePanel from "@/AutoTradePanel";
import GapEnginePage from "@/pages/GapEnginePage";
import MeshHedgePage from "@/pages/MeshHedgePage";
import TouchStraddlePage from "@/pages/TouchStraddlePage";
import ParoliSniperPage from "@/pages/ParoliSniperPage";
import TimeCollarPage from "@/pages/TimeCollarPage";
import QuantDeskPage from "@/pages/QuantDeskPage";
import PhoenixEnginePage from "@/pages/PhoenixEnginePage";
import ChronoVaultPage from "@/pages/ChronoVaultPage";
import {
  digitsFrom,
  entropyBits,
  jumpProfile,
  momentumZ,
  posterior,
  quietProbability,
  repeatProbability,
  weightedDigitCounts,
} from "@/stats";

const STORAGE_KEY = "digit-edge.credentials";

interface StoredCredentials {
  token: string;
  appId: string;
  remember: boolean;
}

interface Notice {
  tone: "ok" | "bad" | "info";
  text: string;
}

type Route = "home" | "gap" | "mesh" | "straddle" | "paroli" | "collar" | "quant" | "phoenix" | "chrono";

/** GitHub Pages has no server-side routing, so the page lives in the hash. */
function readRoute(): Route {
  const path = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  if (path === "gap-engine") return "gap";
  if (path === "mesh-hedge") return "mesh";
  if (path === "touch-straddle") return "straddle";
  if (path === "paroli-sniper") return "paroli";
  if (path === "time-collar") return "collar";
  if (path === "quant-desk") return "quant";
  if (path === "phoenix-engine") return "phoenix";
  if (path === "chrono-vault") return "chrono";
  return "home";
}

function readStore(store: Storage): StoredCredentials | null {
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCredentials;
    if (!parsed.token || !parsed.appId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadCredentials(): StoredCredentials | null {
  return readStore(window.sessionStorage) ?? readStore(window.localStorage);
}

function clearCredentials(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage may be disabled */
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage may be disabled */
  }
}

function saveCredentials(value: StoredCredentials): void {
  clearCredentials();
  try {
    const store = value.remember ? window.localStorage : window.sessionStorage;
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage may be disabled */
  }
}

const FAMILY_LABEL: Record<string, string> = {
  continuous: "Continuous",
  jump: "Jump",
  step: "Step",
};

const FAMILY_ORDER = ["continuous", "jump", "step"];

function toContract(payload: any): Contract {
  return {
    id: Number(payload?.contract_id ?? 0),
    symbol: String(payload?.underlying_symbol ?? payload?.symbol ?? ""),
    contractType: String(payload?.contract_type ?? ""),
    stake: Number(payload?.buy_price ?? 0),
    payout: Number(payload?.payout ?? 0),
    status: String(payload?.status ?? "open"),
    profit: Number(payload?.profit ?? 0),
  };
}

function Sparkline({ values }: { values: number[] }): ReactElement | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 220;
  const height = 44;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * height;
    return x.toFixed(1) + "," + y.toFixed(1);
  });
  return (
    <svg viewBox={"0 0 " + width + " " + height} className="h-11 w-56" aria-hidden="true">
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent" />
    </svg>
  );
}

export default function App(): ReactElement {
  const sessionRef = useRef<DerivSession | null>(null);
  const restoredRef = useRef(false);
  const quoteIdsRef = useRef(new Map<string, string>());
  const candidatesRef = useRef<Candidate[]>([]);
  const snapshotRef = useRef<Snapshot | null>(null);
  const balanceRef = useRef<number | null>(null);
  const currencyRef = useRef("USD");
  const autoRef = useRef<AutoTrader | null>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [detail, setDetail] = useState("Not connected");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [symbol, setSymbol] = useState("");
  const [search, setSearch] = useState("");
  const [prices, setPrices] = useState<number[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [rows, setRows] = useState<RankedQuote[]>([]);
  const [quotedAt, setQuotedAt] = useState(0);
  const [quoting, setQuoting] = useState(false);
  const [stake, setStake] = useState(1);
  const [positions, setPositions] = useState<Contract[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("");
  const [remember, setRemember] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [autoArmed, setAutoArmed] = useState(false);
  const [route, setRoute] = useState<Route>(() => readRoute());
  const quotingRef = useRef(false);
  const routeRef = useRef<Route>(route);
  const gapContractRef = useRef<((payload: any) => void) | null>(null);
  const meshContractRef = useRef<((payload: any) => void) | null>(null);
  const touchContractRef = useRef<((payload: any) => void) | null>(null);
  const paroliContractRef = useRef<((payload: any) => void) | null>(null);
  const collarContractRef = useRef<((payload: any) => void) | null>(null);
  const quantContractRef = useRef<((payload: unknown) => void) | null>(null);
  const phoenixContractRef = useRef<((payload: unknown) => void) | null>(null);
  const chronoContractRef = useRef<((payload: unknown) => void) | null>(null);
  const quantNavigationGuardRef = useRef<(() => string | null) | null>(null);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    const onHash = () => {
      const next = readRoute();
      if (next !== "quant" && routeRef.current === "quant") {
        const blocked = quantNavigationGuardRef.current?.() ?? null;
        if (blocked) {
          window.history.replaceState(null, "", "#/quant-desk");
          setNotice({ tone: "bad", text: blocked });
          return;
        }
      }
      setRoute(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const session = new DerivSession();
    sessionRef.current = session;
    session.onStatus = (next, text) => {
      setStatus(next);
      setDetail(text);
    };
    session.onTick = (tick) => {
      setPrices((previous) => [...previous.slice(-500), tick.quote]);
      autoRef.current?.onTick();
    };
    session.onSymbols = (list) => setSymbols(list);
    session.onBalance = (value, code) => {
      setBalance(value);
      setCurrency(code);
    };
    session.onError = (message) => setNotice({ tone: "bad", text: message });
    session.onContract = (payload) => {
      autoRef.current?.onContractUpdate(payload);
      gapContractRef.current?.(payload);
      meshContractRef.current?.(payload);
      touchContractRef.current?.(payload);
      paroliContractRef.current?.(payload);
      collarContractRef.current?.(payload);
      quantContractRef.current?.(payload);
      phoenixContractRef.current?.(payload);
      chronoContractRef.current?.(payload);
      if (routeRef.current !== "home") return;
      const next = toContract(payload);
      setPositions((previous) => {
        const copy = [...previous];
        const index = copy.findIndex((item) => item.id === next.id);
        if (index >= 0) copy[index] = next;
        else copy.unshift(next);
        return copy.slice(0, 10);
      });
    };
    return () => {
      session.disconnect();
      sessionRef.current = null;
    };
  }, []);

  const authenticate = useCallback(async (rawToken: string, rawAppId: string, persist: boolean): Promise<void> => {
    const session = sessionRef.current;
    if (!session) return;
    setAuthError(null);
    setBusy(true);
    try {
      const list = await session.connect(rawToken, rawAppId);
      const loaded = await session.loadSymbols();
      await session.subscribeBalance();
      setAccounts(list);
      setAccountId(session.accountId);
      saveCredentials({ token: rawToken.trim(), appId: rawAppId.trim(), remember: persist });
      setAuthOpen(false);
      setNotice({ tone: "ok", text: loaded.length + " symbols loaded. Quotes are pulled on demand." });
    } catch (error) {
      setAuthError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const notify = useCallback((text: string, tone: "bad" | "ok") => {
    setNotice({ tone, text });
  }, []);

  const bindContractListener = useCallback((handler: ((payload: any) => void) | null) => {
    gapContractRef.current = handler;
  }, []);

  const bindMeshContractListener = useCallback((handler: ((payload: any) => void) | null) => {
    meshContractRef.current = handler;
  }, []);

  const bindTouchContractListener = useCallback((handler: ((payload: any) => void) | null) => {
    touchContractRef.current = handler;
  }, []);

  const bindParoliContractListener = useCallback((handler: ((payload: any) => void) | null) => {
    paroliContractRef.current = handler;
  }, []);

  const bindCollarContractListener = useCallback((handler: ((payload: any) => void) | null) => {
    collarContractRef.current = handler;
  }, []);

  const bindPhoenixContractListener = useCallback((handler: ((payload: unknown) => void) | null) => {
    phoenixContractRef.current = handler;
  }, []);

  const bindChronoContractListener = useCallback((handler: ((payload: unknown) => void) | null) => {
    chronoContractRef.current = handler;
  }, []);

  const bindQuantContractListener = useCallback((handler: ((payload: unknown) => void) | null) => {
    quantContractRef.current = handler;
  }, []);

  const bindQuantNavigationGuard = useCallback((handler: (() => string | null) | null) => {
    quantNavigationGuardRef.current = handler;
  }, []);

  const switchAccount = useCallback((next: string) => {
    const session = sessionRef.current;
    if (!session || !next || next === accountId) return;
    setAccountId(next);
    void session
      .switchTo(next)
      .then(() => session.subscribeBalance())
      .catch((error: Error) => setNotice({ tone: "bad", text: error.message }));
  }, [accountId]);

  useEffect(() => {
    if (route !== "home") autoRef.current?.stop("Terminal panel closed");
  }, [route]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const stored = loadCredentials();
    if (!stored) return;
    setToken(stored.token);
    setAppId(stored.appId);
    setRemember(stored.remember);
    void authenticate(stored.token, stored.appId, stored.remember);
  }, [authenticate]);

  useEffect(() => {
    if (!symbol && symbols.length > 0) {
      const preferred = symbols.find((item) => item.symbol === "R_100") ?? symbols[0];
      setSymbol(preferred.symbol);
    }
  }, [symbols, symbol]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || status !== "live" || !symbol) return;
    if (route !== "home") return;
    let cancelled = false;
    setPrices([]);
    session.subscribeTicks(symbol).catch((error: Error) => setNotice({ tone: "bad", text: error.message }));
    session.history(symbol, 300).then((list) => {
      if (!cancelled) setPrices(list.map((tick) => tick.quote));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [route, status, symbol]);

  const symbolInfo = useMemo(() => symbols.find((item) => item.symbol === symbol) ?? null, [symbols, symbol]);
  const decimals = useMemo(() => {
    const pip = symbolInfo?.pip ?? 0.01;
    return Math.min(8, Math.max(0, Math.round(-Math.log10(pip))));
  }, [symbolInfo]);

  const model = useMemo(() => {
    const digits = digitsFrom(prices, decimals);
    const counts = weightedDigitCounts(digits, 80);
    const probabilities = posterior(counts, 0.5);
    return {
      digits,
      probabilities,
      momentum: momentumZ(prices),
      repeat: repeatProbability(digits),
      entropy: entropyBits(probabilities),
    };
  }, [prices, decimals]);

  const jump = useMemo(() => jumpProfile(prices), [prices]);
  const family = symbolInfo?.family ?? null;

  const candidates = useMemo<Candidate[]>(() => {
    if (!family) return [];
    return buildCandidates({
      family,
      probabilities: model.probabilities,
      currentDigit: model.digits[model.digits.length - 1] ?? 0,
      momentumZ: model.momentum,
    });
  }, [family, model]);

  candidatesRef.current = candidates;
  balanceRef.current = balance;
  currencyRef.current = currency;
  snapshotRef.current =
    family !== null && symbol !== ""
      ? {
          symbol,
          family,
          probabilities: model.probabilities,
          currentDigit: model.digits[model.digits.length - 1] ?? 0,
          momentumZ: model.momentum,
        }
      : null;

  const engine: AutoTrader =
    autoRef.current ??
    (autoRef.current = new AutoTrader({
      snapshot: () => snapshotRef.current,
      quote: async (input) => {
        const session = sessionRef.current;
        const snap = snapshotRef.current;
        if (!session || !snap) throw new Error("Not connected to Deriv.");
        return session.quote({
          symbol: snap.symbol,
          contract: input.contract,
          barrier: input.barrier,
          duration: input.duration,
          stake: input.stake,
          currency: currencyRef.current,
        });
      },
      buy: async (id, price) => {
        const session = sessionRef.current;
        if (!session) throw new Error("Not connected to Deriv.");
        return session.buy(id, price);
      },
      watch: async (contractId) => {
        const session = sessionRef.current;
        if (!session) throw new Error("Not connected to Deriv.");
        await session.watch(contractId);
      },
      balance: () => balanceRef.current,
      currency: () => currencyRef.current,
    }));

  const refreshLadder = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    const list = candidatesRef.current;
    if (!session || !session.live || !symbol || list.length === 0) return;
    if (quotingRef.current) return;
    quotingRef.current = true;
    setQuoting(true);
    const quotes = new Map<string, { ask: number; payout: number }>();
    const ids = new Map<string, string>();
    try {
      for (const candidate of list) {
        try {
          const quote = await session.quote({
            symbol,
            contract: candidate.contract,
            barrier: candidate.barrier,
            duration: candidate.duration,
            stake,
            currency,
          });
          quotes.set(candidate.key, { ask: quote.ask, payout: quote.payout });
          ids.set(candidate.key, quote.id);
        } catch {
          /* Deriv does not offer this contract on this symbol */
        }
      }
      quoteIdsRef.current = ids;
      setRows(rank(list, quotes));
      setQuotedAt(Date.now());
    } finally {
      quotingRef.current = false;
      setQuoting(false);
    }
  }, [symbol, stake, currency]);

  const refreshRef = useRef(refreshLadder);
  refreshRef.current = refreshLadder;

  useEffect(() => {
    if (status !== "live" || !symbol) return;
    if (route !== "home") return;
    // While auto-trade is armed it owns the proposal budget; the table would
    // compete with the engine and re-trigger Deriv's burst limit.
    if (autoArmed) {
      setRows([]);
      return;
    }
    void refreshRef.current();
    const timer = window.setInterval(() => void refreshRef.current(), 12000);
    return () => window.clearInterval(timer);
  }, [status, symbol, stake, currency, autoArmed, route]);

  const buy = useCallback(async (row: RankedQuote): Promise<void> => {
    const session = sessionRef.current;
    const id = quoteIdsRef.current.get(row.key);
    if (!session || !session.live || !id) {
      setNotice({ tone: "bad", text: "That quote expired. Wait for the next refresh." });
      return;
    }
    const summary =
      "Buy " + row.contract + (row.barrier ? " " + row.barrier : "") + " on " + symbol + "\n" +
      "Stake " + row.ask.toFixed(2) + " " + currency + " -> payout " + row.payout.toFixed(2) + "\n" +
      "Model " + (row.probability * 100).toFixed(1) + "% vs break-even " + (row.breakEven * 100).toFixed(1) + "%\n" +
      "Expected value " + row.edge.toFixed(3) + " per stake";
    if (!window.confirm(summary)) return;
    setBusy(true);
    try {
      const contractId = await session.buy(id, row.ask);
      await session.watch(contractId);
      quoteIdsRef.current.delete(row.key);
      setNotice({ tone: "ok", text: "Contract " + contractId + " opened on the live socket." });
    } catch (error) {
      setNotice({ tone: "bad", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [currency, symbol]);

  const disconnect = useCallback((): void => {
    sessionRef.current?.disconnect();
    clearCredentials();
    setAccounts([]);
    setSymbols([]);
    setSymbol("");
    setPrices([]);
    setRows([]);
    setPositions([]);
    setBalance(null);
    setToken("");
    setAppId("");
    setNotice({ tone: "info", text: "Credentials cleared from this device." });
  }, []);

  const submitAuth = useCallback((): void => {
    if (!validAppId(appId)) {
      setAuthError("App ID must be alphanumeric (letters, digits, hyphen or underscore).");
      return;
    }
    if (token.trim().length < 10) {
      setAuthError("That token looks too short.");
      return;
    }
    void authenticate(token, appId, remember);
  }, [appId, authenticate, remember, token]);

  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? symbols.filter((item) => item.symbol.toLowerCase().includes(query) || item.name.toLowerCase().includes(query))
      : symbols;
    return FAMILY_ORDER.map((key) => ({
      key,
      label: FAMILY_LABEL[key] ?? key,
      items: filtered.filter((item) => item.family === key),
    })).filter((group) => group.items.length > 0);
  }, [search, symbols]);

  const digitTail = model.digits.slice(-36);
  const topProbability = Math.max(...model.probabilities);
  const best = rows.find((row) => row.value) ?? rows[0] ?? null;
  const live = status === "live";
  const accountKind: "demo" | "real" | "unknown" = accounts.find((item) => item.id === accountId)?.kind ?? "unknown";

  return (
    <div className="min-h-screen bg-ink text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Digit Edge</h1>
          <p className="text-xs text-muted">Contract-ladder search for Deriv synthetic indices</p>
        </div>
        <nav className="grid w-full grid-cols-4 gap-1 text-xs md:flex md:w-auto md:items-center" aria-label="Pages">
          <a href="#/" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "home" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Main Terminal
          </a>
          <a href="#/gap-engine" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "gap" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Gap Engine
          </a>
          <a href="#/mesh-hedge" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "mesh" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Mesh Hedge
          </a>
          <a href="#/touch-straddle" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "straddle" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Touch Straddle
          </a>
          <a href="#/paroli-sniper" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "paroli" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Paroli Sniper
          </a>
          <a href="#/time-collar" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "collar" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Time Collar
          </a>
          <a href="#/quant-desk" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "quant" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Quant Desk
          </a>
          <a href="#/phoenix-engine" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "phoenix" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Phoenix Engine
          </a>
          <a href="#/chrono-vault" className={"whitespace-normal rounded px-1 py-1 text-center text-[9px] sm:whitespace-nowrap sm:px-2 sm:text-xs " + (route === "chrono" ? "bg-panel text-slate-100" : "text-muted hover:text-slate-100")}>
            Chrono-Vault
          </a>
        </nav>
        <div className="flex items-center gap-3 text-xs">
          <span className={"rounded-full border px-3 py-1 " + (live ? "border-accent/40 text-accent" : status === "error" ? "border-danger/40 text-danger" : "border-line text-muted")}>
            {status === "live" ? "LIVE" : status.toUpperCase()}
          </span>
          <span className="hidden text-muted sm:inline">{detail}</span>
          {balance !== null ? (
            <span className="font-mono text-slate-200">{balance.toFixed(2)} {currency}</span>
          ) : null}
          {live ? (
            <button type="button" onClick={disconnect} className="rounded border border-line px-3 py-1 text-muted hover:text-slate-100">
              Disconnect
            </button>
          ) : (
            <button type="button" onClick={() => setAuthOpen((open) => !open)} className="rounded bg-accent px-3 py-1 font-medium text-ink">
              Connect
            </button>
          )}
        </div>
      </header>

      {authOpen && !live ? (
        <section className="border-b border-line bg-panel px-5 py-4">
          <form
            className="grid max-w-3xl gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitAuth();
            }}
          >
            <label className="text-xs text-muted">
              Personal access token
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded border border-line bg-ink px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-accent"
                placeholder="paste your Deriv token"
              />
            </label>
            <label className="text-xs text-muted">
              App ID (alphanumeric)
              <input
                type="text"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded border border-line bg-ink px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-accent"
                placeholder="e.g. 34ZCRWtNOpOYBwRAu41qD"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted sm:col-span-2">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              Remember on this device (otherwise the tab session only)
            </label>
            {authError ? (
              <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger sm:col-span-2">
                {authError}
              </p>
            ) : null}
            <div className="flex items-center gap-2 sm:col-span-2">
              <button type="submit" disabled={busy} className="rounded bg-accent px-4 py-2 text-sm font-medium text-ink disabled:opacity-50">
                {busy ? "Authenticating..." : "Authenticate"}
              </button>
              <span className="text-xs text-muted">GET accounts, then POST OTP, then a socket with no authorize frame.</span>
            </div>
          </form>
        </section>
      ) : null}

      {notice ? (
        <div className={"px-5 py-2 text-xs " + (notice.tone === "bad" ? "bg-danger/10 text-danger" : notice.tone === "ok" ? "bg-accent/10 text-accent" : "bg-panel text-muted")}>
          {notice.text}
        </div>
      ) : null}

      {route === "gap" ? (
        <GapEnginePage
          sessionRef={sessionRef}
          connected={live}
          symbols={symbols}
          accounts={accounts}
          accountId={accountId}
          accountKind={accountKind}
          balance={balance}
          currency={currency}
          onConnect={() => setAuthOpen(true)}
          onAccountChange={switchAccount}
          onNotice={notify}
          bindContractListener={bindContractListener}
        />
      ) : route === "mesh" ? (
        <MeshHedgePage
          sessionRef={sessionRef}
          connected={live}
          symbols={symbols}
          accounts={accounts}
          accountId={accountId}
          accountKind={accountKind}
          balance={balance}
          currency={currency}
          onConnect={() => setAuthOpen(true)}
          onAccountChange={switchAccount}
          onNotice={notify}
          bindContractListener={bindMeshContractListener}
        />
      ) : route === "straddle" ? (
        <TouchStraddlePage
          sessionRef={sessionRef}
          connected={live}
          symbols={symbols}
          accounts={accounts}
          accountId={accountId}
          accountKind={accountKind}
          balance={balance}
          currency={currency}
          onConnect={() => setAuthOpen(true)}
          onAccountChange={switchAccount}
          onNotice={notify}
          bindContractListener={bindTouchContractListener}
        />
      ) : route === "paroli" ? (
        <ParoliSniperPage
          sessionRef={sessionRef}
          connected={live}
          symbols={symbols}
          accounts={accounts}
          accountId={accountId}
          accountKind={accountKind}
          balance={balance}
          currency={currency}
          onConnect={() => setAuthOpen(true)}
          onAccountChange={switchAccount}
          onNotice={notify}
          bindContractListener={bindParoliContractListener}
        />
      ) : route === "collar" ? (
        <TimeCollarPage
          sessionRef={sessionRef}
          connected={live}
          symbols={symbols}
          accounts={accounts}
          accountId={accountId}
          accountKind={accountKind}
          balance={balance}
          currency={currency}
          onConnect={() => setAuthOpen(true)}
          onAccountChange={switchAccount}
          onNotice={notify}
          bindContractListener={bindCollarContractListener}
        />
      ) : route === "quant" ? (
        <QuantDeskPage
          sessionRef={sessionRef}
          connected={live}
          accounts={accounts}
          accountId={accountId}
          accountKind={accountKind}
          balance={balance}
          currency={currency}
          onConnect={() => setAuthOpen(true)}
          onAccountChange={switchAccount}
          onNotice={notify}
          bindContractListener={bindQuantContractListener}
          bindNavigationGuard={bindQuantNavigationGuard}
        />
      ) : route === "phoenix" ? (
        <PhoenixEnginePage
          sessionRef={sessionRef}
          connected={live}
          symbols={symbols}
          accounts={accounts}
          accountId={accountId}
          accountKind={accountKind}
          balance={balance}
          currency={currency}
          onConnect={() => setAuthOpen(true)}
          onAccountChange={switchAccount}
          onNotice={notify}
          bindContractListener={bindPhoenixContractListener}
        />
      ) : route === "chrono" ? (
        <ChronoVaultPage
          sessionRef={sessionRef}
          connected={live}
          symbols={symbols}
          accounts={accounts}
          accountId={accountId}
          accountKind={accountKind}
          balance={balance}
          currency={currency}
          onConnect={() => setAuthOpen(true)}
          onAccountChange={switchAccount}
          onNotice={notify}
          bindContractListener={bindChronoContractListener}
        />
      ) : (
        <>
      <main className="grid gap-0 lg:grid-cols-[230px_minmax(0,1fr)_300px]">
        <aside className="border-b border-line p-3 lg:border-b-0 lg:border-r">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search symbols"
            className="mb-3 w-full rounded border border-line bg-panel px-2 py-1.5 text-xs outline-none focus:border-accent"
          />
          <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
            {grouped.length === 0 ? (
              <p className="text-xs text-muted">{live ? "No symbols match." : "Connect to load symbols."}</p>
            ) : null}
            {grouped.map((group) => (
              <div key={group.key}>
                <p className="mb-1 text-[10px] uppercase tracking-widest text-muted">{group.label}</p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <li key={item.symbol}>
                      <button
                        type="button"
                        onClick={() => setSymbol(item.symbol)}
                        className={"flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs " + (item.symbol === symbol ? "bg-accent/15 text-accent" : "text-slate-300 hover:bg-panel")}
                      >
                        <span className="font-mono">{item.symbol}</span>
                        <span className="truncate pl-2 text-[10px] text-muted">{item.name.replace(" Index", "")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        <section className="min-w-0 p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs text-muted">{symbolInfo ? FAMILY_LABEL[symbolInfo.family] + " | " + symbolInfo.name : "No symbol"}</p>
              <p className="font-mono text-3xl">
                {prices.length > 0 ? prices[prices.length - 1].toFixed(decimals) : "--"}
                <span className="ml-2 text-xs text-muted">{decimals} dp</span>
              </p>
            </div>
            <Sparkline values={prices.slice(-90)} />
            <dl className="grid grid-cols-4 gap-3 text-center text-[11px] text-muted">
              <div>
                <dt>z</dt>
                <dd className="font-mono text-sm text-slate-200">{model.momentum.toFixed(2)}</dd>
              </div>
              <div>
                <dt>repeat</dt>
                <dd className="font-mono text-sm text-slate-200">{(model.repeat * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt>entropy</dt>
                <dd className="font-mono text-sm text-slate-200">{model.entropy.toFixed(2)}</dd>
              </div>
              <div>
                <dt>quiet 5t</dt>
                <dd className="font-mono text-sm text-slate-200">{(quietProbability(jump.intensity, 5) * 100).toFixed(0)}%</dd>
              </div>
            </dl>
          </div>

          <div className="mt-3 flex flex-wrap gap-1">
            {digitTail.map((digit, index) => (
              <span
                key={index}
                className={"flex h-6 w-6 items-center justify-center rounded border font-mono text-[11px] " + (index === digitTail.length - 1 ? "border-accent text-accent" : "border-line text-slate-300")}
                title={"P(digit) " + (model.probabilities[digit] * 100).toFixed(1) + "%"}
              >
                {digit}
              </span>
            ))}
            {digitTail.length === 0 ? <span className="text-xs text-muted">Waiting for ticks.</span> : null}
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[540px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="pb-2 font-normal">Contract</th>
                  <th className="pb-2 text-right font-normal">Model</th>
                  <th className="pb-2 text-right font-normal">Break-even</th>
                  <th className="pb-2 text-right font-normal">Payout</th>
                  <th className="pb-2 text-right font-normal">EV / stake</th>
                  <th className="pb-2 text-right font-normal">Quote</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((row) => (
                  <tr key={row.key} className={"border-t border-line " + (row.value ? "text-accent" : "text-slate-300")}>
                    <td className="py-1.5">
                      <span className="font-sans">{row.label}</span>
                      <span className="ml-2 text-[10px] text-muted">{row.contract.toLowerCase()} {row.duration}t</span>
                    </td>
                    <td className="text-right">{(row.probability * 100).toFixed(1)}%</td>
                    <td className="text-right text-muted">{(row.breakEven * 100).toFixed(1)}%</td>
                    <td className="text-right">{row.payout.toFixed(2)}</td>
                    <td className="text-right">{row.edge.toFixed(3)}</td>
                    <td className="text-right">{row.ask.toFixed(2)}</td>
                    <td className="py-1 pl-2 text-right">
                      <button
                        type="button"
                        onClick={() => void buy(row)}
                        disabled={busy || !live}
                        className="rounded border border-line px-2 py-0.5 font-sans text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"
                      >
                        Buy
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-4 text-center font-sans text-xs text-muted">
                      {live ? (quoting ? "Pricing the ladder..." : "No quotes returned. Try another symbol.") : "Connect to price the ladder."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-[11px] text-muted">
            {rows.length > 0
              ? "Quoted " + new Date(quotedAt).toLocaleTimeString() + ". Rows in green clear the house margin; the rest do not."
              : "Every row pairs a model probability with Deriv's own payout, so an edge has to survive the margin."}
            {family === "step" ? " Step indices quote no digit contracts, so only Rise/Fall appear." : ""}
          </p>
        </section>

        <aside className="border-t border-line p-4 lg:border-l lg:border-t-0">
          <div className="space-y-4 text-xs">
            <div>
              <label className="text-muted" htmlFor="account">Account</label>
              <select
                id="account"
                value={accountId}
                disabled={accounts.length <= 1 || !live}
                onChange={(event) => {
                  const next = event.target.value;
                  setAccountId(next);
                  void sessionRef.current?.switchTo(next)
                    .then(() => sessionRef.current?.subscribeBalance())
                    .catch((error: Error) => setNotice({ tone: "bad", text: error.message }));
                }}
                className="mt-1 w-full rounded border border-line bg-panel px-2 py-1.5 text-xs"
              >
                {accounts.length === 0 ? <option value="">Not connected</option> : null}
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.id} ({account.kind})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-muted" htmlFor="stake">Stake per contract</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id="stake"
                  type="number"
                  min={0.35}
                  step={0.5}
                  value={stake}
                  onChange={(event) => setStake(Math.max(0.35, Number(event.target.value) || 0.35))}
                  className="w-full rounded border border-line bg-panel px-2 py-1.5 font-mono"
                />
                <span className="text-muted">{currency}</span>
              </div>
            </div>

            <div className="rounded border border-line bg-panel p-3">
              <p className="mb-1 text-[10px] uppercase tracking-widest text-muted">Top model call</p>
              <p className="font-mono text-sm text-slate-200">
                {prices.length > 0 ? "digit " + model.digits[model.digits.length - 1] + " at " + (topProbability * 100).toFixed(1) + "%" : "waiting for ticks"}
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {best ? (best.value ? "A positive-EV row exists; it is flagged green." : "Nothing clears the margin right now.") : "No ladder yet."}
              </p>
            </div>

            <div>
              <p className="mb-1 text-[10px] uppercase tracking-widest text-muted">Open contracts</p>
              {positions.length === 0 ? (
                <p className="text-[11px] text-muted">None. Contracts you buy stream their status here.</p>
              ) : (
                <ul className="space-y-1">
                  {positions.map((position) => (
                    <li key={position.id} className="flex items-center justify-between rounded border border-line px-2 py-1">
                      <span className="font-mono text-[11px]">{position.id}</span>
                      <span className="text-[11px] text-muted">{position.contractType}</span>
                      <span className={"font-mono text-[11px] " + (position.profit >= 0 ? "text-accent" : "text-danger")}>
                        {position.profit.toFixed(2)}
                      </span>
                      <span className="text-[10px] uppercase text-muted">{position.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded border border-line p-3 text-[11px] leading-relaxed text-muted">
              <p className="mb-1 text-slate-300">How the edge is claimed</p>
              The digit posterior weights recent ticks more heavily than old ones. A contract is only
              interesting when that posterior beats the payout's own break-even, so most rows sit
              negative and stay that way.
              <p className="mt-2">
                No backtest is shown because the app cannot replay Deriv's payout history offline; the
                ladder is a live comparison, not a track record.
              </p>
            </div>
          </div>
        </aside>
      </main>

      <AutoTradePanel
        engine={engine}
        connected={live}
        accountKind={accountKind}
        accountId={accountId}
        onArmedChange={setAutoArmed}
        balance={balance}
        currency={currency}
        symbol={symbol}
      />
        </>
      )}

      <footer className="border-t border-line px-5 py-3 text-[11px] text-muted">
        Prices and payouts come from Deriv's New Options API over a single-use OTP socket. Synthetic indices
        are a house-priced game: a positive EV row is a model disagreement, not a guarantee.
      </footer>
    </div>
  );
}