import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  DEFAULT_AUTO,
  DEFAULT_FILTERS,
  DEFAULT_MARTINGALE,
  EMPTY_BOOK,
  MIN_STAKE,
  previewSteps,
} from "@/autotrade";
import type { AutoState, AutoTrader, MartingaleBook, MartingaleConfig, TradeTypeFilters } from "@/autotrade";

interface Props {
  engine: AutoTrader;
  connected: boolean;
  accountKind: "demo" | "real" | "unknown";
  accountId: string;
  balance: number | null;
  currency: string;
  symbol: string;
}

const STATE_LABEL: Record<AutoState, string> = {
  OFF: "OFF",
  SCANNING: "SCANNING FOR SIGNAL",
  FETCHING: "FETCHING PROPOSAL",
  EXECUTING: "EXECUTING BUY",
  OPEN: "CONTRACT OPEN (LIVE P&L)",
  COOLDOWN: "COOLDOWN",
  HALTED: "HALTED",
};

const STATE_TONE: Record<AutoState, string> = {
  OFF: "border-line text-muted",
  SCANNING: "border-amber-400/40 text-amber-300",
  FETCHING: "border-sky-400/40 text-sky-300",
  EXECUTING: "border-violet-400/40 text-violet-300",
  OPEN: "border-accent/50 text-accent",
  COOLDOWN: "border-line text-slate-300",
  HALTED: "border-danger/60 text-danger",
};

const TYPES: Array<{ key: keyof TradeTypeFilters; label: string; hint: string }> = [
  { key: "riseFall", label: "Rise / Fall", hint: "CALL + PUT" },
  { key: "evenOdd", label: "Even / Odd", hint: "DIGITODD + DIGITEVEN" },
  { key: "overUnder", label: "Over / Under", hint: "barriers 2 and 7" },
  { key: "matchDiff", label: "Matches / Differs", hint: "DIGITMATCH + DIGITDIFF" },
];

const COOLDOWN_SECONDS = [0, 1, 2, 3, 4, 5];
const box = "w-full rounded border border-line bg-ink px-2 py-1 font-mono text-xs text-slate-100 focus:border-accent focus:outline-none";
const labelClass = "block text-[11px] font-medium tracking-wide text-muted";

function NumberBox(props: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
  suffix?: string;
}): ReactElement {
  return (
    <label className="block">
      <span className={labelClass}>{props.label}</span>
      <span className="mt-1 flex items-center gap-1">
        <input
          type="number"
          className={box}
          value={Number.isFinite(props.value) ? props.value : 0}
          min={props.min}
          max={props.max}
          step={props.step ?? 0.01}
          onChange={(event) => {
            const next = Number(event.target.value);
            props.onChange(Number.isFinite(next) ? next : 0);
          }}
        />
        {props.suffix ? <span className="text-[10px] text-muted">{props.suffix}</span> : null}
      </span>
    </label>
  );
}

