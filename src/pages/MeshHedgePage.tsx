import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Account, DerivSession, Quote, SymbolInfo, Tick } from "@/deriv";
import TransitionMeshCircle from "@/components/TransitionMeshCircle";
import {
  MIN_STAKE,
  bundleTotal,
  combinedProbability,
  decimalsFromPip,
  dominanceShare,
  evaluateMesh,
  round2,
  splitStakes,
  topDigits,
} from "@/utils/transitionMeshMath";
import type { ConsensusKind, RankedDigit } from "@/utils/transitionMeshMath";

type Gate = "any" | "strong" | "triple";

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

interface Leg {
  id: number;
  digit: number;
  stake: number;
  profit: number;
  probability: number;
}

interface RoundRow {
  id: number;
  time: number;
  symbol: string;
  digits: number[];
  stakes: number[];
  total: number;
  profit: number;
  probability: number;
}

const FAMILY_TITLE: Record<string, string> = {
  continuous: "Continuous Indices",
  step: "Step Indices",
  jump: "Jump Indices",
};

const DEFAULT_LOOKBACKS: [number, number, number] = [100, 150, 200];
const ESTIMATED_PAYOUT = 8.93;
const SETTLEMENT_TIMEOUT_MS = 30000;
/** 3 proposals + 3 buys + 3 watches + 3 forgets per round, inside 360/min. */
const MIN_ROUND_GAP_SEC = 3;

