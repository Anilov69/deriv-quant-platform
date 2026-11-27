import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Account, ContractOffer, DerivSession, Quote, SymbolInfo, Tick } from "@/deriv";
import BarrierChannelVisualizer from "@/components/BarrierChannelVisualizer";
import SessionAdvisorModal from "@/components/SessionAdvisorModal";
import type { SessionAdvisorMode, SessionAdvisorState } from "@/components/SessionAdvisorModal";
import {
  ATR_BUFFER_SIZE,
  BARRIER_PRESETS,
  DEFAULT_DURATION_TICKS,
  DEFAULT_MARTINGALE_MULTIPLIER,
  DEFAULT_MAX_LEVELS,
  DEFAULT_SQUEEZE_THRESHOLD,
  MARTINGALE_MULTIPLIERS,
  MAX_DURATION_TICKS,
  MAX_LEVELS,
  MIN_LEG_STAKE,
  OUTCOME_LABEL,
  TOUCH_SYMBOL_GROUPS,
  TOUCH_SYMBOLS,
  barrierOffsetFor,
  buildStraddlePayoutPreview,
  clampTouchDuration,
  classifyStraddleOutcome,
  computeAtrSqueeze,
  computeStraddleRiskPlan,
  decimalsForStep,
  formatSignedBarrier,
  isSqueezeReady,
  nextStraddleCost,
  nextStraddleLevel,
  round2,
  roundToStep,
  selectOnetouchTickSpec,
} from "@/utils/straddleMath";
import type {
  BarrierPreset,
  StraddleOutcome,
  StraddleRiskPlan,
  TouchContractSpec,
} from "@/utils/straddleMath";

type ConfirmMode = "auto" | "single";
type MultiplierChoice = "1.5" | "1.65" | "1.8" | "2" | "custom";

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

interface StraddleLeg {
  id: number;
  side: "upper" | "lower";
  barrier: string;
  stake: number;
  payout: number;
  profit: number;
  status: "open" | "won" | "lost" | "rejected";
  touched: boolean;
  settled: boolean;
}

interface ActiveBundle {
  id: number;
  symbol: string;
  level: number;
  duration: number;
  cost: number;
  squeezeRatio: number;
  barrierOffset: number;
  upperBarrier: string;
  lowerBarrier: string;
  legs: StraddleLeg[];
  startedAt: number;
  ticksElapsed: number;
}

interface RoundRow {
  id: number;
  time: number;
  symbol: string;
  level: number;
  duration: number;
  upperBarrier: string;
  lowerBarrier: string;
  squeezeRatio: number;
  upperStatus: "TOUCHED" | "NO TOUCH" | "REJECTED";
  lowerStatus: "TOUCHED" | "NO TOUCH" | "REJECTED";
  legsWon: number;
  outcome: StraddleOutcome;
  cost: number;
  payout: number;
  profit: number;
}

interface Preview {
  key: string;
  upper: Quote;
  lower: Quote;
  at: number;
}

interface RuntimeConfig {
  connected: boolean;
  accountId: string;
  symbol: string;
  duration: number;
  baseStake: number;
  currency: string;
  spec: TouchContractSpec | null;
  pip: number;
  decimals: number;
  offset: number;
  barrierPreset: BarrierPreset;
  customOffset: number;
  upperQuery: string;
  lowerQuery: string;
  currentLevel: number;
  nextCost: number;
  martingaleOn: boolean;
  multiplier: number;
  maxLevels: number;
  squeezeReady: boolean;
  squeezeRatio: number;
  atrReady: boolean;
  requireSqueeze: boolean;
  quoteKey: string;
}

const DEFAULT_RISK_PLAN = computeStraddleRiskPlan({
  baseStake: MIN_LEG_STAKE,
  martingaleEnabled: false,
  multiplier: DEFAULT_MARTINGALE_MULTIPLIER,
  maxLevels: DEFAULT_MAX_LEVELS,
  singleSidePayout: null,
});
const SETTLEMENT_TIMEOUT_MS = 45000;
const COOLDOWN_MS = 2500;
const AUTO_RETRY_MS = 4000;
const QUOTE_REFRESH_MS = 12000;

const inputClass =
  "w-full rounded border border-line bg-ink px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent disabled:opacity-50";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function quoteKeyFor(symbol: string, duration: number, offset: number, decimals: number, stake: number): string {
  return [symbol, duration, offset.toFixed(decimals), stake.toFixed(2)].join("|");
}

function isSold(payload: any): boolean {
  return Number(payload?.is_sold) === 1 || payload?.is_sold === true || String(payload?.is_sold) === "1";
}

function legLabel(leg: StraddleLeg): string {
  if (leg.status === "rejected") return "REJECTED";
  if (leg.status === "won") return "TOUCHED ✓";
  if (leg.status === "lost") return "NO TOUCH";
  return "OPEN";
}

function legTone(leg: StraddleLeg): string {
  if (leg.status === "won") return "border-accent/40 bg-accent/10 text-accent";
  if (leg.status === "lost") return "border-danger/40 bg-danger/10 text-danger";
  if (leg.status === "rejected") return "border-amber-400/40 bg-amber-400/10 text-amber-300";
  return "border-sky-400/40 bg-sky-400/10 text-sky-300";
}

function outcomeTone(outcome: StraddleOutcome): string {
  if (outcome === "WHIPSAW_2X") return "border-accent/40 bg-accent/10 text-accent";
  if (outcome === "ONE_SIDE_WIN") return "border-sky-400/40 bg-sky-400/10 text-sky-300";
  return "border-danger/40 bg-danger/10 text-danger";
}