export default function AutoTradePanel(props: Props): ReactElement {
  const { engine, connected, accountKind, accountId, balance, currency, symbol } = props;

  const [autoOn, setAutoOn] = useState(false);
  const [state, setState] = useState<AutoState>("OFF");
  const [note, setNote] = useState("Idle");
  const [halt, setHalt] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ id: number; text: string; tone: "info" | "good" | "bad" }>>([]);
  const [book, setBook] = useState<MartingaleBook>({ ...EMPTY_BOOK });
  const [dayProfit, setDayProfit] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [live, setLive] = useState<{ id: number; profit: number; status: string } | null>(null);
  const [payoutAssumption, setPayoutAssumption] = useState(engine.lastPayoutRatio);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const [filters, setFilters] = useState<TradeTypeFilters>({ ...DEFAULT_FILTERS });
  const [metric, setMetric] = useState<"ev" | "win">(DEFAULT_AUTO.metric);
  const [minEvPct, setMinEvPct] = useState(DEFAULT_AUTO.minEvPct);
  const [minWinPct, setMinWinPct] = useState(DEFAULT_AUTO.minWinPct);
  const [cooldownMode, setCooldownMode] = useState<"seconds" | "ticks">(DEFAULT_AUTO.cooldownMode);
  const [cooldownSeconds, setCooldownSeconds] = useState(DEFAULT_AUTO.cooldownSeconds);
  const [cooldownTicks, setCooldownTicks] = useState(DEFAULT_AUTO.cooldownTicks);
  const [dailyLossLimit, setDailyLossLimit] = useState(DEFAULT_AUTO.dailyLossLimit);
  const [dailyProfitTarget, setDailyProfitTarget] = useState(DEFAULT_AUTO.dailyProfitTarget);
  const [martOn, setMartOn] = useState(DEFAULT_MARTINGALE.enabled);
  const [martMode, setMartMode] = useState<MartingaleConfig["mode"]>(DEFAULT_MARTINGALE.mode);
  const [baseStake, setBaseStake] = useState(DEFAULT_MARTINGALE.baseStake);
  const [multiplier, setMultiplier] = useState(DEFAULT_MARTINGALE.multiplier);
  const [maxSteps, setMaxSteps] = useState(DEFAULT_MARTINGALE.maxSteps);

  const pushLog = useCallback((text: string, tone: "info" | "good" | "bad") => {
    setLog((previous) => [{ id: Date.now() + Math.random(), text, tone }, ...previous].slice(0, 8));
  }, []);

  useEffect(() => {
    engine.onState = (next, text) => {
      setState(next);
      setNote(text);
      if (next === "OFF") setLive(null);
    };
    engine.onBook = (nextBook, profit) => {
      setBook({ ...nextBook });
      setDayProfit(profit);
      setWins(engine.wins);
      setLosses(engine.losses);
      if (engine.lastPayoutRatio > 0) setPayoutAssumption(engine.lastPayoutRatio);
    };
    engine.onLog = (text, tone) => pushLog(text, tone);
    engine.onHalt = (reason) => {
      setAutoOn(false);
      setHalt(reason);
      engine.resetMartingale();
    };
    engine.onContract = (payload) => {
      const id = Number(payload?.contract_id);
      if (!id) return;
      setLive({ id, profit: Number(payload?.profit ?? 0), status: String(payload?.status ?? "open") });
    };
    return () => {
      engine.stop("Control panel closed");
      engine.onState = null;
      engine.onBook = null;
      engine.onLog = null;
      engine.onHalt = null;
      engine.onContract = null;
    };
  }, [engine, pushLog]);

  useEffect(() => {
    engine.configure(
      {
        filters,
        metric,
        minEvPct,
        minWinPct,
        cooldownMode,
        cooldownSeconds,
        cooldownTicks,
        dailyLossLimit,
        dailyProfitTarget,
      },
      { enabled: martOn, mode: martMode, baseStake, multiplier, maxSteps },
    );
  }, [engine, filters, metric, minEvPct, minWinPct, cooldownMode, cooldownSeconds, cooldownTicks, dailyLossLimit, dailyProfitTarget, martOn, martMode, baseStake, multiplier, maxSteps]);

  useEffect(() => {
    if (!connected && autoOn) {
      engine.stop("Connection to Deriv closed");
      setAutoOn(false);
    }
  }, [connected, autoOn, engine]);

  const accountRef = useRef(accountId);
  useEffect(() => {
    if (accountRef.current === accountId) return;
    accountRef.current = accountId;
    if (autoOn) {
      engine.stop("Account changed; auto-trade stopped.");
      setAutoOn(false);
      setHalt("The trading account changed while auto-trade was armed. Re-arm it deliberately.");
    }
  }, [accountId, autoOn, engine]);

  const arm = useCallback(() => {
    setHalt(null);
    setConfirmOpen(false);
    engine.resetMartingale();
    engine.start();
    setAutoOn(true);
  }, [engine]);

  const toggleAuto = useCallback(() => {
    if (autoOn) {
      engine.stop("Auto-trade switched off by user");
      setAutoOn(false);
      return;
    }
    if (!connected) {
      setHalt("Connect to Deriv before arming auto-trade.");
      return;
    }
    if (engine.locked) {
      setHalt("A contract from the previous run is still open. Wait for it to settle before re-arming.");
      return;
    }
    if (accountKind === "real") {
      setConfirmText("");
      setConfirmOpen(true);
      return;
    }
    arm();
  }, [accountKind, arm, autoOn, connected, engine]);

  const winAssumption = metric === "win" ? Math.min(0.95, Math.max(0.05, minWinPct / 100)) : 0.5;
  const preview = useMemo(
    () =>
      previewSteps({
        martingale: { enabled: martOn, mode: martMode, baseStake, multiplier, maxSteps },
        payoutRatio: payoutAssumption > 1.02 ? payoutAssumption : 1.95,
        winProbability: winAssumption,
      }),
    [baseStake, martOn, martMode, maxSteps, multiplier, payoutAssumption, winAssumption],
  );

  const net = book.netProfit;
  const enabledCount = TYPES.filter((type) => filters[type.key]).length;

  return (
    <section id="auto-trade" className="border-t border-line bg-panel px-4 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-slate-100">Auto-Trade Control Panel</h2>
          <p className="text-[11px] text-muted">
            One contract at a time · settles before the next scan · {symbol || "no symbol"} · {accountKind === "unknown" ? "not connected" : accountKind + " account"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={"rounded-full border px-3 py-1 text-[11px] font-semibold tracking-wide " + STATE_TONE[state]} role="status" aria-live="polite">
            {STATE_LABEL[state]}
          </span>
          {engine.locked ? (
            <span className="rounded-full border border-accent/40 px-2 py-1 text-[10px] text-accent">LOCKED #{engine.activeContractId}</span>
          ) : null}
          <button
            type="button"
            onClick={toggleAuto}
            aria-pressed={autoOn}
            className={"rounded border px-4 py-2 text-xs font-semibold tracking-wide " + (autoOn ? "border-accent bg-accent text-ink" : "border-danger/60 bg-ink text-danger hover:border-danger")}
          >
            AUTO-TRADE {autoOn ? "ON" : "OFF"}
          </button>
        </div>
      </div>

      {halt ? (
        <p role="alert" className="mt-3 rounded border border-danger/50 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {halt}
        </p>
      ) : null}
      {!halt && !connected ? (
        <p className="mt-3 rounded border border-line bg-ink px-3 py-2 text-[11px] text-muted">
          Auto-trade is inactive until a Deriv session is connected. It is never restored as ON after a reload.
        </p>
      ) : null}

      <div className="mt-4 grid gap-5 lg:grid-cols-3">
        <div className="space-y-3">
          <h3 className="text-[11px] font-semibold tracking-wide text-slate-200">SCOPE &amp; SIGNAL FILTER</h3>
          <div className="grid grid-cols-2 gap-2">
            {TYPES.map((type) => (
              <label key={type.key} className="flex items-start gap-2 rounded border border-line bg-ink px-2 py-1.5 text-[11px] text-slate-200">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[#4ade80]"
                  checked={filters[type.key]}
                  onChange={(event) => setFilters({ ...filters, [type.key]: event.target.checked })}
                />
                <span>
                  {type.label}
                  <span className="block text-[10px] text-muted">{type.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {enabledCount === 0 ? <p className="text-[10px] text-danger">No trade types enabled — the engine will only scan.</p> : null}

          <div className="flex items-center gap-3 text-[11px] text-slate-200">
            <span className={labelClass}>Gate</span>
            <label className="flex items-center gap-1">
              <input type="radio" name="gate" checked={metric === "ev"} onChange={() => setMetric("ev")} className="accent-[#4ade80]" /> Min EV
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="gate" checked={metric === "win"} onChange={() => setMetric("win")} className="accent-[#4ade80]" /> Min Win
            </label>
          </div>
          {metric === "ev" ? (
            <label className="block">
              <span className={labelClass}>Minimum expected value: <span className="font-mono text-accent">{minEvPct.toFixed(1)}%</span> per stake</span>
              <input type="range" min={0} max={20} step={0.5} value={minEvPct} onChange={(event) => setMinEvPct(Number(event.target.value))} className="mt-1 w-full accent-[#4ade80]" aria-label="Minimum expected value percent" />
            </label>
          ) : (
            <label className="block">
              <span className={labelClass}>Minimum model win probability: <span className="font-mono text-accent">{minWinPct.toFixed(0)}%</span></span>
              <input type="range" min={30} max={90} step={1} value={minWinPct} onChange={(event) => setMinWinPct(Number(event.target.value))} className="mt-1 w-full accent-[#4ade80]" aria-label="Minimum model win probability" />
            </label>
          )}

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className={labelClass}>Cooldown</span>
              <select className={box} value={cooldownMode} onChange={(event) => setCooldownMode(event.target.value === "ticks" ? "ticks" : "seconds")}>
                <option value="seconds">Seconds</option>
                <option value="ticks">Ticks</option>
              </select>
            </label>
            {cooldownMode === "seconds" ? (
              <label className="block">
                <span className={labelClass}>Wait</span>
                <select className={box} value={cooldownSeconds} onChange={(event) => setCooldownSeconds(Number(event.target.value))}>
                  {COOLDOWN_SECONDS.map((seconds) => (
                    <option key={seconds} value={seconds}>{seconds}s</option>
                  ))}
                </select>
              </label>
            ) : (
              <NumberBox label="Wait" value={cooldownTicks} min={1} max={5} step={1} suffix="ticks" onChange={setCooldownTicks} />
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold tracking-wide text-slate-200">EXECUTION &amp; RISK</h3>
            <button
              type="button"
              aria-pressed={martOn}
              onClick={() => setMartOn(!martOn)}
              className={"rounded border px-3 py-1 text-[11px] font-semibold " + (martOn ? "border-accent bg-accent text-ink" : "border-line text-muted hover:text-slate-100")}
            >
              MARTINGALE {martOn ? "ON" : "OFF"}
            </button>
          </div>

          <p className="text-[10px] text-muted">
            Off: every trade uses the flat base stake. Fractional Kelly sizing is not implemented.
          </p>
          <div className="flex items-center gap-3 text-[11px] text-slate-200">
            <label className="flex items-center gap-1">
              <input type="radio" name="martmode" checked={martMode === "payout"} onChange={() => setMartMode("payout")} className="accent-[#4ade80]" /> Payout-adjusted
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="martmode" checked={martMode === "multiplier"} onChange={() => setMartMode("multiplier")} className="accent-[#4ade80]" /> Fixed multiplier
            </label>
          </div>
          <p className="text-[10px] text-muted">
            {martMode === "payout"
              ? "Next stake = (cumulative loss + base stake × b) ÷ b, where b is the net payout ratio this contract is paying right now."
              : "Next stake = base stake × multiplier ^ step, regardless of payout."}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <NumberBox label="Base stake (S0)" value={baseStake} min={MIN_STAKE} step={0.05} suffix={currency} onChange={setBaseStake} />
            {martMode === "multiplier" ? (
              <NumberBox label="Multiplier" value={multiplier} min={1.1} max={4} step={0.1} suffix="x" onChange={setMultiplier} />
            ) : (
              <NumberBox label="Payout ratio" value={payoutAssumption} min={1.03} step={0.01} suffix="x" onChange={setPayoutAssumption} />
            )}
          </div>

          <label className="block">
            <span className={labelClass}>Max martingale step: <span className="font-mono text-accent">{maxSteps}</span> (resets at the cap)</span>
            <input type="range" min={1} max={6} step={1} value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} className="mt-1 w-full accent-[#4ade80]" aria-label="Maximum martingale step" />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <NumberBox label="Daily loss limit" value={dailyLossLimit} min={0} step={1} suffix={currency} onChange={setDailyLossLimit} />
            <NumberBox label="Daily profit target" value={dailyProfitTarget} min={0} step={1} suffix={currency} onChange={setDailyProfitTarget} />
          </div>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-line bg-ink px-3 py-2 text-[11px]">
            <dt className="text-muted">Session net</dt>
            <dd className={"text-right font-mono " + (net > 0 ? "text-accent" : net < 0 ? "text-danger" : "text-slate-200")}>{net.toFixed(2)} {currency}</dd>
            <dt className="text-muted">Today</dt>
            <dd className={"text-right font-mono " + (dayProfit > 0 ? "text-accent" : dayProfit < 0 ? "text-danger" : "text-slate-200")}>{dayProfit.toFixed(2)} {currency}</dd>
            <dt className="text-muted">W / L</dt>
            <dd className="text-right font-mono">{wins} / {losses}</dd>
            <dt className="text-muted">Ladder step</dt>
            <dd className="text-right font-mono">{book.step} · loss {book.cumulativeLoss.toFixed(2)}</dd>
            <dt className="text-muted">Balance</dt>
            <dd className="text-right font-mono">{balance === null ? "—" : balance.toFixed(2) + " " + currency}</dd>
          </dl>
          <button type="button" onClick={() => engine.resetMartingale()} className="rounded border border-line px-2 py-1 text-[10px] text-muted hover:text-slate-100">
            Reset ladder to base
          </button>
        </div>

        <div className="space-y-3">
          <h3 className="text-[11px] font-semibold tracking-wide text-slate-200">STATUS MONITOR</h3>
          <p className="rounded border border-line bg-ink px-3 py-2 text-[11px] text-slate-200">{note}</p>
          {live ? (
            <p className={"rounded border px-3 py-2 text-[11px] " + (live.profit >= 0 ? "border-accent/30 text-accent" : "border-danger/30 text-danger")}>
              Contract #{live.id} · {live.status} · live P&amp;L <span className="font-mono">{live.profit >= 0 ? "+" : ""}{live.profit.toFixed(2)} {currency}</span>
            </p>
          ) : null}
          <ul className="space-y-1 text-[10px] leading-snug">
            {log.length === 0 ? <li className="text-muted">No auto-trade activity yet.</li> : null}
            {log.map((entry) => (
              <li key={entry.id} className={entry.tone === "good" ? "text-accent" : entry.tone === "bad" ? "text-danger" : "text-muted"}>
                {entry.text}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-muted">
            Stop-loss and take-profit are checked after every settlement and turn auto-trade off by themselves.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <h3 className="text-[11px] font-semibold tracking-wide text-slate-200">PROGRESSION PREVIEW — {martOn ? "LIVE SETTINGS" : "REFERENCE ONLY (MARTINGALE OFF)"}</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] tracking-wide text-muted">
                <th className="py-1 pr-3 font-medium">STEP</th>
                <th className="py-1 pr-3 font-medium">STAKE</th>
                <th className="py-1 pr-3 font-medium">CUMULATIVE CAPITAL AT RISK</th>
                <th className="py-1 font-medium">STREAK PROBABILITY</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((row) => (
                <tr key={row.step} className={"border-b border-line/60 " + (row.step === book.step && martOn ? "text-accent" : "text-slate-200")}>
                  <td className="py-1 pr-3 font-mono">{row.step}</td>
                  <td className="py-1 pr-3 font-mono">{row.stake.toFixed(2)} {currency}</td>
                  <td className="py-1 pr-3 font-mono">{row.cumulativeRisk.toFixed(2)} {currency}</td>
                  <td className="py-1 font-mono">{(row.streakProbability * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[10px] text-muted">
          Streak probability assumes the gate's win rate ({Math.round(winAssumption * 100)}%) and a payout ratio of {payoutAssumption.toFixed(2)}x. The real payout is re-read from Deriv before every buy; the ladder is the price of surviving a losing run, not a guarantee of recovery.
        </p>
      </div>

      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="real-confirm-title">
          <div className="w-full max-w-md rounded-lg border border-danger/50 bg-panel p-5">
            <h3 id="real-confirm-title" className="text-sm font-semibold text-danger">Real account: auto-trade places real orders</h3>
            <p className="mt-2 text-[11px] text-slate-300">
              This account is a <strong>real-money</strong> account. Once armed, every qualifying signal is bought automatically without a confirmation prompt, and martingale can raise the stake up to {maxSteps} steps.
            </p>
            <p className="mt-2 text-[11px] text-muted">
              Balance: {balance === null ? "unknown" : balance.toFixed(2) + " " + currency} · base stake {baseStake.toFixed(2)} {currency} · step cap {maxSteps}
            </p>
            <label className="mt-4 block text-[11px] text-slate-200">
              Type <span className="font-mono text-danger">REAL</span> to confirm
              <input className={box + " mt-1"} value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoFocus />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:text-slate-100">
                Cancel
              </button>
              <button
                type="button"
                disabled={confirmText.trim().toUpperCase() !== "REAL"}
                onClick={arm}
                className="rounded border border-danger bg-danger px-3 py-1.5 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                Start on real account
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
