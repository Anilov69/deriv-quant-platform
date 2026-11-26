import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Account, DerivSession, SymbolInfo, Tick } from "@/deriv";
import { classifyGap, gapSignal, nextStake } from "@/gap";
import type { GapMode, GapSide } from "@/gap";

type MartMode = "off" | "1.5" | "2" | "payout" | "custom";

interface Settings {
  lookback: number;
  mode: GapMode;
  minGapPp: number;
  stake: number;
  duration: number;
  takeProfit: number;
  stopLoss: number;
  delaySeconds: number;
  martMode: MartMode;
  customMultiplier: number;
  martLevels: number;
}

interface TradeRow {
  id: number;
  time: number;
  symbol: string;
  side: GapSide;
  entry: number;
  exit: number;
  stake: number;
  payout: number;
  profit: number;
  level: number;
}

interface Props {
  sessionRef: { readonly current: DerivSession | null };
  connected: boolean;
  symbols: SymbolInfo[];
  accounts: Account[];
  accountId: string;
  accountKind: "demo" | "real" | "unknown";
  balance: number | null;
  currency: string;
  onConnect: () => void;
  onAccountChange: (accountId: string) => void;
  onNotice: (text: string, tone: "bad" | "ok") => void;
  bindContractListener: (handler: ((payload: any) => void) | null) => void;
}

const DEFAULTS: Settings = {
  lookback: 10,
  mode: "momentum",
  minGapPp: 10,
  stake: 1,
  duration: 2,
  takeProfit: 10,
  stopLoss: 10,
  delaySeconds: 3,
  martMode: "2",
  customMultiplier: 2,
  martLevels: 2,
};

const MART_LABEL: Record<MartMode, string> = {
  off: "Off (1x flat stake)",
  "1.5": "1.5x after a loss",
  "2": "2x after a loss",
  payout: "Payout-adjusted recovery",
  custom: "Custom multiplier",
};

const FAMILY_TITLE: Record<string, string> = {
  continuous: "Continuous Indices",
  step: "Step Indices",
  jump: "Jump Indices",
};

const inputClass =
  "w-full rounded border border-line bg-ink px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="text-[11px] text-muted">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function Ring(props: { label: string; pct: number; count: number; total: number; color: string }): ReactElement {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, props.pct)) / 100) * circumference;
  return (
    <div className="flex flex-col items-center gap-1 rounded border border-line bg-ink px-2 py-3">
      <div className="relative h-24 w-24">
        <svg viewBox="0 0 84 84" className="h-24 w-24 -rotate-90" aria-hidden="true">
          <circle cx="42" cy="42" r={radius} fill="none" stroke="#1f2d3a" strokeWidth="7" />
          <circle cx="42" cy="42" r={radius} fill="none" stroke={props.color} strokeWidth="7" strokeLinecap="round" strokeDasharray={filled + " " + circumference} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-lg text-slate-100">{props.pct.toFixed(1)}%</span>
          <span className="text-[10px] text-muted">{props.count} / {props.total}</span>
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-widest text-muted">{props.label}</span>
    </div>
  );
}