const inputClass =
  "w-full rounded border border-line bg-ink px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent disabled:opacity-50";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function gateAllows(kind: ConsensusKind, gate: Gate): boolean {
  if (gate === "any") return true;
  if (gate === "strong") return kind === "triple" || kind === "strong";
  return kind === "triple";
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="text-[11px] text-muted">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded border border-line bg-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-slate-100">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function MeshHedgePage(props: Props): ReactElement {
  const { sessionRef, connected, symbols, accounts, accountId, accountKind, balance, currency, onConnect, onAccountChange, onNotice, bindContractListener } = props;

  const [symbol, setSymbol] = useState("");
  const [quotes, setQuotes] = useState<number[]>([]);
  const [lookbacks, setLookbacks] = useState<[number, number, number]>(DEFAULT_LOOKBACKS);
  const [armed, setArmed] = useState(false);
  const [phase, setPhase] = useState("Paused");
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [baseStake, setBaseStake] = useState(MIN_STAKE);
  const [weighted, setWeighted] = useState(false);
  const [gate, setGate] = useState<Gate>("any");
  const [cooldownSec, setCooldownSec] = useState(3);
  const [pnl, setPnl] = useState(0);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [payoutRatio, setPayoutRatio] = useState(ESTIMATED_PAYOUT);
  const [openLegs, setOpenLegs] = useState<Leg[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [realOk, setRealOk] = useState(false);

  const aliveRef = useRef(true);
  const armedRef = useRef(false);
  const execRef = useRef(false);
  const coolingRef = useRef(false);
  const finalizingRef = useRef(false);
  const quotesRef = useRef<number[]>([]);
  const symbolRef = useRef("");
  const currencyRef = useRef(currency);
  const decimalsRef = useRef(2);
  const stepFilterRef = useRef(false);
  const lookbacksRef = useRef<[number, number, number]>(DEFAULT_LOOKBACKS);
  const baseRef = useRef(MIN_STAKE);
  const weightedRef = useRef(false);
  const gateRef = useRef<Gate>("any");
  const cooldownRef = useRef(3);
  const pnlRef = useRef(0);
  const roundNoRef = useRef(0);
  const legsRef = useRef<Map<number, Leg>>(new Map());
  const activeBundleIdsRef = useRef<Set<number>>(new Set());
  const roundLegsRef = useRef<Leg[]>([]);
  const roundProbabilityRef = useRef(0);
  const bundleTotalRef = useRef(0);
  const settleProfitRef = useRef(0);
  const subsRef = useRef<string[]>([]);
  const settlementTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => { symbolRef.current = symbol; }, [symbol]);
  useEffect(() => { currencyRef.current = currency; }, [currency]);
  useEffect(() => { baseRef.current = baseStake; }, [baseStake]);
  useEffect(() => { weightedRef.current = weighted; }, [weighted]);
  useEffect(() => { gateRef.current = gate; }, [gate]);
  useEffect(() => { cooldownRef.current = cooldownSec; }, [cooldownSec]);
  useEffect(() => { setRealOk(false); }, [accountId]);

  useEffect(() => {
    if (symbol || symbols.length === 0) return;
    const preferred = symbols.find((item) => item.symbol === "R_100") ?? symbols[0];
    setSymbol(preferred.symbol);
  }, [symbol, symbols]);

  const symbolInfo = useMemo(() => symbols.find((item) => item.symbol === symbol) ?? null, [symbol, symbols]);
  const decimals = useMemo(() => decimalsFromPip(symbolInfo?.pip ?? 0.01), [symbolInfo]);
  const stepFilter = symbolInfo?.family === "step";

  useEffect(() => { decimalsRef.current = decimals; }, [decimals]);
  useEffect(() => { stepFilterRef.current = stepFilter; }, [stepFilter]);

  const rememberLookback = useCallback((index: number, value: number) => {
    setLookbacks((current) => {
      const next: [number, number, number] = [current[0], current[1], current[2]];
      next[index] = clamp(value, 20, 300);
      lookbacksRef.current = next;
      return next;
    });
  }, []);

  const forgetSubscriptions = useCallback(() => {
    const session = sessionRef.current;
    if (session) {
      for (const subscription of subsRef.current) void session.forget(subscription);
    }
    subsRef.current = [];
  }, [sessionRef]);

  const stopEngine = useCallback((reason: string) => {
    armedRef.current = false;
    coolingRef.current = false;
    setArmed(false);
    setPhase(reason);
  }, []);

  const finalizeRound = useCallback(async () => {
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    if (settlementTimerRef.current !== undefined) {
      window.clearTimeout(settlementTimerRef.current);
      settlementTimerRef.current = undefined;
    }
    const profit = round2(settleProfitRef.current);
    const legs = roundLegsRef.current;
    const total = bundleTotalRef.current;
    const nextPnl = round2(pnlRef.current + profit);
    pnlRef.current = nextPnl;
    roundNoRef.current += 1;
    const row: RoundRow = {
      id: roundNoRef.current,
      time: Date.now(),
      symbol: symbolRef.current,
      digits: legs.map((leg) => leg.digit),
      stakes: legs.map((leg) => leg.stake),
      total,
      profit,
      probability: roundProbabilityRef.current,
    };
    if (aliveRef.current) {
      setPnl(nextPnl);
      setWins((value) => value + (profit > 0 ? 1 : 0));
      setLosses((value) => value + (profit < 0 ? 1 : 0));
      setRounds((rows) => [row, ...rows].slice(0, 100));
      setOpenLegs(null);
    }
    forgetSubscriptions();
    activeBundleIdsRef.current.clear();
    legsRef.current.clear();
    roundLegsRef.current = [];
    settleProfitRef.current = 0;
    const wait = Math.max(cooldownRef.current, MIN_ROUND_GAP_SEC);
    if (wait > 0 && armedRef.current && aliveRef.current) {
      coolingRef.current = true;
      for (let left = wait; left > 0 && armedRef.current && aliveRef.current; left -= 1) {
        setPhase("Cooldown (" + left + "s)");
        setCooldownLeft(left);
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      coolingRef.current = false;
      setCooldownLeft(0);
    }
    finalizingRef.current = false;
    execRef.current = false;
    if (aliveRef.current) setPhase(armedRef.current ? "Scanning ticks..." : "Paused");
  }, [forgetSubscriptions]);

  const handleContract = useCallback((payload: any) => {
    const id = Number(payload?.contract_id);
    if (!Number.isFinite(id)) return;
    const leg = legsRef.current.get(id);
    if (!leg) return;
    const profit = Number(payload?.profit);
    if (Number.isFinite(profit)) leg.profit = profit;
    if (Number(payload?.is_sold) !== 1) {
      setOpenLegs(Array.from(legsRef.current.values()));
      return;
    }
    legsRef.current.delete(id);
    activeBundleIdsRef.current.delete(id);
    settleProfitRef.current = round2(settleProfitRef.current + leg.profit);
    setOpenLegs(legsRef.current.size > 0 ? Array.from(legsRef.current.values()) : null);
    if (activeBundleIdsRef.current.size === 0) void finalizeRound();
  }, [finalizeRound]);

  useEffect(() => {
    bindContractListener(handleContract);
    return () => bindContractListener(null);
  }, [bindContractListener, handleContract]);

  const executeBundle = useCallback(async (top: RankedDigit[], stakes: [number, number, number]) => {
    const session = sessionRef.current;
    if (!session) {
      execRef.current = false;
      return;
    }
    const market = symbolRef.current;
    const cash = currencyRef.current;
    settleProfitRef.current = 0;
    roundLegsRef.current = [];
    roundProbabilityRef.current = combinedProbability(top);
    setPhase("Pricing 3 legs...");
    let priced: Quote[] = [];
    try {
      priced = await session.quoteBundle(
        top.map((entry, index) => ({
          symbol: market,
          contract: "DIGITMATCH",
          barrier: String(entry.digit),
          duration: 1,
          stake: stakes[index],
          currency: cash,
        })),
      );
    } catch (error) {
      execRef.current = false;
      if (aliveRef.current) {
        stopEngine("Paused: pricing failed");
        onNotice((error as Error).message + " The hedge paused instead of retrying into the limit.", "bad");
      }
      return;
    }
    const ratio = priced[0] && priced[0].ask > 0 ? priced[0].payout / priced[0].ask : 0;
    if (Number.isFinite(ratio) && ratio > 1) setPayoutRatio(ratio);
    if (!aliveRef.current) {
      execRef.current = false;
      return;
    }
    if (!armedRef.current) {
      execRef.current = false;
      setPhase("Paused");
      return;
    }
    setPhase("Locking 3 contracts...");
    const results = await Promise.allSettled(priced.map((quote) => session.buy(quote.id, quote.ask)));
    const legs: Leg[] = [];
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        legs.push({ id: result.value, digit: top[index].digit, stake: priced[index].ask, profit: 0, probability: top[index].transition });
      } else {
        failures.push((result.reason as Error)?.message ?? "Buy rejected");
      }
    });
    if (!aliveRef.current) {
      execRef.current = false;
      return;
    }
    if (legs.length === 0) {
      execRef.current = false;
      setPhase("Paused: no contracts bought");
      onNotice(failures[0] ?? "Deriv rejected all three legs.", "bad");
      return;
    }
    for (const leg of legs) {
      activeBundleIdsRef.current.add(leg.id);
      legsRef.current.set(leg.id, leg);
    }
    roundLegsRef.current = legs;
    bundleTotalRef.current = bundleTotal(legs.map((leg) => leg.stake));
    setOpenLegs(legs.slice());
    setPhase("Open: " + legs.length + " / 3 legs");
    if (failures.length > 0) onNotice(failures.length + " leg(s) rejected: " + failures[0], "bad");
    try {
      for (const leg of legs) {
        const subscription = await session.watch(leg.id);
        if (subscription) {
          if (legsRef.current.has(leg.id)) subsRef.current.push(subscription);
          else void session.forget(subscription);
        }
      }
    } catch (error) {
      onNotice("Could not follow settlement: " + (error as Error).message, "bad");
    }
    if (activeBundleIdsRef.current.size > 0) {
      if (settlementTimerRef.current !== undefined) window.clearTimeout(settlementTimerRef.current);
      settlementTimerRef.current = window.setTimeout(() => {
        if (activeBundleIdsRef.current.size === 0) return;
        stopEngine("Stopped: settlement timeout");
        onNotice("Deriv did not confirm all legs within 30 s. The bot stopped; verify the open contracts in Deriv.", "bad");
        forgetSubscriptions();
        activeBundleIdsRef.current.clear();
        legsRef.current.clear();
        setOpenLegs(null);
        execRef.current = false;
      }, SETTLEMENT_TIMEOUT_MS);
    }
  }, [forgetSubscriptions, onNotice, sessionRef, stopEngine]);

  const maybeTrade = useCallback(async () => {
    if (!armedRef.current || execRef.current || coolingRef.current || finalizingRef.current) return;
    if (!sessionRef.current) return;
    const evaluation = evaluateMesh(quotesRef.current, decimalsRef.current, lookbacksRef.current, stepFilterRef.current);
    const required = Math.max(...lookbacksRef.current);
    if (evaluation.digits.length < required) return;
    const top = topDigits(evaluation.ranked, 3);
    if (top.length < 3) {
      setPhase("Waiting for 3 reachable digits");
      return;
    }
    if (!gateAllows(evaluation.consensus.kind, gateRef.current)) {
      setPhase("Scanning: alignment gate not met");
      return;
    }
    execRef.current = true;
    await executeBundle(top, splitStakes(baseRef.current, weightedRef.current));
  }, [executeBundle, sessionRef]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!connected || !symbol || !session) return;
    quotesRef.current = [];
    setQuotes([]);
    let cancelled = false;
    let subscriptionId = "";
    session.onTickFor = (market, tick: Tick) => {
      if (cancelled || market !== symbolRef.current) return;
      const next = [...quotesRef.current, tick.quote].slice(-300);
      quotesRef.current = next;
      setQuotes(next);
      void maybeTrade();
    };
    session.subscribeTicksFor(symbol)
      .then((id) => {
        if (cancelled) void session.forget(id);
        else subscriptionId = id;
      })
      .catch((error: Error) => {
        if (aliveRef.current) onNotice(error.message, "bad");
      });
    session.history(symbol, 300)
      .then((list) => {
        if (cancelled) return;
        const next = list.map((item) => item.quote).slice(-300);
        quotesRef.current = next;
        setQuotes(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      session.onTickFor = null;
      void session.forget(subscriptionId);
    };
  }, [connected, maybeTrade, onNotice, sessionRef, symbol]);

  const armEngine = useCallback(() => {
    armedRef.current = true;
    setArmed(true);
    setPhase("Scanning ticks...");
    void maybeTrade();
  }, [maybeTrade]);

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
    armEngine();
  }, [accountKind, armEngine, connected, onConnect, realOk]);

  const resetSession = useCallback(() => {
    if (activeBundleIdsRef.current.size > 0) return;
    stopEngine("Paused");
    pnlRef.current = 0;
    roundNoRef.current = 0;
    settleProfitRef.current = 0;
    setPnl(0);
    setRounds([]);
    setWins(0);
    setLosses(0);
    setOpenLegs(null);
  }, [stopEngine]);

  useEffect(() => {
    if (!connected && armedRef.current) stopEngine("Paused: connection closed");
  }, [connected, stopEngine]);

  const accountRef = useRef(accountId);
  useEffect(() => {
    if (accountRef.current === accountId) return;
    accountRef.current = accountId;
    if (armedRef.current) stopEngine("Paused after account change");
  }, [accountId, stopEngine]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      armedRef.current = false;
      if (settlementTimerRef.current !== undefined) window.clearTimeout(settlementTimerRef.current);
      const session = sessionRef.current;
      if (session) {
        for (const subscription of subsRef.current) void session.forget(subscription);
        session.onTickFor = null;
      }
      subsRef.current = [];
    };
  }, [sessionRef]);

  const evaluation = useMemo(
    () => evaluateMesh(quotes, decimals, lookbacks, stepFilter),
    [quotes, decimals, lookbacks, stepFilter],
  );
  const top = topDigits(evaluation.ranked, 3);
  const combined = combinedProbability(top);
  const dominance = dominanceShare(combined);
  const stakes = splitStakes(baseStake, weighted);
  const bundle = bundleTotal(stakes);
  const minStake = Math.min(...stakes);
  const netIfHit = round2(payoutRatio * minStake - bundle);
  const required = Math.max(...lookbacks);
  const ready = evaluation.digits.length >= required;
  const center = evaluation.center;
  const consensus = evaluation.consensus;

  const consensusTone =
    consensus.kind === "triple"
      ? "border-accent/50 bg-accent/10 text-accent"
      : consensus.kind === "strong"
        ? "border-sky-400/40 bg-sky-400/10 text-sky-300"
        : "border-amber-400/40 bg-amber-400/10 text-amber-300";
  const consensusText =
    consensus.kind === "triple"
      ? "Triple alignment: all three windows rank " + (consensus.digit ?? "-") + " as the #1 digit."
      : consensus.kind === "strong"
        ? "Strong consensus: digit " + (consensus.digit ?? "-") + " leads two windows and is runner-up in the third."
        : "Divergent windows: fewer than two green digits align, treat the hedge with caution.";

  const groups = ["continuous", "step", "jump"].filter((family) => symbols.some((item) => item.family === family));
  const openProfit = openLegs ? round2(openLegs.reduce((sum, leg) => sum + leg.profit, 0)) : 0;

  return (
    <section className="px-4 py-4 sm:px-5">
      {!connected ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded border border-accent/40 bg-accent/10 px-4 py-3 text-xs text-accent">
          <span>The mesh trader reuses the terminal session. Connect a Deriv token to arm it.</span>
          <button type="button" onClick={onConnect} className="rounded bg-accent px-3 py-1 font-medium text-ink">Connect</button>
        </div>
      ) : null}

      <div className="mx-auto max-w-6xl space-y-4">
        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-[230px]">
              <label htmlFor="mesh-market" className="text-[10px] uppercase tracking-widest text-muted">Market</label>
              <select
                id="mesh-market"
                value={symbol}
                disabled={armed || !connected}
                onChange={(event) => setSymbol(event.target.value)}
                className="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5 text-xs disabled:opacity-50"
              >
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
              <p className="text-[10px] uppercase tracking-widest text-muted">Live spot / last digit</p>
              <p className="font-mono text-2xl text-slate-100">
                {quotes.length > 0 ? quotes[quotes.length - 1].toFixed(decimals) : "-"}
                <span className="ml-2 rounded border border-line px-2 py-0.5 text-base text-accent">{center >= 0 ? center : "-"}</span>
              </p>
              <p className="text-[10px] text-muted">{symbol || "no symbol"} - {quotes.length} / 300 ticks</p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <label className="text-muted">Account</label>
            <select
              value={accountId}
              disabled={!connected || accounts.length <= 1 || armed}
              onChange={(event) => onAccountChange(event.target.value)}
              className="rounded border border-line bg-ink px-2 py-1 text-xs disabled:opacity-50"
            >
              {accounts.length === 0 ? <option value="">Not connected</option> : null}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.id} ({account.kind})</option>
              ))}
            </select>
            <span className="text-muted">{balance !== null ? balance.toFixed(2) : "-"} {currency}</span>
            <span className="ml-auto text-muted">
              {ready ? "Buffer ready for all three windows" : "Filling buffer " + evaluation.digits.length + " / " + required}
            </span>
          </div>
          {stepFilter ? (
            <p className="mt-2 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-300">
              Step indices rarely quote DIGITMATCH. If Deriv rejects all three legs the round stops flat and no position is opened.
            </p>
          ) : null}
        </article>

        <div className={"rounded border px-4 py-3 text-xs " + consensusTone}>
          <span className="font-semibold uppercase tracking-widest">Consensus</span>
          <span className="ml-3">
            {ready
              ? consensusText
              : "Collecting ticks: " + evaluation.digits.length + " of " + required + " needed before the three windows can agree."}
          </span>
          {ready ? (
            <span className="ml-3 font-mono text-[10px] opacity-80">w{lookbacks[0]} #{evaluation.meshes[0].hottest} / w{lookbacks[1]} #{evaluation.meshes[1].hottest} / w{lookbacks[2]} #{evaluation.meshes[2].hottest}</span>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {evaluation.meshes.map((mesh, index) => (
            <TransitionMeshCircle
              key={index}
              label={"Mesh " + (index + 1) + " - " + mesh.lookback + " ticks"}
              mesh={mesh}
              center={center}
              disabled={armed}
              onLookbackChange={(value) => rememberLookback(index, value)}
            />
          ))}
        </div>

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Top 3 hedged DIGITMATCH digits</h2>
              <p className="text-[11px] text-muted">Score = 0.60 x normalised window frequency + 0.40 x P(next | centre digit){stepFilter ? ", zeroed when the step index cannot reach the digit" : ""}.</p>
            </div>
            <span className="rounded-full border border-line px-3 py-1 text-[11px] text-muted">{gate === "any" ? "No alignment gate" : gate === "strong" ? "Needs strong or triple" : "Needs triple alignment"}</span>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_290px]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-widest text-muted">
                  <tr><th className="py-1 pr-2">#</th><th className="py-1 pr-2">Digit</th><th className="py-1 pr-2">P(next)</th><th className="py-1 pr-2">Score</th><th className="py-1 pr-2">Stake</th></tr>
                </thead>
                <tbody className="font-mono">
                  {top.length === 0 ? (
                    <tr><td colSpan={5} className="py-2 text-muted">Warming up: no ranked digit yet.</td></tr>
                  ) : (
                    top.map((entry, index) => (
                      <tr key={entry.digit} className="border-t border-line/60">
                        <td className="py-1 pr-2 text-muted">{index + 1}</td>
                        <td className="py-1 pr-2 text-base text-slate-100">{entry.digit}</td>
                        <td className="py-1 pr-2">{(entry.transition * 100).toFixed(1)}%</td>
                        <td className="py-1 pr-2">{(entry.score * 100).toFixed(1)}</td>
                        <td className="py-1 pr-2">{stakes[index].toFixed(2)} {currency}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <dl className="grid grid-cols-2 gap-2 rounded border border-line bg-ink p-3 text-[11px]">
              <div>
                <dt className="text-[10px] uppercase tracking-widest text-muted">Combined hit</dt>
                <dd className="font-mono text-base text-slate-100">{(combined * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-widest text-muted">Dominance share</dt>
                <dd className="font-mono text-base text-slate-100">{(dominance * 100).toFixed(0)}%</dd>
                <p className="text-[9px] text-muted">vs the 30% uniform baseline</p>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-widest text-muted">Net if any leg hits</dt>
                <dd className={"font-mono text-base " + (netIfHit >= 0 ? "text-accent" : "text-danger")}>{netIfHit >= 0 ? "+" : ""}{netIfHit.toFixed(2)} {currency}</dd>
                <p className="text-[9px] text-muted">at {payoutRatio.toFixed(2)}x, smallest leg wins</p>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-widest text-muted">Bundle cost</dt>
                <dd className="font-mono text-base text-slate-100">{bundle.toFixed(2)} {currency}</dd>
                <p className="text-[9px] text-muted">3 x {MIN_STAKE.toFixed(2)} minimum per contract</p>
              </div>
            </dl>
          </div>
        </article>

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={armed ? () => stopEngine("Paused") : start}
              className={"rounded px-5 py-2 text-sm font-semibold " + (armed ? "border border-danger/50 bg-danger/10 text-danger" : "bg-accent text-ink")}
            >
              {armed ? "Pause" : "Start"}
            </button>
            <span role="status" className={"rounded-full border px-3 py-1 text-[11px] " + (armed ? "border-accent/40 text-accent" : "border-line text-muted")}>{phase}</span>
            {cooldownLeft > 0 ? <span className="text-[11px] text-muted">cooling {cooldownLeft}s</span> : null}
            <span className="ml-auto text-[11px] text-muted">
              {accountId || "no account"} ({accountKind}) - {balance !== null ? balance.toFixed(2) : "-"} {currency}
            </span>
          </div>

          {openLegs ? (
            <div className="mt-3 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] text-accent">
              <span className="font-semibold">Open bundle</span> - live P/L {openProfit >= 0 ? "+" : ""}{openProfit.toFixed(2)} {currency}
              <span className="ml-3 font-mono">
                {openLegs.map((leg) => leg.digit + ":" + leg.stake.toFixed(2) + " (" + (leg.profit >= 0 ? "+" : "") + leg.profit.toFixed(2) + ")").join("  ")}
              </span>
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={"Base stake per digit (" + currency + ")"}>
              <input
                type="number"
                min={MIN_STAKE}
                step={0.01}
                value={baseStake}
                disabled={armed}
                onChange={(event) => setBaseStake(Math.max(MIN_STAKE, Number(event.target.value) || MIN_STAKE))}
                className={inputClass}
              />
            </Field>
            <Field label="Stake split">
              <div className="flex gap-1">
                <button type="button" disabled={armed} onClick={() => setWeighted(false)} className={"flex-1 rounded px-2 py-1.5 text-[11px] disabled:opacity-50 " + (!weighted ? "bg-accent text-ink" : "border border-line text-muted")}>Flat</button>
                <button type="button" disabled={armed} onClick={() => setWeighted(true)} className={"flex-1 rounded px-2 py-1.5 text-[11px] disabled:opacity-50 " + (weighted ? "bg-accent text-ink" : "border border-line text-muted")}>Weighted</button>
              </div>
            </Field>
            <Field label="Alignment gate">
              <select value={gate} onChange={(event) => setGate(event.target.value as Gate)} disabled={armed} className={inputClass}>
                <option value="any">Any signal</option>
                <option value="strong">Strong or triple</option>
                <option value="triple">Triple only</option>
              </select>
            </Field>
            <Field label="Cooldown (seconds, effective min 3)">
              <input type="number" min={0} max={60} value={cooldownSec} onChange={(event) => setCooldownSec(clamp(Number(event.target.value), 0, 60))} className={inputClass} />
            </Field>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="rounded border border-line bg-ink px-2 py-1 font-mono">
              Legs {stakes[0].toFixed(2)} / {stakes[1].toFixed(2)} / {stakes[2].toFixed(2)} = {bundle.toFixed(2)} {currency}
            </span>
            <span>{weighted ? "Weighted: leg #1 carries the extra stake, legs #2-3 stay at the minimum." : "Flat: every leg carries the same stake."} A 3 s floor keeps the proposal budget under Deriv's 360/min.</span>
            <button type="button" onClick={resetSession} disabled={!!openLegs} className="ml-auto rounded border border-line px-3 py-1 text-[11px] text-muted hover:text-slate-100 disabled:opacity-40">Reset session</button>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted">Session P/L</dt>
              <dd className={"font-mono text-base " + (pnl > 0 ? "text-accent" : pnl < 0 ? "text-danger" : "text-slate-200")}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} {currency}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted">Rounds</dt>
              <dd className="font-mono text-base text-slate-200">{rounds.length}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted">Wins / losses</dt>
              <dd className="font-mono text-base text-slate-200">{wins} / {losses}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted">Payout multiple</dt>
              <dd className="font-mono text-base text-slate-200">{payoutRatio.toFixed(2)}x</dd>
            </div>
          </dl>

          <p className="mt-3 text-[10px] leading-relaxed text-muted">
            All three DIGITMATCH legs are priced together and bought in one Promise.all burst, then the lock stays closed until every bought contract reports is_sold and the cooldown finishes. A 30 second settlement timeout stops the bot rather than guessing an outcome. A one-tick match pays about 8.93x, implying an 11.2% break-even per digit against a fair 10%: hedging spreads the loss, it does not create an edge.
          </p>
        </article>

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight">Recent rounds</h2>
            <span className="text-[10px] text-muted">latest 100</span>
          </div>
          {rounds.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No rounds settled in this session yet.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-widest text-muted">
                  <tr><th className="py-1 pr-2">Time</th><th className="py-1 pr-2">Symbol</th><th className="py-1 pr-2">Digits</th><th className="py-1 pr-2">Stakes</th><th className="py-1 pr-2">Cost</th><th className="py-1 pr-2">P(next)</th><th className="py-1">Net</th></tr>
                </thead>
                <tbody className="font-mono">
                  {rounds.map((row) => (
                    <tr key={row.id} className="border-t border-line/60">
                      <td className="py-1 pr-2">{new Date(row.time).toLocaleTimeString()}</td>
                      <td className="py-1 pr-2">{row.symbol}</td>
                      <td className="py-1 pr-2">{row.digits.join(" / ")}</td>
                      <td className="py-1 pr-2">{row.stakes.map((stake) => stake.toFixed(2)).join(" / ")}</td>
                      <td className="py-1 pr-2">{row.total.toFixed(2)}</td>
                      <td className="py-1 pr-2">{(row.probability * 100).toFixed(1)}%</td>
                      <td className={"py-1 " + (row.profit > 0 ? "text-accent" : row.profit < 0 ? "text-danger" : "")}>{row.profit.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </div>

      {confirmOpen ? (
        <Modal title="Start the 3-leg hedge on a real account?" onClose={() => setConfirmOpen(false)}>
          <div className="space-y-3 text-xs">
            <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
              This session is live money ({accountId}). Every round buys three 1-tick DIGITMATCH contracts and can lose the whole bundle when none of the three digits prints.
            </p>
            <dl className="grid grid-cols-2 gap-2 font-mono">
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Legs</dt><dd>{stakes[0].toFixed(2)} / {stakes[1].toFixed(2)} / {stakes[2].toFixed(2)} {currency}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Bundle at risk</dt><dd>{bundle.toFixed(2)} {currency}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Max loss per round</dt><dd>{bundle.toFixed(2)} {currency}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Alignment gate</dt><dd>{gate}</dd></div>
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
                onClick={() => { setRealOk(true); setConfirmOpen(false); armEngine(); }}
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