function legCsvStatus(leg: StraddleLeg): "TOUCHED" | "NO TOUCH" | "REJECTED" {
  if (leg.status === "rejected") return "REJECTED";
  return leg.touched ? "TOUCHED" : "NO TOUCH";
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

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="text-[11px] text-muted">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

export default function TouchStraddlePage(props: Props): ReactElement {
  const { sessionRef, connected, symbols, accounts, accountId, accountKind, balance, currency, onConnect, onAccountChange, onNotice, bindContractListener } = props;

  const [symbol, setSymbol] = useState("1HZ100V");
  const [prices, setPrices] = useState<number[]>([]);
  const [offers, setOffers] = useState<ContractOffer[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [contractError, setContractError] = useState<string | null>(null);
  const [duration, setDuration] = useState(DEFAULT_DURATION_TICKS);
  const [baseStake, setBaseStake] = useState(MIN_LEG_STAKE);
  const [preset, setPreset] = useState<BarrierPreset>("balanced");
  const [customOffset, setCustomOffset] = useState(0.14);
  const [requireSqueeze, setRequireSqueeze] = useState(true);
  const [squeezeThreshold, setSqueezeThreshold] = useState(DEFAULT_SQUEEZE_THRESHOLD);
  const [martingaleOn, setMartingaleOn] = useState(false);
  const [multiplierChoice, setMultiplierChoice] = useState<MultiplierChoice>("1.65");
  const [customMultiplier, setCustomMultiplier] = useState(DEFAULT_MARTINGALE_MULTIPLIER);
  const [maxLevels, setMaxLevels] = useState(DEFAULT_MAX_LEVELS);
  const [martingaleLevel, setMartingaleLevel] = useState(0);
  const [armed, setArmed] = useState(false);
  const [phase, setPhase] = useState("Ready - select a market");
  const [executing, setExecuting] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [pnl, setPnl] = useState(0);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);
  const [stopLoss, setStopLoss] = useState(DEFAULT_RISK_PLAN.autoStopLoss);
  const [takeProfit, setTakeProfit] = useState(DEFAULT_RISK_PLAN.autoTakeProfit);
  const [isSlManual, setIsSlManual] = useState(false);
  const [isTpManual, setIsTpManual] = useState(false);
  const [slFocused, setSlFocused] = useState(false);
  const [tpFocused, setTpFocused] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [openBundle, setOpenBundle] = useState<ActiveBundle | null>(null);
  const [advisor, setAdvisor] = useState<SessionAdvisorState | null>(null);
  const [confirmMode, setConfirmMode] = useState<ConfirmMode | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [realOk, setRealOk] = useState(false);

  const aliveRef = useRef(true);
  const pricesRef = useRef<number[]>([]);
  const runtimeRef = useRef<RuntimeConfig | null>(null);
  const armedRef = useRef(false);
  const execRef = useRef(false);
  const coolingRef = useRef(false);
  const finalizingRef = useRef(false);
  const bundleRef = useRef<ActiveBundle | null>(null);
  const activeIdsRef = useRef<Set<number>>(new Set());
  const subsRef = useRef<string[]>([]);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const cooldownTimerRef = useRef<number | undefined>(undefined);
  const pnlRef = useRef(0);
  const winsRef = useRef(0);
  const lossesRef = useRef(0);
  const peakLevelRef = useRef(0);
  const levelRef = useRef(0);
  const slRef = useRef(DEFAULT_RISK_PLAN.autoStopLoss);
  const tpRef = useRef(DEFAULT_RISK_PLAN.autoTakeProfit);
  const roundNoRef = useRef(0);
  const autoAttemptRef = useRef(0);
  const customOffsetTouchedRef = useRef(false);
  const maybeAutoRef = useRef<() => void>(() => undefined);
  const tickHandlerRef = useRef<(tickSymbol: string, tick: Tick) => void>(() => undefined);
  const assignedTickHandlerRef = useRef<((tickSymbol: string, tick: Tick) => void) | null>(null);
  const prevAccountRef = useRef(accountId);

  const symbolInfo = useMemo(() => symbols.find((item) => item.symbol === symbol) ?? null, [symbol, symbols]);
  const symbolPip = symbolInfo?.pip && symbolInfo.pip > 0 ? symbolInfo.pip : 0.01;
  const spec = useMemo(() => selectOnetouchTickSpec(offers, symbolPip), [offers, symbolPip]);
  const pip = spec?.pipSize && spec.pipSize > 0 ? spec.pipSize : symbolPip;
  const decimals = Math.max(0, decimalsForStep(pip));
  const effectiveDuration = spec ? clampTouchDuration(duration, spec) : duration;
  const atr = useMemo(() => computeAtrSqueeze(prices), [prices]);
  const spot = prices.length > 0 ? prices[prices.length - 1] : 0;
  const ready = atr.ready;
  const fallbackOffset = Math.max(pip * 2, 0.01);
  const baseOffset = spec && spec.defaultBarrier > 0 ? spec.defaultBarrier : fallbackOffset;
  const barrierOffset = spec ? barrierOffsetFor(baseOffset, preset, customOffset, pip) : 0;
  const upperQuery = formatSignedBarrier(barrierOffset, decimals, "upper");
  const lowerQuery = formatSignedBarrier(barrierOffset, decimals, "lower");
  const upperBarrierPrice = spot > 0 ? spot + barrierOffset : 0;
  const lowerBarrierPrice = spot > 0 ? spot - barrierOffset : 0;
  const squeezeReady = isSqueezeReady(atr, squeezeThreshold, requireSqueeze);
  const cleanBase = round2(Math.max(MIN_LEG_STAKE, baseStake));
  const activeMultiplier =
    multiplierChoice === "custom"
      ? clamp(customMultiplier, 1.05, 5)
      : Number(multiplierChoice);
  const quoteKey = quoteKeyFor(symbol, effectiveDuration, barrierOffset, decimals, cleanBase);
  const livePreview = preview && preview.key === quoteKey ? preview : null;
  const singleSidePayout = livePreview ? Math.min(livePreview.upper.payout, livePreview.lower.payout) : null;
  const riskPlan: StraddleRiskPlan = useMemo(
    () =>
      computeStraddleRiskPlan({
        baseStake: cleanBase,
        martingaleEnabled: martingaleOn,
        multiplier: activeMultiplier,
        maxLevels,
        singleSidePayout,
      }),
    [activeMultiplier, cleanBase, livePreview, martingaleOn, maxLevels, singleSidePayout],
  );
  const currentLevel = martingaleOn ? Math.min(martingaleLevel, riskPlan.effectiveMaxLevels) : 0;
  const currentCost = riskPlan.levels[currentLevel]?.straddleCost ?? riskPlan.initialCost;
  const nextLevel = martingaleOn ? Math.min(riskPlan.effectiveMaxLevels, currentLevel + 1) : 0;
  const nextCost = martingaleOn ? nextStraddleCost(riskPlan, nextLevel) : riskPlan.initialCost;
  const payoutPreview = livePreview ? buildStraddlePayoutPreview(livePreview.upper, livePreview.lower) : null;
  const payoutMultiple = payoutPreview && payoutPreview.cost > 0 ? payoutPreview.doublePayout / payoutPreview.cost : null;
  const canPrice = connected && !!spec && spot > 0;
  const canStart = canPrice && !executing && !openBundle && !cooling;
  const buyBlocked = executing || !!openBundle || cooling;

  runtimeRef.current = {
    connected,
    accountId,
    symbol,
    duration: effectiveDuration,
    baseStake: cleanBase,
    currency,
    spec,
    pip,
    decimals,
    offset: barrierOffset,
    barrierPreset: preset,
    customOffset,
    upperQuery,
    lowerQuery,
    currentLevel,
    nextCost: currentCost,
    martingaleOn,
    multiplier: activeMultiplier,
    maxLevels,
    squeezeReady,
    squeezeRatio: atr.squeezeRatio,
    atrReady: ready,
    requireSqueeze,
    quoteKey,
  };

  useEffect(() => {
    if (symbols.length === 0) return;
    const available = symbols.filter((item) => TOUCH_SYMBOLS.includes(item.symbol));
    if (available.length === 0) return;
    if (available.some((item) => item.symbol === symbol)) return;
    const preferred = available.find((item) => item.symbol === "1HZ100V") ?? available.find((item) => item.symbol === "R_100") ?? available[0];
    setSymbol(preferred.symbol);
  }, [symbol, symbols]);

  useEffect(() => {
    if (!spec) return;
    setDuration((previous) => clampTouchDuration(previous, spec));
    if (!customOffsetTouchedRef.current && spec.defaultBarrier > 0) setCustomOffset(spec.defaultBarrier);
  }, [duration, spec]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      armedRef.current = false;
      if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
      if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current);
      const session = sessionRef.current;
      if (session) {
        for (const subscription of subsRef.current) void session.forget(subscription);
        if (assignedTickHandlerRef.current && session.onTickFor === assignedTickHandlerRef.current) session.onTickFor = null;
        assignedTickHandlerRef.current = null;
      }
      subsRef.current = [];
    };
  }, [sessionRef]);

  const stopEngine = useCallback((label: string) => {
    armedRef.current = false;
    setArmed(false);
    // A settled round keeps execRef latched through its post-round cooldown.
    // Never clear that timer here, or pausing during cooldown would leave the
    // page permanently locked with no timer left to release it.
    if (!execRef.current) {
      coolingRef.current = false;
      setCooling(false);
      if (cooldownTimerRef.current !== undefined) {
        window.clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = undefined;
      }
    }
    setPhase(label);
  }, []);

  const showAdvisor = useCallback(
    (mode: SessionAdvisorMode, finalPnl: number, finalWins: number, finalLosses: number, guardCost?: number) => {
      armedRef.current = false;
      setArmed(false);
      coolingRef.current = false;
      setCooling(false);
      if (cooldownTimerRef.current !== undefined) {
        window.clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = undefined;
      }
      levelRef.current = 0;
      setMartingaleLevel(0);
      setAdvisor({
        mode,
        pnl: round2(finalPnl),
        wins: finalWins,
        losses: finalLosses,
        peakLevel: peakLevelRef.current,
        stopLoss: slRef.current,
        takeProfit: tpRef.current,
        nextBundleCost: guardCost,
      });
      setPhase(
        mode === "TP_HIT"
          ? "Take profit hit - engine stopped"
          : mode === "SL_PARTIAL_WINS"
            ? "Stop loss hit - engine stopped"
            : "Zero-win stop loss - engine stopped",
      );
    },
    [],
  );

  const releaseSettledBundle = useCallback(() => {
    if (settleTimerRef.current !== undefined) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = undefined;
    }
    bundleRef.current = null;
    activeIdsRef.current.clear();
    setOpenBundle(null);
    const session = sessionRef.current;
    for (const subscription of subsRef.current) void session?.forget(subscription);
    subsRef.current = [];
  }, [sessionRef]);

  const beginCooldown = useCallback((label: string) => {
    coolingRef.current = true;
    setCooling(true);
    setPhase(label + " - cooldown");
    if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = window.setTimeout(() => {
      coolingRef.current = false;
      setCooling(false);
      execRef.current = false;
      setExecuting(false);
      if (armedRef.current) {
        setPhase("Scanning for the next ATR compression");
        maybeAutoRef.current();
      } else {
        setPhase("Ready for the next straddle");
      }
    }, COOLDOWN_MS);
  }, []);

  const finalizeBundle = useCallback(
    (bundle: ActiveBundle) => {
      if (finalizingRef.current) return;
      finalizingRef.current = true;
      const bought = bundle.legs.filter((leg) => leg.id > 0);
      const winningLegs = bundle.legs.filter((leg) => leg.touched).length;
      const outcome = classifyStraddleOutcome(winningLegs);
      const profit = round2(bundle.legs.reduce((sum, leg) => sum + leg.profit, 0));
      const cost = round2(bought.reduce((sum, leg) => sum + leg.stake, 0));
      const payout = round2(bought.reduce((sum, leg) => sum + leg.payout, 0));
      const nextPnl = round2(pnlRef.current + profit);
      const nextWins = winsRef.current + (profit > 0 ? 1 : 0);
      const nextLosses = lossesRef.current + (profit < 0 ? 1 : 0);
      const nextPeak = Math.max(peakLevelRef.current, bundle.level);
      const upper = bundle.legs.find((leg) => leg.side === "upper");
      const lower = bundle.legs.find((leg) => leg.side === "lower");
      const record: RoundRow = {
        id: (roundNoRef.current += 1),
        time: Date.now(),
        symbol: bundle.symbol,
        level: bundle.level,
        duration: bundle.duration,
        upperBarrier: bundle.upperBarrier,
        lowerBarrier: bundle.lowerBarrier,
        squeezeRatio: bundle.squeezeRatio,
        upperStatus: upper ? legCsvStatus(upper) : "REJECTED",
        lowerStatus: lower ? legCsvStatus(lower) : "REJECTED",
        legsWon: winningLegs,
        outcome,
        cost,
        payout,
        profit,
      };
      pnlRef.current = nextPnl;
      winsRef.current = nextWins;
      lossesRef.current = nextLosses;
      peakLevelRef.current = nextPeak;
      setPnl(nextPnl);
      setWins(nextWins);
      setLosses(nextLosses);
      setPeakLevel(nextPeak);
      setRounds((previous) => [record, ...previous].slice(0, 100));

      const wonRound = profit >= 0;
      const followingLevel = nextStraddleLevel(bundle.level, wonRound, martingaleOn, maxLevels);
      levelRef.current = followingLevel;
      setMartingaleLevel(followingLevel);

      releaseSettledBundle();
      finalizingRef.current = false;

      if (nextPnl >= tpRef.current && tpRef.current > 0) {
        execRef.current = false;
        setExecuting(false);
        showAdvisor("TP_HIT", nextPnl, nextWins, nextLosses);
        return;
      }
      if (nextPnl <= -Math.abs(slRef.current)) {
        execRef.current = false;
        setExecuting(false);
        showAdvisor(nextWins === 0 ? "SL_ZERO_WINS" : "SL_PARTIAL_WINS", nextPnl, nextWins, nextLosses);
        return;
      }
      setExecuting(false);
      beginCooldown(OUTCOME_LABEL[outcome] + " · " + (profit >= 0 ? "+" : "") + profit.toFixed(2) + " " + currency);
    },
    [beginCooldown, currency, martingaleOn, maxLevels, releaseSettledBundle, showAdvisor],
  );

  const handleContract = useCallback(
    (payload: any) => {
      const id = Number(payload?.contract_id ?? 0);
      const bundle = bundleRef.current;
      if (!bundle || !activeIdsRef.current.has(id)) return;
      const index = bundle.legs.findIndex((leg) => leg.id === id);
      if (index < 0) return;
      const leg = bundle.legs[index];
      const rawProfit = Number(payload?.profit);
      let profit = Number.isFinite(rawProfit) ? rawProfit : leg.profit;
      const statusText = String(payload?.status ?? "").toLowerCase();
      if (isSold(payload)) {
        const won = profit > 0 || statusText === "won";
        if (profit === 0) profit = won ? round2(leg.payout - leg.stake) : -leg.stake;
        const nextLegs = bundle.legs.map((item) =>
          item.id === id
            ? {
                ...item,
                profit: round2(profit),
                touched: won,
                settled: true,
                status: won ? ("won" as const) : ("lost" as const),
              }
            : item,
        );
        const nextBundle: ActiveBundle = { ...bundle, legs: nextLegs };
        bundleRef.current = nextBundle;
        setOpenBundle(nextBundle);
        activeIdsRef.current.delete(id);
        if (activeIdsRef.current.size === 0) finalizeBundle(nextBundle);
      } else {
        const nextLegs = bundle.legs.map((item) => (item.id === id ? { ...item, profit: round2(profit) } : item));
        const nextBundle: ActiveBundle = { ...bundle, legs: nextLegs };
        bundleRef.current = nextBundle;
        setOpenBundle(nextBundle);
      }
    },
    [finalizeBundle],
  );

  useEffect(() => {
    bindContractListener(handleContract);
    return () => bindContractListener(null);
  }, [bindContractListener, handleContract]);

  const armSettlementTimeout = useCallback(() => {
    if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      if (activeIdsRef.current.size === 0) return;
      armedRef.current = false;
      setArmed(false);
      coolingRef.current = false;
      setCooling(false);
      setPhase("Settlement timeout - verify open contracts in Deriv");
      onNotice("Settlement timeout: a straddle leg has not reported is_sold. The execution lock is still held; verify the open contract in Deriv and reload the page after it settles.", "bad");
    }, SETTLEMENT_TIMEOUT_MS);
  }, [onNotice]);

  const fireStraddle = useCallback(
    async (mode: "auto" | "single") => {
      const session = sessionRef.current;
      const cfg = runtimeRef.current;
      if (!session || !cfg || !cfg.spec) {
        onNotice("Tick ONETOUCH is not available for this market right now.", "bad");
        return;
      }
      if (!aliveRef.current || execRef.current || coolingRef.current || bundleRef.current || activeIdsRef.current.size > 0) return;
      if (mode === "auto" && !armedRef.current) return;
      if (mode === "single") {
        if (!cfg.atrReady) {
          onNotice("The 100-tick ATR baseline is still warming up. Wait for the signal to leave WARMING before firing.", "bad");
          return;
        }
        if (cfg.requireSqueeze && !cfg.squeezeReady) {
          onNotice("Require ATR compression is ON and the ratio is above " + squeezeThreshold.toFixed(2) + "x. Turn the filter off to override manually.", "bad");
          return;
        }
      }
      autoAttemptRef.current = Date.now();
      execRef.current = true;
      setExecuting(true);
      setQuoteError(null);
      const stillLive = (): boolean =>
        aliveRef.current &&
        runtimeRef.current?.connected === true &&
        runtimeRef.current?.accountId === cfg.accountId &&
        (mode === "single" || armedRef.current);
      try {
        setPhase("Checking contracts_for capability...");
        const freshOffers = await session.contractsFor(cfg.symbol, cfg.currency);
        if (!stillLive()) return;
        const freshSpec = selectOnetouchTickSpec(freshOffers, cfg.pip);
        if (!freshSpec) throw new Error("Deriv no longer offers tick ONETOUCH for " + cfg.symbol + ".");
        setOffers(freshOffers);
        const freshDuration = clampTouchDuration(cfg.duration, freshSpec);
        if (freshDuration !== cfg.duration) {
          setDuration(freshDuration);
          onNotice("Deriv's tick ONETOUCH duration range changed; the straddle was clamped to " + freshDuration + " ticks.", "ok");
        }
        const freshPip = freshSpec.pipSize > 0 ? freshSpec.pipSize : cfg.pip;
        const freshDecimals = decimalsForStep(freshPip);
        const freshBaseOffset = freshSpec.defaultBarrier > 0 ? freshSpec.defaultBarrier : Math.max(freshPip * 2, 0.01);
        const freshOffset = barrierOffsetFor(freshBaseOffset, cfg.barrierPreset, cfg.customOffset, freshPip);
        const freshUpperQuery = formatSignedBarrier(freshOffset, freshDecimals, "upper");
        const freshLowerQuery = formatSignedBarrier(freshOffset, freshDecimals, "lower");
        if (pnlRef.current - cfg.nextCost < -Math.abs(slRef.current) - 0.02) {
          showAdvisor(winsRef.current === 0 ? "SL_ZERO_WINS" : "SL_PARTIAL_WINS", pnlRef.current, winsRef.current, lossesRef.current, cfg.nextCost);
          return;
        }
        setPhase("Pricing both legs with live proposals...");
        const requests = [
          { symbol: cfg.symbol, contract: "ONETOUCH", barrier: freshUpperQuery, duration: freshDuration, stake: cfg.baseStake, currency: cfg.currency },
          { symbol: cfg.symbol, contract: "ONETOUCH", barrier: freshLowerQuery, duration: freshDuration, stake: cfg.baseStake, currency: cfg.currency },
        ];
        const quotes = await session.quoteBundle(requests);
        if (!stillLive()) return;
        const [upperQuote, lowerQuote] = quotes;
        if (!upperQuote || !lowerQuote) throw new Error("Deriv returned fewer than two ONETOUCH proposals.");
        const actualCost = round2(upperQuote.ask + lowerQuote.ask);
        if (pnlRef.current - actualCost < -Math.abs(slRef.current) - 0.02) {
          showAdvisor(winsRef.current === 0 ? "SL_ZERO_WINS" : "SL_PARTIAL_WINS", pnlRef.current, winsRef.current, lossesRef.current, actualCost);
          return;
        }
        setPreview({
          key: quoteKeyFor(cfg.symbol, freshDuration, freshOffset, freshDecimals, cfg.baseStake),
          upper: upperQuote,
          lower: lowerQuote,
          at: Date.now(),
        });
        setQuoteError(null);
        if (!stillLive()) return;
        setPhase("Buying both ONETOUCH legs atomically...");
        const results = await Promise.allSettled([
          session.buy(upperQuote.id, upperQuote.ask),
          session.buy(lowerQuote.id, lowerQuote.ask),
        ]);
        if (!aliveRef.current) return;
        const makeLeg = (side: "upper" | "lower", quote: Quote, result: PromiseSettledResult<number>): StraddleLeg => {
          const barrier = side === "upper" ? freshUpperQuery : freshLowerQuery;
          if (result.status === "fulfilled") {
            return {
              id: result.value,
              side,
              barrier,
              stake: quote.ask,
              payout: quote.payout,
              profit: 0,
              status: "open",
              touched: false,
              settled: false,
            };
          }
          return {
            id: 0,
            side,
            barrier,
            stake: quote.ask,
            payout: quote.payout,
            profit: 0,
            status: "rejected",
            touched: false,
            settled: true,
          };
        };
        const legs = [makeLeg("upper", upperQuote, results[0]), makeLeg("lower", lowerQuote, results[1])];
        const purchased = legs.filter((leg) => leg.id > 0);
        if (purchased.length === 0) {
          setQuoteError("Both ONETOUCH buy calls were rejected by Deriv. No position was opened.");
          onNotice("Both straddle legs were rejected. No position was opened.", "bad");
          setPhase("Both legs rejected - no position");
          return;
        }
        const bundle: ActiveBundle = {
          id: Date.now(),
          symbol: cfg.symbol,
          level: currentLevel,
          duration: freshDuration,
          cost: round2(purchased.reduce((sum, leg) => sum + leg.stake, 0)),
          squeezeRatio: cfg.squeezeRatio,
          barrierOffset: freshOffset,
          upperBarrier: freshUpperQuery,
          lowerBarrier: freshLowerQuery,
          legs,
          startedAt: Date.now(),
          ticksElapsed: 0,
        };
        bundleRef.current = bundle;
        activeIdsRef.current = new Set(purchased.map((leg) => leg.id));
        setOpenBundle(bundle);
        setPhase("Both legs live - watching onContract...");
        if (purchased.length < 2) onNotice("One ONETOUCH leg was rejected. The bought leg remains live and is tracked alone.", "bad");
        const watchResults = await Promise.allSettled(purchased.map((leg) => session.watch(leg.id)));
        if (!aliveRef.current || !bundleRef.current) {
          for (const result of watchResults) {
            if (result.status === "fulfilled" && result.value) void session.forget(result.value);
          }
          return;
        }
        watchResults.forEach((result, index) => {
          if (result.status === "fulfilled" && result.value) subsRef.current.push(result.value);
          else if (result.status === "rejected") onNotice("A contract watch failed for leg " + purchased[index].side + "; settlement will fall back to the timeout check.", "bad");
        });
        armSettlementTimeout();
        setPhase("Straddle live - tick 0 of " + freshDuration);
      } catch (error) {
        if (!aliveRef.current) return;
        const message = (error as Error).message || "The straddle order failed.";
        setQuoteError(message);
        setPreview(null);
        onNotice(message, "bad");
        setPhase(armedRef.current ? "Pricing failed - auto will retry" : "Pricing failed - no order");
      } finally {
        if (aliveRef.current && activeIdsRef.current.size === 0 && !bundleRef.current) {
          execRef.current = false;
          setExecuting(false);
        }
      }
    },
    [currentLevel, onNotice, showAdvisor, armSettlementTimeout, squeezeThreshold],
  );

  const maybeAuto = useCallback(() => {
    const cfg = runtimeRef.current;
    if (!aliveRef.current || !connected || !cfg || !cfg.spec || !armedRef.current) return;
    if (execRef.current || coolingRef.current || bundleRef.current || activeIdsRef.current.size > 0) return;
    if (!cfg.atrReady) {
      setPhase("Armed - filling the 50-tick ATR baseline");
      return;
    }
    if (!cfg.squeezeReady) {
      setPhase("Armed - ratio " + cfg.squeezeRatio.toFixed(2) + "x above " + squeezeThreshold.toFixed(2) + "x");
      return;
    }
    if (Date.now() - autoAttemptRef.current < AUTO_RETRY_MS) return;
    void fireStraddle("auto");
  }, [connected, fireStraddle, squeezeThreshold]);

  maybeAutoRef.current = maybeAuto;

  const armEngine = useCallback(
    (force = false) => {
      const cfg = runtimeRef.current;
      if (!connected) {
        onNotice("Connect to Deriv before arming the straddle engine.", "bad");
        return;
      }
      if (!cfg || !cfg.spec) {
        onNotice("Tick ONETOUCH is not available for this market.", "bad");
        return;
      }
      if (execRef.current || bundleRef.current || activeIdsRef.current.size > 0) {
        onNotice("A straddle is still live. Wait for both legs to settle before arming again.", "bad");
        return;
      }
      if (accountKind === "real" && !realOk && !force) {
        setConfirmText("");
        setConfirmMode("auto");
        return;
      }
      armedRef.current = true;
      setArmed(true);
      autoAttemptRef.current = 0;
      setPhase(cfg.squeezeReady ? "Armed - waiting for the next valid quote" : "Armed - scanning for ATR compression");
      maybeAutoRef.current();
    },
    [accountKind, connected, onNotice, realOk],
  );

  const requestSingle = useCallback(() => {
    const cfg = runtimeRef.current;
    if (!connected || !cfg?.spec) {
      onNotice("Connect and select a tick ONETOUCH market first.", "bad");
      return;
    }
    if (execRef.current || bundleRef.current || activeIdsRef.current.size > 0) return;
    if (!cfg.atrReady) {
      onNotice("The 100-tick ATR baseline is still warming up. Wait for the signal to leave WARMING before firing.", "bad");
      return;
    }
    if (cfg.requireSqueeze && !cfg.squeezeReady) {
      onNotice("Require ATR compression is ON and the ratio is above " + squeezeThreshold.toFixed(2) + "x. Turn the filter off to override manually.", "bad");
      return;
    }
    if (accountKind === "real" && !realOk) {
      setConfirmText("");
      setConfirmMode("single");
      return;
    }
    void fireStraddle("single");
  }, [accountKind, connected, fireStraddle, onNotice, realOk, squeezeThreshold]);

  const toggleEngine = useCallback(() => {
    if (armedRef.current) stopEngine("Paused by user");
    else armEngine();
  }, [armEngine, stopEngine]);

  const resetSession = useCallback(() => {
    if (activeIdsRef.current.size > 0 || bundleRef.current) return;
    stopEngine("Session reset - start when ready");
    execRef.current = false;
    setExecuting(false);
    pnlRef.current = 0;
    winsRef.current = 0;
    lossesRef.current = 0;
    peakLevelRef.current = 0;
    levelRef.current = 0;
    roundNoRef.current = 0;
    setPnl(0);
    setWins(0);
    setLosses(0);
    setPeakLevel(0);
    setMartingaleLevel(0);
    setRounds([]);
    setAdvisor(null);
    setOpenBundle(null);
  }, [stopEngine]);

  useEffect(() => {
    const previous = document.title;
    document.title = "Touch Straddle | Digit Edge";
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (!openBundle) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [openBundle]);

  useEffect(() => {
    if (!connected && armedRef.current) stopEngine("Paused: connection closed");
  }, [connected, stopEngine]);

  useEffect(() => {
    if (prevAccountRef.current === accountId) return;
    prevAccountRef.current = accountId;
    setRealOk(false);
    if (armedRef.current) stopEngine("Paused after account change");
  }, [accountId, stopEngine]);

  tickHandlerRef.current = (tickSymbol: string, tick: Tick) => {
    if (tickSymbol !== symbol || !Number.isFinite(tick.quote) || tick.quote <= 0) return;
    const next = [...pricesRef.current, tick.quote].slice(-ATR_BUFFER_SIZE);
    pricesRef.current = next;
    setPrices(next);
    const bundle = bundleRef.current;
    if (bundle && bundle.ticksElapsed < bundle.duration && activeIdsRef.current.size > 0) {
      const nextBundle = { ...bundle, ticksElapsed: bundle.ticksElapsed + 1 };
      bundleRef.current = nextBundle;
      setOpenBundle(nextBundle);
      setPhase("Straddle live - tick " + nextBundle.ticksElapsed + " of " + nextBundle.duration);
    }
    maybeAutoRef.current();
  };

  useEffect(() => {
    if (!connected || !symbol) {
      setPrices([]);
      pricesRef.current = [];
      return;
    }
    let cancelled = false;
    let subscription = "";
    setPrices([]);
    pricesRef.current = [];
    setPreview(null);
    setQuoteError(null);
    const session = sessionRef.current;
    if (!session) return;
    const handler = tickHandlerRef.current;
    assignedTickHandlerRef.current = handler;
    session.onTickFor = handler;
    void (async () => {
      try {
        const history = await session.history(symbol, ATR_BUFFER_SIZE);
        if (cancelled) return;
        const seed = history.map((tick) => tick.quote).filter((quote) => Number.isFinite(quote) && quote > 0).slice(-ATR_BUFFER_SIZE);
        pricesRef.current = seed;
        setPrices(seed);
        const nextSubscription = await session.subscribeTicksFor(symbol);
        if (cancelled) {
          if (nextSubscription) void session.forget(nextSubscription);
          return;
        }
        subscription = nextSubscription;
      } catch (error) {
        if (!cancelled) onNotice("Could not seed " + symbol + " ticks: " + (error as Error).message, "bad");
      }
    })();
    return () => {
      cancelled = true;
      if (session.onTickFor === handler) session.onTickFor = null;
      if (assignedTickHandlerRef.current === handler) assignedTickHandlerRef.current = null;
      if (subscription) void session.forget(subscription);
    };
  }, [connected, onNotice, sessionRef, symbol]);

  useEffect(() => {
    if (!connected || !symbol) {
      setOffers([]);
      setContractError(null);
      setOffersLoading(false);
      return;
    }
    const session = sessionRef.current;
    if (!session) return;
    let cancelled = false;
    setOffersLoading(true);
    setContractError(null);
    setOffers([]);
    void session
      .contractsFor(symbol, currency)
      .then((list) => {
        if (cancelled) return;
        setOffers(list);
        const candidate = selectOnetouchTickSpec(list, symbolPip);
        if (!candidate) {
          const touchTenors = Array.from(new Set(list.filter((offer) => offer.contractType.toUpperCase() === "ONETOUCH").map((offer) => offer.expiryType)));
          setContractError(
            touchTenors.length === 0
              ? symbol + " has no ONETOUCH contract in contracts_for right now."
              : symbol + " offers ONETOUCH only for " + touchTenors.join(", ") + ", not tick expiry; this page requires tick ONETOUCH.",
          );
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setOffers([]);
          setContractError("contracts_for failed: " + error.message);
        }
      })
      .finally(() => {
        if (!cancelled) setOffersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, connected, currency, sessionRef, symbol, symbolPip]);

  useEffect(() => {
    if (executing || cooling) {
      setPreviewLoading(false);
      return;
    }
    if (!connected || !spec || !symbol) {
      setPreview(null);
      setPreviewLoading(false);
      setQuoteError(null);
      return;
    }
    const session = sessionRef.current;
    if (!session) return;
    let cancelled = false;
    let inFlight = false;
    const key = quoteKey;
    const requests = [
      { symbol, contract: "ONETOUCH", barrier: upperQuery, duration: effectiveDuration, stake: cleanBase, currency },
      { symbol, contract: "ONETOUCH", barrier: lowerQuery, duration: effectiveDuration, stake: cleanBase, currency },
    ];
    const load = (quiet: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (!quiet) {
        setPreviewLoading(true);
        setQuoteError(null);
      }
      void session
        .quoteBundle(requests)
        .then(([upper, lower]) => {
          if (cancelled) return;
          if (!upper || !lower) throw new Error("Deriv returned fewer than two ONETOUCH proposals.");
          setPreview({ key, upper, lower, at: Date.now() });
          setQuoteError(null);
        })
        .catch((error: Error) => {
          if (cancelled) return;
          setQuoteError(error.message);
          setPreview(null);
          if (armedRef.current && !execRef.current) stopEngine("Paused: proposal rejected - adjust barrier");
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) setPreviewLoading(false);
        });
    };
    const timer = window.setTimeout(() => load(false), 300);
    const interval = window.setInterval(() => load(true), QUOTE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [accountId, cleanBase, connected, cooling, currency, effectiveDuration, executing, lowerQuery, quoteKey, quoteNonce, sessionRef, spec, stopEngine, symbol, upperQuery]);

  useEffect(() => {
    if (isSlManual) return;
    slRef.current = riskPlan.autoStopLoss;
    setStopLoss(riskPlan.autoStopLoss);
  }, [isSlManual, riskPlan.autoStopLoss]);

  useEffect(() => {
    if (isTpManual) return;
    tpRef.current = riskPlan.autoTakeProfit;
    setTakeProfit(riskPlan.autoTakeProfit);
  }, [isTpManual, riskPlan.autoTakeProfit]);

  useEffect(() => {
    levelRef.current = currentLevel;
  }, [currentLevel]);

  const downloadCsv = useCallback(() => {
    const escape = (value: string): string => '"' + value.replace(/"/g, '""') + '"';
    const lines = ["Timestamp,Symbol,Upper Barrier,Lower Barrier,Squeeze Ratio,Upper Leg,Lower Leg,Payout,Outcome,Profit"];
    for (const row of rounds) {
      lines.push(
        [
          new Date(row.time).toISOString(),
          row.symbol,
          row.upperBarrier,
          row.lowerBarrier,
          row.squeezeRatio.toFixed(2),
          row.upperStatus,
          row.lowerStatus,
          row.payout.toFixed(2),
          OUTCOME_LABEL[row.outcome],
          row.profit.toFixed(2),
        ]
          .map(escape)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "touch-straddle-rounds.csv";
    link.click();
    URL.revokeObjectURL(url);
  }, [rounds]);

  const selectableGroups = useMemo(
    () =>
      TOUCH_SYMBOL_GROUPS.map((group) => ({
        ...group,
        items: symbols.filter((item) => (group.symbols as readonly string[]).includes(item.symbol)),
      })).filter((group) => group.items.length > 0),
    [symbols],
  );
  const groupedRounds = useMemo(() => {
    const map = new Map<string, RoundRow[]>();
    for (const row of rounds) {
      const list = map.get(row.symbol) ?? [];
      list.push(row);
      map.set(row.symbol, list);
    }
    return Array.from(map.entries());
  }, [rounds]);

  const onSymbolChange = (next: string) => {
    if (armedRef.current || execRef.current || bundleRef.current || activeIdsRef.current.size > 0) return;
    customOffsetTouchedRef.current = false;
    setSymbol(next);
    setOffers([]);
    setContractError(null);
    setPreview(null);
    levelRef.current = 0;
    setMartingaleLevel(0);
    setQuoteError(null);
  };

  const applyPreset = (next: BarrierPreset) => {
    setPreset(next);
    if (next === "custom" && !customOffsetTouchedRef.current && spec?.defaultBarrier) {
      setCustomOffset(spec.defaultBarrier);
    }
  };

  const phaseTone = executing
    ? "border-sky-400/40 bg-sky-400/10 text-sky-300"
    : cooling
      ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
      : armed
        ? "border-accent/50 bg-accent/10 text-accent"
        : "border-line bg-ink text-muted";

  const sourceMeta = spec
    ? "Tick ONETOUCH " + spec.minTicks + "-" + spec.maxTicks + "t · default ±" + spec.defaultBarrier.toFixed(decimals) + " · pip " + pip.toFixed(decimals)
    : "Tick ONETOUCH unavailable";

  return (
    <section className="px-4 py-4 sm:px-5">
      {!connected ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded border border-accent/40 bg-accent/10 px-4 py-3 text-xs text-accent">
          <span>The dual one-touch straddle reuses the terminal session. Connect a Deriv token to calibrate and trade.</span>
          <button type="button" onClick={onConnect} className="rounded bg-accent px-3 py-1 font-medium text-ink">Connect</button>
        </div>
      ) : null}

      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] text-muted">Page 3 · One-touch volatility</p>
            <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-100">Dual One-Touch Whipsaw Straddle</h1>
          </div>
          <p className="max-w-md text-[10px] leading-relaxed text-muted">Buy the upper and lower ONETOUCH barriers at the same moment. One touch pays one leg; a whipsaw touches both.</p>
        </div>

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-[240px]">
              <label htmlFor="touch-market" className="text-[10px] uppercase tracking-widest text-muted">Market</label>
              <select
                id="touch-market"
                value={symbol}
                disabled={!connected || armed || executing || !!openBundle}
                onChange={(event) => onSymbolChange(event.target.value)}
                className="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5 text-xs disabled:opacity-50"
              >
                {symbols.length === 0 ? <option value="">Connect to load symbols</option> : null}
                {selectableGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.items.map((item) => (
                      <option key={item.symbol} value={item.symbol}>{item.symbol} - {item.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-muted">{symbolInfo?.name ?? "Select a supported synthetic index"}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-widest text-muted">Live spot</p>
              <p className="font-mono text-2xl text-slate-100">{spot > 0 ? spot.toFixed(decimals) : "-"}</p>
              <p className="text-[10px] text-muted">{symbol || "no symbol"} · {prices.length} / {ATR_BUFFER_SIZE} ticks</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <label className="text-muted">Account</label>
            <select
              value={accountId}
              disabled={!connected || accounts.length <= 1 || armed || executing || !!openBundle}
              onChange={(event) => onAccountChange(event.target.value)}
              className="rounded border border-line bg-ink px-2 py-1 text-xs disabled:opacity-50"
            >
              {accounts.length === 0 ? <option value="">Not connected</option> : null}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.id} ({account.kind})</option>
              ))}
            </select>
            <span className="text-muted">{balance !== null ? balance.toFixed(2) : "-"} {currency}</span>
            <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-muted">{sourceMeta}</span>
            <span className={"ml-auto rounded-full border px-2 py-0.5 text-[10px] " + phaseTone}>{executing ? "EXECUTING" : cooling ? "COOLDOWN" : armed ? "AUTO ARMED" : "PAUSED"}</span>
          </div>

          {offersLoading ? <p className="mt-2 text-[10px] text-muted">Loading contracts_for capabilities...</p> : null}
          {contractError ? (
            <div className="mt-2 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger" role="alert">
              {contractError} Start and single-fire are disabled until Deriv offers a tick ONETOUCH contract.
            </div>
          ) : null}
          {!contractError && spec ? (
            <p className="mt-2 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-[10px] text-accent">
              Dynamic contracts_for check passed. Duration is clamped to {spec.minTicks}-{spec.maxTicks} ticks; both barriers are re-priced from live proposals before every order.
            </p>
          ) : null}
          {spec && spec.defaultBarrier <= 0 ? (
            <p className="mt-2 text-[10px] text-amber-300">Deriv did not publish a default barrier; the page uses a {fallbackOffset.toFixed(decimals)} fallback offset.</p>
          ) : null}
        </article>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <BarrierChannelVisualizer
            symbol={symbol}
            prices={prices}
            upperBarrier={upperBarrierPrice}
            lowerBarrier={lowerBarrierPrice}
            decimals={decimals}
            fastAtr={atr.fastAtr}
            baselineAtr={atr.baselineAtr}
            squeezeRatio={atr.squeezeRatio}
            threshold={squeezeThreshold}
            squeezeReady={squeezeReady}
            ready={ready}
          />

          <article className="rounded border border-line bg-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold tracking-tight">Signal &amp; sizing</h2>
                <p className="mt-0.5 text-[10px] text-muted">ATR(10)/ATR(50) compression filter, then two simultaneous touch quotes.</p>
              </div>
              <span className={"rounded-full border px-2 py-0.5 text-[9px] font-semibold " + (squeezeReady ? "border-accent/50 bg-accent/10 text-accent" : "border-amber-400/40 bg-amber-400/10 text-amber-300")}>
                {squeezeReady ? "SIGNAL READY" : ready ? "WAITING" : "WARMING"}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              {BARRIER_PRESETS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={buyBlocked}
                  onClick={() => applyPreset(entry.id)}
                  className={"rounded border px-2.5 py-2 text-left text-[11px] transition disabled:opacity-50 " + (preset === entry.id ? "border-accent bg-accent/10 text-accent" : "border-line bg-ink text-slate-300 hover:border-muted")}
                >
                  <span className="block font-semibold">{entry.label}</span>
                  <span className="mt-0.5 block text-[9px] leading-relaxed text-muted">{entry.blurb}</span>
                </button>
              ))}
            </div>
            {preset === "custom" ? (
              <div className="mt-2">
                <Field label={"Custom absolute offset (± " + decimals + " dp)"}>
                  <input
                    type="number"
                    min={pip}
                    step={pip}
                    value={customOffset}
                    disabled={buyBlocked}
                    onChange={(event) => {
                      customOffsetTouchedRef.current = true;
                      setCustomOffset(roundToStep(Math.max(pip, Math.abs(Number(event.target.value) || pip)), pip));
                    }}
                    className={inputClass}
                  />
                </Field>
              </div>
            ) : null}
            <p className="mt-2 rounded border border-line bg-ink px-2.5 py-2 font-mono text-[10px] text-slate-300">
              Upper {spot > 0 ? upperQuery + " → " + upperBarrierPrice.toFixed(decimals) : upperQuery} <span className="text-muted">·</span> Lower {spot > 0 ? lowerQuery + " → " + lowerBarrierPrice.toFixed(decimals) : lowerQuery}
            </p>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Field label={"Duration (ticks) · allowed " + (spec ? spec.minTicks + "-" + spec.maxTicks : "-")}>
                <input
                  type="number"
                  min={spec?.minTicks ?? 1}
                  max={spec?.maxTicks ?? MAX_DURATION_TICKS}
                  step={1}
                  value={effectiveDuration}
                  disabled={buyBlocked || !spec}
                  onChange={(event) => setDuration(clampTouchDuration(Number(event.target.value), spec))}
                  className={inputClass}
                />
              </Field>
              <Field label={"Stake per leg (" + currency + ") · min 0.35"}>
                <input
                  type="number"
                  min={MIN_LEG_STAKE}
                  step={0.05}
                  value={baseStake}
                  disabled={buyBlocked}
                  onChange={(event) => setBaseStake(round2(Math.max(MIN_LEG_STAKE, Number(event.target.value) || MIN_LEG_STAKE)))}
                  className={inputClass}
                />
              </Field>
            </div>
            <p className="mt-1 font-mono text-[10px] text-muted">Level {currentLevel} · {cleanBase.toFixed(2)} × 2 = {currentCost.toFixed(2)} {currency} total straddle cost</p>

            <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-300">
              <input type="checkbox" checked={requireSqueeze} onChange={(event) => setRequireSqueeze(event.target.checked)} disabled={buyBlocked} />
              Require ATR compression before auto-firing
            </label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Field label="Squeeze threshold (fast / baseline)">
                <input
                  type="number"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={squeezeThreshold}
                  disabled={buyBlocked || !requireSqueeze}
                  onChange={(event) => setSqueezeThreshold(clamp(Number(event.target.value), 0.1, 2))}
                  className={inputClass}
                />
              </Field>
              <div className="rounded border border-line bg-ink px-3 py-2 text-[10px] text-muted">
                <p className="font-mono text-xs text-slate-100">ratio {atr.ready ? atr.squeezeRatio.toFixed(2) + "x" : "-"}</p>
                <p>{requireSqueeze ? (squeezeReady ? "Compression pass - auto may fire." : "Compression not ready - auto holds.") : "Filter bypassed - auto may fire after the baseline fills."}</p>
              </div>
            </div>

            <div className={"mt-3 rounded border px-3 py-2 text-[10px] " + phaseTone} aria-live="polite">{phase}</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={toggleEngine}
                disabled={!canStart && !armed}
                className={"rounded px-3 py-2 text-xs font-semibold disabled:opacity-40 " + (armed ? "border border-amber-400/50 bg-amber-400/10 text-amber-300" : "bg-accent text-ink")}
              >
                {armed ? "Pause Auto-Straddle" : "Start Auto-Straddle"}
              </button>
              <button
                type="button"
                onClick={requestSingle}
                disabled={!canStart}
                className="rounded border border-line bg-ink px-3 py-2 text-xs font-medium text-slate-200 hover:border-accent disabled:opacity-40"
              >
                Fire Single Straddle
              </button>
            </div>
            <p className="mt-2 text-[9px] leading-relaxed text-muted">
              Auto waits for the selected preset to be priced, both legs to fill, both contracts to report is_sold, and a {COOLDOWN_MS / 1000}s post-round cooldown. One leg rejected never releases the lock on the other.
            </p>
          </article>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <article className="rounded border border-line bg-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold tracking-tight">Live payout matrix</h2>
                <p className="mt-0.5 text-[10px] text-muted">Both ONETOUCH proposals are calibrated with the exact signed barriers above.</p>
              </div>
              <button
                type="button"
                onClick={() => setQuoteNonce((value) => value + 1)}
                disabled={!canPrice || buyBlocked}
                className="rounded border border-line px-2 py-1 text-[10px] text-muted hover:text-slate-100 disabled:opacity-40"
              >
                {previewLoading ? "Refreshing..." : "Refresh quotes"}
              </button>
            </div>
            {quoteError ? <p className="mt-2 rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-[10px] leading-relaxed text-danger" role="alert">{quoteError} Try a different preset or custom offset.</p> : null}
            <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded border border-line bg-ink px-3 py-2">
                <dt className="text-[9px] uppercase tracking-widest text-muted">Total cost</dt>
                <dd className="font-mono text-sm text-slate-100">{payoutPreview ? payoutPreview.cost.toFixed(2) : currentCost.toFixed(2)} {currency}</dd>
              </div>
              <div className="rounded border border-line bg-ink px-3 py-2">
                <dt className="text-[9px] uppercase tracking-widest text-muted">Double payout multiple</dt>
                <dd className="font-mono text-sm text-slate-100">{payoutMultiple ? payoutMultiple.toFixed(2) + "x" : "-"}</dd>
              </div>
            </dl>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[9px] uppercase tracking-widest text-muted">
                  <tr><th className="py-1 pr-2">Scenario</th><th className="py-1 pr-2">Payout</th><th className="py-1 pr-2">Net P&amp;L</th><th className="py-1 pr-2">ROI</th></tr>
                </thead>
                <tbody className="font-mono">
                  <tr className="border-t border-line/60">
                    <td className="py-1.5 pr-2 text-slate-200">Upper touch only</td>
                    <td className="py-1.5 pr-2">{payoutPreview ? payoutPreview.upperPayout.toFixed(2) : "-"}</td>
                    <td className={"py-1.5 pr-2 " + (payoutPreview && payoutPreview.upperNet >= 0 ? "text-accent" : "text-danger")}>{payoutPreview ? (payoutPreview.upperNet >= 0 ? "+" : "") + payoutPreview.upperNet.toFixed(2) : "-"}</td>
                    <td className="py-1.5 pr-2 text-muted">{payoutPreview ? (payoutPreview.upperRoi >= 0 ? "+" : "") + payoutPreview.upperRoi.toFixed(1) + "%" : "-"}</td>
                  </tr>
                  <tr className="border-t border-line/60">
                    <td className="py-1.5 pr-2 text-slate-200">Lower touch only</td>
                    <td className="py-1.5 pr-2">{payoutPreview ? payoutPreview.lowerPayout.toFixed(2) : "-"}</td>
                    <td className={"py-1.5 pr-2 " + (payoutPreview && payoutPreview.lowerNet >= 0 ? "text-accent" : "text-danger")}>{payoutPreview ? (payoutPreview.lowerNet >= 0 ? "+" : "") + payoutPreview.lowerNet.toFixed(2) : "-"}</td>
                    <td className="py-1.5 pr-2 text-muted">{payoutPreview ? (payoutPreview.lowerRoi >= 0 ? "+" : "") + payoutPreview.lowerRoi.toFixed(1) + "%" : "-"}</td>
                  </tr>
                  <tr className="border-t border-line/60 bg-accent/5">
                    <td className="py-1.5 pr-2 font-semibold text-accent">Whipsaw / both touch</td>
                    <td className="py-1.5 pr-2 text-accent">{payoutPreview ? payoutPreview.doublePayout.toFixed(2) : "-"}</td>
                    <td className={"py-1.5 pr-2 " + (payoutPreview && payoutPreview.doubleNet >= 0 ? "text-accent" : "text-danger")}>{payoutPreview ? (payoutPreview.doubleNet >= 0 ? "+" : "") + payoutPreview.doubleNet.toFixed(2) : "-"}</td>
                    <td className="py-1.5 pr-2 text-muted">{payoutPreview ? (payoutPreview.doubleRoi >= 0 ? "+" : "") + payoutPreview.doubleRoi.toFixed(1) + "%" : "-"}</td>
                  </tr>
                  <tr className="border-t border-line/60">
                    <td className="py-1.5 pr-2 text-slate-200">Quiet / neither touches</td>
                    <td className="py-1.5 pr-2">0.00</td>
                    <td className="py-1.5 pr-2 text-danger">{payoutPreview ? payoutPreview.quietNet.toFixed(2) : -currentCost.toFixed(2)}</td>
                    <td className="py-1.5 pr-2 text-muted">-100%</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[9px] leading-relaxed text-muted">
              {livePreview ? "Quotes calibrated " + new Date(livePreview.at).toLocaleTimeString() + ". " : "Waiting for two live proposals. "}
              A single touch pays that leg's exact proposal payout; a whipsaw needs both barriers touched inside the same {effectiveDuration}-tick window. Both calls are re-priced immediately before any buy.
            </p>
          </article>

          <article className="rounded border border-line bg-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold tracking-tight">Martingale &amp; risk ladder</h2>
                <p className="mt-0.5 text-[10px] text-muted">Optional recovery. Default OFF; when ON, the stop loss budgets one complete cycle through Max Levels.</p>
              </div>
              <span className={"rounded-full border px-2 py-0.5 text-[9px] font-semibold " + (martingaleOn ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-line bg-ink text-muted")}>{martingaleOn ? "MARTINGALE ON" : "FLAT STAKE"}</span>
            </div>
            <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={martingaleOn}
                disabled={buyBlocked}
                onChange={(event) => {
                  setMartingaleOn(event.target.checked);
                  if (!event.target.checked) {
                    levelRef.current = 0;
                    setMartingaleLevel(0);
                  }
                }}
              />
              Enable Martingale recovery
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="Multiplier">
                <select
                  value={multiplierChoice}
                  disabled={buyBlocked || !martingaleOn}
                  onChange={(event) => setMultiplierChoice(event.target.value as MultiplierChoice)}
                  className={inputClass}
                >
                  {MARTINGALE_MULTIPLIERS.map((value) => (
                    <option key={value} value={value}>{value.toFixed(2)}×</option>
                  ))}
                  <option value="custom">Custom</option>
                </select>
              </Field>
              <Field label={"Max Levels (1 - " + MAX_LEVELS + ")"}>
                <input
                  type="number"
                  min={1}
                  max={MAX_LEVELS}
                  step={1}
                  value={maxLevels}
                  disabled={buyBlocked || !martingaleOn}
                  onChange={(event) => setMaxLevels(clamp(Math.round(Number(event.target.value)), 1, MAX_LEVELS))}
                  className={inputClass}
                />
              </Field>
            </div>
            {multiplierChoice === "custom" ? (
              <div className="mt-2">
                <Field label="Custom multiplier (1.05 - 5.00)">
                  <input
                    type="number"
                    min={1.05}
                    max={5}
                    step={0.05}
                    value={customMultiplier}
                    disabled={buyBlocked || !martingaleOn}
                    onChange={(event) => setCustomMultiplier(clamp(Number(event.target.value), 1.05, 5))}
                    className={inputClass}
                  />
                </Field>
              </div>
            ) : null}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[10px]">
                <thead className="text-[9px] uppercase tracking-widest text-muted">
                  <tr><th className="py-1 pr-2">Level</th><th className="py-1 pr-2">Leg stake</th><th className="py-1 pr-2">2-leg cost</th><th className="py-1 pr-2">Cumulative</th></tr>
                </thead>
                <tbody className="font-mono">
                  {riskPlan.levels.map((level) => (
                    <tr key={level.level} className={"border-t border-line/60 " + (level.level === currentLevel ? "bg-accent/5 text-accent" : "text-slate-300")}>
                      <td className="py-1 pr-2">L{level.level}</td>
                      <td className="py-1 pr-2">{level.legStake.toFixed(2)}</td>
                      <td className="py-1 pr-2">{level.straddleCost.toFixed(2)}</td>
                      <td className="py-1 pr-2">{level.cumulativeCost.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted">
              <span>Current L{currentLevel} · next straddle {nextCost.toFixed(2)} {currency}</span>
              <button type="button" onClick={resetSession} disabled={buyBlocked || activeIdsRef.current.size > 0} className="rounded border border-line px-2 py-1 text-[10px] text-muted hover:text-slate-100 disabled:opacity-40">Reset session</button>
            </div>
          </article>
        </div>

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Auto Stop Loss / Take Profit</h2>
              <p className="mt-0.5 text-[10px] text-muted">Editable, with Auto/Custom badges and a pre-trade headroom guard.</p>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px]">
              <span className="rounded border border-line bg-ink px-2 py-1 font-mono">Cycle risk {riskPlan.rawCycleCost.toFixed(2)}</span>
              <span className="rounded border border-line bg-ink px-2 py-1 font-mono">Buffer {riskPlan.recommendedBuffer.toFixed(2)}</span>
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-line bg-ink/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="touch-stop-loss" className="text-[10px] uppercase tracking-widest text-muted">Stop Loss ({currency})</label>
                <span className="flex items-center gap-2">
                  <span className={"rounded-full px-2 py-0.5 text-[9px] font-semibold " + (isSlManual ? "bg-amber-400/15 text-amber-300" : "bg-accent/10 text-accent")}>{isSlManual ? "Custom" : "Auto"}</span>
                  {isSlManual ? <button type="button" onClick={() => { setIsSlManual(false); setStopLoss(riskPlan.autoStopLoss); slRef.current = riskPlan.autoStopLoss; }} className="text-[9px] text-amber-300 underline decoration-dotted">Reset to Auto</button> : null}
                </span>
              </div>
              <input
                id="touch-stop-loss"
                type="number"
                min={MIN_LEG_STAKE}
                step={0.05}
                value={slFocused ? stopLoss : stopLoss.toFixed(2)}
                disabled={buyBlocked}
                onFocus={() => setSlFocused(true)}
                onBlur={() => setSlFocused(false)}
                onChange={(event) => {
                  const next = round2(Math.max(MIN_LEG_STAKE, Number(event.target.value) || MIN_LEG_STAKE));
                  setIsSlManual(true);
                  setStopLoss(next);
                  slRef.current = next;
                }}
                className={inputClass + " mt-1"}
              />
              <p className="mt-1 text-[9px] leading-relaxed text-muted">
                Martingale OFF: 4× the flat two-leg cost. ON: one complete L0-L{riskPlan.effectiveMaxLevels} cycle. Auto now {riskPlan.autoStopLoss.toFixed(2)}.
              </p>
            </div>
            <div className="rounded border border-line bg-ink/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="touch-take-profit" className="text-[10px] uppercase tracking-widest text-muted">Take Profit ({currency})</label>
                <span className="flex items-center gap-2">
                  <span className={"rounded-full px-2 py-0.5 text-[9px] font-semibold " + (isTpManual ? "bg-amber-400/15 text-amber-300" : "bg-accent/10 text-accent")}>{isTpManual ? "Custom" : "Auto"}</span>
                  {isTpManual ? <button type="button" onClick={() => { setIsTpManual(false); setTakeProfit(riskPlan.autoTakeProfit); tpRef.current = riskPlan.autoTakeProfit; }} className="text-[9px] text-amber-300 underline decoration-dotted">Reset to Auto</button> : null}
                </span>
              </div>
              <input
                id="touch-take-profit"
                type="number"
                min={MIN_LEG_STAKE}
                step={0.25}
                value={tpFocused ? takeProfit : takeProfit.toFixed(2)}
                disabled={buyBlocked}
                onFocus={() => setTpFocused(true)}
                onBlur={() => setTpFocused(false)}
                onChange={(event) => {
                  const next = round2(Math.max(0.25, Number(event.target.value) || 0.25));
                  setIsTpManual(true);
                  setTakeProfit(next);
                  tpRef.current = next;
                }}
                className={inputClass + " mt-1"}
              />
              <p className="mt-1 text-[9px] leading-relaxed text-muted">
                Auto: 3× the smaller single-side net (payout minus both asks), or 65% of Auto SL, whichever is larger, rounded to the nearest 0.25. Auto now {riskPlan.autoTakeProfit.toFixed(2)}.
              </p>
            </div>
          </div>
          <p className="mt-2 text-[9px] leading-relaxed text-muted">
            Before every order the engine checks the actual next straddle cost against the remaining room to SL. If losing that straddle would breach the limit, no quote or buy is sent and the advisor explains why. Manual SL/TP are never overwritten by later stake or level changes.
          </p>
        </article>

        {openBundle ? (
          <article className="rounded border border-accent/40 bg-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold tracking-tight">Active straddle · Tick {openBundle.ticksElapsed} of {openBundle.duration}</h2>
                <p className="mt-0.5 text-[10px] text-muted">{openBundle.symbol} · L{openBundle.level} · {openBundle.upperBarrier} / {openBundle.lowerBarrier} · cost {openBundle.cost.toFixed(2)} {currency}</p>
              </div>
              <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[9px] font-semibold text-accent">DUAL LEGS LOCKED</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: clamp((openBundle.ticksElapsed / Math.max(1, openBundle.duration)) * 100, 0, 100) + "%" }} />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {openBundle.legs.map((leg) => (
                <div key={leg.side} className={"rounded border p-3 " + legTone(leg)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-widest">{leg.side} ONETOUCH</span>
                    <span className="rounded-full border border-current px-2 py-0.5 text-[9px] font-semibold">{legLabel(leg)}</span>
                  </div>
                  <p className="mt-2 font-mono text-lg text-slate-100">{leg.barrier}</p>
                  <div className="mt-1 flex flex-wrap justify-between gap-2 font-mono text-[10px] text-muted">
                    <span>stake {leg.stake.toFixed(2)}</span>
                    <span>payout {leg.payout.toFixed(2)}</span>
                    <span>P/L {leg.profit >= 0 ? "+" : ""}{leg.profit.toFixed(2)}</span>
                  </div>
                  {leg.id > 0 ? <p className="mt-1 font-mono text-[9px] text-muted">contract #{leg.id}</p> : <p className="mt-1 text-[9px] text-amber-300">Buy rejected; no contract.</p>}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[9px] leading-relaxed text-muted">
              Settlement lock holds until both bought contracts report <span className="font-mono">is_sold === 1</span> and the post-round cooldown ends. Early touches are reflected immediately; the other leg stays live.
            </p>
          </article>
        ) : null}

        <article className="rounded border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Round history</h2>
              <p className="mt-0.5 text-[10px] text-muted">Grouped by market. Wins/losses count winning rounds, not individual legs.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] text-muted">Session {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} {currency} · {rounds.length} rounds · {wins}W / {losses}L · peak L{peakLevel}</span>
              <button type="button" onClick={downloadCsv} disabled={rounds.length === 0} className="rounded border border-line px-2 py-1 text-[10px] text-muted hover:text-slate-100 disabled:opacity-40">Download CSV</button>
            </div>
          </div>
          {groupedRounds.length === 0 ? (
            <p className="mt-3 rounded border border-line bg-ink px-3 py-4 text-center text-[11px] text-muted">No settled straddles yet. Start with Demo and let both legs finish before judging the barrier preset.</p>
          ) : (
            <div className="mt-3 space-y-4">
              {groupedRounds.map(([groupSymbol, groupRows]) => (
                <div key={groupSymbol}>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted">{groupSymbol} · {groupRows.length} rounds</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[10px]">
                      <thead className="text-[9px] uppercase tracking-widest text-muted">
                        <tr><th className="py-1 pr-2">Time</th><th className="py-1 pr-2">Barriers</th><th className="py-1 pr-2">L</th><th className="py-1 pr-2">Squeeze</th><th className="py-1 pr-2">Upper</th><th className="py-1 pr-2">Lower</th><th className="py-1 pr-2">Payout</th><th className="py-1 pr-2">Outcome</th><th className="py-1 pr-2">P&amp;L</th></tr>
                      </thead>
                      <tbody className="font-mono">
                        {groupRows.map((row) => (
                          <tr key={row.id} className="border-t border-line/60">
                            <td className="py-1 pr-2 text-muted">{new Date(row.time).toLocaleTimeString()}</td>
                            <td className="py-1 pr-2">{row.upperBarrier} / {row.lowerBarrier}</td>
                            <td className="py-1 pr-2">L{row.level}</td>
                            <td className="py-1 pr-2">{row.squeezeRatio.toFixed(2)}x</td>
                            <td className={"py-1 pr-2 " + (row.upperStatus === "TOUCHED" ? "text-accent" : row.upperStatus === "REJECTED" ? "text-amber-300" : "text-muted")}>{row.upperStatus}</td>
                            <td className={"py-1 pr-2 " + (row.lowerStatus === "TOUCHED" ? "text-accent" : row.lowerStatus === "REJECTED" ? "text-amber-300" : "text-muted")}>{row.lowerStatus}</td>
                            <td className="py-1 pr-2">{row.payout.toFixed(2)}</td>
                            <td className="py-1 pr-2"><span className={"rounded-full border px-1.5 py-0.5 text-[8px] font-semibold " + outcomeTone(row.outcome)}>{OUTCOME_LABEL[row.outcome]}</span></td>
                            <td className={"py-1 pr-2 " + (row.profit >= 0 ? "text-accent" : "text-danger")}>{row.profit >= 0 ? "+" : ""}{row.profit.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>

        <p className="pb-4 text-[9px] leading-relaxed text-muted">
          Honest caveat: DIGITMATCH and ONETOUCH are house-priced products with negative expected value; both legs can pay, one can pay, or neither can touch. This page automates execution and risk limits but cannot change the underlying odds. Verify every contract on Deriv and use Demo first.
        </p>
      </div>

      {confirmMode ? (
        <Modal title={confirmMode === "auto" ? "Start straddle engine on Real money" : "Fire one straddle on Real money"} onClose={() => setConfirmMode(null)}>
          <p className="text-[11px] leading-relaxed text-slate-300">
            You are about to send {confirmMode === "auto" ? "an auto-straddle engine that can fire repeatedly" : "one simultaneous two-leg ONETOUCH order"} to the <span className="font-semibold text-danger">REAL</span> account {accountId}. Two legs are bought in one Promise.all; a single touch pays that leg, a whipsaw needs both.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <div><dt className="text-[9px] uppercase tracking-widest text-muted">Market</dt><dd className="font-mono">{symbol} · {effectiveDuration} ticks</dd></div>
            <div><dt className="text-[9px] uppercase tracking-widest text-muted">Barriers</dt><dd className="font-mono">{upperQuery} / {lowerQuery}</dd></div>
            <div><dt className="text-[9px] uppercase tracking-widest text-muted">Stake</dt><dd className="font-mono">{cleanBase.toFixed(2)} × 2 = {currentCost.toFixed(2)} {currency}</dd></div>
            <div><dt className="text-[9px] uppercase tracking-widest text-muted">SL / TP</dt><dd className="font-mono">{stopLoss.toFixed(2)} / {takeProfit.toFixed(2)}</dd></div>
          </dl>
          <label className="mt-3 block text-[11px] text-muted">
            Type <span className="font-mono font-semibold text-danger">REAL</span> to confirm
            <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} className={inputClass + " mt-1"} autoComplete="off" spellCheck={false} />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmMode(null)} className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:text-slate-100">Cancel</button>
            <button
              type="button"
              disabled={confirmText.trim().toUpperCase() !== "REAL"}
              onClick={() => {
                const mode = confirmMode;
                setRealOk(true);
                setConfirmMode(null);
                if (mode === "auto") armEngine(true);
                else void fireStraddle("single");
              }}
              className="rounded bg-danger px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40"
            >
              {confirmMode === "single" ? "Fire on real money" : "Start on real money"}
            </button>
          </div>
        </Modal>
      ) : null}

      <SessionAdvisorModal
        open={advisor !== null}
        state={advisor}
        currency={currency}
        variant="straddle"
        onDismiss={() => setAdvisor(null)}
        onReset={resetSession}
      />
    </section>
  );
}
