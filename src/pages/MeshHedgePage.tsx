import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Account, DerivSession, Quote, SymbolInfo, Tick } from "@/deriv";
import TransitionMeshCircle from "@/components/TransitionMeshCircle";
import {
  AUTO_MULTIPLIER,
  DEFAULT_DOMINANCE_PERCENT,
  MAX_MARTINGALE_LEVELS,
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  MIN_STAKE,
  PREDICTION_COUNTS,
  ROI_BADGE,
  UNIFORM_BASELINE,
  bundleTotal,
  combinedProbability,
  decimalsFromPip,
  dominanceShare,
  evaluateMesh,
  martingaleStake,
  nextMartingaleLevel,
  round2,
  splitStakes,
  streakMissProbability,
  topDigits,
} from "@/utils/transitionMeshMath";
import type { ConsensusKind, PredictionCount, RankedDigit } from "@/utils/transitionMeshMath";

type Gate = "any" | "strong" | "triple";
type ConfirmMode = "auto" | "single";
type MultiplierChoice = "auto" | "1.6" | "1.9" | "2.4" | "custom";

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
  level: number;
}

const FAMILY_TITLE: Record<string, string> = {
  continuous: "Continuous Indices",
  step: "Step Indices",
  jump: "Jump Indices",
};

const DEFAULT_LOOKBACKS: [number, number, number] = [100, 150, 200];
const ESTIMATED_PAYOUT = 8.93;
const SETTLEMENT_TIMEOUT_MS = 30000;
/**
 * One round costs roughly 4K API calls (proposal, buy, watch, forget per leg).
 * Pacing against 300/min leaves headroom under Deriv's 360/min budget:
 * K=3 -> 3 s, K=4 -> 4 s, K=5 -> 4 s.
 */
