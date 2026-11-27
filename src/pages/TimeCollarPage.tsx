import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { DerivError } from "@/deriv";
import type { Account, ContractOffer, DerivSession, Quote, SymbolInfo, Tick } from "@/deriv";
import CollarCorridorVisualizer from "@/components/CollarCorridorVisualizer";
import SessionAdvisorModal from "@/components/SessionAdvisorModal";
import type { SessionAdvisorMode, SessionAdvisorState } from "@/components/SessionAdvisorModal";
import {
  COLLAR_BUFFER_SIZE,
  COLLAR_COOLDOWN_MS,
  COLLAR_DEFAULT_CORRIDOR,
  COLLAR_DEFAULT_DURATION,
  COLLAR_DEFAULT_IMPULSE,
  COLLAR_DEFAULT_MARTINGALE,
  COLLAR_DEFAULT_MIN_LOCK_TICK,
  COLLAR_DEFAULT_STAKE,
  COLLAR_FALLBACK_MULTIPLE,
  COLLAR_MAX_MARTINGALE_LEVELS,
  COLLAR_MIN_CONTRACT_TICKS,
  COLLAR_MIN_DURATION,
  COLLAR_MIN_STAKE,
  COLLAR_TP_MULTIPLE,
  COLLAR_WEIGHTED_LEG1,
  buildCollarPayoffMatrix,
  clamp,
  clampCollarDuration,
  clampLockStart,
  classifyCollarOutcome,
  collarLockWindow,
  computeCollarImpulse,
  computeCollarRiskPlan,
  corridorWidth,
  decimalsForPip,
  directionLabel,
  formatPrice,
  leg2DurationFor,
  lockConditionMet,
  maxCollarDuration,
  nextCollarLevel,
  oppositeSide,
  round2,
  roundStake,
  selectCollarSpec,
  selectImpulseSide,
  sideLabel,
  stakesForLevel,
  targetSpotFor,
} from "@/utils/collarMath";
import type { CollarContractSpec, CollarDirectionMode, CollarOutcome, CollarPreset, CollarRiskPlan, CollarSide } from "@/utils/collarMath";

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
  bindContractListener: (handler: ((payload: unknown) => void) | null) => void;
}

interface CollarLeg {
  id: number;
  role: "leg1" | "leg2";
  side: CollarSide;
  stake: number;
  payout: number;
  profit: number;
  status: "open" | "won" | "lost";
  settled: boolean;
  entrySpot: number | null;
  entryEpoch: number | null;
}

interface ActiveCollar {
  id: number;
  symbol: string;
  side: CollarSide;
  duration: number;
  contractMinTicks: number;
  minLockTick: number;
  lockStart: number;
  lockEnd: number;
  minCorridor: number;
  atrAtEntry: number;
  entrySpot: number | null;
  entryEpoch: number | null;
  ticksElapsed: number;
  lockSpot: number | null;
  lockTick: number | null;
  leg2Duration: number | null;
  locked: boolean;
  alignmentWarning: boolean;
  leg1Stake: number;
  leg2Stake: number;
  cost: number;
  legs: CollarLeg[];
  startedAt: number;
  martingaleLevel: number;
}

interface CollarRow {
  time: number;
  symbol: string;
  direction: string;
  lockStatus: string;
  width: number;
  leg1Pnl: number;
  leg2Pnl: number;
  outcome: CollarOutcome;
  net: number;
}

interface CollarPreview {
  key: string;
  call1: Quote;
  put1: Quote;
  call2: Quote;
  put2: Quote;
  fetchedAt: number;
}

interface ContractFrame {
  id: number;
  sold: boolean;
  profit: number | null;
  status: string;
  entrySpot: number | null;
  entryEpoch: number | null;
  payout: number | null;
}

interface CollarRuntime {
  connected: boolean;
  accountId: string;
  symbol: string;
  currency: string;
  duration: number;
  minLockTick: number;
  minCorridor: number;
  spec: CollarContractSpec | null;
  streaming: boolean;
  pip: number;
  leg1Stake: number;
  leg2Stake: number;
  currentLevel: number;
  martingaleOn: boolean;
  martingaleMultiplier: number;
  martingaleMaxLevels: number;
  riskPlan: CollarRiskPlan;
  stopLoss: number;
  takeProfit: number;
}

const DEFAULT_RISK = computeCollarRiskPlan({
  leg1Stake: COLLAR_DEFAULT_STAKE,
  leg2Stake: COLLAR_DEFAULT_STAKE,
  martingaleEnabled: false,
  multiplier: COLLAR_DEFAULT_MARTINGALE,
  maxLevels: COLLAR_MAX_MARTINGALE_LEVELS,
});

const PREVIEW_REFRESH_MS = 20000;

const MARKETS: Array<{ group: string; items: Array<{ symbol: string; label: string }> }> = [
  {
    group: "1-Second Volatility",
    items: [
      { symbol: "1HZ10V", label: "1HZ10V" },
      { symbol: "1HZ25V", label: "1HZ25V" },
      { symbol: "1HZ50V", label: "1HZ50V" },
      { symbol: "1HZ75V", label: "1HZ75V" },
      { symbol: "1HZ100V", label: "1HZ100V" },
    ],
  },
  {
    group: "Standard Volatility",
    items: [
      { symbol: "R_10", label: "R_10" },
      { symbol: "R_25", label: "R_25" },
      { symbol: "R_50", label: "R_50" },
      { symbol: "R_75", label: "R_75" },
      { symbol: "R_100", label: "R_100" },
    ],
  },
  {
    group: "Drift Switching",
    items: [
      { symbol: "DSI10", label: "DSI10" },
      { symbol: "DSI20", label: "DSI20" },
      { symbol: "DSI30", label: "DSI30" },
    ],
  },
];

const MARKET_NAMES = new Map(MARKETS.flatMap((group) => group.items.map((item) => [item.symbol, item.label] as const)));
const SUPPORTED_SYMBOLS = new Set(MARKETS.flatMap((group) => group.items.map((item) => item.symbol)));