function Modal(props: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded border border-line bg-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">{props.title}</h2>
          <button type="button" onClick={props.onClose} className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-slate-100">
            Close
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export default function GapEnginePage(props: Props): ReactElement {
  const { sessionRef, connected, symbols, accounts, accountId, accountKind, balance, currency, onConnect, onAccountChange, onNotice, bindContractListener } = props;

  const [symbol, setSymbol] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [buffer, setBuffer] = useState<number[]>([]);
  const [spot, setSpot] = useState(0);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("Paused");
  const [pnl, setPnl] = useState(0);
  const [nextStakeView, setNextStakeView] = useState(DEFAULTS.stake);
  const [stepView, setStepView] = useState(0);
  const [history, setHistory] = useState<TradeRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [realOk, setRealOk] = useState(false);
  const [openContract, setOpenContract] = useState<{ id: number; stake: number; profit: number; side: GapSide } | null>(null);

  const settingsRef = useRef<Settings>(DEFAULTS);
  const runningRef = useRef(false);
  const execRef = useRef(false);
  const coolingRef = useRef(false);
  const nextStakeRef = useRef(DEFAULTS.stake);
  const stepRef = useRef(0);
  const pnlRef = useRef(0);
  const cumLossRef = useRef(0);
  const pricesRef = useRef<number[]>([]);
  const symbolRef = useRef("");
  const currencyRef = useRef(currency);
  const settleRef = useRef<{ id: number; resolve: (payload: any) => void } | null>(null);
  const historyIdRef = useRef(0);

  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { symbolRef.current = symbol; }, [symbol]);
  useEffect(() => { currencyRef.current = currency; }, [currency]);
  useEffect(() => { setRealOk(false); }, [accountId]);

  useEffect(() => {
    if (symbol || symbols.length === 0) return;
    const preferred = symbols.find((item) => item.symbol === "R_100") ?? symbols[0];
    setSymbol(preferred.symbol);
  }, [symbol, symbols]);

  const stopBot = useCallback((label: string) => {
    runningRef.current = false;
    coolingRef.current = false;
    setRunning(false);
    setPhase(label);
  }, []);

  const onContract = useCallback((payload: any) => {
    const current = settleRef.current;
    if (!current || Number(payload?.contract_id) !== current.id) return;
    const profit = Number(payload?.profit ?? 0);
    setOpenContract((previous) => (previous ? { ...previous, profit } : previous));
    if (Number(payload?.is_sold) === 1) {
      const resolve = current.resolve;
      settleRef.current = null;
      resolve(payload);
    }
  }, []);

  useEffect(() => {
    bindContractListener(onContract);
    return () => bindContractListener(null);
  }, [bindContractListener, onContract]);

  const attemptTrade = useCallback(async (entrySpot: number) => {
    if (!runningRef.current || execRef.current || coolingRef.current) return;
    const cfg = settingsRef.current;
    const session = sessionRef.current;
    if (!session) return;
    const side = gapSignal(classifyGap(pricesRef.current, cfg.lookback), cfg.mode, cfg.minGapPp).side;
    if (!side) return;
    execRef.current = true;
    const market = symbolRef.current;
    const cash = currencyRef.current;
    const stake = nextStakeRef.current;
    setPhase(side === "CALL" ? "Placing Rise..." : "Placing Fall...");
    let subscriptionId = "";
    try {
      const quote = await session.quote({ symbol: market, contract: side, duration: cfg.duration, stake, currency: cash });
      const contractId = await session.buy(quote.id, quote.ask);
      setOpenContract({ id: contractId, stake: quote.ask, profit: 0, side });
      setPhase("Contract Open");
      let timer = 0;
      const settled = new Promise<any>((resolve) => {
        timer = window.setTimeout(() => resolve(null), 180000);
        settleRef.current = {
          id: contractId,
          resolve: (payload) => {
            window.clearTimeout(timer);
            resolve(payload);
          },
        };
      });
      subscriptionId = await session.watch(contractId);
      const payload = await settled;
      if (!payload) throw new Error("Deriv did not settle the contract within 180 s.");
      const profit = Number(payload.profit ?? 0);
      const newPnl = Math.round((pnlRef.current + profit) * 100) / 100;
      pnlRef.current = newPnl;
      setPnl(newPnl);
      if (profit > 0) {
        stepRef.current = 0;
        cumLossRef.current = 0;
        nextStakeRef.current = cfg.stake;
      } else {
        cumLossRef.current = Math.round((cumLossRef.current + quote.ask) * 100) / 100;
        if (cfg.martMode !== "off" && stepRef.current < cfg.martLevels) {
          stepRef.current += 1;
          nextStakeRef.current = nextStake({
            mode: cfg.martMode,
            baseStake: cfg.stake,
            multiplier: cfg.customMultiplier,
            lastStake: quote.ask,
            payout: quote.payout,
            cumulativeLoss: cumLossRef.current,
          });
        } else {
          stepRef.current = 0;
          cumLossRef.current = 0;
          nextStakeRef.current = cfg.stake;
        }
      }
      setStepView(stepRef.current);
      setNextStakeView(nextStakeRef.current);
      const exitSpot = Number(payload.exit_tick ?? payload.sell_spot ?? 0);
      historyIdRef.current += 1;
      const row: TradeRow = {
        id: historyIdRef.current,
        time: Date.now(),
        symbol: market,
        side,
        entry: entrySpot,
        exit: exitSpot,
        stake: quote.ask,
        payout: quote.payout,
        profit,
        level: stepRef.current,
      };
      setHistory((rows) => [row, ...rows].slice(0, 300));
      if (newPnl >= cfg.takeProfit) {
        stopBot("Stopped: Take Profit Hit");
      } else if (newPnl <= -cfg.stopLoss) {
        stopBot("Stopped: Stop Loss Hit");
      } else {
        if (cfg.delaySeconds > 0) {
          coolingRef.current = true;
          for (let left = cfg.delaySeconds; left > 0 && runningRef.current; left -= 1) {
            setPhase("Cooldown (" + left + "s)");
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
          }
          coolingRef.current = false;
        }
        if (runningRef.current) setPhase("Scanning ticks...");
      }
    } catch (error) {
      stopBot("Stopped: " + (error as Error).message);
      onNotice((error as Error).message, "bad");
    } finally {
      settleRef.current = null;
      if (subscriptionId) void session.forget(subscriptionId);
      setOpenContract(null);
      execRef.current = false;
    }
  }, [onNotice, sessionRef, stopBot]);

  const begin = useCallback(() => {
    const cfg = settingsRef.current;
    runningRef.current = true;
    execRef.current = false;
    coolingRef.current = false;
    stepRef.current = 0;
    cumLossRef.current = 0;
    nextStakeRef.current = cfg.stake;
    setStepView(0);
    setNextStakeView(cfg.stake);
    setRunning(true);
    setPhase("Scanning ticks...");
    const last = pricesRef.current[pricesRef.current.length - 1] ?? 0;
    void attemptTrade(last);
  }, [attemptTrade]);

  const start = useCallback(() => {
    if (!connected) {
      onConnect();
      return;
    }
    if (accountKind === "real" && !realOk) {
      setConfirmText("");
      setConfirmOpen(true);
      return;
    }
    begin();
  }, [accountKind, begin, connected, onConnect, realOk]);

  const resetSession = useCallback(() => {
    stopBot("Paused");
    pnlRef.current = 0;
    cumLossRef.current = 0;
    stepRef.current = 0;
    nextStakeRef.current = settingsRef.current.stake;
    setPnl(0);
    setStepView(0);
    setNextStakeView(settingsRef.current.stake);
    setHistory([]);
    setOpenContract(null);
  }, [stopBot]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!connected || !symbol || !session) return;
    pricesRef.current = [];
    setBuffer([]);
    setSpot(0);
    let cancelled = false;
    let subscriptionId = "";
    session.onTickFor = (_market, tick: Tick) => {
      pricesRef.current = [...pricesRef.current.slice(-200), tick.quote];
      setBuffer(pricesRef.current.slice());
      setSpot(tick.quote);
      void attemptTrade(tick.quote);
    };
    session.subscribeTicksFor(symbol)
      .then((id) => {
        if (cancelled) void session.forget(id);
        else subscriptionId = id;
      })
      .catch((error: Error) => onNotice(error.message, "bad"));
    session.history(symbol, 100)
      .then((list) => {
        if (cancelled) return;
        const values = list.map((item) => item.quote);
        pricesRef.current = values.slice(-200);
        setBuffer(values.slice(-200));
        setSpot(values[values.length - 1] ?? 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      session.onTickFor = null;
      void session.forget(subscriptionId);
    };
  }, [attemptTrade, connected, onNotice, sessionRef, symbol]);

  useEffect(() => () => {
    runningRef.current = false;
  }, []);

  const stats = useMemo(() => classifyGap(buffer, settings.lookback), [buffer, settings.lookback]);
  const decision = useMemo(() => gapSignal(stats, settings.mode, settings.minGapPp), [settings.minGapPp, settings.mode, stats]);
  const symbolInfo = useMemo(() => symbols.find((item) => item.symbol === symbol) ?? null, [symbol, symbols]);
  const decimals = useMemo(() => {
    const pip = symbolInfo?.pip ?? 0.01;
    return Math.min(8, Math.max(0, Math.round(-Math.log10(pip))));
  }, [symbolInfo]);

  const signalLabel = !stats.ready ? "Collecting ticks" : !decision.side ? "No signal / below gap" : decision.side === "CALL" ? "Rise (CALL)" : "Fall (PUT)";
  const signalTone = !stats.ready
    ? "border-line text-muted"
    : !decision.side
      ? "border-line text-slate-300"
      : decision.side === "CALL"
        ? "border-accent/50 bg-accent/10 text-accent"
        : "border-danger/50 bg-danger/10 text-danger";
  const spreadText = !stats.ready
    ? "Need " + settings.lookback + " ticks; " + buffer.length + " in the buffer"
    : stats.leader === "balanced"
      ? "Balanced (0.0 pp)"
      : (stats.leader === "up" ? "Up leads by " : "Down leads by ") + stats.gapPp.toFixed(1) + " pp";

  const groups = ["continuous", "step", "jump"].filter((family) => symbols.some((item) => item.family === family));

  const setField = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((current) => ({ ...current, [key]: value }));

  const downloadCsv = () => {
    const head = "time,symbol,contract,entry,exit,stake,payout,profit,level";
    const body = history.map((row) => [new Date(row.time).toISOString(), row.symbol, row.side, row.entry, row.exit, row.stake.toFixed(2), row.payout.toFixed(2), row.profit.toFixed(2), row.level].join(",")).join("\n");
    const blob = new Blob([head + "\n" + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "gap-engine-history.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="px-4 py-4 sm:px-5">
      {!connected ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded border border-accent/40 bg-accent/10 px-4 py-3 text-xs text-accent">
          <span>The gap engine trades the session you already have. Connect a Deriv token to arm it.</span>
          <button type="button" onClick={onConnect} className="rounded bg-accent px-3 py-1 font-medium text-ink">Connect</button>
        </div>
      ) : null}

      <div className="mx-auto max-w-4xl space-y-4">
        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-[220px]">
              <label htmlFor="gap-market" className="text-[10px] uppercase tracking-widest text-muted">Market</label>
              <select id="gap-market" value={symbol} onChange={(event) => setSymbol(event.target.value)} disabled={running || !connected} className="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5 text-xs">
                {symbols.length === 0 ? <option value="">Connect to load symbols</option> : null}
                {groups.map((family) => (
                  <optgroup key={family} label={FAMILY_TITLE[family] ?? family}>
                    {symbols.filter((item) => item.family === family).map((item) => (
                      <option key={item.symbol} value={item.symbol}>{item.symbol} - {item.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-widest text-muted">Live spot</p>
              <p className="font-mono text-2xl text-slate-100">{spot > 0 ? spot.toFixed(decimals) : "-"}</p>
              <p className="text-[10px] text-muted">{symbol || "no symbol"} - {buffer.length} ticks buffered</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-line bg-ink px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={"rounded-full border px-4 py-1.5 text-lg font-semibold " + signalTone}>{signalLabel}</span>
              <span className="text-xs text-muted">{spreadText}</span>
            </div>
            <span className="text-[11px] text-muted">
              {settings.mode === "momentum" ? "Momentum" : "Mean-reversion"} - min {settings.minGapPp} pp - {settings.duration} ticks
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <Ring label="Up" pct={stats.upPct} count={stats.up} total={stats.total} color="#34d399" />
            <Ring label="Flat" pct={stats.flatPct} count={stats.flat} total={stats.total} color="#fbbf24" />
            <Ring label="Down" pct={stats.downPct} count={stats.down} total={stats.total} color="#fb7185" />
          </div>
        </article>

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={running ? () => stopBot("Paused") : start} className={"rounded px-5 py-2 text-sm font-semibold " + (running ? "border border-danger/50 bg-danger/10 text-danger" : "bg-accent text-ink")}>
              {running ? "Pause" : "Start"}
            </button>
            <span role="status" className={"rounded-full border px-3 py-1 text-[11px] " + (running ? "border-accent/40 text-accent" : "border-line text-muted")}>{phase}</span>
            <span className="ml-auto text-[11px] text-muted">
              {accountId || "no account"} ({accountKind}) - {balance !== null ? balance.toFixed(2) : "-"} {currency}
            </span>
          </div>

          {openContract ? (
            <p className="mt-3 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] text-accent">
              Contract #{openContract.id} - {openContract.side === "CALL" ? "Rise" : "Fall"} - stake {openContract.stake.toFixed(2)} {currency} - live P/L {openContract.profit >= 0 ? "+" : ""}{openContract.profit.toFixed(2)} {currency}
            </p>
          ) : null}

          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted">Session P/L</dt>
              <dd className={"font-mono text-base " + (pnl > 0 ? "text-accent" : pnl < 0 ? "text-danger" : "text-slate-200")}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} {currency}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted">Next stake</dt>
              <dd className="font-mono text-base text-slate-200">{nextStakeView.toFixed(2)} {currency}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted">Martingale step</dt>
              <dd className="font-mono text-base text-slate-200">{stepView} / {settings.martMode === "off" ? "off" : settings.martLevels}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted">Trades</dt>
              <dd className="font-mono text-base text-slate-200">{history.length}</dd>
            </div>
          </dl>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setHistoryOpen(true)} className="rounded border border-line px-3 py-1 text-[11px] text-muted hover:text-slate-100">History ({history.length})</button>
            <button type="button" onClick={resetSession} className="rounded border border-line px-3 py-1 text-[11px] text-muted hover:text-slate-100">Reset</button>
            <span className="text-[10px] text-muted">Reset stops the bot, clears P/L, the ladder and the session history.</span>
          </div>
        </article>

        <details className="rounded border border-line bg-panel p-4">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-widest text-muted">Bot settings</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Lookback ticks">
              <input type="number" min={3} max={100} value={settings.lookback} onChange={(event) => setField("lookback", clamp(Number(event.target.value), 3, 100))} className={inputClass} />
            </Field>
            <Field label="Strategy mode">
              <div className="flex gap-1">
                <button type="button" onClick={() => setField("mode", "momentum")} className={"flex-1 rounded px-2 py-1.5 text-[11px] " + (settings.mode === "momentum" ? "bg-accent text-ink" : "border border-line text-muted")}>Momentum</button>
                <button type="button" onClick={() => setField("mode", "meanrev")} className={"flex-1 rounded px-2 py-1.5 text-[11px] " + (settings.mode === "meanrev" ? "bg-accent text-ink" : "border border-line text-muted")}>Mean-Reversion</button>
              </div>
            </Field>
            <Field label="Minimum gap - pp">
              <input type="number" min={0} max={100} step={0.5} value={settings.minGapPp} onChange={(event) => setField("minGapPp", clamp(Number(event.target.value), 0, 100))} className={inputClass} />
            </Field>
            <Field label={"Stake (" + currency + ")"}>
              <input type="number" min={0.35} step={0.01} value={settings.stake} onChange={(event) => setField("stake", Math.max(0.35, Number(event.target.value) || 0.35))} className={inputClass} />
            </Field>
            <Field label="Duration - ticks">
              <input type="number" min={1} max={10} value={settings.duration} onChange={(event) => setField("duration", clamp(Number(event.target.value), 1, 10))} className={inputClass} />
            </Field>
            <Field label="Trade delay - seconds">
              <input type="number" min={0} max={60} value={settings.delaySeconds} onChange={(event) => setField("delaySeconds", clamp(Number(event.target.value), 0, 60))} className={inputClass} />
            </Field>
            <Field label="Take profit">
              <input type="number" min={0} step={0.5} value={settings.takeProfit} onChange={(event) => setField("takeProfit", Math.max(0, Number(event.target.value) || 0))} className={inputClass} />
            </Field>
            <Field label="Stop loss">
              <input type="number" min={0} step={0.5} value={settings.stopLoss} onChange={(event) => setField("stopLoss", Math.max(0, Number(event.target.value) || 0))} className={inputClass} />
            </Field>
            <Field label="Martingale">
              <select value={settings.martMode} onChange={(event) => setField("martMode", event.target.value as MartMode)} className={inputClass}>
                {(Object.keys(MART_LABEL) as MartMode[]).map((mode) => (
                  <option key={mode} value={mode}>{MART_LABEL[mode]}</option>
                ))}
              </select>
            </Field>
            {settings.martMode === "custom" ? (
              <Field label="Custom multiplier">
                <input type="number" min={1.01} step={0.1} value={settings.customMultiplier} onChange={(event) => setField("customMultiplier", Math.max(1.01, Number(event.target.value) || 1.01))} className={inputClass} />
              </Field>
            ) : null}
            <Field label="Martingale levels">
              <input type="number" min={1} max={8} value={settings.martLevels} onChange={(event) => setField("martLevels", clamp(Number(event.target.value), 1, 8))} className={inputClass} />
            </Field>
          </div>
          <p className="mt-3 text-[10px] text-muted">
            Levels are the maximum consecutive step-ups after losses before the stake resets to base. A payout-adjusted step solves (cumulative loss + base x b) / b with b read from the live proposal, so a 1.95x Rise/Fall and a 1.09x thin contract ladder very differently.
          </p>
        </details>

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
            <span>Account</span>
            <select value={accountId} disabled={!connected || accounts.length <= 1 || running} onChange={(event) => onAccountChange(event.target.value)} className="rounded border border-line bg-ink px-2 py-1 text-xs">
              {accounts.length === 0 ? <option value="">Not connected</option> : null}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.id} ({account.kind})</option>
              ))}
            </select>
          </div>
          <p className="mt-2 text-[10px] text-muted">
            One socket, one session: the Gap Engine reuses the terminal connection, the OTP handshake and the balance stream, and stops itself if you switch account or disconnect.
          </p>
        </article>
      </div>

      {historyOpen ? (
        <Modal title="Gap engine session history" onClose={() => setHistoryOpen(false)}>
          <div className="mb-2 flex justify-end">
            <button type="button" onClick={downloadCsv} disabled={history.length === 0} className="rounded border border-line px-3 py-1 text-[11px] text-muted hover:text-slate-100 disabled:opacity-40">Download CSV</button>
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-muted">No trades in this session yet.</p>
          ) : (
            <table className="w-full text-left text-[11px]">
              <thead className="text-[10px] uppercase tracking-widest text-muted">
                <tr><th className="py-1 pr-2">Time</th><th className="py-1 pr-2">Symbol</th><th className="py-1 pr-2">Contract</th><th className="py-1 pr-2">Entry</th><th className="py-1 pr-2">Exit</th><th className="py-1 pr-2">Stake</th><th className="py-1 pr-2">Payout</th><th className="py-1 pr-2">P/L</th><th className="py-1">Level</th></tr>
              </thead>
              <tbody className="font-mono">
                {history.map((row) => (
                  <tr key={row.id} className="border-t border-line/60">
                    <td className="py-1 pr-2">{new Date(row.time).toLocaleTimeString()}</td>
                    <td className="py-1 pr-2">{row.symbol}</td>
                    <td className="py-1 pr-2">{row.side === "CALL" ? "Rise" : "Fall"}</td>
                    <td className="py-1 pr-2">{row.entry.toFixed(decimals)}</td>
                    <td className="py-1 pr-2">{row.exit > 0 ? row.exit.toFixed(decimals) : "-"}</td>
                    <td className="py-1 pr-2">{row.stake.toFixed(2)}</td>
                    <td className="py-1 pr-2">{row.payout.toFixed(2)}</td>
                    <td className={"py-1 pr-2 " + (row.profit > 0 ? "text-accent" : row.profit < 0 ? "text-danger" : "")}>{row.profit.toFixed(2)}</td>
                    <td className="py-1">{row.level}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      ) : null}

      {confirmOpen ? (
        <Modal title="Start auto-trading on a real account?" onClose={() => setConfirmOpen(false)}>
          <div className="space-y-3 text-xs">
            <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
              This session is live money ({accountId}). The bot will buy Rise/Fall contracts from the gap signal until take profit, stop loss, or you press Pause.
            </p>
            <dl className="grid grid-cols-2 gap-2 font-mono">
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Base stake</dt><dd>{settings.stake.toFixed(2)} {currency}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Martingale cap</dt><dd>{settings.martMode === "off" ? "off" : settings.martLevels + " levels"}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Stop loss</dt><dd>{settings.stopLoss.toFixed(2)} {currency}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Take profit</dt><dd>{settings.takeProfit.toFixed(2)} {currency}</dd></div>
            </dl>
            <label className="block text-[11px] text-muted">
              Type REAL to confirm
              <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} className={inputClass + " mt-1"} placeholder="REAL" spellCheck={false} />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="rounded border border-line px-3 py-1.5 text-xs text-muted">Cancel</button>
              <button
                type="button"
                disabled={confirmText.trim().toUpperCase() !== "REAL"}
                onClick={() => { setRealOk(true); setConfirmOpen(false); begin(); }}
                className="rounded bg-danger px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40"
              >
                Start on real money
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