function minRoundGapSec(legs: number): number {
  return Math.max(3, Math.ceil((4 * Math.max(1, legs) * 60) / 300));
}

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
  const [predictionCount, setPredictionCount] = useState<PredictionCount>(3);
  const [dominanceThreshold, setDominanceThreshold] = useState<number>(DEFAULT_DOMINANCE_PERCENT[3]);
  const [thresholdLocked, setThresholdLocked] = useState(false);
  const [martingaleOn, setMartingaleOn] = useState(false);
  const [multiplierChoice, setMultiplierChoice] = useState<MultiplierChoice>("auto");
  const [customMultiplier, setCustomMultiplier] = useState(2);
  const [maxLevels, setMaxLevels] = useState(3);
  const [martingaleLevel, setMartingaleLevel] = useState(0);
  const [executing, setExecuting] = useState(false);
  const [pnl, setPnl] = useState(0);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [payoutRatio, setPayoutRatio] = useState(ESTIMATED_PAYOUT);
  const [openLegs, setOpenLegs] = useState<Leg[] | null>(null);
  const [confirmMode, setConfirmMode] = useState<ConfirmMode | null>(null);
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
  const weightedRef = useRef(false);
  const gateRef = useRef<Gate>("any");
  const cooldownRef = useRef(3);
  const countRef = useRef<PredictionCount>(3);
  const dominanceRef = useRef(DEFAULT_DOMINANCE_PERCENT[3]);
  const martingaleOnRef = useRef(false);
  const martingaleLevelRef = useRef(0);
  const maxLevelsRef = useRef(3);
  const stakePerDigitRef = useRef(MIN_STAKE);
  const roundLevelRef = useRef(0);
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
  useEffect(() => { weightedRef.current = weighted; }, [weighted]);
  useEffect(() => { gateRef.current = gate; }, [gate]);
  useEffect(() => { cooldownRef.current = cooldownSec; }, [cooldownSec]);
  useEffect(() => { countRef.current = predictionCount; }, [predictionCount]);
  useEffect(() => { dominanceRef.current = dominanceThreshold; }, [dominanceThreshold]);
  useEffect(() => { martingaleOnRef.current = martingaleOn; }, [martingaleOn]);
  useEffect(() => { martingaleLevelRef.current = martingaleLevel; }, [martingaleLevel]);
  useEffect(() => { maxLevelsRef.current = maxLevels; }, [maxLevels]);
  useEffect(() => { setRealOk(false); }, [accountId]);
  useEffect(() => {
    if (!thresholdLocked) setDominanceThreshold(DEFAULT_DOMINANCE_PERCENT[predictionCount]);
  }, [predictionCount, thresholdLocked]);

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

  const changePredictionCount = useCallback((next: PredictionCount) => {
    if (armedRef.current || execRef.current) return;
    setPredictionCount(next);
    setMartingaleLevel(0);
    martingaleLevelRef.current = 0;
  }, []);

  const toggleMartingale = useCallback(() => {
    const next = !martingaleOnRef.current;
    martingaleOnRef.current = next;
    setMartingaleOn(next);
    if (!next) {
      setMartingaleLevel(0);
      martingaleLevelRef.current = 0;
    }
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
    const levelUsed = roundLevelRef.current;
    const nextLevel = martingaleOnRef.current
      ? nextMartingaleLevel(levelUsed, maxLevelsRef.current, profit < 0)
      : 0;
    martingaleLevelRef.current = nextLevel;
    const row: RoundRow = {
      id: roundNoRef.current,
      time: Date.now(),
      symbol: symbolRef.current,
      digits: legs.map((leg) => leg.digit),
      stakes: legs.map((leg) => leg.stake),
      total,
      profit,
      probability: roundProbabilityRef.current,
      level: levelUsed,
    };
    if (aliveRef.current) {
      setPnl(nextPnl);
      setMartingaleLevel(nextLevel);
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
    const wait = Math.max(cooldownRef.current, minRoundGapSec(legs.length || countRef.current));
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

  const executeBundle = useCallback(async (top: RankedDigit[], mode: ConfirmMode) => {
    const session = sessionRef.current;
    if (!session || top.length === 0) {
      execRef.current = false;
      return;
    }
    execRef.current = true;
    const stakes = splitStakes(stakePerDigitRef.current, weightedRef.current, top.length);
    const market = symbolRef.current;
    const cash = currencyRef.current;
    settleProfitRef.current = 0;
    roundLegsRef.current = [];
    roundLevelRef.current = martingaleOnRef.current ? martingaleLevelRef.current : 0;
    roundProbabilityRef.current = combinedProbability(top);
    setPhase("Pricing " + top.length + " leg" + (top.length === 1 ? "" : "s") + "...");
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
    if (mode === "auto" && !armedRef.current) {
      execRef.current = false;
      setPhase("Paused");
      return;
    }
    setPhase("Locking " + priced.length + " contract" + (priced.length === 1 ? "" : "s") + "...");
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
      onNotice(failures[0] ?? "Deriv rejected all " + top.length + " legs.", "bad");
      return;
    }
    for (const leg of legs) {
      activeBundleIdsRef.current.add(leg.id);
      legsRef.current.set(leg.id, leg);
    }
    roundLegsRef.current = legs;
    bundleTotalRef.current = bundleTotal(legs.map((leg) => leg.stake));
    setOpenLegs(legs.slice());
    setPhase("Open: " + legs.length + " / " + top.length + " legs");
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
    if (!symbolRef.current) {
      setPhase("Select a market to scan");
      return;
    }
    const evaluation = evaluateMesh(quotesRef.current, decimalsRef.current, lookbacksRef.current, stepFilterRef.current);
    const required = Math.max(...lookbacksRef.current);
    if (evaluation.digits.length < required) return;
    const top = topDigits(evaluation.ranked, countRef.current);
    if (top.length === 0) {
      setPhase("Waiting for a reachable digit");
      return;
    }
    const combinedPct = combinedProbability(top) * 100;
    if (combinedPct + 1e-9 < dominanceRef.current) {
      setPhase("Scanning: dominance " + combinedPct.toFixed(0) + "% < " + dominanceRef.current.toFixed(0) + "%");
      return;
    }
    if (!gateAllows(evaluation.consensus.kind, gateRef.current)) {
      setPhase("Scanning: alignment gate not met");
      return;
    }
    await executeBundle(top, "auto");
  }, [executeBundle, sessionRef]);

  /** One manual hedge, outside the auto loop. Gates are bypassed by design. */
  const fireOnce = useCallback(async () => {
    if (armedRef.current || execRef.current || coolingRef.current || finalizingRef.current) return;
    if (activeBundleIdsRef.current.size > 0) return;
    const session = sessionRef.current;
    const market = symbolRef.current;
    if (!session || !market) {
      onNotice("Connect and select a market before firing a hedge.", "bad");
      return;
    }
    const evaluation = evaluateMesh(quotesRef.current, decimalsRef.current, lookbacksRef.current, stepFilterRef.current);
    const required = Math.max(...lookbacksRef.current);
    if (evaluation.digits.length < required) {
      onNotice("Collecting ticks: " + evaluation.digits.length + " of " + required + " needed before a manual hedge.", "bad");
      return;
    }
    const top = topDigits(evaluation.ranked, countRef.current);
    if (top.length === 0) {
      onNotice("No reachable digit to hedge from the current centre digit yet.", "bad");
      return;
    }
    setExecuting(true);
    try {
      await executeBundle(top, "single");
    } finally {
      if (aliveRef.current) setExecuting(false);
    }
  }, [executeBundle, onNotice, sessionRef]);

  const fireSingle = useCallback(() => {
    if (!connected) {
      onConnect();
      return;
    }
    if (!symbolRef.current) {
      onNotice("Select a market first.", "bad");
      return;
    }
    if (armedRef.current || execRef.current) return;
    if (accountKind === "real" && !realOk) {
      setConfirmText("");
      setConfirmMode("single");
      return;
    }
    void fireOnce();
  }, [accountKind, connected, fireOnce, onConnect, onNotice, realOk]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!connected || !symbol || !session) return;
    quotesRef.current = [];
    setQuotes([]);
    let cancelled = false;
    let subscriptionId = "";

    const listen = () => {
      if (cancelled) return;
      session.onTickFor = (market, tick: Tick) => {
        if (cancelled || market !== symbolRef.current) return;
        const next = [...quotesRef.current, tick.quote].slice(-300);
        quotesRef.current = next;
        setQuotes(next);
        void maybeTrade();
      };
      session
        .subscribeTicksFor(symbol)
        .then((id) => {
          if (cancelled) void session.forget(id);
          else subscriptionId = id;
        })
        .catch((error: Error) => {
          if (aliveRef.current) onNotice(error.message, "bad");
        });
    };

    // Seed first, then listen: a live tick that lands during the history
    // request cannot be overwritten by the seed.
    session
      .history(symbol, 300)
      .then((list) => {
        if (cancelled) return;
        const next = list.map((item) => item.quote).slice(-300);
        quotesRef.current = next;
        setQuotes(next);
      })
      .catch(() => undefined)
      .finally(listen);

    return () => {
      cancelled = true;
      session.onTickFor = null;
      if (subscriptionId) void session.forget(subscriptionId);
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
      setConfirmMode("auto");
      return;
    }
    armEngine();
  }, [accountKind, armEngine, connected, onConnect, realOk]);

  const exportCsv = useCallback(() => {
    const header = ["time", "symbol", "digits", "stakes", "bundle", "probability", "profit", "martingale_level"];
    const escape = (value: string | number): string => {
      const text = String(value);
      return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const lines = [header.join(",")];
    for (const row of rounds) {
      lines.push([
        new Date(row.time).toISOString(),
        row.symbol,
        row.digits.join(" "),
        row.stakes.map((stake) => stake.toFixed(2)).join(" "),
        row.total.toFixed(2),
        (row.probability * 100).toFixed(2),
        row.profit.toFixed(2),
        "L" + row.level,
      ].map(escape).join(","));
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "mesh-hedge-rounds.csv";
    link.click();
    URL.revokeObjectURL(url);
  }, [rounds]);

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
    setMartingaleLevel(0);
    martingaleLevelRef.current = 0;
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
  const top = topDigits(evaluation.ranked, predictionCount);
  const reachableCount = stepFilter ? evaluation.ranked.filter((entry) => entry.transition > 0).length : 10;
  const combined = combinedProbability(top);
  const combinedPct = combined * 100;
  const baseline = UNIFORM_BASELINE[predictionCount];
  const lift = dominanceShare(combined, baseline);
  const autoMultiplier = AUTO_MULTIPLIER[predictionCount];
  const activeMultiplier =
    multiplierChoice === "auto"
      ? autoMultiplier
      : multiplierChoice === "custom"
        ? clamp(customMultiplier, MIN_MULTIPLIER, MAX_MULTIPLIER)
        : Number(multiplierChoice);
  const cleanBase = round2(Math.max(MIN_STAKE, baseStake));
  const currentLevel = martingaleOn ? martingaleLevel : 0;
  const stakePerDigit = martingaleOn
    ? martingaleStake(cleanBase, activeMultiplier, currentLevel)
    : cleanBase;
  const stakeCount = Math.max(1, top.length || predictionCount);
  const stakes = splitStakes(stakePerDigit, weighted, stakeCount);
  const bundle = bundleTotal(stakes);
  const minStake = Math.min(...stakes);
  const netIfHit = round2(payoutRatio * minStake - bundle);
  const nextLevel = martingaleOn ? nextMartingaleLevel(currentLevel, maxLevels, true) : 0;
  const nextStakePerDigit = martingaleOn ? martingaleStake(cleanBase, activeMultiplier, nextLevel) : cleanBase;
  const nextStakes = splitStakes(nextStakePerDigit, weighted, stakeCount);
  const nextBundle = bundleTotal(nextStakes);
  const required = Math.max(...lookbacks);
  const ready = evaluation.digits.length >= required;
  const center = evaluation.center;
  const consensus = evaluation.consensus;
  const minGap = minRoundGapSec(predictionCount);
  const dominancePass = combinedPct + 1e-9 >= dominanceThreshold;

  let cumulativeRisk = 0;
  const progression = Array.from({ length: maxLevels + 1 }, (_, level) => {
    const perDigit = martingaleStake(cleanBase, activeMultiplier, level);
    const rowStakes = splitStakes(perDigit, weighted, stakeCount);
    const cost = bundleTotal(rowStakes);
    cumulativeRisk = round2(cumulativeRisk + cost);
    return {
      level,
      perDigit,
      cost,
      cumulative: cumulativeRisk,
      netIfHit: round2(payoutRatio * Math.min(...rowStakes) - cost),
      missStreak: streakMissProbability(combined, level) * 100,
    };
  });

  useEffect(() => { stakePerDigitRef.current = stakePerDigit; }, [stakePerDigit]);

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
              Step indices rarely quote DIGITMATCH. If Deriv rejects all {top.length || predictionCount} legs the round stops flat and no position is opened.
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
              <h2 className="text-sm font-semibold tracking-tight">Top {predictionCount} hedged DIGITMATCH digits</h2>
              <p className="text-[11px] text-muted">Score = 0.60 x normalised window frequency + 0.40 x P(next | centre digit){stepFilter ? ", zeroed when the step index cannot reach the digit" : ""}.</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="rounded-full border border-line px-3 py-1 text-muted">{predictionCount} predictions</span>
              <span className="rounded-full border border-line px-3 py-1 text-muted">{gate === "any" ? "No alignment gate" : gate === "strong" ? "Needs strong or triple" : "Needs triple alignment"}</span>
            </div>
          </div>
          {stepFilter && top.length < predictionCount ? (
            <p className="mt-2 rounded border border-sky-400/40 bg-sky-400/10 px-2 py-1 text-[10px] text-sky-300">
              Step Reachability Guard: Buying {top.length} of {predictionCount} digits ({reachableCount} reachable from centre digit {center >= 0 ? center : "-"}).
            </p>
          ) : null}

          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_290px]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-widest text-muted">
                  <tr><th className="py-1 pr-2">#</th><th className="py-1 pr-2">Digit</th><th className="py-1 pr-2">P(next)</th><th className="py-1 pr-2">Score</th><th className="py-1 pr-2">Stake</th></tr>
                </thead>
                <tbody className="font-mono">
                  {top.length === 0 ? (
                    <tr><td colSpan={5} className="py-2 text-muted">{stepFilter ? "No digit is reachable from the current centre digit yet." : "Warming up: no ranked digit yet."}</td></tr>
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
                <dt className="text-[10px] uppercase tracking-widest text-muted">Dominance gate</dt>
                <dd className={"font-mono text-base " + (dominancePass ? "text-accent" : "text-amber-300")}>{combinedPct.toFixed(1)}% / {dominanceThreshold.toFixed(0)}%</dd>
                <p className="text-[9px] text-muted">{dominancePass ? "pass" : "below threshold"} - uniform {baseline * 100}%</p>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-widest text-muted">Lift vs random</dt>
                <dd className="font-mono text-base text-slate-100">{lift.toFixed(2)}x</dd>
                <p className="text-[9px] text-muted">combined / {baseline * 100}% baseline</p>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-widest text-muted">Net if any leg hits</dt>
                <dd className={"font-mono text-base " + (netIfHit >= 0 ? "text-accent" : "text-danger")}>{netIfHit >= 0 ? "+" : ""}{netIfHit.toFixed(2)} {currency}</dd>
                <p className="text-[9px] text-muted">at {payoutRatio.toFixed(2)}x, smallest leg wins</p>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-widest text-muted">Bundle cost</dt>
                <dd className="font-mono text-base text-slate-100">{bundle.toFixed(2)} {currency}</dd>
                <p className="text-[9px] text-muted">{stakeCount} legs, {MIN_STAKE.toFixed(2)} minimum per contract</p>
              </div>
            </dl>
          </div>
        </article>

        <article className="rounded border border-line bg-panel p-4">
          <div className="mb-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold tracking-tight">Predictions per round</h2>
              <span className="text-[10px] text-muted">Top-K DIGITMATCH bundle - switch while paused</span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {PREDICTION_COUNTS.map((count) => {
                const selected = count === predictionCount;
                return (
                  <button
                    key={count}
                    type="button"
                    aria-label={count + " digits: " + ROI_BADGE[count]}
                    disabled={armed || executing || !!openLegs}
                    onClick={() => changePredictionCount(count)}
                    className={"rounded border px-3 py-2 text-left transition disabled:opacity-50 " + (selected ? "border-accent bg-accent/10" : "border-line bg-ink hover:border-muted")}
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className={"text-sm font-semibold " + (selected ? "text-accent" : "text-slate-100")}>{count} Digits</span>
                      <span className="rounded-full border border-line px-2 py-0.5 text-[9px] text-muted">{ROI_BADGE[count]}</span>
                    </span>
                    <span className="mt-1 block text-[9px] text-muted">Default gate {DEFAULT_DOMINANCE_PERCENT[count]}% - auto {AUTO_MULTIPLIER[count].toFixed(1)}x recovery</span>
                  </button>
                );
              })}
            </div>
            {predictionCount === 5 ? (
              <p className="mt-2 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-[10px] text-amber-300">
                5 predictions cover 50% of digits (~78% net ROI per hit) and require a 2.4× Martingale step to recover losses.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={fireSingle}
              disabled={armed || executing || !!openLegs}
              className="rounded border border-accent/50 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent disabled:opacity-40"
            >
              Fire Single Hedge Now
            </button>
            <button
              type="button"
              onClick={armed ? () => stopEngine("Paused") : start}
              disabled={executing || !!openLegs}
              className={"rounded px-5 py-2 text-sm font-semibold disabled:opacity-40 " + (armed ? "border border-danger/50 bg-danger/10 text-danger" : "bg-accent text-ink")}
            >
              {armed ? "Pause" : "Start Auto-Hedge"}
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

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label={"Base stake per digit (" + currency + ")"}>
              <input
                type="number"
                min={MIN_STAKE}
                step={0.01}
                value={baseStake}
                disabled={armed || executing || !!openLegs}
                onChange={(event) => setBaseStake(Math.max(MIN_STAKE, Number(event.target.value) || MIN_STAKE))}
                className={inputClass}
              />
            </Field>
            <Field label="Stake split">
              <div className="flex gap-1">
                <button type="button" disabled={armed || executing || !!openLegs} onClick={() => setWeighted(false)} className={"flex-1 rounded px-2 py-1.5 text-[11px] disabled:opacity-50 " + (!weighted ? "bg-accent text-ink" : "border border-line text-muted")}>Equal</button>
                <button type="button" disabled={armed || executing || !!openLegs} onClick={() => setWeighted(true)} className={"flex-1 rounded px-2 py-1.5 text-[11px] disabled:opacity-50 " + (weighted ? "bg-accent text-ink" : "border border-line text-muted")}>Weighted</button>
              </div>
            </Field>
            <Field label="Min combined dominance (%)">
              <div className="flex gap-1">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={dominanceThreshold}
                  disabled={armed || executing || !!openLegs}
                  onChange={(event) => {
                    setDominanceThreshold(clamp(Number(event.target.value), 0, 100));
                    setThresholdLocked(true);
                  }}
                  className={inputClass}
                />
                <button
                  type="button"
                  disabled={armed || executing || !!openLegs}
                  onClick={() => setThresholdLocked((value) => !value)}
                  title="When unlocked, the threshold follows the prediction count"
                  className={"rounded border px-2 text-[10px] disabled:opacity-50 " + (thresholdLocked ? "border-amber-400/50 text-amber-300" : "border-line text-muted")}
                >
                  {thresholdLocked ? "Locked" : "Auto"}
                </button>
              </div>
            </Field>
            <Field label="Alignment gate">
              <select value={gate} onChange={(event) => setGate(event.target.value as Gate)} disabled={armed || executing || !!openLegs} className={inputClass}>
                <option value="any">Any signal</option>
                <option value="strong">Strong or triple</option>
                <option value="triple">Triple only</option>
              </select>
            </Field>
            <Field label={"Cooldown (s, effective min " + minGap + ")"}>
              <input type="number" min={0} max={60} value={cooldownSec} disabled={armed || executing || !!openLegs} onChange={(event) => setCooldownSec(clamp(Number(event.target.value), 0, 60))} className={inputClass} />
            </Field>
          </div>

          <div className="mt-4 rounded border border-line bg-ink/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-200">Martingale Settings</h3>
                <p className="mt-1 text-[10px] text-muted">OFF = flat base stake every round. ON = step up only after a full miss and reset to Level 0 on any win or at max levels.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={martingaleOn}
                onClick={toggleMartingale}
                disabled={armed || executing || !!openLegs}
                className={"flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50 " + (martingaleOn ? "border-accent/60 bg-accent/15 text-accent" : "border-line bg-panel text-muted")}
              >
                <span className={"h-2 w-2 rounded-full " + (martingaleOn ? "bg-accent" : "bg-slate-500")} />
                Martingale {martingaleOn ? "ON" : "OFF"}
              </button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Multiplier after a loss">
                <select
                  value={multiplierChoice}
                  disabled={armed || executing || !!openLegs}
                  onChange={(event) => setMultiplierChoice(event.target.value as MultiplierChoice)}
                  className={inputClass}
                >
                  <option value="auto">Auto-matched ({autoMultiplier.toFixed(2)}x for {predictionCount})</option>
                  <option value="1.6">1.6x after a loss</option>
                  <option value="1.9">1.9x after a loss</option>
                  <option value="2.4">2.4x after a loss</option>
                  <option value="custom">Custom multiplier</option>
                </select>
              </Field>
              {multiplierChoice === "custom" ? (
                <Field label={"Custom multiplier (" + MIN_MULTIPLIER.toFixed(2) + " - " + MAX_MULTIPLIER.toFixed(2) + ")"}>
                  <input
                    type="number"
                    min={MIN_MULTIPLIER}
                    max={MAX_MULTIPLIER}
                    step={0.05}
                    value={customMultiplier}
                    disabled={armed || executing || !!openLegs}
                    onChange={(event) => setCustomMultiplier(clamp(Number(event.target.value) || MIN_MULTIPLIER, MIN_MULTIPLIER, MAX_MULTIPLIER))}
                    className={inputClass}
                  />
                </Field>
              ) : (
                <div className="text-[10px] text-muted">
                  <p className="uppercase tracking-widest">Auto-matched</p>
                  <p className="mt-1 text-[11px] text-slate-300">{predictionCount} predictions use {autoMultiplier.toFixed(2)}x after a full miss.</p>
                </div>
              )}
              <Field label={"Martingale max levels (1 - " + MAX_MARTINGALE_LEVELS + ")"}>
                <input
                  type="number"
                  min={1}
                  max={MAX_MARTINGALE_LEVELS}
                  step={1}
                  value={maxLevels}
                  disabled={armed || executing || !!openLegs}
                  onChange={(event) => {
                    const next = clamp(Math.round(Number(event.target.value) || 1), 1, MAX_MARTINGALE_LEVELS);
                    setMaxLevels(next);
                    if (martingaleLevel > next) setMartingaleLevel(0);
                  }}
                  className={inputClass}
                />
              </Field>
            </div>

            <p className="mt-2 font-mono text-[10px] text-muted">
              stepStakePerDigit = +({cleanBase.toFixed(2)} x {activeMultiplier.toFixed(2)}^{currentLevel}).toFixed(2) = {stakePerDigit.toFixed(2)} {currency} at Level {currentLevel}
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[10px]">
                <thead className="text-[9px] uppercase tracking-widest text-muted">
                  <tr>
                    <th className="py-1 pr-2">Level</th>
                    <th className="py-1 pr-2">Stake / Digit</th>
                    <th className="py-1 pr-2">Total Bundle Cost</th>
                    <th className="py-1 pr-2">Cumulative Risk</th>
                    <th className="py-1 pr-2">Net Profit if Hit</th>
                    <th className="py-1" title="Probability that all selected digits miss this many rounds in a row">Streak Odds</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {progression.map((row) => {
                    const active = row.level === (martingaleOn ? martingaleLevel : 0);
                    return (
                      <tr key={row.level} className={"border-t border-line/60 " + (active ? "bg-accent/10 text-accent" : "text-slate-300")}>
                        <td className="py-1 pr-2">L{row.level}{row.level === maxLevels ? " (cap)" : ""}</td>
                        <td className="py-1 pr-2">{row.perDigit.toFixed(2)}</td>
                        <td className="py-1 pr-2">{row.cost.toFixed(2)}</td>
                        <td className="py-1 pr-2">{row.cumulative.toFixed(2)}</td>
                        <td className={"py-1 pr-2 " + (row.netIfHit >= 0 ? "text-accent" : "text-danger")}>{row.netIfHit >= 0 ? "+" : ""}{row.netIfHit.toFixed(2)}</td>
                        <td className="py-1">{ready && combined > 0 ? row.missStreak.toFixed(1) + "%" : "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-muted">
              Values in {currency}. Stake / Digit is the base step stake; Weighted boosts leg #1 by another 1.5x. Cumulative risk adds every bundle from Level 0 to that level. Streak odds use the current combined hit rate of the {top.length || predictionCount} selected digits and show the chance of missing that many rounds in a row. {martingaleOn ? "The highlighted row is the live level." : "Master OFF: only Level 0 is traded, the rest is preview."}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="rounded border border-line bg-ink px-2 py-1 font-mono">
              Legs {stakes.map((stake) => stake.toFixed(2)).join(" / ")} = {bundle.toFixed(2)} {currency}
            </span>
            <span>
              {weighted ? "Weighted: leg #1 gets base + 1.5x, legs #2-" + predictionCount + " stay at base." : "Equal: every leg gets the base stake."}{" "}
              {martingaleOn ? "Martingale ON at Level " + currentLevel + ", next bundle " + nextBundle.toFixed(2) + ", cap " + maxLevels + "." : "Martingale OFF, flat stake."} A {minGap}s floor keeps the K={predictionCount} proposal budget under Deriv's 360/min.
            </span>
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

          <p className="mt-2 font-mono text-[11px] text-slate-200">
            Martingale Level: {martingaleOn ? martingaleLevel : 0} / {maxLevels}
            <span className="mx-2 text-muted">·</span>
            Next Bundle Stake: {nextBundle.toFixed(2)} {currency}
            <span className="ml-2 text-[10px] text-muted">{martingaleOn ? "(if the next round misses)" : "(flat)"}</span>
          </p>

          <p className="mt-3 text-[10px] leading-relaxed text-muted">
            All {top.length || predictionCount} DIGITMATCH legs are priced together and bought in one Promise.all burst, then the lock stays closed until every bought contract reports is_sold and the cooldown finishes. A 30 second settlement timeout stops the bot rather than guessing an outcome. A one-tick match pays about 8.93x, implying an 11.2% break-even per digit against a fair 10%: hedging spreads the loss, it does not create an edge. The ROI badges are gross per-hit returns at that payout; misses and the house margin still apply.
          </p>
        </article>

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-tight">Recent rounds</h2>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted">latest 100</span>
              <button type="button" onClick={exportCsv} disabled={rounds.length === 0} className="rounded border border-line px-2 py-1 text-[10px] text-muted hover:text-slate-100 disabled:opacity-40">Export CSV</button>
            </div>
          </div>
          {rounds.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No rounds settled in this session yet.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-widest text-muted">
                  <tr><th className="py-1 pr-2">Time</th><th className="py-1 pr-2">Symbol</th><th className="py-1 pr-2">Digits</th><th className="py-1 pr-2">Stakes</th><th className="py-1 pr-2">Cost</th><th className="py-1 pr-2">P(next)</th><th className="py-1 pr-2">Mg</th><th className="py-1">Net</th></tr>
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
                      <td className="py-1 pr-2">L{row.level}</td>
                      <td className={"py-1 " + (row.profit > 0 ? "text-accent" : row.profit < 0 ? "text-danger" : "")}>{row.profit.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </div>

      {confirmMode ? (
        <Modal
          title={confirmMode === "single" ? "Fire a " + predictionCount + "-leg hedge on a real account?" : "Start the " + predictionCount + "-leg auto-hedge on a real account?"}
          onClose={() => setConfirmMode(null)}
        >
          <div className="space-y-3 text-xs">
            <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
              This session is live money ({accountId}). {confirmMode === "single" ? "This click buys" : "Every round buys"} {stakes.length} 1-tick DIGITMATCH contracts and can lose the whole bundle when none of the {predictionCount} selected digits prints.
            </p>
            <dl className="grid grid-cols-2 gap-2 font-mono">
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Legs</dt><dd>{stakes.map((stake) => stake.toFixed(2)).join(" / ")} {currency}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Bundle at risk</dt><dd>{bundle.toFixed(2)} {currency}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Max loss per round</dt><dd>{bundle.toFixed(2)} {currency}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Predictions</dt><dd>{predictionCount} ({top.length} reachable)</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Alignment gate</dt><dd>{gate}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Dominance gate</dt><dd>{dominanceThreshold}%</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-muted">Martingale</dt><dd>{martingaleOn ? "ON · level " + martingaleLevel + " / " + maxLevels + " · " + activeMultiplier.toFixed(2) + "x" : "OFF (flat)"}</dd></div>
            </dl>
            <label className="block text-[11px] text-muted">
              Type REAL to confirm
              <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} className={inputClass + " mt-1"} placeholder="REAL" spellCheck={false} />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmMode(null)} className="rounded border border-line px-3 py-1.5 text-xs text-muted">Cancel</button>
              <button
                type="button"
                disabled={confirmText.trim().toUpperCase() !== "REAL"}
                onClick={() => {
                  const mode = confirmMode;
                  setRealOk(true);
                  setConfirmMode(null);
                  if (mode === "auto") armEngine();
                  else if (mode === "single") void fireOnce();
                }}
                className="rounded bg-danger px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40"
              >
                {confirmMode === "single" ? "Fire on real money" : "Start on real money"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