const inputClass = "w-full rounded border border-line bg-ink px-2 py-1.5 font-mono text-[11px] text-slate-100 outline-none transition focus:border-accent/60";
const buttonBase = "rounded border px-2.5 py-1.5 text-[10px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40";

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOf(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function contractFrame(raw: unknown): ContractFrame {
  const payload = recordOf(raw);
  const soldRaw = payload.is_sold;
  return {
    id: numeric(payload.contract_id) ?? 0,
    sold: soldRaw === 1 || soldRaw === "1" || soldRaw === true,
    profit: numeric(payload.profit),
    status: String(payload.status ?? ""),
    entrySpot: numeric(payload.entry_tick) ?? numeric(payload.entry_spot),
    entryEpoch: numeric(payload.entry_tick_time) ?? numeric(payload.date_start),
    payout: numeric(payload.payout),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function ambiguousPurchase(error: unknown): boolean {
  if (!(error instanceof DerivError)) return true;
  return error.code === "Timeout" || error.code === "Socket" || error.code === "NoContract";
}

function alreadySubscribed(error: unknown): boolean {
  return error instanceof DerivError && error.code === "AlreadySubscribed";
}

function signedMoney(value: number, currency: string): string {
  return (value >= 0 ? "+$" : "-$") + Math.abs(value).toFixed(2) + (currency ? " " + currency : "");
}

function costMoney(value: number, currency: string): string {
  return "$" + Math.max(0, value).toFixed(2) + (currency ? " " + currency : "");
}

function phaseTone(phase: string): string {
  const text = phase.toLowerCase();
  if (text.includes("locked") || text.includes("timeout") || text.includes("error") || text.includes("failed") || text.includes("rejected")) {
    return "border-danger/50 bg-danger/10 text-danger";
  }
  if (text.includes("armed") || text.includes("corridor") || text.includes("lock ") || text.includes("win")) {
    return "border-emerald-400/50 bg-emerald-400/10 text-emerald-200";
  }
  if (text.includes("window") || text.includes("cool") || text.includes("wait")) {
    return "border-amber-400/50 bg-amber-400/10 text-amber-200";
  }
  return "border-line bg-ink/60 text-muted";
}

function outcomeTone(outcome: CollarOutcome): string {
  if (outcome === "CORRIDOR_2X") return "border-emerald-400/50 bg-emerald-400/10 text-emerald-200";
  if (outcome === "COLLAR_SCRATCH") return "border-amber-400/50 bg-amber-400/10 text-amber-200";
  if (outcome === "COLLAR_LOSS") return "border-danger/50 bg-danger/10 text-danger";
  if (outcome === "SOLO_WIN") return "border-sky-400/50 bg-sky-400/10 text-sky-200";
  return "border-line bg-ink/60 text-muted";
}

function outcomeLabel(outcome: CollarOutcome): string {
  if (outcome === "CORRIDOR_2X") return "CORRIDOR 2×";
  if (outcome === "COLLAR_SCRATCH") return "COLLAR SCRATCH";
  if (outcome === "COLLAR_LOSS") return "COLLAR LOSS";
  if (outcome === "SOLO_WIN") return "SOLO WIN";
  return "SAVED MISS";
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): ReactElement {
  return (
    <label className="block">
      <span className="text-[9px] uppercase tracking-widest text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-0.5 block text-[8px] leading-relaxed text-muted">{hint}</span> : null}
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }): ReactElement {
  return (
    <div className="rounded border border-line bg-ink/60 px-2 py-1.5">
      <p className="text-[8px] uppercase tracking-widest text-muted">{label}</p>
      <p className={"mt-0.5 font-mono text-[11px] " + (tone ?? "text-slate-100")}>{value}</p>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3" role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-panel p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-slate-100">{title}</h2>
          <button type="button" onClick={onClose} className="rounded border border-line px-2 py-1 text-[10px] text-muted hover:text-slate-100">
            Close
          </button>
        </div>
        <div className="mt-3 text-[11px] leading-relaxed text-slate-300">{children}</div>
      </div>
    </div>
  );
}

export default function TimeCollarPage(props: Props): ReactElement {
  const { sessionRef, connected, symbols, accounts, accountId, accountKind, balance, currency, onConnect, onAccountChange, onNotice, bindContractListener } = props;

  const [symbol, setSymbol] = useState("1HZ100V");
  const [duration, setDuration] = useState(COLLAR_DEFAULT_DURATION);
  const [minLockTick, setMinLockTick] = useState(COLLAR_DEFAULT_MIN_LOCK_TICK);
  const [minCorridor, setMinCorridor] = useState(COLLAR_DEFAULT_CORRIDOR);
  const [directionMode, setDirectionMode] = useState<CollarDirectionMode>("auto");
  const [requireImpulse, setRequireImpulse] = useState(true);
  const [minImpulse, setMinImpulse] = useState(COLLAR_DEFAULT_IMPULSE);
  const [preset, setPreset] = useState<CollarPreset>("symmetric");
  const [leg1Stake, setLeg1Stake] = useState(COLLAR_DEFAULT_STAKE);
  const [leg2Stake, setLeg2Stake] = useState(COLLAR_DEFAULT_STAKE);
  const [martingaleOn, setMartingaleOn] = useState(false);
  const [martingaleLevel, setMartingaleLevel] = useState(0);
  const [martingaleMultiplier, setMartingaleMultiplier] = useState(COLLAR_DEFAULT_MARTINGALE);
  const [martingaleMaxLevels, setMartingaleMaxLevels] = useState(COLLAR_MAX_MARTINGALE_LEVELS);
  const [stopLoss, setStopLoss] = useState(DEFAULT_RISK.autoStopLoss);
  const [takeProfit, setTakeProfit] = useState(DEFAULT_RISK.autoTakeProfit);
  const [isSlManual, setIsSlManual] = useState(false);
  const [isTpManual, setIsTpManual] = useState(false);
  const [armed, setArmed] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [hardLocked, setHardLocked] = useState(false);
  const [phase, setPhase] = useState("Connect to Deriv, then seed 60 ticks");
  const [prices, setPrices] = useState<number[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [spec, setSpec] = useState<CollarContractSpec | null>(null);
  const [offersLoading, setOffersLoading] = useState(false);
  const [contractError, setContractError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CollarPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [active, setActive] = useState<ActiveCollar | null>(null);
  const [rounds, setRounds] = useState<CollarRow[]>([]);
  const [pnl, setPnl] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);
  const [advisor, setAdvisor] = useState<SessionAdvisorState | null>(null);
  const [confirmIntent, setConfirmIntent] = useState<"arm" | CollarSide | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [realOk, setRealOk] = useState(false);

  const aliveRef = useRef(true);
  const sessionLiveRef = useRef<DerivSession | null>(null);
  const pricesRef = useRef<number[]>([]);
  const tickBufferRef = useRef<Tick[]>([]);
  const symbolRef = useRef(symbol);
  const durationRef = useRef(duration);
  const minLockRef = useRef(minLockTick);
  const minCorridorRef = useRef(minCorridor);
  const directionRef = useRef(directionMode);
  const requireImpulseRef = useRef(requireImpulse);
  const minImpulseRef = useRef(minImpulse);
  const leg1BaseRef = useRef(leg1Stake);
  const leg2BaseRef = useRef(leg2Stake);
  const levelRef = useRef(martingaleLevel);
  const martingaleRef = useRef(martingaleOn);
  const martingaleMultiplierRef = useRef(martingaleMultiplier);
  const martingaleMaxLevelsRef = useRef(martingaleMaxLevels);
  const currencyRef = useRef(currency);
  currencyRef.current = currency;
  const stopRef = useRef(stopLoss);
  const tpRef = useRef(takeProfit);
  const slManualRef = useRef(isSlManual);
  const tpManualRef = useRef(isTpManual);
  const specRef = useRef<CollarContractSpec | null>(null);
  const runtimeRef = useRef<CollarRuntime | null>(null);
  const armedRef = useRef(false);
  const execRef = useRef(false);
  const coolingRef = useRef(false);
  const hardLockedRef = useRef(false);
  const activeRef = useRef<ActiveCollar | null>(null);
  const activeIdsRef = useRef<Set<number>>(new Set());
  const collarLockedRef = useRef(false);
  const lockLeg2Ref = useRef<(spot: number) => void>(() => undefined);
  const lockAttemptRef = useRef(false);
  const leg2BuyInFlightRef = useRef(false);
  const finalizePendingRef = useRef(false);
  const lastTickEpochRef = useRef(0);
  const watchIdsRef = useRef<string[]>([]);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const cooldownTimerRef = useRef<number | undefined>(undefined);
  const pnlRef = useRef(0);
  const winsRef = useRef(0);
  const lossesRef = useRef(0);
  const peakLevelRef = useRef(0);
  const finalizingRef = useRef(false);
  const roundNoRef = useRef(0);
  const lastAttemptRef = useRef(0);
  const subsRef = useRef<Map<string, string>>(new Map());
  const seedTokenRef = useRef(0);
  const seedBuffersRef = useRef<Map<string, { token: number; ticks: Tick[] }>>(new Map());
  const streamingRef = useRef(false);
  const tickHandlerRef = useRef<(tickSymbol: string, tick: Tick) => void>(() => undefined);
  const maybeAutoRef = useRef<() => void>(() => undefined);
  const prevAccountRef = useRef(accountId);
  const realOkRef = useRef(false);
  const confirmAccountRef = useRef("");
  const lockFeasibleRef = useRef(false);

  const symbolInfo = useMemo(() => symbols.find((item) => item.symbol === symbol) ?? null, [symbol, symbols]);
  const fallbackPip = symbolInfo?.pip && symbolInfo.pip > 0 ? symbolInfo.pip : 0.01;
  const pip = spec?.pip && spec.pip > 0 ? spec.pip : fallbackPip;
  const decimals = Math.max(0, decimalsForPip(pip));
  const impulse = useMemo(() => computeCollarImpulse(prices), [prices]);
  const leg2MinTicks = Math.max(COLLAR_MIN_CONTRACT_TICKS, spec?.minTickDuration ?? COLLAR_MIN_CONTRACT_TICKS);
  const lockWindow = useMemo(() => collarLockWindow(duration, minLockTick, leg2MinTicks), [duration, leg2MinTicks, minLockTick]);
  const currentLevel = martingaleOn ? clamp(martingaleLevel, 0, Math.min(COLLAR_MAX_MARTINGALE_LEVELS, martingaleMaxLevels)) : 0;

  const leg1MultipleForRisk = useMemo(() => {
    if (!preview) return COLLAR_FALLBACK_MULTIPLE;
    const call = preview.call1.payout / Math.max(0.01, preview.call1.ask);
    const put = preview.put1.payout / Math.max(0.01, preview.put1.ask);
    return call > 0 && put > 0 ? Math.min(call, put) : COLLAR_FALLBACK_MULTIPLE;
  }, [preview]);

  const leg2MultipleForRisk = useMemo(() => {
    if (!preview) return COLLAR_FALLBACK_MULTIPLE;
    const call = preview.call2.payout / Math.max(0.01, preview.call2.ask);
    const put = preview.put2.payout / Math.max(0.01, preview.put2.ask);
    return call > 0 && put > 0 ? Math.min(call, put) : COLLAR_FALLBACK_MULTIPLE;
  }, [preview]);

  const riskPlan = useMemo(
    () =>
      computeCollarRiskPlan({
        leg1Stake,
        leg2Stake,
        martingaleEnabled: martingaleOn,
        multiplier: martingaleMultiplier,
        maxLevels: martingaleMaxLevels,
        leg1Multiple: leg1MultipleForRisk,
        leg2Multiple: leg2MultipleForRisk,
      }),
    [leg1MultipleForRisk, leg2MultipleForRisk, leg1Stake, leg2Stake, martingaleMaxLevels, martingaleMultiplier, martingaleOn],
  );

  const levelStakes = stakesForLevel(riskPlan, currentLevel);
  const currentLeg1 = levelStakes.leg1Stake;
  const currentLeg2 = levelStakes.leg2Stake;
  const lockFeasible = Boolean(spec && spec.symbol === symbol && lockWindow.valid && duration - minLockTick >= leg2MinTicks);
  lockFeasibleRef.current = lockFeasible;
  const previewLeg2Duration = Math.max(leg2MinTicks, leg2DurationFor(duration, minLockTick) ?? leg2MinTicks);
  const previewKey = [symbol, currency, duration, previewLeg2Duration, currentLeg1.toFixed(2), currentLeg2.toFixed(2)].join("|");
  const livePreview = preview && preview.key === previewKey ? preview : null;
  useEffect(() => {
    setPreview(null);
  }, [previewKey]);
  const matrixSide: CollarSide = active?.side ?? (directionMode === "bullish" ? "call" : directionMode === "bearish" ? "put" : impulse.ratio < 0 ? "put" : "call");
  const matrixLeg1Quote = livePreview ? (matrixSide === "call" ? livePreview.call1 : livePreview.put1) : null;
  const matrixLeg2Quote = livePreview ? (matrixSide === "call" ? livePreview.put2 : livePreview.call2) : null;
  const bookedLeg1 = active?.legs.find((leg) => leg.role === "leg1") ?? null;
  const bookedLeg2 = active?.legs.find((leg) => leg.role === "leg2") ?? null;
  const matrixLeg1Stake = active?.leg1Stake ?? currentLeg1;
  const matrixLeg2Stake = active?.leg2Stake ?? currentLeg2;
  const bookedLeg1Multiple = bookedLeg1 && bookedLeg1.stake > 0 ? bookedLeg1.payout / bookedLeg1.stake : 0;
  const bookedLeg2Multiple = bookedLeg2 && bookedLeg2.stake > 0 ? bookedLeg2.payout / bookedLeg2.stake : 0;
  const matrixLeg1Multiple = active
    ? bookedLeg1Multiple > 0 ? bookedLeg1Multiple : COLLAR_FALLBACK_MULTIPLE
    : matrixLeg1Quote && matrixLeg1Stake > 0 ? matrixLeg1Quote.payout / matrixLeg1Stake : COLLAR_FALLBACK_MULTIPLE;
  const matrixLeg2Multiple = active?.locked
    ? bookedLeg2Multiple > 0 ? bookedLeg2Multiple : COLLAR_FALLBACK_MULTIPLE
    : matrixLeg2Quote && matrixLeg2Stake > 0 ? matrixLeg2Quote.payout / matrixLeg2Stake : COLLAR_FALLBACK_MULTIPLE;
  const payoff = buildCollarPayoffMatrix({ leg1Stake: matrixLeg1Stake, leg2Stake: matrixLeg2Stake, leg1Multiple: matrixLeg1Multiple, leg2Multiple: matrixLeg2Multiple });
  const budget = active?.cost ?? round2(currentLeg1 + currentLeg2);
  const busy = executing || active !== null || cooling || hardLocked;
  const canArm = connected && spec !== null && spec.symbol === symbol && streaming && impulse.ready && lockFeasible && !busy;
  const selectedMarket = MARKET_NAMES.get(symbol) ?? symbol;
  const visualActive = active && active.entrySpot !== null && active.atrAtEntry > 0
    ? {
        direction: active.side,
        entrySpot: active.entrySpot,
        targetSpot: targetSpotFor(active.entrySpot, active.side, active.atrAtEntry, active.minCorridor),
        lockSpot: active.lockSpot,
        locked: active.locked,
        duration: active.duration,
        ticksElapsed: active.ticksElapsed,
        lockStart: active.lockStart,
        lockEnd: active.lockEnd,
        leg2Duration: active.leg2Duration,
      }
    : null;

  const matrixOneWinPositive = payoff.lockedBest;
  const matrixOneWinNegative = payoff.lockedWorst;
  const matrixOneWinSame = round2(matrixOneWinPositive) === round2(matrixOneWinNegative);

  symbolRef.current = symbol;
  durationRef.current = duration;
  minLockRef.current = minLockTick;
  minCorridorRef.current = minCorridor;
  directionRef.current = directionMode;
  requireImpulseRef.current = requireImpulse;
  minImpulseRef.current = minImpulse;
  leg1BaseRef.current = leg1Stake;
  leg2BaseRef.current = leg2Stake;
  levelRef.current = martingaleLevel;
  martingaleRef.current = martingaleOn;
  martingaleMultiplierRef.current = martingaleMultiplier;
  martingaleMaxLevelsRef.current = martingaleMaxLevels;
  stopRef.current = stopLoss;
  tpRef.current = takeProfit;
  slManualRef.current = isSlManual;
  tpManualRef.current = isTpManual;
  specRef.current = spec;
  streamingRef.current = streaming;
  activeRef.current = active;
  pnlRef.current = pnl;
  winsRef.current = wins;
  lossesRef.current = losses;
  peakLevelRef.current = peakLevel;

  runtimeRef.current = {
    connected,
    accountId,
    symbol,
    currency,
    duration,
    minLockTick,
    minCorridor,
    spec,
    streaming,
    pip,
    leg1Stake,
    leg2Stake,
    currentLevel,
    martingaleOn,
    martingaleMultiplier,
    martingaleMaxLevels,
    riskPlan,
    stopLoss,
    takeProfit,
  };

  const clearSettlementTimer = useCallback((): void => {
    if (settleTimerRef.current !== undefined) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = undefined;
    }
  }, []);

  const clearCooldownTimer = useCallback((): void => {
    if (cooldownTimerRef.current !== undefined) {
      window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = undefined;
    }
  }, []);

  const forgetWatches = useCallback((): void => {
    const session = sessionRef.current;
    if (session) {
      for (const watchId of watchIdsRef.current) void session.forget(watchId);
    }
    watchIdsRef.current = [];
  }, [sessionRef]);

  const showAdvisor = useCallback(
    (mode: SessionAdvisorMode, nextPnl: number, nextWins: number, nextLosses: number, nextCost: number): void => {
      clearCooldownTimer();
      coolingRef.current = false;
      setCooling(false);
      execRef.current = false;
      setExecuting(false);
      armedRef.current = false;
      setArmed(false);
      levelRef.current = 0;
      setMartingaleLevel(0);
      setAdvisor({
        mode,
        pnl: round2(nextPnl),
        wins: nextWins,
        losses: nextLosses,
        peakLevel: peakLevelRef.current,
        stopLoss: stopRef.current,
        takeProfit: tpRef.current,
        nextBundleCost: round2(nextCost),
      });
      setPhase(
        mode === "TP_HIT"
          ? "TAKE PROFIT HIT - session cooldown active"
          : nextWins > 0
            ? "STOP LOSS HIT after partial wins - session paused"
            : "STOP LOSS HIT with zero wins - session hard pause",
      );
    },
    [clearCooldownTimer],
  );

  const beginCooldown = useCallback(
    (label: string): void => {
      clearCooldownTimer();
      coolingRef.current = true;
      setCooling(true);
      setPhase(label + " - cooldown " + Math.round(COLLAR_COOLDOWN_MS / 1000) + "s");
      cooldownTimerRef.current = window.setTimeout(() => {
        cooldownTimerRef.current = undefined;
        coolingRef.current = false;
        setCooling(false);
        if (!aliveRef.current || hardLockedRef.current) return;
        execRef.current = false;
        setExecuting(false);
        if (armedRef.current) {
          maybeAutoRef.current();
        } else {
          setPhase("Ready - armed engine is off");
        }
      }, COLLAR_COOLDOWN_MS);
    },
    [clearCooldownTimer],
  );

  const releaseRound = useCallback((): void => {
    clearSettlementTimer();
    forgetWatches();
    activeIdsRef.current.clear();
    activeRef.current = null;
    setActive(null);
    collarLockedRef.current = false;
    lockAttemptRef.current = false;
    leg2BuyInFlightRef.current = false;
    finalizePendingRef.current = false;
    finalizingRef.current = false;
  }, [clearSettlementTimer, forgetWatches]);

  const stopEngine = useCallback(
    (label: string): void => {
      armedRef.current = false;
      setArmed(false);
      if (activeRef.current) {
        setPhase(label + " - active collar continues");
        return;
      }
      if (execRef.current || coolingRef.current) {
        setPhase(label + " - current round/cooldown continues");
        return;
      }
      setPhase(label);
    },
    [],
  );

  const hardLock = useCallback(
    (message: string): void => {
      hardLockedRef.current = true;
      setHardLocked(true);
      armedRef.current = false;
      setArmed(false);
      execRef.current = true;
      setExecuting(false);
      setPhase(message);
      onNotice(message + " Reload the page and verify the Deriv contract list before trading again.", "bad");
    },
    [onNotice],
  );

  const finalizeCollar = useCallback(
    (finished: ActiveCollar): void => {
      if (finalizingRef.current || hardLockedRef.current) return;
      if (leg2BuyInFlightRef.current) {
        finalizePendingRef.current = true;
        return;
      }
      if (activeIdsRef.current.size > 0) return;
      const leg1 = finished.legs.find((leg) => leg.role === "leg1");
      const leg2 = finished.legs.find((leg) => leg.role === "leg2");
      if (!leg1 || !leg1.settled || (leg2 && !leg2.settled)) return;
      finalizingRef.current = true;
      const leg1Pnl = round2(leg1.profit);
      const leg2Pnl = round2(leg2?.profit ?? 0);
      const net = round2(leg1Pnl + leg2Pnl);
      const locked = Boolean(leg2);
      const outcome = classifyCollarOutcome(locked, leg1Pnl, leg2Pnl);
      const nextPnl = round2(pnlRef.current + net);
      const nextWins = winsRef.current + (net > 0 ? 1 : 0);
      const nextLosses = lossesRef.current + (net < 0 ? 1 : 0);
      const width = finished.lockSpot !== null && finished.entrySpot !== null ? corridorWidth(finished.entrySpot, finished.lockSpot) : 0;
      const row: CollarRow = {
        time: Date.now(),
        symbol: finished.symbol,
        direction: directionLabel(finished.side),
        lockStatus: finished.locked ? "LOCKED @ T" + (finished.lockTick ?? 0) : "UNLOCKED",
        width,
        leg1Pnl,
        leg2Pnl,
        outcome,
        net,
      };
      const nextLevel = nextCollarLevel(
        finished.martingaleLevel,
        net,
        martingaleOn,
        Math.min(COLLAR_MAX_MARTINGALE_LEVELS, martingaleMaxLevels),
      );
      const nextBudget = stakesForLevel(riskPlan, nextLevel).roundCost;
      pnlRef.current = nextPnl;
      winsRef.current = nextWins;
      lossesRef.current = nextLosses;
      peakLevelRef.current = Math.max(peakLevelRef.current, finished.martingaleLevel);
      levelRef.current = nextLevel;
      setPnl(nextPnl);
      setWins(nextWins);
      setLosses(nextLosses);
      setPeakLevel(peakLevelRef.current);
      setMartingaleLevel(nextLevel);
      setRounds((previous) => [row, ...previous].slice(0, 60));
      roundNoRef.current += 1;
      releaseRound();
      const sl = Math.abs(stopRef.current);
      if (tpRef.current > 0 && nextPnl >= tpRef.current) {
        showAdvisor("TP_HIT", nextPnl, nextWins, nextLosses, nextBudget);
        return;
      }
      if (sl > 0 && nextPnl <= -sl) {
        showAdvisor(nextWins > 0 ? "SL_PARTIAL_WINS" : "SL_ZERO_WINS", nextPnl, nextWins, nextLosses, nextBudget);
        return;
      }
      beginCooldown(
        outcomeLabel(outcome) + " " + signedMoney(net, currency) + " - " + (locked ? "both legs settled" : "Leg 2 stake saved"),
      );
    },
    [beginCooldown, currency, martingaleMaxLevels, martingaleOn, releaseRound, riskPlan, showAdvisor],
  );

  const handleContract = useCallback(
    (raw: unknown): void => {
      if (!aliveRef.current) return;
      const frame = contractFrame(raw);
      if (!frame.id || !activeIdsRef.current.has(frame.id)) return;
      const current = activeRef.current;
      if (!current) return;
      const index = current.legs.findIndex((leg) => leg.id === frame.id);
      if (index < 0) return;
      const existing = current.legs[index];
      const rawProfit = frame.profit;
      const resolvedStatus = frame.sold ? (frame.status.toLowerCase().includes("won") || (rawProfit ?? 0) > 0 ? "won" : "lost") : existing.status;
      const inferredProfit = rawProfit ?? (resolvedStatus === "won" ? frame.payout ?? existing.payout - existing.stake : resolvedStatus === "lost" ? -existing.stake : existing.profit);
      const nextLeg: CollarLeg = {
        ...existing,
        payout: frame.payout && frame.payout > 0 ? frame.payout : existing.payout,
        profit: frame.sold ? round2(inferredProfit) : round2(rawProfit ?? existing.profit),
        status: frame.sold ? resolvedStatus : existing.status,
        settled: frame.sold ? true : existing.settled,
        entrySpot: frame.entrySpot && frame.entrySpot > 0 ? frame.entrySpot : existing.entrySpot,
        entryEpoch: frame.entryEpoch && frame.entryEpoch > 0 ? frame.entryEpoch : existing.entryEpoch,
      };
      let next: ActiveCollar = {
        ...current,
        legs: current.legs.map((leg) => (leg.id === frame.id ? nextLeg : leg)),
      };
      if (nextLeg.role === "leg1" && nextLeg.entrySpot !== null && nextLeg.entryEpoch !== null && (current.entrySpot === null || current.entryEpoch === null)) {
        next = {
          ...next,
          entrySpot: nextLeg.entrySpot,
          entryEpoch: nextLeg.entryEpoch,
          ticksElapsed: countElapsedTicks(nextLeg.entryEpoch, next.duration),
        };
      }
      activeRef.current = next;
      setActive(next);
      if (!frame.sold) {
        if (nextLeg.role === "leg1" && next.entrySpot !== null && next.entryEpoch !== null && !next.locked && !collarLockedRef.current) {
          const trigger = firstLockTrigger(next);
          if (trigger) lockLeg2Ref.current(trigger.spot);
        }
        return;
      }
      activeIdsRef.current.delete(frame.id);
      if (activeIdsRef.current.size === 0) {
        if (leg2BuyInFlightRef.current) {
          finalizePendingRef.current = true;
        } else {
          finalizeCollar(next);
        }
      }
    },
    [finalizeCollar],
  );

  function countElapsedTicks(entryEpoch: number, limit: number): number {
    const ticks = tickBufferRef.current.filter((tick) => tick.epoch > entryEpoch);
    return Math.min(limit, ticks.length);
  }

  function firstLockTrigger(collar: ActiveCollar): { spot: number; elapsed: number } | null {
    if (collar.entrySpot === null || collar.entryEpoch === null || collar.atrAtEntry <= 0) return null;
    const entryEpoch = collar.entryEpoch;
    const ticks = tickBufferRef.current.filter((tick) => tick.epoch > entryEpoch);
    if (ticks.length === 0) return null;
    const elapsed = ticks.length;
    if (elapsed !== collar.ticksElapsed || elapsed < collar.lockStart || elapsed > collar.lockEnd) return null;
    const spot = ticks[ticks.length - 1].quote;
    if (!lockConditionMet(collar.side, spot, collar.entrySpot, collar.atrAtEntry, collar.minCorridor)) return null;
    return { spot, elapsed };
  }

  const lockLeg2 = useCallback(
    async (triggerSpot: number): Promise<void> => {
      if (collarLockedRef.current || lockAttemptRef.current || hardLockedRef.current) return;
      const session = sessionRef.current;
      const current = activeRef.current;
      if (!session || !current || current.locked) return;
      lockAttemptRef.current = true;
      leg2BuyInFlightRef.current = true;
      let committed = false;
      setPhase("Peak-lock condition met - pricing the opposite leg");
      let quote: Quote | null = null;
      let quoteElapsed = 0;
      let quoteDuration: number | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const live = activeRef.current;
          if (!live || live.locked) return;
          const duration = leg2DurationFor(live.duration, live.ticksElapsed);
          if (duration === null) {
            setPhase("Peak-lock window closed - Leg 2 stake saved");
            return;
          }
          if (duration < live.contractMinTicks) {
            setPhase("Market requires " + live.contractMinTicks + " ticks for Leg 2 - stake saved");
            return;
          }
          const latest = tickBufferRef.current[tickBufferRef.current.length - 1];
          if (!latest || live.entrySpot === null || !lockConditionMet(live.side, latest.quote, live.entrySpot, live.atrAtEntry, live.minCorridor)) {
            setPhase("Corridor retreated before Leg 2 - Leg 1 continues solo");
            return;
          }
          const priced = await session.quote({
            symbol: live.symbol,
            contract: oppositeSide(live.side).toUpperCase(),
            duration,
            durationUnit: "t",
            stake: live.leg2Stake,
            currency: currencyRef.current,
          });
          if (!aliveRef.current) return;
          const after = activeRef.current;
          if (!after || after.locked) return;
          if (after.ticksElapsed !== live.ticksElapsed) continue;
          if (leg2DurationFor(after.duration, after.ticksElapsed) !== duration) continue;
          quote = priced;
          quoteElapsed = live.ticksElapsed;
          quoteDuration = duration;
          break;
        }
        if (!quote || quoteDuration === null) {
          setPhase("Peak-lock pricing missed the tick - Leg 1 continues solo");
          return;
        }
        const beforeBuy = activeRef.current;
        if (!beforeBuy || beforeBuy.locked || beforeBuy.ticksElapsed !== quoteElapsed || leg2DurationFor(beforeBuy.duration, beforeBuy.ticksElapsed) !== quoteDuration) {
          setPhase("Tick moved before Leg 2 buy - Leg 1 continues solo");
          return;
        }
        const bufferedElapsed = beforeBuy.entryEpoch === null ? beforeBuy.ticksElapsed : countElapsedTicks(beforeBuy.entryEpoch, beforeBuy.duration);
        const latestBeforeBuy = tickBufferRef.current[tickBufferRef.current.length - 1];
        if (bufferedElapsed !== quoteElapsed || !latestBeforeBuy || beforeBuy.entrySpot === null || !lockConditionMet(beforeBuy.side, latestBeforeBuy.quote, beforeBuy.entrySpot, beforeBuy.atrAtEntry, beforeBuy.minCorridor)) {
          setPhase("Tick moved before Leg 2 buy - Leg 1 continues solo");
          return;
        }
        const leg1 = beforeBuy.legs.find((leg) => leg.role === "leg1");
        if (!leg1 || !activeIdsRef.current.has(leg1.id)) {
          setPhase("Leg 1 settled before Leg 2 could be bought - second stake saved");
          return;
        }
        const projected = round2(beforeBuy.leg1Stake + quote.ask);
        if (pnlRef.current - projected < -Math.abs(stopRef.current) - 0.01) {
          setPhase("Leg 2 blocked by stop-loss headroom - Leg 1 continues solo");
          onNotice("Leg 2 was not bought because the remaining collar budget would breach the stop loss.", "bad");
          return;
        }
        if (!aliveRef.current || hardLockedRef.current) return;
        if (sessionRef.current !== session) {
          setPhase("Account changed before Leg 2 buy - Leg 1 continues solo");
          return;
        }
        let contractId = 0;
        try {
          contractId = await session.buy(quote.id, quote.ask);
        } catch (error) {
          if (ambiguousPurchase(error)) {
            committed = true;
            collarLockedRef.current = true;
            hardLock("Leg 2 buy acknowledgement missing - radar locked");
          } else {
            setPhase("Leg 2 buy rejected - Leg 1 continues solo");
            onNotice("Leg 2 was rejected: " + errorText(error), "bad");
          }
          return;
        }
        if (!contractId) {
          committed = true;
          hardLock("Leg 2 buy returned no contract id - radar locked");
          return;
        }
        if (!aliveRef.current) return;
        const afterBuy = activeRef.current;
        if (!afterBuy) {
          collarLockedRef.current = true;
          committed = true;
          void session.watch(contractId).then((watchId) => {
            if (watchId && aliveRef.current) watchIdsRef.current.push(watchId);
          }).catch(() => undefined);
          hardLock("Leg 2 was bought after the round was released - radar locked");
          return;
        }
        const leg1Now = afterBuy.legs.find((leg) => leg.role === "leg1");
        const leg1StillLive = Boolean(leg1Now && activeIdsRef.current.has(leg1Now.id));
        const alignmentWarning = afterBuy.ticksElapsed !== quoteElapsed || !leg1StillLive;
        const leg2: CollarLeg = {
          id: contractId,
          role: "leg2",
          side: oppositeSide(afterBuy.side),
          stake: round2(quote.ask),
          payout: round2(quote.payout),
          profit: 0,
          status: "open",
          settled: false,
          entrySpot: null,
          entryEpoch: null,
        };
        const next: ActiveCollar = {
          ...afterBuy,
          locked: true,
          lockSpot: latestBeforeBuy.quote > 0 ? latestBeforeBuy.quote : triggerSpot,
          lockTick: quoteElapsed,
          leg2Duration: quoteDuration,
          alignmentWarning,
          leg2Stake: round2(quote.ask),
          cost: round2(afterBuy.leg1Stake + quote.ask),
          legs: [...afterBuy.legs, leg2],
        };
        activeRef.current = next;
        setActive(next);
        activeIdsRef.current.add(contractId);
        finalizePendingRef.current = false;
        collarLockedRef.current = true;
        committed = true;
        void session.watch(contractId).then((watchId) => {
          if (!watchId) return;
          if (!aliveRef.current || !activeIdsRef.current.has(contractId)) {
            void session.forget(watchId);
            return;
          }
          watchIdsRef.current.push(watchId);
        }).catch((error: unknown) => {
          if (aliveRef.current) onNotice("Leg 2 settlement stream failed: " + errorText(error), "bad");
        });
        if (alignmentWarning) {
          hardLock("Leg 1 settled or a tick crossed during the Leg 2 buy - radar locked");
          return;
        }
        setPhase("COLLAR LOCKED @ T" + quoteElapsed + " - both legs now live");
      } catch (error) {
        if (aliveRef.current) {
          setPhase("Leg 2 lock failed - Leg 1 continues solo");
          onNotice("Leg 2 lock failed: " + errorText(error), "bad");
        }
      } finally {
        lockAttemptRef.current = false;
        leg2BuyInFlightRef.current = false;
        if (!committed && !hardLockedRef.current) {
          collarLockedRef.current = false;
        }
        if (!committed && finalizePendingRef.current && activeIdsRef.current.size === 0) {
          finalizePendingRef.current = false;
          const settled = activeRef.current;
          if (settled) finalizeCollar(settled);
        }
      }
    },
    [finalizeCollar, hardLock, onNotice, sessionRef],
  );

  lockLeg2Ref.current = (spot: number): void => {
    void lockLeg2(spot);
  };

  const handleTick = useCallback(
    (tickSymbol: string, tick: Tick): void => {
      if (!aliveRef.current || tickSymbol !== symbolRef.current) return;
      if (!Number.isFinite(tick.quote) || tick.quote <= 0) return;
      if (!streamingRef.current) {
        const seed = seedBuffersRef.current.get(tickSymbol);
        if (seed) {
          seed.ticks.push({ epoch: tick.epoch, quote: tick.quote });
          if (seed.ticks.length > COLLAR_BUFFER_SIZE) seed.ticks.splice(0, seed.ticks.length - COLLAR_BUFFER_SIZE);
        }
        return;
      }
      if (tick.epoch <= lastTickEpochRef.current) return;
      lastTickEpochRef.current = tick.epoch;
      tickBufferRef.current = [...tickBufferRef.current.slice(-(COLLAR_BUFFER_SIZE - 1)), { epoch: tick.epoch, quote: tick.quote }];
      const nextPrices = [...pricesRef.current.slice(-(COLLAR_BUFFER_SIZE - 1)), tick.quote];
      pricesRef.current = nextPrices;
      setPrices(nextPrices);
      const current = activeRef.current;
      if (current) {
        if (current.entryEpoch !== null && current.entrySpot !== null) {
          const elapsed = countElapsedTicks(current.entryEpoch, current.duration);
          if (elapsed !== current.ticksElapsed) {
            const next = { ...current, ticksElapsed: elapsed };
            activeRef.current = next;
            setActive(next);
          }
          const live = activeRef.current;
          if (live && !live.locked && !collarLockedRef.current && !lockAttemptRef.current) {
            if (live.ticksElapsed > live.lockEnd) {
              setPhase("Peak-lock window closed - Leg 2 stake saved");
            } else {
              const trigger = firstLockTrigger(live);
              if (trigger) {
                void lockLeg2(trigger.spot);
              }
            }
          }
        }
        return;
      }
      maybeAutoRef.current();
    },
    [lockLeg2],
  );

  const fireRound = useCallback(
    async (mode: "auto" | "manual", side: CollarSide): Promise<void> => {
      const session = sessionRef.current;
      if (!session || !aliveRef.current || hardLockedRef.current) return;
      if (execRef.current || coolingRef.current || activeRef.current || activeIdsRef.current.size > 0) return;
      const rt = runtimeRef.current;
      if (!rt || !rt.connected || !rt.streaming || !rt.spec || rt.spec.symbol !== rt.symbol || session.accountId !== rt.accountId) {
        onNotice("Connect, load the market capability and finish the tick seed before opening a collar.", "bad");
        return;
      }
      const leg2Min = Math.max(COLLAR_MIN_CONTRACT_TICKS, rt.spec.minTickDuration);
      if (rt.duration - rt.minLockTick < leg2Min) {
        onNotice("This lock start cannot fit Leg 2: the market needs at least " + leg2Min + " ticks after entry.", "bad");
        return;
      }
      if (Date.now() - lastAttemptRef.current < 1200) return;
      if (mode === "manual") {
        armedRef.current = false;
        setArmed(false);
      }
      lastAttemptRef.current = Date.now();
      const level = stakesForLevel(rt.riskPlan, rt.currentLevel);
      const plannedCost = round2(level.leg1Stake + level.leg2Stake);
      if (tpRef.current > 0 && pnlRef.current >= tpRef.current) {
        showAdvisor("TP_HIT", pnlRef.current, winsRef.current, lossesRef.current, plannedCost);
        return;
      }
      if (stopRef.current > 0 && pnlRef.current - plannedCost < -Math.abs(stopRef.current) - 0.01) {
        showAdvisor(winsRef.current > 0 ? "SL_PARTIAL_WINS" : "SL_ZERO_WINS", pnlRef.current, winsRef.current, lossesRef.current, plannedCost);
        return;
      }
      execRef.current = true;
      setExecuting(true);
      setPhase((mode === "auto" ? "Auto impulse" : "Manual") + " " + sideLabel(side) + " - checking capability");
      let purchaseStarted = false;
      try {
        const offers = await session.contractsFor(rt.symbol);
        if (!aliveRef.current || hardLockedRef.current) return;
        const freshSpec = selectCollarSpec(offers, rt.symbol, rt.pip);
        if (!freshSpec) throw new Error("CALL and PUT tick contracts are not available on " + rt.symbol + ".");
        const freshDuration = clampCollarDuration(rt.duration, freshSpec, rt.minLockTick);
        if (freshDuration < COLLAR_MIN_DURATION) throw new Error("This market does not expose an 8-tick CALL/PUT window.");
        const freshLeg2Min = Math.max(COLLAR_MIN_CONTRACT_TICKS, freshSpec.minTickDuration);
        if (freshDuration - rt.minLockTick < freshLeg2Min) {
          throw new Error("This lock start cannot fit a " + freshLeg2Min + "-tick Leg 2 at the live market minimum.");
        }
        const freshImpulse = computeCollarImpulse(pricesRef.current);
        if (!freshImpulse.ready) throw new Error("The 60-tick baseline is not ready yet.");
        if (freshImpulse.atr20 <= 0) throw new Error("ATR20 is zero; wait for live price movement.");
        setSpec(freshSpec);
        setDuration(freshDuration);
        setPhase((mode === "auto" ? "Auto impulse" : "Manual") + " " + sideLabel(side) + " - pricing Leg 1");
        const quote = await session.quote({
          symbol: rt.symbol,
          contract: side.toUpperCase(),
          duration: freshDuration,
          durationUnit: "t",
          stake: level.leg1Stake,
          currency: rt.currency,
        });
        if (!aliveRef.current || hardLockedRef.current) return;
        if (sessionRef.current !== session || session.accountId !== rt.accountId) {
          throw new Error("The Deriv account changed before Leg 1 could be bought.");
        }
        const actualLeg1 = round2(quote.ask);
        if (pnlRef.current - (actualLeg1 + level.leg2Stake) < -Math.abs(stopRef.current) - 0.01) {
          throw new Error("The live Leg 1 ask leaves no stop-loss headroom for a possible Leg 2.");
        }
        const entryImpulse = computeCollarImpulse(pricesRef.current);
        const entryAtr = entryImpulse.atr20 > 0 ? entryImpulse.atr20 : freshImpulse.atr20;
        setPhase("Leg 1 quoted - buying the first leg");
        let contractId = 0;
        purchaseStarted = true;
        contractId = await session.buy(quote.id, quote.ask);
        if (!contractId) throw new Error("Deriv returned no contract id for Leg 1.");
        if (!aliveRef.current) return;
        const lockWindowSpec = collarLockWindow(freshDuration, rt.minLockTick, freshSpec.minTickDuration);
        const leg1: CollarLeg = {
          id: contractId,
          role: "leg1",
          side,
          stake: actualLeg1,
          payout: round2(quote.payout),
          profit: 0,
          status: "open",
          settled: false,
          entrySpot: null,
          entryEpoch: null,
        };
        const collar: ActiveCollar = {
          id: contractId,
          symbol: rt.symbol,
          side,
          duration: freshDuration,
          contractMinTicks: freshSpec.minTickDuration,
          minLockTick: rt.minLockTick,
          lockStart: lockWindowSpec.start,
          lockEnd: lockWindowSpec.end,
          minCorridor: rt.minCorridor,
          atrAtEntry: entryAtr,
          entrySpot: null,
          entryEpoch: null,
          ticksElapsed: 0,
          lockSpot: null,
          lockTick: null,
          leg2Duration: null,
          locked: false,
          alignmentWarning: false,
          leg1Stake: actualLeg1,
          leg2Stake: level.leg2Stake,
          cost: round2(actualLeg1 + level.leg2Stake),
          legs: [leg1],
          startedAt: Date.now(),
          martingaleLevel: rt.currentLevel,
        };
        activeRef.current = collar;
        setActive(collar);
        activeIdsRef.current.add(contractId);
        collarLockedRef.current = false;
        lockAttemptRef.current = false;
        leg2BuyInFlightRef.current = false;
        finalizePendingRef.current = false;
        setPhase("Leg 1 " + sideLabel(side) + " live - waiting for entry tick and Peak-Lock Window");
        settleTimerRef.current = window.setTimeout(() => {
          settleTimerRef.current = undefined;
          if (!aliveRef.current || activeIdsRef.current.size === 0) return;
          hardLock("Settlement timeout - contract lock held");
        }, Math.max(45000, freshDuration * 1000 + 25000));
        void session.watch(contractId).then((watchId) => {
          if (!watchId) return;
          if (!aliveRef.current || !activeIdsRef.current.has(contractId)) {
            void session.forget(watchId);
            return;
          }
          watchIdsRef.current.push(watchId);
        }).catch((error: unknown) => {
          if (aliveRef.current) onNotice("Leg 1 settlement stream failed: " + errorText(error), "bad");
        });
      } catch (error) {
        if (purchaseStarted && ambiguousPurchase(error)) {
          hardLock("Leg 1 buy acknowledgement missing - radar locked");
          return;
        }
        if (aliveRef.current) {
          execRef.current = false;
          setExecuting(false);
          setPhase("Round not opened - " + errorText(error));
          onNotice("Round not opened: " + errorText(error), "bad");
        }
      }
    },
    [hardLock, onNotice, sessionRef, showAdvisor],
  );

  const maybeAuto = useCallback((): void => {
    if (!aliveRef.current || !armedRef.current || hardLockedRef.current) return;
    if (execRef.current || coolingRef.current || activeRef.current || activeIdsRef.current.size > 0) return;
    const rt = runtimeRef.current;
    if (!rt || !rt.connected || !rt.streaming || !rt.spec || rt.spec.symbol !== rt.symbol) return;
    if (!lockFeasibleRef.current) {
      setPhase("Lock start cannot fit the market's minimum Leg 2 duration - adjust duration or lock start");
      return;
    }
    if (tpRef.current > 0 && pnlRef.current >= tpRef.current) {
      showAdvisor("TP_HIT", pnlRef.current, winsRef.current, lossesRef.current, budget);
      return;
    }
    if (stopRef.current > 0 && pnlRef.current - budget < -Math.abs(stopRef.current) - 0.01) {
      showAdvisor(winsRef.current > 0 ? "SL_PARTIAL_WINS" : "SL_ZERO_WINS", pnlRef.current, winsRef.current, lossesRef.current, budget);
      return;
    }
    const currentImpulse = computeCollarImpulse(pricesRef.current);
    const side = selectImpulseSide(currentImpulse, directionRef.current, requireImpulseRef.current, minImpulseRef.current);
    if (!side) {
      if (!currentImpulse.ready) {
        setPhase("Armed - warming the 60-tick impulse baseline (" + currentImpulse.samples + "/60)");
      } else if (requireImpulseRef.current) {
        setPhase("Armed - waiting for " + (directionRef.current === "bearish" ? "I <= -" : directionRef.current === "bullish" ? "I >= +" : "|I| >= ") + minImpulseRef.current.toFixed(2) + " impulse");
      } else {
        setPhase("Armed - waiting for a directional tick");
      }
      return;
    }
    setPhase("Armed - impulse " + (currentImpulse.ratio >= 0 ? "+" : "") + currentImpulse.ratio.toFixed(2) + "x triggers " + sideLabel(side));
    void fireRound("auto", side);
  }, [budget, fireRound, showAdvisor]);

  maybeAutoRef.current = maybeAuto;

  const requestArm = useCallback((): void => {
    if (!connected) {
      onConnect();
      return;
    }
    if (busy || hardLockedRef.current) return;
    if (!lockFeasibleRef.current) {
      onNotice("Move the lock start earlier or increase duration to leave at least " + leg2MinTicks + " ticks for Leg 2.", "bad");
      return;
    }
    if (!spec || !streaming) {
      onNotice("Wait for both CALL/PUT capability and the 60-tick seed before arming.", "bad");
      return;
    }
    if (accountKind !== "demo" && !realOkRef.current) {
      confirmAccountRef.current = accountId;
      setConfirmChecked(false);
      setConfirmIntent("arm");
      return;
    }
    armedRef.current = true;
    setArmed(true);
    setPhase("Armed - scanning for an impulse entry");
    maybeAutoRef.current();
  }, [accountId, accountKind, busy, connected, onConnect, onNotice, spec, streaming]);

  const requestManual = useCallback(
    (side: CollarSide): void => {
      if (!connected) {
        onConnect();
        return;
      }
      if (busy || hardLockedRef.current) return;
      if (!lockFeasibleRef.current) {
        onNotice("This lock start cannot fit Leg 2 at the market minimum. Adjust the duration or lock start first.", "bad");
        return;
      }
      if (!spec || !streaming) {
        onNotice("The market capability and live tick seed must be ready first.", "bad");
        return;
      }
      if (accountKind !== "demo" && !realOkRef.current) {
        confirmAccountRef.current = accountId;
        setConfirmChecked(false);
        setConfirmIntent(side);
        return;
      }
      void fireRound("manual", side);
    },
    [accountId, accountKind, busy, connected, fireRound, onConnect, onNotice, spec, streaming],
  );

  const confirmReal = useCallback((): void => {
    if (!confirmChecked) return;
    if (confirmAccountRef.current !== accountId || accountKind === "demo" || busy || hardLockedRef.current) {
      setConfirmIntent(null);
      setConfirmChecked(false);
      onNotice("The Real account changed or the collar state moved. Re-open the confirmation before continuing.", "bad");
      return;
    }
    if (!connected || !streaming || !spec || spec.symbol !== symbol || !lockFeasibleRef.current) {
      setConfirmIntent(null);
      setConfirmChecked(false);
      onNotice("The market capability or lock window is no longer ready. Re-confirm after it is ready.", "bad");
      return;
    }
    const intent = confirmIntent;
    realOkRef.current = true;
    setRealOk(true);
    setConfirmIntent(null);
    setConfirmChecked(false);
    if (intent === "arm") {
      armedRef.current = true;
      setArmed(true);
      setPhase("Armed on Real - scanning for an impulse entry");
      maybeAutoRef.current();
    } else if (intent) {
      void fireRound("manual", intent);
    }
  }, [accountId, accountKind, busy, confirmChecked, confirmIntent, connected, fireRound, onNotice, spec, streaming, symbol]);

  const resetSession = useCallback((): void => {
    if (busy || hardLockedRef.current) return;
    armedRef.current = false;
    execRef.current = false;
    coolingRef.current = false;
    setArmed(false);
    setExecuting(false);
    setCooling(false);
    clearCooldownTimer();
    clearSettlementTimer();
    forgetWatches();
    activeIdsRef.current.clear();
    activeRef.current = null;
    setActive(null);
    collarLockedRef.current = false;
    lockAttemptRef.current = false;
    leg2BuyInFlightRef.current = false;
    finalizePendingRef.current = false;
    finalizingRef.current = false;
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
    setIsSlManual(false);
    setIsTpManual(false);
    slManualRef.current = false;
    tpManualRef.current = false;
    setStopLoss(riskPlan.autoStopLoss);
    setTakeProfit(riskPlan.autoTakeProfit);
    stopRef.current = riskPlan.autoStopLoss;
    tpRef.current = riskPlan.autoTakeProfit;
    setPhase("Session reset - flat stakes restored");
  }, [busy, clearCooldownTimer, clearSettlementTimer, forgetWatches, riskPlan.autoStopLoss, riskPlan.autoTakeProfit]);

  useEffect(() => {
    document.title = "Contingent Time-Axis Collar | Deriv Quant Platform";
    return () => {
      document.title = "Digit Edge | Deriv contract ladder";
    };
  }, []);

  useEffect(() => {
    const session = sessionRef.current;
    sessionLiveRef.current = session;
    if (!session) return;
    const handler = (tickSymbol: string, tick: Tick): void => tickHandlerRef.current(tickSymbol, tick);
    session.onTickAny = handler;
    return () => {
      if (session.onTickAny === handler) session.onTickAny = null;
    };
  }, [connected, sessionRef]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      armedRef.current = false;
      clearSettlementTimer();
      clearCooldownTimer();
      seedTokenRef.current += 1;
      const session = sessionRef.current;
      if (session) {
        for (const id of subsRef.current.values()) void session.forget(id);
        for (const watchId of watchIdsRef.current) void session.forget(watchId);
      }
      subsRef.current.clear();
      watchIdsRef.current = [];
      activeIdsRef.current.clear();
      seedBuffersRef.current.clear();
    };
  }, [clearCooldownTimer, clearSettlementTimer, sessionRef]);

  useEffect(() => {
    bindContractListener(handleContract);
    return () => bindContractListener(null);
  }, [bindContractListener, handleContract]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!connected || !session || !accountId || session.accountId !== accountId) return;
    let cancelled = false;
    if (!SUPPORTED_SYMBOLS.has(symbol)) return;
    streamingRef.current = false;
    setStreaming(false);
    setSeedError(null);
    lastTickEpochRef.current = 0;
    setPhase("Seeding 60 ticks for " + symbol);
    const token = seedTokenRef.current + 1;
    seedTokenRef.current = token;
    seedBuffersRef.current.set(symbol, { token, ticks: [] });
    const run = async (): Promise<void> => {
      let historyTicks: Tick[] = [];
      try {
        historyTicks = await session.history(symbol, COLLAR_BUFFER_SIZE, "ticks");
      } catch (error) {
        if (!cancelled) {
          setSeedError("History seed failed: " + errorText(error));
          onNotice("Could not seed 60 ticks: " + errorText(error), "bad");
        }
      }
      if (cancelled) return;
      let ownedId = "";
      try {
        ownedId = await session.subscribeTicksFor(symbol);
      } catch (error) {
        if (!alreadySubscribed(error)) {
          if (!cancelled) {
            setSeedError("Tick subscription failed: " + errorText(error));
            setPhase("Tick subscription failed - " + errorText(error));
          }
          return;
        }
      }
      if (cancelled) {
        if (ownedId) void session.forget(ownedId);
        return;
      }
      if (ownedId) subsRef.current.set(symbol, ownedId);
      const seed = seedBuffersRef.current.get(symbol);
      const buffered = seed && seed.token === token ? seed.ticks : [];
      const lastHistoryEpoch = historyTicks.length > 0 ? historyTicks[historyTicks.length - 1].epoch : 0;
      const merged = new Map<number, Tick>();
      for (const tick of historyTicks) merged.set(tick.epoch, tick);
      for (const tick of buffered) {
        if (tick.epoch > lastHistoryEpoch) merged.set(tick.epoch, tick);
      }
      const combined = Array.from(merged.values()).sort((a, b) => a.epoch - b.epoch).slice(-COLLAR_BUFFER_SIZE);
      if (seed && seed.token === token) seedBuffersRef.current.delete(symbol);
      tickBufferRef.current = combined;
      lastTickEpochRef.current = combined.length > 0 ? combined[combined.length - 1].epoch : 0;
      pricesRef.current = combined.map((tick) => tick.quote);
      setPrices(pricesRef.current);
      streamingRef.current = true;
      setStreaming(true);
      setPhase("Streaming " + symbol + " - " + combined.length + " tick baseline ready");
      if (armedRef.current) maybeAutoRef.current();
    };
    void run();
    return () => {
      cancelled = true;
      seedTokenRef.current += 1;
      const owned = subsRef.current.get(symbol);
      if (owned) {
        subsRef.current.delete(symbol);
        void session.forget(owned);
      }
      const seed = seedBuffersRef.current.get(symbol);
      if (seed && seed.token === token) seedBuffersRef.current.delete(symbol);
      streamingRef.current = false;
      setStreaming(false);
    };
  }, [accountId, connected, onNotice, sessionRef, symbol]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!connected || !session || !accountId || session.accountId !== accountId) return;
    let cancelled = false;
    setOffersLoading(true);
    setSpec(null);
    setContractError(null);
    session.contractsFor(symbol)
      .then((offers: ContractOffer[]) => {
        if (cancelled) return;
        const next = selectCollarSpec(offers, symbol, fallbackPip);
        if (!next) {
          setSpec(null);
          setContractError("CALL and PUT tick contracts are not both available on " + symbol + " (rise/fall required).");
          return;
        }
        setSpec(next);
        setDuration((value) => clampCollarDuration(value, next, minLockRef.current));
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setSpec(null);
          setContractError("contracts_for failed: " + error.message);
        }
      })
      .finally(() => {
        if (!cancelled) setOffersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, connected, fallbackPip, sessionRef, symbol]);

  useEffect(() => {
    if (!spec) return;
    const nextDuration = clampCollarDuration(durationRef.current, spec, minLockRef.current);
    setDuration(nextDuration);
    durationRef.current = nextDuration;
    setMinLockTick((value) => {
      const next = clampLockStart(value, nextDuration, leg2MinTicks);
      minLockRef.current = next;
      return next === value ? value : next;
    });
  }, [leg2MinTicks, spec]);

  useEffect(() => {
    setMinLockTick((value) => {
      const next = clampLockStart(value, duration, leg2MinTicks);
      return next === value ? value : next;
    });
  }, [duration, leg2MinTicks]);

  useEffect(() => {
    if (!connected) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (!spec || spec.symbol !== symbol) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (!lockFeasible) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (!streaming || executing || active !== null) return;
    let cancelled = false;
    let inFlight = false;
    const load = async (): Promise<void> => {
      if (inFlight || cancelled) return;
      inFlight = true;
      setPreviewLoading(true);
      const key = previewKey;
      try {
        const quotes = await sessionRef.current?.quoteBundle([
          { symbol, contract: "CALL", duration, durationUnit: "t", stake: currentLeg1, currency },
          { symbol, contract: "PUT", duration, durationUnit: "t", stake: currentLeg1, currency },
          { symbol, contract: "CALL", duration: previewLeg2Duration, durationUnit: "t", stake: currentLeg2, currency },
          { symbol, contract: "PUT", duration: previewLeg2Duration, durationUnit: "t", stake: currentLeg2, currency },
        ]);
        if (!quotes || quotes.length < 4) throw new Error("Deriv did not return all four proposal previews.");
        if (cancelled) return;
        setPreview({ key, call1: quotes[0], put1: quotes[1], call2: quotes[2], put2: quotes[3], fetchedAt: Date.now() });
        setPreviewError(null);
      } catch (error) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError("Proposal preview unavailable: " + errorText(error));
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
        inFlight = false;
      }
    };
    const timer = window.setTimeout(() => void load(), 350);
    const interval = window.setInterval(() => void load(), PREVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [active, connected, currency, currentLeg1, currentLeg2, duration, executing, lockFeasible, previewKey, previewLeg2Duration, previewNonce, sessionRef, spec, streaming, symbol]);

  useEffect(() => {
    if (isSlManual) return;
    setStopLoss(riskPlan.autoStopLoss);
    stopRef.current = riskPlan.autoStopLoss;
  }, [isSlManual, riskPlan.autoStopLoss]);

  useEffect(() => {
    if (isTpManual) return;
    setTakeProfit(riskPlan.autoTakeProfit);
    tpRef.current = riskPlan.autoTakeProfit;
  }, [isTpManual, riskPlan.autoTakeProfit]);

  useEffect(() => {
    if (prevAccountRef.current !== accountId) {
      prevAccountRef.current = accountId;
      realOkRef.current = false;
      setRealOk(false);
      if (activeRef.current || activeIdsRef.current.size > 0) {
        hardLock("Account changed while a collar was open - radar locked");
      } else {
        stopEngine("Account changed - disarm and verify the account");
      }
    }
  }, [accountId, hardLock, stopEngine]);

  useEffect(() => {
    if (!connected) {
      armedRef.current = false;
      setArmed(false);
      realOkRef.current = false;
      setRealOk(false);
      setConfirmIntent(null);
      setConfirmChecked(false);
      if (!activeRef.current) {
        stopEngine("Connect to Deriv, then seed 60 ticks");
      } else {
        setPhase("Disconnected - active collar left untouched; settlement may time out");
      }
    }
  }, [connected, stopEngine]);

  useEffect(() => {
    hardLockedRef.current = hardLocked;
  }, [hardLocked]);

  const applyPreset = (next: CollarPreset): void => {
    if (busy) return;
    setPreset(next);
    if (next === "symmetric") {
      setLeg1Stake(COLLAR_DEFAULT_STAKE);
      setLeg2Stake(COLLAR_DEFAULT_STAKE);
    } else if (next === "weighted") {
      setLeg1Stake(roundStake(COLLAR_WEIGHTED_LEG1));
      setLeg2Stake(COLLAR_DEFAULT_STAKE);
    }
    levelRef.current = 0;
    setMartingaleLevel(0);
  };

  const updateLeg1 = (value: number): void => {
    if (busy) return;
    setPreset("custom");
    const next = roundStake(value);
    setLeg1Stake(next);
    leg1BaseRef.current = next;
  };

  const updateLeg2 = (value: number): void => {
    if (busy) return;
    setPreset("custom");
    const next = roundStake(value);
    setLeg2Stake(next);
    leg2BaseRef.current = next;
  };

  const updateDuration = (value: number): void => {
    if (busy) return;
    const next = clampCollarDuration(value, spec, minLockRef.current);
    setDuration(next);
    durationRef.current = next;
    setMinLockTick((current) => {
      const clamped = clampLockStart(current, next, leg2MinTicks);
      minLockRef.current = clamped;
      return clamped;
    });
  };

  const updateLockStart = (value: number): void => {
    if (busy) return;
    const next = clampLockStart(value, durationRef.current, leg2MinTicks);
    setMinLockTick(next);
    minLockRef.current = next;
  };

  const toggleMartingale = (): void => {
    if (busy) return;
    const next = !martingaleOn;
    setMartingaleOn(next);
    martingaleRef.current = next;
    levelRef.current = 0;
    setMartingaleLevel(0);
  };

  const downloadCsv = useCallback((): void => {
    const cell = (value: string | number): string => '"' + String(value).replace(/"/g, '""') + '"';
    const header = ["Timestamp", "Symbol", "Direction", "Lock Status", "Corridor Width", "Leg 1 P&L", "Leg 2 P&L", "Outcome Badge", "Net Round P&L"].map(cell).join(",");
    const lines = rounds.map((row) =>
      [
        new Date(row.time).toISOString(),
        row.symbol,
        row.direction,
        row.lockStatus,
        row.width.toFixed(4),
        row.leg1Pnl.toFixed(2),
        row.leg2Pnl.toFixed(2),
        outcomeLabel(row.outcome),
        row.net.toFixed(2),
      ].map(cell).join(","),
    );
    const blob = new Blob([header + String.fromCharCode(10) + lines.join(String.fromCharCode(10))], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "collar-rounds-" + new Date().toISOString().slice(0, 10) + ".csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [rounds]);

  const planText = riskPlan.effectiveMaxLevels === 0
    ? "6 × Leg 1 base, rounded up to $0.05"
    : "one complete L0-L" + riskPlan.effectiveMaxLevels + " collar cycle";

  return (
    <main className="min-h-screen bg-ink px-3 py-3 text-slate-100 sm:px-5 sm:py-5">
      <div className="mx-auto max-w-[1500px] space-y-3">
        <section className="rounded-lg border border-line bg-panel p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest text-accent">PAGE 5 · CONTINGENT COLLAR</span>
                <span className="rounded-full border border-line bg-ink px-2.5 py-1 text-[9px] font-semibold text-muted">CTAC · 2-LEG</span>
                <span className="rounded-full border border-line bg-ink px-2.5 py-1 text-[9px] font-semibold text-muted">PEAK-LOCK WINDOW</span>
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Contingent Time-Axis Collar</h1>
              <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted">
                Leg 1 enters on a 5-tick impulse. Leg 2 is bought only if the same move reaches the ATR corridor target inside T+{lockWindow.start} to T+{lockWindow.end}; both legs then expire on one terminal tick T+{duration}. Otherwise Leg 1 finishes solo and the second stake is never spent.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={"rounded border px-2 py-1 text-[9px] font-semibold " + (connected ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-ink text-muted")}>
                {connected ? "LIVE SOCKET" : "DISCONNECTED"}
              </span>
              <span className={"rounded border px-2 py-1 text-[9px] font-semibold " + (accountKind === "real" ? "border-danger/40 bg-danger/10 text-danger" : "border-line bg-ink text-muted")}>
                {accountKind === "real" ? "REAL MONEY" : accountKind === "demo" ? "DEMO" : "ACCOUNT"}
              </span>
              {accounts.length > 0 ? (
                <select
                  value={accountId}
                  onChange={(event) => onAccountChange(event.target.value)}
                  disabled={busy || !connected}
                  className={inputClass + " max-w-[210px]"}
                  aria-label="Trading account"
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.kind === "real" ? "Real" : "Demo"} · {account.id}</option>
                  ))}
                </select>
              ) : (
                <button type="button" onClick={onConnect} className={buttonBase + " border-accent/50 bg-accent/10 text-accent"}>Connect Deriv</button>
              )}
              <span className="rounded border border-line bg-ink/60 px-2 py-1 font-mono text-[11px] text-slate-200">
                {balance === null ? "-" : balance.toFixed(2)} {currency || "USD"}
              </span>
            </div>
          </div>
        </section>

        <section className={"rounded-lg border px-3 py-2 text-[10px] leading-relaxed " + phaseTone(phase)} role="status">
          <span className="font-semibold uppercase tracking-widest">Engine phase</span>
          <span className="ml-2 font-mono">{phase}</span>
        </section>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_370px]">
          <div className="space-y-3">
            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Market & Tick Alignment</h2>
                  <p className="mt-0.5 text-[10px] text-muted">CALL/PUT rise-fall capability is checked with contracts_for before every round.</p>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[9px]">
                  <span className={"rounded border px-2 py-0.5 " + (streaming ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-ink text-muted")}>{streaming ? "TICKS LIVE" : "SEEDING"}</span>
                  <span className={"rounded border px-2 py-0.5 " + (spec ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-ink text-muted")}>{spec ? "CALL + PUT OK" : "CAPABILITY CHECK"}</span>
                  <span className="rounded border border-line bg-ink px-2 py-0.5 text-muted">ATR20 {formatPrice(impulse.atr20, decimals)}</span>
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Supported market">
                  <select value={symbol} onChange={(event) => { if (event.target.value === symbol) return; armedRef.current = false; setArmed(false); setSymbol(event.target.value); }} disabled={busy} className={inputClass}>
                    {MARKETS.map((group) => (
                      <optgroup key={group.group} label={group.group}>
                        {group.items.map((item) => (
                          <option key={item.symbol} value={item.symbol}>{item.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Field>
                <Field label="Leg 1 duration (ticks)" hint={"min " + Math.max(COLLAR_MIN_DURATION, leg2MinTicks, minLockTick + leg2MinTicks) + " · max " + maxCollarDuration(spec)}>
                  <input
                    type="number"
                    min={Math.max(COLLAR_MIN_DURATION, leg2MinTicks, minLockTick + leg2MinTicks)}
                    max={maxCollarDuration(spec)}
                    step={1}
                    value={duration}
                    disabled={busy}
                    onChange={(event) => updateDuration(Number(event.target.value))}
                    className={inputClass}
                  />
                </Field>
                <Field label="Peak-lock start tick" hint={"window T+" + lockWindow.start + " to T+" + lockWindow.end}>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, duration - leg2MinTicks)}
                    step={1}
                    value={minLockTick}
                    disabled={busy}
                    onChange={(event) => updateLockStart(Number(event.target.value))}
                    className={inputClass}
                  />
                </Field>
                <Field label="Min corridor (ATR×)" hint="Leg 2 fires at the first qualifying tick">
                  <input
                    type="number"
                    min={0.1}
                    max={5}
                    step={0.1}
                    value={minCorridor}
                    disabled={busy}
                    onChange={(event) => {
                      const next = Math.max(0.1, Math.min(5, Number(event.target.value)));
                      setMinCorridor(next);
                      minCorridorRef.current = next;
                    }}
                    className={inputClass}
                  />
                </Field>
              </div>
              {spec && !lockFeasible ? <p className="mt-2 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[9px] leading-relaxed text-danger">This lock start cannot fit Leg 2: {selectedMarket} needs at least {leg2MinTicks} ticks after entry. Increase duration or move the lock start earlier.</p> : null}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[9px] text-muted">
                <span>
                  {selectedMarket} · rise/fall · tick range {spec ? spec.minTickDuration + "-" + spec.maxTickDuration : "waiting"} · {SUPPORTED_SYMBOLS.size} supported markets
                </span>
                <span className="font-mono text-slate-300">seed {impulse.samples}/{COLLAR_BUFFER_SIZE}</span>
              </div>
              {contractError ? <p className="mt-2 rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-[10px] text-danger" role="alert">{contractError}</p> : null}
              {seedError ? <p className="mt-2 rounded border border-amber-400/40 bg-amber-400/10 px-2.5 py-2 text-[10px] text-amber-200" role="alert">{seedError}</p> : null}
              {offersLoading ? <p className="mt-2 text-[9px] text-muted">Checking contracts_for…</p> : null}
            </section>

            <CollarCorridorVisualizer prices={prices} decimals={decimals} impulse={impulse} active={visualActive} />

            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Live 4-Scenario Payoff Matrix</h2>
                  <p className="mt-0.5 text-[10px] text-muted">
                    {active ? "Booked leg 1 plus " + (active.locked ? "booked Leg 2" : "live Leg 2 preview") : "Live CALL/PUT proposals for current stakes"} · {livePreview ? "live multiples" : "fallback " + COLLAR_FALLBACK_MULTIPLE.toFixed(2) + "×"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {previewLoading ? <span className="text-[9px] text-muted">pricing…</span> : null}
                  <button type="button" onClick={() => setPreviewNonce((value) => value + 1)} disabled={busy || !connected || !spec} className={buttonBase + " border-line text-muted hover:text-slate-100"}>
                    Refresh quotes
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded border border-emerald-400/40 bg-emerald-400/10 p-2.5">
                  <p className="text-[8px] uppercase tracking-widest text-emerald-300">Scenario 1 · Corridor double-win</p>
                  <p className="mt-1 font-mono text-lg text-emerald-200">{signedMoney(payoff.corridorProfit, currency)}</p>
                  <p className="text-[9px] text-emerald-300/80">{payoff.corridorRoiPct >= 0 ? "+" : ""}{payoff.corridorRoiPct.toFixed(1)}% ROI · S₀ to S_lock</p>
                </div>
                <div className="rounded border border-amber-400/40 bg-amber-400/10 p-2.5">
                  <p className="text-[8px] uppercase tracking-widest text-amber-300">Scenario 2 · Locked breakout / reversal</p>
                  <p className="mt-1 font-mono text-lg text-amber-200">
                    {matrixOneWinSame
                      ? signedMoney(matrixOneWinPositive, currency)
                      : signedMoney(matrixOneWinPositive, currency) + " / " + signedMoney(matrixOneWinNegative, currency)}
                  </p>
                  <p className="text-[9px] text-amber-300/80">
                    {matrixOneWinSame ? "Either one-leg result lands at the same scratch" : "Breakout vs full reversal · one leg wins"}
                  </p>
                </div>
                <div className="rounded border border-sky-400/40 bg-sky-400/10 p-2.5">
                  <p className="text-[8px] uppercase tracking-widest text-sky-300">Scenario 3 · Unlocked solo win</p>
                  <p className="mt-1 font-mono text-lg text-sky-200">{signedMoney(payoff.soloWinProfit, currency)}</p>
                  <p className="text-[9px] text-sky-300/80">No lock needed · Leg 2 stake saved</p>
                </div>
                <div className="rounded border border-line bg-ink/60 p-2.5">
                  <p className="text-[8px] uppercase tracking-widest text-muted">Scenario 4 · Unlocked early drop</p>
                  <p className="mt-1 font-mono text-lg text-slate-200">{signedMoney(payoff.savedMissLoss, currency)}</p>
                  <p className="text-[9px] text-muted">Leg 2 saved · max loss capped at Leg 1</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-[9px] text-muted">
                <span>Matrix uses {matrixSide === "call" ? "CALL → PUT" : "PUT → CALL"} · Leg 2 preview at {previewLeg2Duration} ticks · total budget {costMoney(payoff.totalCost, currency)}</span>
                <span>Corridor target {active && active.entrySpot !== null ? formatPrice(targetSpotFor(active.entrySpot, active.side, active.atrAtEntry, active.minCorridor), decimals) : "waiting for S₀"}</span>
              </div>
              {previewError ? <p className="mt-2 text-[9px] text-amber-200">{previewError} Matrix is using the conservative fallback multiple.</p> : null}
            </section>

            {active ? (
              <section className="rounded-lg border border-line bg-panel p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold tracking-tight">Active Collar · {active.symbol}</h2>
                    <p className="mt-0.5 text-[10px] text-muted">{directionLabel(active.side)} · Leg 1 {sideLabel(active.side)} {active.duration}t · {active.locked ? "Leg 2 " + sideLabel(oppositeSide(active.side)) + " " + (active.leg2Duration ?? 0) + "t" : "Leg 2 contingent"}</p>
                  </div>
                  <span className={"rounded border px-2 py-1 text-[9px] font-semibold " + (active.locked ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : "border-amber-400/50 bg-amber-400/10 text-amber-200")}>
                    {active.locked ? "COLLAR LOCKED @ T" + (active.lockTick ?? 0) : "PEAK-LOCK WINDOW T+" + active.lockStart + "–T+" + active.lockEnd}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <Stat label="Entry S₀" value={active.entrySpot === null ? "waiting" : formatPrice(active.entrySpot, decimals)} />
                  <Stat label="Lock S_lock" value={active.lockSpot === null ? "not locked" : formatPrice(active.lockSpot, decimals)} />
                  <Stat label="Corridor width" value={active.lockSpot !== null && active.entrySpot !== null ? corridorWidth(active.entrySpot, active.lockSpot).toFixed(decimals) + " pts" : "-"} />
                  <Stat label="Tick progress" value={active.ticksElapsed + " / " + active.duration} />
                  <Stat label="Leg 1 P&L" value={signedMoney(active.legs[0]?.profit ?? 0, currency)} tone={(active.legs[0]?.profit ?? 0) >= 0 ? "text-emerald-300" : "text-danger"} />
                  <Stat label="Leg 2 P&L" value={active.locked ? signedMoney(active.legs[1]?.profit ?? 0, currency) : "saved " + costMoney(active.leg2Stake, currency)} />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded border border-line bg-ink/60 p-2 text-[9px] leading-relaxed text-muted">
                    <p><span className="text-slate-200">Alignment:</span> {active.locked ? "Leg 2 duration " + (active.leg2Duration ?? 0) + "t was priced at T+" + (active.lockTick ?? 0) + "; both legs target terminal tick T+" + active.duration + "." : "Leg 2 remains unbought until the corridor trigger; if the window closes, Leg 1 settles alone."}</p>
                    {active.alignmentWarning ? <p className="mt-1 text-amber-300">A tick arrived during the Leg 2 buy round-trip. Verify the terminal tick in Deriv; the lock guard prevents a second Leg 2.</p> : null}
                  </div>
                  <div className="rounded border border-line bg-ink/60 p-2 text-[9px] leading-relaxed text-muted">
                    <p><span className="text-slate-200">Risk lock:</span> {activeIdsRef.current.size} contract(s) still awaiting is_sold. The engine cannot open another collar until both settle and the post-round cooldown finishes.</p>
                    <p className="mt-1">Round budget {costMoney(active.cost, currency)} · Martingale level {active.martingaleLevel}.</p>
                  </div>
                </div>
              </section>
            ) : null}

            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Grouped Collar History</h2>
                  <p className="mt-0.5 text-[10px] text-muted">One row per settled round; both legs are grouped under the same lock decision.</p>
                </div>
                <button type="button" onClick={downloadCsv} disabled={rounds.length === 0} className={buttonBase + " border-line text-muted hover:text-slate-100"}>Export CSV</button>
              </div>
              {rounds.length === 0 ? (
                <p className="mt-3 rounded border border-line bg-ink px-3 py-5 text-center text-[11px] text-muted">No settled collar rounds yet. Start on Demo and wait for both is_sold confirmations.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[880px] border-collapse text-[10px]">
                    <thead>
                      <tr className="border-b border-line text-left text-[8px] uppercase tracking-widest text-muted">
                        <th className="py-1.5 pr-2 font-medium">Timestamp</th>
                        <th className="py-1.5 pr-2 font-medium">Symbol</th>
                        <th className="py-1.5 pr-2 font-medium">Direction</th>
                        <th className="py-1.5 pr-2 font-medium">Lock Status</th>
                        <th className="py-1.5 pr-2 font-medium">Corridor Width</th>
                        <th className="py-1.5 pr-2 text-right font-medium">Leg 1 P&amp;L</th>
                        <th className="py-1.5 pr-2 text-right font-medium">Leg 2 P&amp;L</th>
                        <th className="py-1.5 pr-2 font-medium">Outcome Badge</th>
                        <th className="py-1.5 text-right font-medium">Net Round P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rounds.map((row, index) => (
                        <tr key={row.time + "-" + index} className="border-b border-line/60 last:border-0">
                          <td className="py-1.5 pr-2 font-mono text-muted">{new Date(row.time).toLocaleString()}</td>
                          <td className="py-1.5 pr-2 font-mono text-slate-200">{row.symbol}</td>
                          <td className="py-1.5 pr-2 text-muted">{row.direction}</td>
                          <td className="py-1.5 pr-2 font-mono text-slate-300">{row.lockStatus}</td>
                          <td className="py-1.5 pr-2 font-mono text-slate-300">{row.width > 0 ? row.width.toFixed(4) + " pts" : "-"}</td>
                          <td className={"py-1.5 pr-2 text-right font-mono " + (row.leg1Pnl >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(row.leg1Pnl, currency)}</td>
                          <td className={"py-1.5 pr-2 text-right font-mono " + (row.leg2Pnl >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(row.leg2Pnl, currency)}</td>
                          <td className="py-1.5 pr-2"><span className={"rounded border px-1.5 py-0.5 text-[8px] font-semibold " + outcomeTone(row.outcome)}>{outcomeLabel(row.outcome)}</span></td>
                          <td className={"py-1.5 text-right font-mono font-semibold " + (row.net >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(row.net, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-3">
            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">Session Ledger</h2>
                <span className="rounded border border-line bg-ink px-2 py-0.5 font-mono text-[9px] text-muted">{rounds.length} rounds</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Stat label="Net session P&L" value={signedMoney(pnl, currency)} tone={pnl > 0 ? "text-emerald-300" : pnl < 0 ? "text-danger" : "text-slate-100"} />
                <Stat label="Wins / losses" value={wins + " / " + losses} />
                <Stat label="Peak martingale" value={"L" + peakLevel} />
                <Stat label="Open legs" value={String(activeIdsRef.current.size)} />
              </div>
            </section>

            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">Collar Sizing</h2>
                <span className="rounded border border-line bg-ink px-2 py-0.5 font-mono text-[9px] text-muted">{preset.toUpperCase()}</span>
              </div>
              <div className="mt-2 grid gap-1.5">
                <button type="button" onClick={() => applyPreset("symmetric")} disabled={busy} className={buttonBase + " text-left " + (preset === "symmetric" ? "border-accent bg-accent/10 text-accent" : "border-line bg-ink text-slate-300 hover:border-muted")}>
                  Symmetric Collar · $0.35 + $0.35
                  <span className="block text-[8px] font-normal text-muted">Max $0.70 · double-win +$0.66 · scratch −$0.02</span>
                </button>
                <button type="button" onClick={() => applyPreset("weighted")} disabled={busy} className={buttonBase + " text-left " + (preset === "weighted" ? "border-accent bg-accent/10 text-accent" : "border-line bg-ink text-slate-300 hover:border-muted")}>
                  Weighted Core-Collar · $0.70 + $0.35
                  <span className="block text-[8px] font-normal text-muted">Max $1.05 · corridor +$0.99 · continuation +$0.31</span>
                </button>
                <button type="button" onClick={() => applyPreset("custom")} disabled={busy} className={buttonBase + " text-left " + (preset === "custom" ? "border-accent bg-accent/10 text-accent" : "border-line bg-ink text-slate-300 hover:border-muted")}>
                  Custom Leg Stakes
                  <span className="block text-[8px] font-normal text-muted">Minimum $0.35 · $0.05 step</span>
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Leg 1 stake ($)">
                  <input type="number" min={COLLAR_MIN_STAKE} step={0.05} value={leg1Stake} disabled={busy} onChange={(event) => updateLeg1(Number(event.target.value))} className={inputClass} />
                </Field>
                <Field label="Leg 2 stake ($)">
                  <input type="number" min={COLLAR_MIN_STAKE} step={0.05} value={leg2Stake} disabled={busy} onChange={(event) => updateLeg2(Number(event.target.value))} className={inputClass} />
                </Field>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[9px]">
                <div className="rounded border border-line bg-ink/60 px-2 py-1.5"><span className="text-muted">Base budget</span><span className="mt-0.5 block font-mono text-slate-100">{costMoney(round2(leg1Stake + leg2Stake), currency)}</span></div>
                <div className="rounded border border-line bg-ink/60 px-2 py-1.5"><span className="text-muted">This round</span><span className="mt-0.5 block font-mono text-slate-100">{costMoney(budget, currency)}</span></div>
              </div>
              <div className="mt-2 rounded border border-line bg-ink/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-semibold text-slate-200">Martingale</p>
                    <p className="text-[8px] text-muted">Only after a net-negative round below −$0.05 · max {martingaleMaxLevels} levels</p>
                  </div>
                  <button type="button" onClick={toggleMartingale} disabled={busy} className={buttonBase + " " + (martingaleOn ? "border-amber-400/50 bg-amber-400/10 text-amber-200" : "border-line bg-ink text-muted")}>
                    {martingaleOn ? "ON" : "OFF"}
                  </button>
                </div>
                {martingaleOn ? (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Field label="Multiplier" hint="Applied to both legs">
                      <input type="number" min={1.1} max={3} step={0.1} value={martingaleMultiplier} disabled={busy} onChange={(event) => { const next = Math.max(1.1, Math.min(3, Number(event.target.value) || 1.6)); setMartingaleMultiplier(next); martingaleMultiplierRef.current = next; levelRef.current = 0; setMartingaleLevel(0); }} className={inputClass} />
                    </Field>
                    <Field label="Max levels" hint="Cycle 0 through max">
                      <input type="number" min={1} max={COLLAR_MAX_MARTINGALE_LEVELS} step={1} value={martingaleMaxLevels} disabled={busy} onChange={(event) => { const next = Math.max(1, Math.min(COLLAR_MAX_MARTINGALE_LEVELS, Math.round(Number(event.target.value) || 1))); setMartingaleMaxLevels(next); martingaleMaxLevelsRef.current = next; levelRef.current = 0; setMartingaleLevel(0); }} className={inputClass} />
                    </Field>
                  </div>
                ) : null}
                <p className="mt-1 font-mono text-[9px] text-slate-300">
                  {martingaleOn ? "Level " + currentLevel + " / " + martingaleMaxLevels + " · " + martingaleMultiplier.toFixed(1) + "× both legs" : "Flat stakes · near-zero scratches do not escalate"}
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-line bg-panel p-3">
              <h2 className="text-sm font-semibold tracking-tight">Phase 1 · Impulse</h2>
              <div className="mt-2">
                <p className="text-[9px] uppercase tracking-widest text-muted">Direction mode</p>
                <div className="mt-1 grid grid-cols-3 gap-1 rounded border border-line bg-ink/60 p-1">
                  {(["auto", "bullish", "bearish"] as const).map((mode) => (
                    <button key={mode} type="button" onClick={() => { setDirectionMode(mode); directionRef.current = mode; }} disabled={busy} className={"rounded px-1 py-1.5 text-[9px] font-semibold disabled:opacity-50 " + (directionMode === mode ? "bg-accent text-ink" : "text-muted hover:text-slate-100")}>
                      {mode === "auto" ? "Auto impulse" : mode === "bullish" ? "Bullish only" : "Bearish only"}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[8px] leading-relaxed text-muted">
                  {directionMode === "auto" ? "Follow the sign of Δ5: CALL above +threshold, PUT below −threshold." : directionMode === "bullish" ? "Only a positive impulse starts a CALL → PUT collar." : "Only a negative impulse starts a PUT → CALL collar."}
                </p>
              </div>
              <label className="mt-2 flex items-center justify-between gap-2 rounded border border-line bg-ink/60 px-2 py-1.5">
                <span className="text-[9px] text-muted">Require impulse filter</span>
                <input type="checkbox" checked={requireImpulse} disabled={busy} onChange={(event) => { setRequireImpulse(event.target.checked); requireImpulseRef.current = event.target.checked; }} className="h-3.5 w-3.5 accent-emerald-400" />
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Min impulse ratio" hint="Δ5 ÷ ATR20 · step 0.10">
                  <input type="number" min={0.1} max={5} step={0.1} value={minImpulse} disabled={busy || !requireImpulse} onChange={(event) => { const next = Math.max(0.1, Math.min(5, Number(event.target.value))); setMinImpulse(next); minImpulseRef.current = next; }} className={inputClass} />
                </Field>
                <Field label="Live ratio">
                  <div className={"rounded border bg-ink px-2 py-1.5 font-mono text-[11px] " + (impulse.ratio >= 0 ? "border-emerald-400/40 text-emerald-300" : "border-danger/40 text-danger")}>
                    {impulse.ratio >= 0 ? "+" : ""}{impulse.ratio.toFixed(2)}×
                  </div>
                </Field>
              </div>
              <p className="mt-1 text-[8px] leading-relaxed text-muted">Δ5 {formatPrice(impulse.delta5, decimals)} · ATR20 {formatPrice(impulse.atr20, decimals)} · {impulse.samples}/60 samples</p>
            </section>

            <section className="rounded-lg border border-line bg-panel p-3">
              <h2 className="text-sm font-semibold tracking-tight">Risk & Execution</h2>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Stop loss ($)">
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0.25}
                      step={0.25}
                      value={stopLoss}
                      disabled={busy}
                      onChange={(event) => { const next = Math.max(0.25, Number(event.target.value) || 0.25); setIsSlManual(true); setStopLoss(next); stopRef.current = next; }}
                      className={inputClass}
                    />
                  </div>
                  <span className={"mt-1 inline-flex rounded px-1.5 py-0.5 text-[8px] font-semibold " + (isSlManual ? "bg-amber-400/15 text-amber-300" : "bg-accent/10 text-accent")}>{isSlManual ? "Custom SL" : "Auto SL"}</span>
                  {isSlManual ? <button type="button" disabled={busy} onClick={() => { setIsSlManual(false); setStopLoss(riskPlan.autoStopLoss); stopRef.current = riskPlan.autoStopLoss; }} className="ml-1 text-[8px] text-amber-300 underline decoration-dotted disabled:opacity-40">Reset to Auto</button> : null}
                </Field>
                <Field label="Take profit ($)">
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0.25}
                      step={0.25}
                      value={takeProfit}
                      disabled={busy}
                      onChange={(event) => { const next = Math.max(0.25, Number(event.target.value) || 0.25); setIsTpManual(true); setTakeProfit(next); tpRef.current = next; }}
                      className={inputClass}
                    />
                  </div>
                  <span className={"mt-1 inline-flex rounded px-1.5 py-0.5 text-[8px] font-semibold " + (isTpManual ? "bg-amber-400/15 text-amber-300" : "bg-accent/10 text-accent")}>{isTpManual ? "Custom TP" : "Auto TP"}</span>
                  {isTpManual ? <button type="button" disabled={busy} onClick={() => { setIsTpManual(false); setTakeProfit(riskPlan.autoTakeProfit); tpRef.current = riskPlan.autoTakeProfit; }} className="ml-1 text-[8px] text-amber-300 underline decoration-dotted disabled:opacity-40">Reset to Auto</button> : null}
                </Field>
              </div>
              <p className="mt-1 text-[8px] leading-relaxed text-muted">Auto SL: {planText}. Auto TP: {COLLAR_TP_MULTIPLE}× corridor net, floored at 75% of Auto SL and rounded to $0.25. Current Auto: SL {riskPlan.autoStopLoss.toFixed(2)} · TP {riskPlan.autoTakeProfit.toFixed(2)}.</p>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button type="button" onClick={requestArm} disabled={!canArm || armed} className={buttonBase + " border-accent/60 bg-accent/15 text-accent hover:bg-accent/25"}>
                  {armed ? "Armed" : "Arm Auto Collar"}
                </button>
                <button type="button" onClick={() => stopEngine("Engine stopped")} disabled={!armed && !active} className={buttonBase + " border-line bg-ink text-muted hover:text-slate-100"}>
                  Stop / Disarm
                </button>
                <button type="button" onClick={() => requestManual("call")} disabled={busy || !connected || !spec || !streaming || !lockFeasible} className={buttonBase + " border-sky-400/50 bg-sky-400/10 text-sky-200 hover:bg-sky-400/20"}>
                  Fire CALL Collar
                </button>
                <button type="button" onClick={() => requestManual("put")} disabled={busy || !connected || !spec || !streaming || !lockFeasible} className={buttonBase + " border-rose-400/50 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20"}>
                  Fire PUT Collar
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between text-[9px] text-muted">
                <span>{armed ? "Auto scanning: " + (requireImpulse ? "filter ON" : "filter OFF") : "Auto off"}</span>
                <button type="button" onClick={resetSession} disabled={busy || hardLocked} className="text-muted underline decoration-dotted hover:text-slate-100">Reset session</button>
              </div>
              {connected && accountKind !== "demo" && !realOk ? <p className="mt-2 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[9px] leading-relaxed text-danger">Real money: explicit confirmation is required before arming or firing.</p> : null}
            </section>

            <section className="rounded-lg border border-line bg-panel p-3 text-[9px] leading-relaxed text-muted">
              <h2 className="text-sm font-semibold tracking-tight text-slate-100">Execution invariants</h2>
              <p className="mt-2"><span className="text-slate-200">Single lock:</span> Leg 2 can fire once per round. If the window closes with no trigger, Leg 1 finishes solo and the second stake is never bought.</p>
              <p className="mt-1"><span className="text-slate-200">Exact terminal tick:</span> Leg 2 duration is D − ticksElapsed; the page re-prices if a tick moves during the proposal round-trip and hard-locks if the buy itself crosses a tick.</p>
              <p className="mt-1"><span className="text-slate-200">Atomic settlement:</span> the engine holds the round lock until every bought contract reports is_sold = 1. A settlement timeout or ambiguous buy acknowledgement locks the page rather than guessing.</p>
              <p className="mt-1"><span className="text-slate-200">Risk gate:</span> TP/SL is checked after every settled round; the next round must also pass the full two-leg headroom check before quoting.</p>
            </section>
          </aside>
        </div>
      </div>

      <SessionAdvisorModal
        open={advisor !== null}
        state={advisor}
        currency={currency}
        variant="collar"
        onDismiss={() => setAdvisor(null)}
        onReset={resetSession}
      />

      {confirmIntent ? (
        <Modal title={confirmIntent === "arm" ? "Arm auto collar on Real money" : "Fire one collar on Real money"} onClose={() => { setConfirmIntent(null); setConfirmChecked(false); }}>
          <p>
            You are about to {confirmIntent === "arm" ? "arm an engine that can open repeated contingent two-leg collars" : "buy a contingent two-leg collar"} on the <span className="font-semibold text-danger">REAL</span> account <span className="font-mono">{accountId}</span>.
            Leg 1 is {costMoney(currentLeg1, currency)} and Leg 2 is at most {costMoney(currentLeg2, currency)}; the maximum round cost is {costMoney(budget, currency)}. Leg 2 is bought only inside the Peak-Lock Window.
          </p>
          <label className="mt-3 flex items-start gap-2 rounded border border-danger/40 bg-danger/10 p-2 text-[10px] text-danger">
            <input type="checkbox" checked={confirmChecked} onChange={(event) => setConfirmChecked(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-red-400" />
            <span>I understand this can place real-money CALL and PUT contracts and that the automatic engine can fire again after its cooldown.</span>
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => { setConfirmIntent(null); setConfirmChecked(false); }} className={buttonBase + " border-line text-muted"}>Cancel</button>
            <button type="button" onClick={confirmReal} disabled={!confirmChecked} className={buttonBase + " border-danger/60 bg-danger/15 text-danger"}>
              {confirmIntent === "arm" ? "Confirm & Arm" : "Confirm & Fire"}
            </button>
          </div>
        </Modal>
      ) : null}

      <div className="mx-auto mt-3 max-w-[1500px] text-[8px] leading-relaxed text-muted">
        Trading synthetic indices carries risk. A corridor win is not guaranteed by a momentum impulse; the four-scenario matrix shows every settled outcome at the current proposal multiples.
      </div>
    </main>
  );
}
