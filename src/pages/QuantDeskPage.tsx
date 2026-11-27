/**
 * Page 6 — The Quant Desk.
 *
 * A 10-market implied-vs-realized scanner with a Bayesian four-regime
 * router, fractional-Kelly micro-stakes, automatic early-exit harvesting,
 * hard risk locks and a session audit trail. All exchange interaction goes
 * through the shared DerivSession so the existing pages keep their socket.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Account, ContractOffer, DerivSession, Quote, QuoteRequest, Tick } from "@/deriv";
import { DerivError } from "@/deriv";
import QuantRegimeScanner from "@/components/QuantRegimeScanner";
import type { QuantScannerRow } from "@/components/QuantRegimeScanner";
import SessionAdvisorModal from "@/components/SessionAdvisorModal";
import type { SessionAdvisorMode, SessionAdvisorState } from "@/components/SessionAdvisorModal";
import {
  QUANT_AUTO_STOP_LOSS,
  QUANT_AUTO_TAKE_PROFIT,
  QUANT_BREAKER_MIN_TRADES,
  QUANT_BUFFER_SIZE,
  QUANT_CAPTURE_CEILING,
  QUANT_CAPTURE_FLOOR,
  QUANT_COOLDOWN_MS,
  QUANT_DEFAULT_CAPTURE_PCT,
  QUANT_DEFAULT_MIN_EV,
  QUANT_MAX_EV_FLOOR,
  QUANT_MAX_STAKE,
  QUANT_MIN_EV_FLOOR,
  QUANT_MIN_STAKE,
  QUANT_STAKE_STEP,
  QUANT_SYMBOLS,
  QUANT_UNIVERSE,
  buildQuantTradePlan,
  clamp,
  classifyQuantRegime,
  computeQuantFeatures,
  edgeDriftBreaker,
  extractQuantCapabilities,
  formatQuantDuration,
  quantAutoStopLoss,
  quantAutoTakeProfit,
  quantQuoteMetrics,
  quantStakeCap,
  round2,
  roundStake,
  shouldHarvest,
  sizeQuantStake,
} from "@/utils/quantEngineMath";
import type {
  QuantCapabilities,
  QuantContractKind,
  QuantDurationUnit,
  QuantRegimeId,
  QuantRegimeSignal,
  QuantTradePlan,
} from "@/utils/quantEngineMath";

interface Props {
  sessionRef: { readonly current: DerivSession | null };
  connected: boolean;
  accounts: Account[];
  accountId: string;
  accountKind: "demo" | "real" | "unknown";
  balance: number | null;
  currency: string;
  onConnect: () => void;
  onAccountChange: (accountId: string) => void;
  onNotice: (text: string, tone: "bad" | "ok") => void;
  bindContractListener: (handler: ((payload: unknown) => void) | null) => void;
  bindNavigationGuard: (handler: (() => string | null) | null) => void;
}

type ExitMode = "pending" | "early";

interface QuantPosition {
  id: number;
  symbol: string;
  regime: QuantRegimeId;
  regimeLabel: string;
  contract: QuantContractKind;
  direction: -1 | 0 | 1;
  duration: number;
  unit: QuantDurationUnit;
  barrier: string | null;
  stake: number;
  buyPrice: number;
  payout: number;
  pRealized: number;
  pImplied: number;
  posterior: number;
  evPct: number;
  openedAt: number;
  bidPrice: number;
  unrealized: number;
  isValidToSell: boolean;
  isSold: boolean;
  exitMode: ExitMode;
  sellInFlight: boolean;
  sellAttempts: number;
  sellBlocked: boolean;
  sellAcknowledged: boolean;
  watchId: string;
  status: string;
  profit: number | null;
}

interface QuantQuoteSnapshot {
  key: string;
  quote: Quote;
  pRealized: number;
  pImplied: number;
  evPct: number;
  fetchedAt: number;
  stake: number;
}

interface QuantAuditRow {
  at: string;
  symbol: string;
  regime: string;
  contract: QuantContractKind;
  pRealized: number;
  pImplied: number;
  evPct: number;
  stake: number;
  exitMode: "EARLY SELL" | "EXPIRY";
  net: number;
  won: boolean;
}

interface ConfirmIntent {
  kind: "arm" | "execute";
  symbol?: string;
}

interface SeedBuffer {
  token: number;
  ticks: Tick[];
}

function emptyRow(market: (typeof QUANT_UNIVERSE)[number]): QuantScannerRow {
  return {
    symbol: market.symbol,
    family: market.family,
    watched: true,
    samples: 0,
    ready: false,
    spot: null,
    atrRatio: null,
    efficiency30: null,
    hurst: null,
    ticksSinceJump: null,
    regime: null,
    regimeLabel: "",
    posterior: null,
    contract: null,
    direction: 0,
    duration: null,
    unit: null,
    barrier: null,
    pRealized: null,
    pImplied: null,
    evPct: null,
    quoteAgeMs: null,
    historyError: null,
    contractError: null,
    quoteError: null,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function numeric(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function boolish(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface ContractFrame {
  id: number;
  buyPrice: number;
  payout: number;
  bidPrice: number;
  sellPrice: number | null;
  isValidToSell: boolean;
  isSold: boolean;
  profit: number | null;
  status: string;
}

function parseContractFrame(raw: unknown): ContractFrame | null {
  const outer = recordOf(raw);
  if (!outer) return null;
  const source = recordOf(outer.proposal_open_contract) ?? outer;
  const id = Math.trunc(numeric(source.contract_id));
  if (id <= 0) return null;
  const status = textOf(source.status).toLowerCase();
  const isSold = boolish(source.is_sold) || boolish(source.sold) || status === "sold" || status === "won" || status === "lost";
  const profitRaw = source.profit ?? source.sell_profit;
  const profit = typeof profitRaw === "number" && Number.isFinite(profitRaw)
    ? profitRaw
    : typeof profitRaw === "string" && profitRaw.trim() !== "" && Number.isFinite(Number(profitRaw))
      ? Number(profitRaw)
      : null;
  const sellRaw = numeric(source.sell_price) > 0 ? numeric(source.sell_price) : numeric(source.sold_for);
  return {
    id,
    buyPrice: numeric(source.buy_price),
    payout: numeric(source.payout),
    bidPrice: numeric(source.bid_price),
    sellPrice: sellRaw > 0 ? sellRaw : null,
    isValidToSell: boolish(source.is_valid_to_sell) && !isSold,
    isSold,
    profit,
    status,
  };
}

function mergeHistory(existing: readonly Tick[], incoming: readonly Tick[]): Tick[] {
  const byEpoch = new Map<number, Tick>();
  const withoutEpoch: Tick[] = [];
  for (const tick of [...existing, ...incoming]) {
    if (!Number.isFinite(tick.quote) || tick.quote <= 0) continue;
    if (Number.isFinite(tick.epoch) && tick.epoch > 0) byEpoch.set(tick.epoch, tick);
    else withoutEpoch.push(tick);
  }
  return [...byEpoch.values()].sort((left, right) => left.epoch - right.epoch).concat(withoutEpoch).slice(-QUANT_BUFFER_SIZE);
}

function horizonTimeoutMs(duration: number, unit: QuantDurationUnit): number {
  const raw = unit === "t" ? Math.max(90_000, duration * 2_500 + 45_000) : unit === "s" ? duration * 1_000 + 45_000 : duration * 60_000 + 45_000;
  return Math.max(90_000, raw);
}

function initialStake(
  plan: QuantTradePlan,
  balance: number | null,
  mode: "kelly" | "fixed",
  fixedStake: number,
  snapshot: QuantQuoteSnapshot | null,
): number {
  const quote = snapshot && snapshot.key === plan.key ? snapshot.quote : { ask: QUANT_MIN_STAKE, payout: QUANT_MIN_STAKE * 2 };
  return sizeQuantStake({
    mode,
    balance: balance ?? 0,
    quote,
    pRealized: plan.pRealized,
    fixedStake,
  });
}

function quoteRequestFor(plan: QuantTradePlan, stake: number, currency: string): QuoteRequest {
  const base: QuoteRequest = {
    symbol: plan.symbol,
    contract: plan.contract,
    duration: plan.duration,
    durationUnit: plan.unit,
    stake,
    currency,
  };
  return plan.barrier ? { ...base, barrier: plan.barrier } : base;
}

function describeError(error: unknown): string {
  if (error instanceof DerivError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unknown broker error";
}

function isAmbiguousPurchase(error: unknown): boolean {
  if (!(error instanceof DerivError)) return true;
  return error.code === "Timeout" || error.code === "Socket";
}

function csvCell(value: string | number): string {
  const text = String(value);
  return "\"" + text.replace(/"/g, "\"\"") + "\"";
}

function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-lg rounded-lg border border-line bg-panel p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
          <button type="button" onClick={onClose} className="rounded border border-line px-2 py-1 text-[10px] text-muted hover:text-slate-100">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }): ReactElement {
  return (
    <div className="rounded border border-line bg-ink/50 px-2.5 py-2">
      <p className="text-[8px] uppercase tracking-widest text-muted">{label}</p>
      <p className={"mt-0.5 font-mono text-[12px] " + (tone ?? "text-slate-100")}>{value}</p>
    </div>
  );
}

export default function QuantDeskPage({
  sessionRef,
  connected,
  accounts,
  accountId,
  accountKind,
  balance,
  currency,
  onConnect,
  onAccountChange,
  onNotice,
  bindContractListener,
  bindNavigationGuard,
}: Props): ReactElement {
  const [watched, setWatched] = useState<Set<string>>(() => new Set(QUANT_SYMBOLS));
  const [rows, setRows] = useState<QuantScannerRow[]>(() => QUANT_UNIVERSE.map(emptyRow));
  const [active, setActive] = useState<QuantPosition | null>(null);
  const [audit, setAudit] = useState<QuantAuditRow[]>([]);
  const [pnl, setPnl] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [minEv, setMinEv] = useState(QUANT_DEFAULT_MIN_EV);
  const [sizingMode, setSizingMode] = useState<"kelly" | "fixed">("kelly");
  const [fixedStake, setFixedStake] = useState(QUANT_MIN_STAKE);
  const [earlyExit, setEarlyExit] = useState(true);
  const [capturePct, setCapturePct] = useState(QUANT_DEFAULT_CAPTURE_PCT);
  const [stopLoss, setStopLoss] = useState(quantAutoStopLoss());
  const [takeProfit, setTakeProfit] = useState(quantAutoTakeProfit());
  const [slManual, setSlManual] = useState(false);
  const [tpManual, setTpManual] = useState(false);
  const [armed, setArmed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hardLocked, setHardLocked] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [phase, setPhase] = useState("Warming the 10-symbol scan.");
  const [quoteScanning, setQuoteScanning] = useState(false);
  const [executingSymbol, setExecutingSymbol] = useState<string | null>(null);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [realOk, setRealOk] = useState(false);
  const [advisor, setAdvisor] = useState<SessionAdvisorState | null>(null);

  const aliveRef = useRef(true);
  const sessionLiveRef = useRef<DerivSession | null>(null);
  const connectedRef = useRef(connected);
  const accountIdRef = useRef(accountId);
  const accountKindRef = useRef(accountKind);
  const balanceRef = useRef(balance);
  const currencyRef = useRef(currency);
  const watchedRef = useRef(watched);
  const minEvRef = useRef(minEv);
  const sizingModeRef = useRef(sizingMode);
  const fixedStakeRef = useRef(fixedStake);
  const earlyExitRef = useRef(earlyExit);
  const captureRef = useRef(capturePct);
  const stopLossRef = useRef(stopLoss);
  const takeProfitRef = useRef(takeProfit);
  const armedRef = useRef(armed);
  const pausedRef = useRef(paused);
  const hardLockedRef = useRef(hardLocked);
  const coolingRef = useRef(cooling);
  const realOkRef = useRef(realOk);
  const execRef = useRef(false);
  const activeRef = useRef<QuantPosition | null>(null);
  const activeIdsRef = useRef<Set<number>>(new Set());
  const auditRef = useRef<QuantAuditRow[]>([]);
  const pnlRef = useRef(0);
  const winsRef = useRef(0);
  const lossesRef = useRef(0);
  const historiesRef = useRef<Map<string, Tick[]>>(new Map());
  const featuresRef = useRef(new Map<string, ReturnType<typeof computeQuantFeatures>>());
  const signalsRef = useRef(new Map<string, QuantRegimeSignal>());
  const plansRef = useRef(new Map<string, QuantTradePlan>());
  const capabilitiesRef = useRef(new Map<string, QuantCapabilities>());
  const capabilityLoadingRef = useRef(new Set<string>());
  const quotesRef = useRef(new Map<string, QuantQuoteSnapshot>());
  const lastQuoteAttemptRef = useRef(new Map<string, number>());
  const historyErrorsRef = useRef(new Map<string, string>());
  const contractErrorsRef = useRef(new Map<string, string>());
  const quoteErrorsRef = useRef(new Map<string, string>());
  const streamsRef = useRef(new Map<string, string>());
  const activeStreamsRef = useRef(new Set<string>());
  const pendingSubsRef = useRef(new Map<string, number>());
  const seedBuffersRef = useRef(new Map<string, SeedBuffer>());
  const streamTokenRef = useRef(0);
  const streamGenerationRef = useRef(0);
  const watchIdsRef = useRef(new Map<number, string>());
  const finalizingRef = useRef(new Set<number>());
  const settleTimerRef = useRef<number | null>(null);
  const cooldownTimerRef = useRef<number | null>(null);
  const confirmAccountRef = useRef("");
  const quoteBusyRef = useRef(false);
  const requestQuoteRef = useRef<(symbol: string) => void>(() => undefined);
  const maybeAutoRef = useRef<() => void>(() => undefined);
  const tickHandlerRef = useRef<(symbol: string, tick: Tick) => void>(() => undefined);
  const contractHandlerRef = useRef<(payload: unknown) => void>(() => undefined);
  const previousAccountRef = useRef(accountId);
  const previousConnectedRef = useRef(connected);

  connectedRef.current = connected;
  accountIdRef.current = accountId;
  accountKindRef.current = accountKind;
  balanceRef.current = balance;
  currencyRef.current = currency;
  watchedRef.current = watched;
  // The engine reads refs synchronously, so malformed/cleared inputs can never
  // widen a risk limit before the input's onBlur clamp runs.
  minEvRef.current = clamp(minEv, QUANT_MIN_EV_FLOOR, QUANT_MAX_EV_FLOOR);
  sizingModeRef.current = sizingMode;
  fixedStakeRef.current = Math.max(QUANT_MIN_STAKE, fixedStake);
  earlyExitRef.current = earlyExit;
  captureRef.current = clamp(capturePct, QUANT_CAPTURE_FLOOR, QUANT_CAPTURE_CEILING);
  stopLossRef.current = Math.max(QUANT_MIN_STAKE, stopLoss);
  takeProfitRef.current = Math.max(0.05, takeProfit);
  armedRef.current = armed;
  pausedRef.current = paused;
  hardLockedRef.current = hardLocked;
  coolingRef.current = cooling;
  realOkRef.current = realOk;

  const publishRows = useCallback(() => {
    const now = Date.now();
    const next = QUANT_UNIVERSE.map((market) => {
      const base = emptyRow(market);
      const features = featuresRef.current.get(market.symbol);
      const signal = signalsRef.current.get(market.symbol);
      const plan = plansRef.current.get(market.symbol);
      const snapshot = quotesRef.current.get(market.symbol);
      const fresh = plan && snapshot && snapshot.key === plan.key ? snapshot : null;
      return {
        ...base,
        watched: watchedRef.current.has(market.symbol),
        samples: features?.samples ?? 0,
        ready: features?.ready ?? false,
        spot: features && features.spot > 0 ? features.spot : null,
        atrRatio: features?.atrRatio ?? null,
        efficiency30: features?.efficiency30 ?? null,
        hurst: features?.hurst ?? null,
        ticksSinceJump: features?.ticksSinceJump ?? null,
        regime: plan?.regime ?? signal?.regime ?? null,
        regimeLabel: plan?.regimeLabel ?? signal?.label ?? "",
        posterior: plan?.posterior ?? signal?.posterior ?? null,
        contract: plan?.contract ?? signal?.contract ?? null,
        direction: plan?.direction ?? signal?.direction ?? 0,
        duration: plan?.duration ?? null,
        unit: plan?.unit ?? null,
        barrier: plan?.barrier ?? null,
        pRealized: fresh?.pRealized ?? plan?.pRealized ?? null,
        pImplied: fresh?.pImplied ?? null,
        evPct: fresh?.evPct ?? null,
        quoteAgeMs: fresh ? now - fresh.fetchedAt : null,
        historyError: historyErrorsRef.current.get(market.symbol) ?? null,
        contractError: contractErrorsRef.current.get(market.symbol) ?? null,
        quoteError: quoteErrorsRef.current.get(market.symbol) ?? null,
      };
    });
    setRows(next);
  }, []);

  const recomputeSymbol = useCallback((symbol: string) => {
    const history = historiesRef.current.get(symbol) ?? [];
    const features = computeQuantFeatures(history);
    featuresRef.current.set(symbol, features);
    if (!features.ready) {
      signalsRef.current.delete(symbol);
      plansRef.current.delete(symbol);
      quotesRef.current.delete(symbol);
      publishRows();
      return;
    }
    const signal = classifyQuantRegime(features, symbol);
    if (signal) signalsRef.current.set(symbol, signal);
    else signalsRef.current.delete(symbol);
    const capabilities = capabilitiesRef.current.get(symbol);
    const plan = signal && capabilities
      ? buildQuantTradePlan({ symbol, features, signal, capabilities, history })
      : null;
    if (plan) plansRef.current.set(symbol, plan);
    else plansRef.current.delete(symbol);
    const snapshot = quotesRef.current.get(symbol);
    if (snapshot && (!plan || snapshot.key !== plan.key)) quotesRef.current.delete(symbol);
    publishRows();
    if (plan) requestQuoteRef.current(symbol);
  }, [publishRows]);

  const loadCapabilities = useCallback(async (symbol: string) => {
    if (capabilitiesRef.current.has(symbol) || capabilityLoadingRef.current.has(symbol)) return;
    const session = sessionRef.current;
    if (!session) return;
    const generation = streamGenerationRef.current;
    capabilityLoadingRef.current.add(symbol);
    try {
      let offers: ContractOffer[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          offers = await session.contractsFor(symbol);
          break;
        } catch (error) {
          if (attempt === 1) throw error;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 600));
          if (!aliveRef.current || generation !== streamGenerationRef.current || !watchedRef.current.has(symbol)) return;
        }
      }
      if (!aliveRef.current || generation !== streamGenerationRef.current || !watchedRef.current.has(symbol)) return;
      const capabilities = extractQuantCapabilities(offers);
      capabilitiesRef.current.set(symbol, capabilities);
      contractErrorsRef.current.delete(symbol);
      recomputeSymbol(symbol);
    } catch (error) {
      if (aliveRef.current && watchedRef.current.has(symbol)) {
        contractErrorsRef.current.set(symbol, "contracts_for: " + describeError(error));
        publishRows();
      }
    } finally {
      capabilityLoadingRef.current.delete(symbol);
    }
  }, [publishRows, recomputeSymbol, sessionRef]);

  const stopSymbol = useCallback((symbol: string) => {
    streamTokenRef.current += 1;
    pendingSubsRef.current.delete(symbol);
    seedBuffersRef.current.delete(symbol);
    activeStreamsRef.current.delete(symbol);
    const subscriptionId = streamsRef.current.get(symbol);
    streamsRef.current.delete(symbol);
    if (subscriptionId) {
      const session = sessionRef.current;
      if (session) void session.forget(subscriptionId).catch(() => undefined);
    }
    historiesRef.current.delete(symbol);
    featuresRef.current.delete(symbol);
    signalsRef.current.delete(symbol);
    plansRef.current.delete(symbol);
    quotesRef.current.delete(symbol);
    lastQuoteAttemptRef.current.delete(symbol);
    historyErrorsRef.current.delete(symbol);
    contractErrorsRef.current.delete(symbol);
    quoteErrorsRef.current.delete(symbol);
    publishRows();
  }, [publishRows, sessionRef]);

  const startSymbol = useCallback(async (symbol: string) => {
    const session = sessionRef.current;
    if (!session || !connectedRef.current || !watchedRef.current.has(symbol)) return;
    if (pendingSubsRef.current.has(symbol) || activeStreamsRef.current.has(symbol)) return;
    const token = ++streamTokenRef.current;
    const generation = streamGenerationRef.current;
    pendingSubsRef.current.set(symbol, token);
    seedBuffersRef.current.set(symbol, { token, ticks: [] });
    historyErrorsRef.current.delete(symbol);
    contractErrorsRef.current.delete(symbol);
    quoteErrorsRef.current.delete(symbol);
    publishRows();
    let history: Tick[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        history = await session.history(symbol, QUANT_BUFFER_SIZE, "ticks");
        break;
      } catch (error) {
        if (attempt === 1) {
          if (aliveRef.current && watchedRef.current.has(symbol)) {
            historyErrorsRef.current.set(symbol, "history: " + describeError(error));
          }
          break;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 650));
        if (!aliveRef.current || generation !== streamGenerationRef.current || pendingSubsRef.current.get(symbol) !== token) return;
      }
    }
    const stillCurrent = aliveRef.current
      && generation === streamGenerationRef.current
      && pendingSubsRef.current.get(symbol) === token
      && watchedRef.current.has(symbol);
    if (!stillCurrent) return;
    const seed = seedBuffersRef.current.get(symbol);
    historiesRef.current.set(symbol, mergeHistory(history, seed?.ticks ?? []));
    seedBuffersRef.current.delete(symbol);
    recomputeSymbol(symbol);
    void loadCapabilities(symbol);
    try {
      const subscriptionId = await session.subscribeTicksFor(symbol);
      const canKeep = aliveRef.current
        && generation === streamGenerationRef.current
        && watchedRef.current.has(symbol);
      if (!canKeep) {
        if (subscriptionId) void session.forget(subscriptionId).catch(() => undefined);
        return;
      }
      if (subscriptionId) streamsRef.current.set(symbol, subscriptionId);
      activeStreamsRef.current.add(symbol);
    } catch (error) {
      if (error instanceof DerivError && error.code === "AlreadySubscribed") {
        activeStreamsRef.current.add(symbol);
      } else if (aliveRef.current && watchedRef.current.has(symbol)) {
        historyErrorsRef.current.set(symbol, "stream: " + describeError(error));
        publishRows();
      }
    } finally {
      if (pendingSubsRef.current.get(symbol) === token) pendingSubsRef.current.delete(symbol);
      if (aliveRef.current) recomputeSymbol(symbol);
    }
  }, [loadCapabilities, publishRows, recomputeSymbol, sessionRef]);

  const releaseWatch = useCallback((contractId: number) => {
    const watchId = watchIdsRef.current.get(contractId);
    watchIdsRef.current.delete(contractId);
    if (watchId) {
      const session = sessionRef.current;
      if (session) void session.forget(watchId).catch(() => undefined);
    }
  }, [sessionRef]);

  const clearSettlementTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const clearCooldownTimer = useCallback(() => {
    if (cooldownTimerRef.current !== null) {
      window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, []);

  const lockEngine = useCallback((reason: string) => {
    hardLockedRef.current = true;
    setHardLocked(true);
    armedRef.current = false;
    setArmed(false);
    setPhase(reason);
    onNotice(reason, "bad");
  }, [onNotice]);

  const showAdvisor = useCallback((mode: SessionAdvisorMode) => {
    armedRef.current = false;
    setArmed(false);
    pausedRef.current = true;
    setPaused(true);
    coolingRef.current = false;
    setCooling(false);
    clearCooldownTimer();
    setAdvisor({
      mode,
      pnl: pnlRef.current,
      wins: winsRef.current,
      losses: lossesRef.current,
      peakLevel: 0,
      stopLoss: stopLossRef.current,
      takeProfit: takeProfitRef.current,
    });
  }, [clearCooldownTimer]);

  const beginCooldown = useCallback((reason: string) => {
    clearCooldownTimer();
    coolingRef.current = true;
    setCooling(true);
    setPhase(reason);
    cooldownTimerRef.current = window.setTimeout(() => {
      cooldownTimerRef.current = null;
      coolingRef.current = false;
      setCooling(false);
      if (!aliveRef.current || pausedRef.current || hardLockedRef.current) return;
      setPhase("Scanning for +EV mispricing.");
      for (const market of QUANT_UNIVERSE) {
        if (watchedRef.current.has(market.symbol)) requestQuoteRef.current(market.symbol);
      }
      maybeAutoRef.current();
    }, QUANT_COOLDOWN_MS);
  }, [clearCooldownTimer]);

  const requestQuote = useCallback((symbol: string) => {
    if (!aliveRef.current || !connectedRef.current || execRef.current || activeRef.current || activeIdsRef.current.size > 0 || hardLockedRef.current || coolingRef.current) return;
    if (quoteBusyRef.current) return;
    const plan = plansRef.current.get(symbol);
    if (!plan) return;
    const now = Date.now();
    const snapshot = quotesRef.current.get(symbol);
    if (snapshot && snapshot.key === plan.key && now - snapshot.fetchedAt < 6_000) return;
    const lastAttempt = lastQuoteAttemptRef.current.get(symbol) ?? 0;
    if (now - lastAttempt < 2_500) return;
    const session = sessionRef.current;
    if (!session) return;
    const stake = initialStake(plan, balanceRef.current, sizingModeRef.current, fixedStakeRef.current, snapshot ?? null);
    quoteBusyRef.current = true;
    setQuoteScanning(true);
    lastQuoteAttemptRef.current.set(symbol, now);
    quoteErrorsRef.current.delete(symbol);
    publishRows();
    void session.quote(quoteRequestFor(plan, stake, currencyRef.current || "USD"))
      .then((quote) => {
        if (!aliveRef.current || !connectedRef.current || !watchedRef.current.has(symbol)) return;
        const currentPlan = plansRef.current.get(symbol);
        if (!currentPlan || currentPlan.key !== plan.key) return;
        const metrics = quantQuoteMetrics(quote, currentPlan.pRealized);
        quotesRef.current.set(symbol, {
          key: currentPlan.key,
          quote,
          pRealized: currentPlan.pRealized,
          pImplied: metrics.pImplied,
          evPct: metrics.evPct,
          fetchedAt: Date.now(),
          stake,
        });
        quoteErrorsRef.current.delete(symbol);
        publishRows();
        maybeAutoRef.current();
      })
      .catch((error) => {
        if (aliveRef.current && watchedRef.current.has(symbol)) {
          quoteErrorsRef.current.set(symbol, "proposal: " + describeError(error));
          publishRows();
        }
      })
      .finally(() => {
        quoteBusyRef.current = false;
        if (aliveRef.current) setQuoteScanning(false);
      });
  }, [publishRows, sessionRef]);
  requestQuoteRef.current = requestQuote;

  const executePlan = useCallback(async (symbol: string, origin: "manual" | "auto") => {
    if (!aliveRef.current || !connectedRef.current || execRef.current || activeRef.current || activeIdsRef.current.size > 0) return;
    if (hardLockedRef.current || pausedRef.current || coolingRef.current) return;
    if (pnlRef.current >= takeProfitRef.current) { showAdvisor("TP_HIT"); return; }
    if (pnlRef.current <= -stopLossRef.current) { showAdvisor(winsRef.current > 0 ? "SL_PARTIAL_WINS" : "SL_ZERO_WINS"); return; }
    const session = sessionRef.current;
    if (!session) return;
    const initialPlan = plansRef.current.get(symbol);
    if (!initialPlan) {
      if (origin === "manual") onNotice("No executable regime is active for " + symbol + ".", "bad");
      return;
    }
    execRef.current = true;
    setExecutingSymbol(symbol);
    setPhase("Preparing a fresh " + initialPlan.contract + " proposal for " + symbol + "…");
    const accountAtStart = accountIdRef.current;
    try {
      let planNow = initialPlan;
      let stake = initialStake(planNow, balanceRef.current, sizingModeRef.current, fixedStakeRef.current, quotesRef.current.get(symbol) ?? null);
      let quote = await session.quote(quoteRequestFor(planNow, stake, currencyRef.current || "USD"));
      let currentPlan = plansRef.current.get(symbol);
      if (!currentPlan || currentPlan.key !== planNow.key) {
        setPhase("Setup changed while quoting — no order sent.");
        return;
      }
      planNow = currentPlan;
      let desired = sizeQuantStake({
        mode: sizingModeRef.current,
        balance: balanceRef.current ?? 0,
        quote,
        pRealized: planNow.pRealized,
        fixedStake: fixedStakeRef.current,
      });
      if (Math.abs(desired - stake) >= 0.01) {
        stake = desired;
        quote = await session.quote(quoteRequestFor(planNow, stake, currencyRef.current || "USD"));
        currentPlan = plansRef.current.get(symbol);
        if (!currentPlan || currentPlan.key !== planNow.key) {
          setPhase("Setup changed on the second quote — no order sent.");
          return;
        }
        planNow = currentPlan;
        desired = sizeQuantStake({
          mode: sizingModeRef.current,
          balance: balanceRef.current ?? 0,
          quote,
          pRealized: planNow.pRealized,
          fixedStake: fixedStakeRef.current,
        });
        if (Math.abs(desired - stake) >= 0.01) {
          stake = desired;
          quote = await session.quote(quoteRequestFor(planNow, stake, currencyRef.current || "USD"));
        }
      }
      currentPlan = plansRef.current.get(symbol);
      if (!currentPlan || currentPlan.key !== planNow.key) {
        setPhase("Setup changed before execution — no order sent.");
        return;
      }
      planNow = currentPlan;
      const metrics = quantQuoteMetrics(quote, planNow.pRealized);
      quotesRef.current.set(symbol, {
        key: planNow.key,
        quote,
        pRealized: planNow.pRealized,
        pImplied: metrics.pImplied,
        evPct: metrics.evPct,
        fetchedAt: Date.now(),
        stake: quote.ask,
      });
      publishRows();
      if (metrics.evPct < minEvRef.current) {
        setPhase("EV gate rejected " + symbol + " at " + metrics.evPct.toFixed(1) + "% (need +" + minEvRef.current.toFixed(1) + "%).");
        if (origin === "manual") onNotice("The fresh proposal is below the +" + minEvRef.current.toFixed(1) + "% EV gate. No order sent.", "bad");
        return;
      }
      if (!aliveRef.current || !connectedRef.current || accountIdRef.current !== accountAtStart || activeRef.current || hardLockedRef.current) {
        setPhase("Session changed before the buy — no order sent.");
        return;
      }
      const buyPrice = quote.ask;
      const payout = quote.payout;
      if (buyPrice <= 0 || payout <= buyPrice) {
        setPhase("Proposal is not payable — no order sent.");
        return;
      }
      let contractId = 0;
      try {
        contractId = await session.buy(quote.id, buyPrice);
      } catch (error) {
        if (isAmbiguousPurchase(error)) {
          lockEngine("Buy confirmation timed out. The desk has locked execution; refresh before placing another order.");
        } else {
          setPhase("Buy rejected: " + describeError(error));
          if (origin === "manual") onNotice("Buy rejected: " + describeError(error), "bad");
        }
        return;
      }
      if (!Number.isFinite(contractId) || contractId <= 0) {
        lockEngine("Broker returned no contract id. Execution locked to avoid a duplicate purchase; refresh to reconcile.");
        return;
      }
      if (!aliveRef.current) {
        // The route changed while the buy was in flight. Do not leave an
        // untracked contract open; flatten it immediately through the shared
        // session and let the ledger reconcile it.
        void session.sell(contractId, 0).catch(() => undefined);
        return;
      }
      const position: QuantPosition = {
        id: contractId,
        symbol,
        regime: planNow.regime,
        regimeLabel: planNow.regimeLabel,
        contract: planNow.contract,
        direction: planNow.direction,
        duration: planNow.duration,
        unit: planNow.unit,
        barrier: planNow.barrier,
        stake: buyPrice,
        buyPrice,
        payout,
        pRealized: planNow.pRealized,
        pImplied: metrics.pImplied,
        posterior: planNow.posterior,
        evPct: metrics.evPct,
        openedAt: Date.now(),
        bidPrice: 0,
        unrealized: -buyPrice,
        isValidToSell: false,
        isSold: false,
        exitMode: "pending",
        sellInFlight: false,
        sellAttempts: 0,
        sellBlocked: false,
        sellAcknowledged: false,
        watchId: "",
        status: "open",
        profit: null,
      };
      activeRef.current = position;
      setActive(position);
      activeIdsRef.current.add(contractId);
      quotesRef.current.delete(symbol);
      clearSettlementTimer();
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        const current = activeRef.current;
        if (current && current.id === contractId && !current.isSold) {
          lockEngine("Settlement update timed out for contract " + contractId + ". Execution locked; refresh and reconcile before trading.");
        }
      }, horizonTimeoutMs(planNow.duration, planNow.unit));
      setPhase("OPEN — tracking contract " + contractId + ".");
      let watchId = "";
      for (let attempt = 0; attempt < 2 && !watchId; attempt += 1) {
        try {
          watchId = await session.watch(contractId);
        } catch {
          watchId = "";
        }
      }
      if (!activeRef.current || activeRef.current.id !== contractId) {
        if (watchId) void session.forget(watchId).catch(() => undefined);
        return;
      }
      if (!watchId) {
        lockEngine("Contract " + contractId + " opened but its settlement stream could not be attached. Execution locked; refresh to reconcile.");
        return;
      }
      watchIdsRef.current.set(contractId, watchId);
      const tracked = activeRef.current;
      const next = { ...tracked, watchId };
      activeRef.current = next;
      setActive(next);
    } catch (error) {
      setPhase("Quote/watch error: " + describeError(error));
      if (origin === "manual") onNotice("Execution error: " + describeError(error), "bad");
    } finally {
      execRef.current = false;
      setExecutingSymbol(null);
    }
  }, [clearSettlementTimer, lockEngine, onNotice, publishRows, sessionRef, showAdvisor]);

  const triggerSell = useCallback((position: QuantPosition) => {
    if (position.sellAcknowledged || position.sellInFlight || position.sellBlocked || position.sellAttempts >= 3) return;
    const session = sessionRef.current;
    if (!session) return;
    const attempt = position.sellAttempts + 1;
    const next: QuantPosition = {
      ...position,
      sellInFlight: true,
      sellAttempts: attempt,
      sellAcknowledged: false,
      exitMode: "early",
    };
    activeRef.current = next;
    setActive(next);
    setPhase("Early-harvest sell sent on contract " + position.id + " (attempt " + attempt + "/3).");
    void session.sell(position.id, 0)
      .then(() => {
        const current = activeRef.current;
        if (!current || current.id !== position.id || current.isSold) return;
        const cleared = { ...current, sellInFlight: false, sellAcknowledged: true };
        activeRef.current = cleared;
        setActive(cleared);
        setPhase("Early sell accepted — waiting for the sold confirmation.");
      })
      .catch((error) => {
        const current = activeRef.current;
        if (!current || current.id !== position.id || current.isSold) return;
        const blocked = attempt >= 3;
        const failed: QuantPosition = {
          ...current,
          sellInFlight: false,
          sellAttempts: attempt,
          sellBlocked: blocked,
          sellAcknowledged: false,
          exitMode: "pending",
        };
        activeRef.current = failed;
        setActive(failed);
        if (blocked) {
          setPhase("Early sell was rejected three times; holding to expiry.");
        } else {
          setPhase("Early sell rejected: " + describeError(error) + ". Will retry on a later bid.");
        }
        onNotice("Early-exit sell rejected: " + describeError(error), "bad");
      });
  }, [onNotice, sessionRef]);

  const finalizePosition = useCallback((position: QuantPosition, frame: ContractFrame) => {
    if (finalizingRef.current.has(position.id)) return;
    finalizingRef.current.add(position.id);
    clearSettlementTimer();
    releaseWatch(position.id);
    activeIdsRef.current.delete(position.id);
    const fallbackProceeds = frame.sellPrice ?? (frame.bidPrice > 0 ? frame.bidPrice : 0);
    const net = round2(frame.profit ?? (fallbackProceeds > 0 ? fallbackProceeds - position.buyPrice : -position.stake));
    const won = net > 0;
    const earlyProceeds = frame.sellPrice !== null && frame.sellPrice < position.payout - 0.005;
    const exitLabel: "EARLY SELL" | "EXPIRY" = position.sellAcknowledged || (position.exitMode === "early" && earlyProceeds) ? "EARLY SELL" : "EXPIRY";
    const row: QuantAuditRow = {
      at: new Date().toISOString(),
      symbol: position.symbol,
      regime: position.regimeLabel || String(position.regime),
      contract: position.contract,
      pRealized: position.pRealized,
      pImplied: position.pImplied,
      evPct: position.evPct,
      stake: position.stake,
      exitMode: exitLabel,
      net,
      won,
    };
    const nextAudit = [row, ...auditRef.current].slice(0, 250);
    auditRef.current = nextAudit;
    setAudit(nextAudit);
    const nextPnl = round2(pnlRef.current + net);
    pnlRef.current = nextPnl;
    setPnl(nextPnl);
    const nextWins = winsRef.current + (won ? 1 : 0);
    const nextLosses = lossesRef.current + (won ? 0 : 1);
    winsRef.current = nextWins;
    lossesRef.current = nextLosses;
    setWins(nextWins);
    setLosses(nextLosses);
    activeRef.current = null;
    setActive(null);
    quotesRef.current.delete(position.symbol);
    setPhase((exitLabel === "EARLY SELL" ? "Early harvest booked " : "Expiry booked ") + (net >= 0 ? "+" : "") + net.toFixed(2) + " " + (currencyRef.current || "USD") + ".");
    publishRows();
    if (nextPnl >= takeProfitRef.current) {
      showAdvisor("TP_HIT");
      return;
    }
    if (nextPnl <= -stopLossRef.current) {
      showAdvisor(nextWins > 0 ? "SL_PARTIAL_WINS" : "SL_ZERO_WINS");
      return;
    }
    // The ledger is newest-first; the breaker wants the most recent window in
    // chronological order. Reversing also prevents a long session from being
    // judged on its oldest 20 trades.
    const breaker = edgeDriftBreaker([...auditRef.current].reverse());
    if (breaker.triggered) {
      showAdvisor(nextWins > 0 ? "SL_PARTIAL_WINS" : "SL_ZERO_WINS");
      return;
    }
    beginCooldown("Settled — " + QUANT_COOLDOWN_MS / 1_000 + "s cooldown before the next scan.");
  }, [beginCooldown, clearSettlementTimer, publishRows, releaseWatch, showAdvisor]);

  const handleContract = useCallback((raw: unknown) => {
    const frame = parseContractFrame(raw);
    if (!frame) return;
    const current = activeRef.current;
    if (!current || current.id !== frame.id) return;
    if (frame.isSold) {
      finalizePosition(current, frame);
      return;
    }
    const next: QuantPosition = {
      ...current,
      buyPrice: frame.buyPrice > 0 ? frame.buyPrice : current.buyPrice,
      payout: frame.payout > 0 ? frame.payout : current.payout,
      bidPrice: frame.bidPrice,
      unrealized: frame.bidPrice - (frame.buyPrice > 0 ? frame.buyPrice : current.buyPrice),
      isValidToSell: frame.isValidToSell,
      isSold: false,
      status: frame.status || current.status,
      profit: frame.profit,
    };
    activeRef.current = next;
    setActive(next);
    if (!next.sellAcknowledged && shouldHarvest({
      enabled: earlyExitRef.current,
      targetCapturePct: captureRef.current,
      buyPrice: next.buyPrice,
      payout: next.payout,
      bidPrice: next.bidPrice,
      isValidToSell: next.isValidToSell,
      isSold: false,
    })) {
      triggerSell(next);
    }
  }, [finalizePosition, triggerSell]);

  const maybeAuto = useCallback(() => {
    if (!aliveRef.current || !connectedRef.current || !armedRef.current) return;
    if (pausedRef.current || hardLockedRef.current || coolingRef.current) return;
    if (execRef.current || activeRef.current || activeIdsRef.current.size > 0) return;
    const now = Date.now();
    const plans = [...plansRef.current.values()];
    const candidates = [...quotesRef.current.values()]
      .filter((snapshot) => {
        const plan = plans.find((item) => item.key === snapshot.key);
        return plan !== undefined
          && watchedRef.current.has(plan.symbol)
          && now - snapshot.fetchedAt <= 12_000
          && snapshot.evPct >= minEvRef.current;
      })
      .sort((left, right) => right.evPct - left.evPct);
    for (const snapshot of candidates) {
      const plan = plans.find((item) => item.key === snapshot.key);
      if (!plan) continue;
      void executePlan(plan.symbol, "auto");
      return;
    }
  }, [executePlan]);
  maybeAutoRef.current = maybeAuto;

  const armNow = useCallback(() => {
    if (!connectedRef.current) { onConnect(); return; }
    if (hardLockedRef.current || pausedRef.current || activeRef.current || execRef.current) return;
    setArmed(true);
    armedRef.current = true;
    setPhase("ARMED — only a setup clearing +" + minEvRef.current.toFixed(1) + "% EV can fire.");
    for (const plan of plansRef.current.values()) requestQuoteRef.current(plan.symbol);
    maybeAutoRef.current();
  }, [onConnect]);

  const openConfirm = useCallback((intent: ConfirmIntent) => {
    confirmAccountRef.current = accountIdRef.current;
    setConfirmChecked(false);
    setConfirmIntent(intent);
  }, []);

  const requestArm = useCallback(() => {
    if (!connectedRef.current) { onConnect(); return; }
    if (hardLockedRef.current) { onNotice("Execution is hard-locked. Refresh and reconcile the open contract first.", "bad"); return; }
    if (pausedRef.current) { onNotice("The session is paused by the risk advisor. Reset the session before arming.", "bad"); return; }
    if (activeRef.current || activeIdsRef.current.size > 0 || execRef.current) { onNotice("Wait for the open contract to settle before arming again.", "bad"); return; }
    if (accountKindRef.current !== "demo" && !realOkRef.current) { openConfirm({ kind: "arm" }); return; }
    armNow();
  }, [armNow, onConnect, onNotice, openConfirm]);

  const requestExecute = useCallback((symbol: string) => {
    if (!connectedRef.current) { onConnect(); return; }
    if (hardLockedRef.current) { onNotice("Execution is hard-locked. Refresh before placing another order.", "bad"); return; }
    if (pausedRef.current) { onNotice("The session is paused by the risk advisor. Reset before executing.", "bad"); return; }
    if (activeRef.current || activeIdsRef.current.size > 0 || execRef.current) { onNotice("Another execution lock is active.", "bad"); return; }
    if (coolingRef.current) { onNotice("The post-trade cooldown is still active. Wait for it to finish before executing.", "bad"); return; }
    const plan = plansRef.current.get(symbol);
    const snapshot = quotesRef.current.get(symbol);
    if (!plan || !snapshot || snapshot.key !== plan.key) {
      onNotice("No live proposal for " + symbol + " yet. Keep the matrix watched and retry when its quote appears.", "bad");
      requestQuoteRef.current(symbol);
      return;
    }
    if (snapshot.evPct < minEvRef.current) {
      onNotice(symbol + " is at " + snapshot.evPct.toFixed(1) + "% EV, below the +" + minEvRef.current.toFixed(1) + "% gate.", "bad");
      return;
    }
    if (accountKindRef.current !== "demo" && !realOkRef.current) {
      openConfirm({ kind: "execute", symbol });
      return;
    }
    void executePlan(symbol, "manual");
  }, [executePlan, onConnect, onNotice, openConfirm]);

  const confirmReal = useCallback(() => {
    const intent = confirmIntent;
    if (!intent || !confirmChecked) return;
    if (confirmAccountRef.current !== accountIdRef.current || accountKindRef.current === "demo") {
      setConfirmIntent(null);
      onNotice("Account changed while confirming. The real-money action was cancelled.", "bad");
      return;
    }
    realOkRef.current = true;
    setRealOk(true);
    setConfirmIntent(null);
    setConfirmChecked(false);
    if (intent.kind === "arm") armNow();
    else if (intent.symbol) void executePlan(intent.symbol, "manual");
  }, [armNow, confirmChecked, confirmIntent, executePlan, onNotice]);

  const toggleWatch = useCallback((symbol: string) => {
    if (activeRef.current || activeIdsRef.current.size > 0 || execRef.current) {
      onNotice("Symbol routing is locked while a contract is being executed or is open.", "bad");
      return;
    }
    const next = new Set(watchedRef.current);
    if (next.has(symbol)) next.delete(symbol);
    else next.add(symbol);
    watchedRef.current = next;
    setWatched(next);
    if (next.has(symbol)) {
      if (connectedRef.current) void startSymbol(symbol);
    } else {
      stopSymbol(symbol);
    }
    publishRows();
  }, [onNotice, publishRows, startSymbol, stopSymbol]);

  const resetSession = useCallback(() => {
    if (activeRef.current) { onNotice("Wait for the open contract to settle before resetting the session.", "bad"); return; }
    if (hardLockedRef.current) { onNotice("Hard lock requires a page refresh and reconciliation; the session cannot be reset in place.", "bad"); return; }
    clearCooldownTimer();
    auditRef.current = [];
    setAudit([]);
    pnlRef.current = 0;
    setPnl(0);
    winsRef.current = 0;
    lossesRef.current = 0;
    setWins(0);
    setLosses(0);
    setAdvisor(null);
    setPaused(false);
    pausedRef.current = false;
    setArmed(false);
    armedRef.current = false;
    setRealOk(false);
    realOkRef.current = false;
    setPhase("Session reset — risk counters cleared.");
    for (const market of QUANT_UNIVERSE) {
      if (watchedRef.current.has(market.symbol)) requestQuoteRef.current(market.symbol);
    }
  }, [clearCooldownTimer, onNotice]);

  const exportAudit = useCallback(() => {
    if (auditRef.current.length === 0) { onNotice("The audit log is empty.", "bad"); return; }
    const header = ["Timestamp", "Symbol", "Regime", "Contract", "P_realized / P_implied", "EV %", "Stake", "Exit Mode (EARLY SELL / EXPIRY)", "Net P&L"].join(",");
    const body = auditRef.current.map((row) => [
      csvCell(row.at),
      csvCell(row.symbol),
      csvCell(String(row.regime)),
      csvCell(row.contract),
      csvCell(row.pRealized.toFixed(3) + " / " + row.pImplied.toFixed(3)),
      csvCell(row.evPct.toFixed(2)),
      csvCell(row.stake.toFixed(2)),
      csvCell(row.exitMode),
      csvCell(row.net.toFixed(2)),
    ].join(","));
    const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "quant-desk-audit-" + new Date().toISOString().slice(0, 10) + ".csv";
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice("Quant Desk audit CSV exported.", "ok");
  }, [onNotice]);

  const teardownStreams = useCallback(() => {
    streamGenerationRef.current += 1;
    const session = sessionRef.current;
    if (session) {
      for (const subscriptionId of streamsRef.current.values()) void session.forget(subscriptionId).catch(() => undefined);
      for (const watchId of watchIdsRef.current.values()) void session.forget(watchId).catch(() => undefined);
    }
    streamsRef.current.clear();
    activeStreamsRef.current.clear();
    pendingSubsRef.current.clear();
    seedBuffersRef.current.clear();
    watchIdsRef.current.clear();
    historiesRef.current.clear();
    featuresRef.current.clear();
    signalsRef.current.clear();
    plansRef.current.clear();
    quotesRef.current.clear();
    lastQuoteAttemptRef.current.clear();
    contractErrorsRef.current.clear();
    quoteErrorsRef.current.clear();
    capabilityLoadingRef.current.clear();
  }, [sessionRef]);

  const handleTick = useCallback((symbol: string, tick: Tick) => {
    if (!aliveRef.current || !watchedRef.current.has(symbol)) return;
    if (!Number.isFinite(tick.quote) || tick.quote <= 0) return;
    const seed = seedBuffersRef.current.get(symbol);
    if (seed) {
      seed.ticks.push(tick);
      if (seed.ticks.length > 220) seed.ticks.shift();
      return;
    }
    const history = historiesRef.current.get(symbol) ?? [];
    const last = history[history.length - 1];
    if (last && last.epoch > 0 && tick.epoch > 0 && tick.epoch <= last.epoch) return;
    historiesRef.current.set(symbol, mergeHistory(history, [tick]));
    historyErrorsRef.current.delete(symbol);
    recomputeSymbol(symbol);
  }, [recomputeSymbol]);
  tickHandlerRef.current = handleTick;
  contractHandlerRef.current = handleContract;

  useEffect(() => {
    aliveRef.current = true;
    publishRows();
    return () => {
      aliveRef.current = false;
      teardownStreams();
      clearSettlementTimer();
      clearCooldownTimer();
    };
  }, [clearCooldownTimer, clearSettlementTimer, publishRows, teardownStreams]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !connected) return;
    sessionLiveRef.current = session;
    const handler = (symbol: string, tick: Tick) => tickHandlerRef.current(symbol, tick);
    session.onTickAny = handler;
    return () => {
      if (session.onTickAny === handler) session.onTickAny = null;
    };
  }, [connected, sessionRef]);

  useEffect(() => {
    const handler = (payload: unknown) => contractHandlerRef.current(payload);
    bindContractListener(handler);
    return () => bindContractListener(null);
  }, [bindContractListener]);

  useEffect(() => {
    const guard = (): string | null => {
      const current = activeRef.current;
      if (current) {
        return "Contract #" + current.id + " is still open. Use early exit or wait for settlement before leaving Quant Desk.";
      }
      if (activeIdsRef.current.size > 0 || execRef.current) {
        return "An execution is in flight. Wait for the broker acknowledgement before leaving Quant Desk.";
      }
      return null;
    };
    bindNavigationGuard(guard);
    return () => bindNavigationGuard(null);
  }, [bindNavigationGuard]);

  useEffect(() => {
    if (!connected) return;
    for (const symbol of watchedRef.current) void startSymbol(symbol);
    for (const symbol of [...activeStreamsRef.current]) {
      if (!watchedRef.current.has(symbol)) stopSymbol(symbol);
    }
  }, [connected, watched, startSymbol, stopSymbol]);

  useEffect(() => {
    if (previousConnectedRef.current && !connected) {
      if (activeRef.current) {
        lockEngine("Broker connection lost while a contract is open. Execution locked; refresh and reconcile before trading.");
      } else {
        armedRef.current = false;
        setArmed(false);
        setPhase("Broker connection closed.");
      }
      teardownStreams();
      publishRows();
    }
    if (!previousConnectedRef.current && connected) {
      setPhase("Connected — seeding 150-tick windows.");
    }
    previousConnectedRef.current = connected;
  }, [connected, lockEngine, publishRows, teardownStreams]);

  useEffect(() => {
    if (previousAccountRef.current && previousAccountRef.current !== accountId) {
      armedRef.current = false;
      setArmed(false);
      realOkRef.current = false;
      setRealOk(false);
      setConfirmIntent(null);
      quotesRef.current.clear();
      if (activeRef.current) lockEngine("Account changed while a contract is open. Execution locked; refresh and reconcile.");
      publishRows();
    }
    previousAccountRef.current = accountId;
  }, [accountId, lockEngine, publishRows]);

  useEffect(() => {
    if (armed) maybeAutoRef.current();
  }, [armed, minEv]);

  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const currencyCode = currency || "USD";
  const stakeCap = quantStakeCap(balance ?? 0);
  const gatePct = clamp(minEv, QUANT_MIN_EV_FLOOR, QUANT_MAX_EV_FLOOR);
  const effectiveCapturePct = clamp(capturePct, QUANT_CAPTURE_FLOOR, QUANT_CAPTURE_CEILING);
  const totalSettled = wins + losses;
  const winRate = totalSettled > 0 ? wins / totalSettled : null;
  const activeMaxProfit = active ? Math.max(0, active.payout - active.buyPrice) : 0;
  const activeHarvestTarget = activeMaxProfit * effectiveCapturePct / 100;
  const activeProgress = active && activeHarvestTarget > 0
    ? clamp((active.unrealized / activeHarvestTarget) * 100, 0, 100)
    : 0;
  const selectedAccount = accounts.find((account) => account.id === accountId) ?? null;
  const confirmPlan = confirmIntent?.symbol ? plansRef.current.get(confirmIntent.symbol) ?? null : null;
  const confirmQuote = confirmIntent?.symbol ? quotesRef.current.get(confirmIntent.symbol) ?? null : null;
  const phaseTone = hardLocked ? "border-danger/50 bg-danger/10 text-danger" : paused ? "border-amber-400/50 bg-amber-400/10 text-amber-200" : armed ? "border-accent/50 bg-accent/10 text-accent" : "border-line bg-ink/50 text-muted";
  const busy = executingSymbol !== null || active !== null || hardLocked;

  const disarm = () => {
    armedRef.current = false;
    setArmed(false);
    setPhase("Disarmed — manual Execute Setup remains available.");
  };

  const changeAccount = (next: string) => {
    if (activeRef.current || execRef.current) {
      onNotice("Finish the open execution before switching accounts.", "bad");
      return;
    }
    if (!next || next === accountId) return;
    onAccountChange(next);
  };

  const resetStopLoss = () => {
    setSlManual(false);
    setStopLoss(quantAutoStopLoss());
    stopLossRef.current = quantAutoStopLoss();
  };

  const resetTakeProfit = () => {
    setTpManual(false);
    setTakeProfit(quantAutoTakeProfit());
    takeProfitRef.current = quantAutoTakeProfit();
  };

  return (
    <div className="space-y-4 p-4 lg:p-5">
      <header className="rounded-lg border border-line bg-panel/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[9px] uppercase tracking-[0.28em] text-accent">Page 06 / derived-imprint desk</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-100 sm:text-2xl">THE QUANT DESK</h1>
            <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted">
              Implied-vs-realized arbitrage across 10 tick indices. A Bayesian four-regime router estimates what the contract should be worth; the live proposal says what Deriv charges. Only a strictly positive expected value survives the gate, and every open position is watched for an early-harvest bid.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className={"rounded border px-2 py-1 text-[8px] font-semibold tracking-wide " + (accountKind === "real" ? "border-danger/40 bg-danger/10 text-danger" : "border-line bg-ink text-muted")}>
                {accountKind === "real" ? "REAL MONEY" : accountKind === "demo" ? "DEMO" : "ACCOUNT"}
              </span>
              {accountId ? <span className="rounded border border-line bg-ink px-2 py-1 font-mono text-[8px] text-muted">{accountId}</span> : null}
              <span className="rounded border border-line bg-ink px-2 py-1 font-mono text-[8px] text-slate-200">
                {balance === null ? "BALANCE —" : balance.toFixed(2) + " " + currencyCode}
              </span>
              <span className={"rounded border px-2 py-1 text-[8px] font-semibold tracking-wide " + (connected ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-danger/40 bg-danger/10 text-danger")}>
                {connected ? "WS LIVE" : "WS OFFLINE"}
              </span>
              <span className="rounded border border-line bg-ink px-2 py-1 text-[8px] text-muted">
                {quoteScanning ? "QUOTING…" : watched.size + "/10 watched"}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="quant-account">Account</label>
            <select
              id="quant-account"
              value={accountId}
              onChange={(event) => changeAccount(event.target.value)}
              disabled={accounts.length <= 1 || Boolean(active) || Boolean(executingSymbol) || connected === false}
              className="rounded border border-line bg-ink px-2 py-1.5 text-[10px] text-slate-200 disabled:opacity-50"
            >
              {accounts.length === 0 ? <option value="">Not connected</option> : null}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.kind === "real" ? "Real" : "Demo"} · {account.id}
                </option>
              ))}
            </select>
            {!connected ? (
              <button type="button" onClick={onConnect} className="rounded border border-accent/50 bg-accent/10 px-3 py-1.5 text-[10px] font-semibold text-accent hover:bg-accent/20">
                Connect Deriv
              </button>
            ) : null}
            {connected && !armed ? (
              <button
                type="button"
                onClick={requestArm}
                disabled={hardLocked || paused || Boolean(active) || Boolean(executingSymbol)}
                className="rounded border border-accent/50 bg-accent px-3 py-1.5 text-[10px] font-semibold text-ink transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {paused ? "ADVISOR PAUSED" : "ARM HARVESTER"}
              </button>
            ) : null}
            {connected && armed ? (
              <button type="button" onClick={disarm} className="rounded border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-400/20">
                DISARM
              </button>
            ) : null}
            {paused && !hardLocked ? (
              <button type="button" onClick={resetSession} className="rounded border border-line px-3 py-1.5 text-[10px] font-semibold text-slate-200 hover:bg-panel">
                Reset Session
              </button>
            ) : null}
          </div>
        </div>
        <div className={"mt-3 flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-[10px] " + phaseTone}>
          <p><span className="font-semibold">ENGINE:</span> {phase}</p>
          <p className="font-mono">
            {armed ? "AUTO +EV" : "MANUAL"} · gate +{gatePct.toFixed(1)}% · {sizingMode === "kelly" ? "QUARTER KELLY" : "FIXED " + fixedStake.toFixed(2)}
          </p>
        </div>
        {connected && accountKind !== "demo" && !realOk ? (
          <p className="mt-2 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[10px] leading-relaxed text-danger">
            Real money requires a fresh confirmation before the first arm or manual execution. Confirmation is tied to this account and resets if the account changes.
          </p>
        ) : null}
      </header>

      {hardLocked ? (
        <div className="rounded-lg border border-danger/60 bg-danger/10 p-3 text-[11px] leading-relaxed text-danger">
          <p className="font-semibold">EXECUTION HARD-LOCKED</p>
          <p className="mt-0.5">The desk will not place, arm, or sell anything else in this state. Refresh the page, reconcile the Deriv contract ledger, then start a fresh session. Do not retry a buy blindly.</p>
        </div>
      ) : null}

      <QuantRegimeScanner
        rows={rows}
        minEv={gatePct}
        busy={busy}
        armed={armed}
        paused={paused}
        connected={connected}
        executingSymbol={executingSymbol}
        onExecute={requestExecute}
        onToggle={toggleWatch}
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <section className="rounded-lg border border-line bg-panel/60">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-3">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-slate-100">Open Position / Early-Exit Harvester</h2>
                <p className="mt-0.5 text-[10px] text-muted">One contract at a time. A market sell is sent only when Deriv marks the position sellable and the bid reaches the capture target.</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={"rounded border px-2 py-1 text-[8px] font-semibold tracking-wide " + (earlyExit ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-line bg-ink text-muted")}>
                  {earlyExit ? "EARLY HARVEST ON" : "HOLD TO EXPIRY"}
                </span>
                {active ? <span className="rounded border border-accent/40 bg-accent/10 px-2 py-1 font-mono text-[8px] text-accent">#{active.id}</span> : null}
              </div>
            </div>
            {active ? (
              <div className="space-y-3 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm font-semibold text-slate-100">{active.symbol} <span className="text-muted">{active.contract} · {formatQuantDuration(active.duration, active.unit)}</span></p>
                    <p className="mt-0.5 text-[9px] text-muted">{active.regimeLabel} · posterior {(active.posterior * 100).toFixed(1)}% · P_realized {(active.pRealized * 100).toFixed(1)}% / P_implied {(active.pImplied * 100).toFixed(1)}%</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[8px]">
                    <span className={"rounded border px-2 py-1 font-semibold " + (active.isValidToSell ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-line bg-ink text-muted")}>
                      {active.isValidToSell ? "SELLABLE" : "NOT SELLABLE YET"}
                    </span>
                    {active.sellInFlight ? <span className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-200">SELL SENT</span> : null}
                    {active.sellAcknowledged ? <span className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-emerald-200">EARLY FILL</span> : null}
                    {active.sellBlocked ? <span className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-danger">SELL BLOCKED</span> : null}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <Stat label="Stake / buy" value={active.buyPrice.toFixed(2) + " " + currencyCode} />
                  <Stat label="Payout" value={active.payout.toFixed(2) + " " + currencyCode} />
                  <Stat label="Live bid" value={active.bidPrice > 0 ? active.bidPrice.toFixed(3) : "—"} />
                  <Stat label="Unrealized" value={(active.unrealized >= 0 ? "+" : "") + active.unrealized.toFixed(2)} tone={active.unrealized >= 0 ? "text-accent" : "text-danger"} />
                  <Stat label="Max net" value={activeMaxProfit.toFixed(2)} />
                  <Stat label="Harvest at" value={activeHarvestTarget.toFixed(2)} />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[9px] text-muted">
                    <span>Bid progress to {effectiveCapturePct}% capture</span>
                    <span className="font-mono">{activeProgress.toFixed(0)}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-ink">
                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-accent transition-all" style={{ width: activeProgress.toFixed(1) + "%" }} />
                  </div>
                  <p className="mt-1 text-[9px] leading-relaxed text-muted">
                    Auto-sell at bid ≥ {active.buyPrice.toFixed(2)} + {activeMaxProfit.toFixed(2)} × {effectiveCapturePct}% = <span className="font-mono text-slate-200">{(active.buyPrice + activeHarvestTarget).toFixed(2)}</span>, and only when the net bid gain is at least $0.04. A sell at price 0 asks Deriv for its executable bid; settlement P&L is taken from the sold frame.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-line bg-ink/50 px-2.5 py-2 text-[9px] text-muted">
                  <span>Opened {new Date(active.openedAt).toLocaleTimeString()} · status {active.status || "open"} · barrier {active.barrier ?? "none"}</span>
                  <span className="font-mono">P_realized {active.pRealized.toFixed(3)} · P_implied {active.pImplied.toFixed(3)} · EV {active.evPct.toFixed(1)}%</span>
                </div>
                {active.sellAcknowledged ? (
                  <p className="rounded border border-emerald-400/30 bg-emerald-400/5 px-3 py-2 text-[10px] text-emerald-200">Early harvest accepted. Waiting for the sold confirmation to book the final P&L.</p>
                ) : active.sellBlocked ? (
                  <p className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-[10px] text-danger">Three early-sell attempts were rejected. The contract is being held to expiry; do not retry from this page.</p>
                ) : null}
              </div>
            ) : (
              <div className="p-4">
                <p className="rounded border border-dashed border-line bg-ink/30 px-3 py-5 text-center text-[11px] text-muted">
                  No open quant position. The desk stays flat while it scans; an armed setup or a manual Execute Setup can open one micro-stake contract.
                </p>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-panel/60">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-3">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-slate-100">Trade Audit Log</h2>
                <p className="mt-0.5 text-[10px] text-muted">Settled outcomes only. The CSV uses the exact desk columns.</p>
              </div>
              <button type="button" onClick={exportAudit} className="rounded border border-line px-2.5 py-1.5 text-[9px] font-semibold text-slate-200 hover:bg-ink">
                Export CSV
              </button>
            </div>
            <div className="overflow-x-auto p-2">
              <table className="w-full min-w-[820px] border-separate border-spacing-y-1 text-left text-[10px]">
                <thead className="text-[8px] uppercase tracking-widest text-muted">
                  <tr>
                    <th className="px-2 py-1">Timestamp</th>
                    <th className="px-2 py-1">Symbol</th>
                    <th className="px-2 py-1">Regime</th>
                    <th className="px-2 py-1">Contract</th>
                    <th className="px-2 py-1">P<sub>realized</sub> / P<sub>implied</sub></th>
                    <th className="px-2 py-1">EV %</th>
                    <th className="px-2 py-1">Stake</th>
                    <th className="px-2 py-1">Exit Mode</th>
                    <th className="px-2 py-1 text-right">Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.length === 0 ? (
                    <tr><td colSpan={9} className="rounded border border-dashed border-line px-3 py-6 text-center text-[10px] text-muted">No settled quant trades yet. Audit rows appear only after a sold confirmation.</td></tr>
                  ) : audit.map((row, index) => (
                    <tr key={row.at + "-" + row.symbol + "-" + index} className="bg-ink/40">
                      <td className="rounded-l border-y border-l border-line px-2 py-2 font-mono text-[9px] text-muted">{new Date(row.at).toLocaleString()}</td>
                      <td className="border-y border-line px-2 py-2 font-mono text-slate-100">{row.symbol}</td>
                      <td className="border-y border-line px-2 py-2"><span className="rounded border border-line bg-ink px-1.5 py-0.5 text-[8px] text-slate-200">{row.regime}</span></td>
                      <td className="border-y border-line px-2 py-2 font-mono text-slate-200">{row.contract}</td>
                      <td className="border-y border-line px-2 py-2 font-mono text-slate-200">{row.pRealized.toFixed(3)} / {row.pImplied.toFixed(3)}</td>
                      <td className="border-y border-line px-2 py-2"><span className={"rounded border px-1.5 py-0.5 font-mono text-[9px] " + (row.evPct >= 0 ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-danger/40 bg-danger/10 text-danger")}>{row.evPct.toFixed(1)}%</span></td>
                      <td className="border-y border-line px-2 py-2 font-mono text-slate-200">{row.stake.toFixed(2)}</td>
                      <td className="border-y border-line px-2 py-2"><span className={"rounded border px-1.5 py-0.5 text-[8px] " + (row.exitMode === "EARLY SELL" ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-ink text-muted")}>{row.exitMode}</span></td>
                      <td className={"rounded-r border-y border-r border-line px-2 py-2 text-right font-mono font-semibold " + (row.net >= 0 ? "text-accent" : "text-danger")}>{row.net >= 0 ? "+" : ""}{row.net.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-line bg-panel/60">
            <div className="border-b border-line px-3 py-3">
              <h2 className="text-sm font-semibold tracking-tight text-slate-100">Four-Regime Playbook</h2>
              <p className="mt-0.5 text-[10px] text-muted">The Bayesian router only arms a weapon after its microstructure gate is true. Priority: post-jump, coil, drift, vacuum.</p>
            </div>
            <div className="grid gap-2 p-3 sm:grid-cols-2">
              <article className="rounded border border-emerald-400/25 bg-emerald-400/[0.04] p-2.5">
                <p className="font-mono text-[8px] tracking-widest text-emerald-300">01 · VOLATILITY VACUUM</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-100">1HZ* · ATR15/ATR100 ≤ 0.65 · H &lt; 0.45</p>
                <p className="mt-1 text-[9px] leading-relaxed text-muted">Sell NOTOUCH at the fastest valid duration and barrier. Survival is measured across the last 100 matching windows, clamped 50%–92%.</p>
              </article>
              <article className="rounded border border-sky-400/25 bg-sky-400/[0.04] p-2.5">
                <p className="font-mono text-[8px] tracking-widest text-sky-300">02 · LOCKED DRIFT</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-100">ER30 ≥ 0.62 · H &gt; 0.55</p>
                <p className="mt-1 text-[9px] leading-relaxed text-muted">CALL when P(t) &gt; P(t−30), otherwise PUT, always over a 5-tick horizon. Continuation is sampled across the last 120 ticks and clamped 45%–72%.</p>
              </article>
              <article className="rounded border border-fuchsia-400/25 bg-fuchsia-400/[0.04] p-2.5">
                <p className="font-mono text-[8px] tracking-widest text-fuchsia-300">03 · POST-JUMP CALM</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-100">JD75/JD100 · ticksSinceJump ≤ 2</p>
                <p className="mt-1 text-[9px] leading-relaxed text-muted">A jump is a single tick ≥ 18× the 100-tick median range. Fade the discharged move with CALL/PUT, or take NOTOUCH when its EV survives the gate.</p>
              </article>
              <article className="rounded border border-amber-400/25 bg-amber-400/[0.04] p-2.5">
                <p className="font-mono text-[8px] tracking-widest text-amber-300">04 · COIL BREAKOUT</p>
                <p className="mt-1 text-[10px] font-semibold text-slate-100">prior-10 ATR ratio ≤ 0.70 · impulse &gt; 2.2× ATR15</p>
                <p className="mt-1 text-[9px] leading-relaxed text-muted">Buy ONETOUCH in the impulse direction at the fastest valid duration. A stale compression shelf is never re-used after the break.</p>
              </article>
            </div>
            <p className="border-t border-line px-3 py-2 text-[9px] leading-relaxed text-muted">
              P<sub>realized</sub> is an empirical hit rate, not a promise. P<sub>implied</sub> = ask / payout. EV% = ((P<sub>realized</sub> × payout − ask) / ask) × 100. The +{gatePct.toFixed(1)}% gate is re-checked on the fresh pre-buy proposal, so a stale row can never fill.
            </p>
          </section>
        </div>

        <aside className="min-w-0 space-y-4">
          <section className="rounded-lg border border-line bg-panel/60">
            <div className="border-b border-line px-3 py-3">
              <h2 className="text-sm font-semibold tracking-tight text-slate-100">Risk Governor</h2>
              <p className="mt-0.5 text-[10px] text-muted">No martingale, no averaging down, one open contract.</p>
            </div>
            <div className="space-y-3 p-3">
              <div>
                <div className="flex items-center justify-between text-[10px] text-slate-200">
                  <label htmlFor="quant-ev">Strict EV gate</label>
                  <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9px] text-muted">+{gatePct.toFixed(1)}%</span>
                </div>
                <input
                  id="quant-ev"
                  type="number"
                  min={QUANT_MIN_EV_FLOOR}
                  max={QUANT_MAX_EV_FLOOR}
                  step={0.5}
                  value={minEv}
                  onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) setMinEv(next); }}
                  onBlur={() => setMinEv(clamp(minEv, QUANT_MIN_EV_FLOOR, QUANT_MAX_EV_FLOOR))}
                  className="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5 font-mono text-[11px] text-slate-100 outline-none focus:border-accent/60"
                />
                <p className="mt-1 text-[9px] text-muted">Editable +2.0% to +20.0%. The fresh pre-buy proposal must clear this exact gate.</p>
              </div>

              <div className="border-t border-line pt-3">
                <p className="text-[10px] text-slate-200">Position sizing</p>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => setSizingMode("kelly")} className={"rounded border px-2 py-1.5 text-[9px] font-semibold " + (sizingMode === "kelly" ? "border-accent/50 bg-accent/10 text-accent" : "border-line bg-ink text-muted")}>Quarter-Kelly (0.25×)</button>
                  <button type="button" onClick={() => setSizingMode("fixed")} className={"rounded border px-2 py-1.5 text-[9px] font-semibold " + (sizingMode === "fixed" ? "border-accent/50 bg-accent/10 text-accent" : "border-line bg-ink text-muted")}>Fixed base</button>
                </div>
                {sizingMode === "fixed" ? (
                  <div className="mt-2 flex items-center gap-2">
                    <label htmlFor="quant-fixed" className="text-[9px] text-muted">Base stake</label>
                    <input
                      id="quant-fixed"
                      type="number"
                      min={QUANT_MIN_STAKE}
                      max={stakeCap}
                      step={QUANT_STAKE_STEP}
                      value={fixedStake}
                      onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) setFixedStake(next); }}
                      onBlur={() => setFixedStake(clamp(fixedStake, QUANT_MIN_STAKE, stakeCap))}
                      className="w-24 rounded border border-line bg-ink px-2 py-1 font-mono text-[10px] text-slate-100 outline-none focus:border-accent/60"
                    />
                    <span className="font-mono text-[9px] text-muted">{currencyCode}</span>
                  </div>
                ) : null}
                <p className="mt-1 text-[9px] leading-relaxed text-muted">
                  f* = (b·P<sub>realized</sub> − (1−P<sub>realized</sub>)) / b. Stake is 25% of full Kelly, floored at ${QUANT_MIN_STAKE.toFixed(2)} and capped at min(${QUANT_MAX_STAKE.toFixed(2)}, 2.5% of balance) = <span className="font-mono text-slate-200">${stakeCap.toFixed(2)}</span>.
                </p>
              </div>

              <div className="border-t border-line pt-3">
                <label className="flex items-center justify-between gap-2 text-[10px] text-slate-200">
                  <span>Automatic early exit</span>
                  <input type="checkbox" checked={earlyExit} onChange={(event) => setEarlyExit(event.target.checked)} className="h-3.5 w-3.5 accent-emerald-400" />
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <label htmlFor="quant-capture" className="text-[9px] text-muted">Capture target</label>
                  <input
                    id="quant-capture"
                    type="number"
                    min={QUANT_CAPTURE_FLOOR}
                    max={QUANT_CAPTURE_CEILING}
                    step={5}
                    value={capturePct}
                    disabled={!earlyExit}
                    onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) setCapturePct(next); }}
                    onBlur={() => setCapturePct(clamp(capturePct, QUANT_CAPTURE_FLOOR, QUANT_CAPTURE_CEILING))}
                    className="w-20 rounded border border-line bg-ink px-2 py-1 font-mono text-[10px] text-slate-100 outline-none focus:border-accent/60 disabled:opacity-40"
                  />
                  <span className="text-[9px] text-muted">% of max net profit</span>
                </div>
                <p className="mt-1 text-[9px] leading-relaxed text-muted">Default 65%, editable 40%–90%. The +$0.04 minimum bid gain is always enforced.</p>
              </div>

              <div className="border-t border-line pt-3">
                <div className="flex items-center justify-between text-[10px] text-slate-200">
                  <span>Auto stop loss</span>
                  <span className="rounded border border-line px-1.5 py-0.5 text-[8px] text-muted">{slManual ? "CUSTOM" : "AUTO"}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={QUANT_MIN_STAKE}
                    step={QUANT_STAKE_STEP}
                    value={stopLoss}
                    onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) { setSlManual(true); setStopLoss(next); stopLossRef.current = next; } }}
                    onBlur={() => setStopLoss(clamp(stopLoss, QUANT_MIN_STAKE, 100))}
                    className="w-24 rounded border border-line bg-ink px-2 py-1 font-mono text-[10px] text-slate-100 outline-none focus:border-accent/60"
                  />
                  <span className="font-mono text-[9px] text-muted">{currencyCode}</span>
                  <button type="button" onClick={resetStopLoss} className="ml-auto text-[8px] text-accent hover:underline">Reset to Auto</button>
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-slate-200">
                  <span>Auto take profit</span>
                  <span className="rounded border border-line px-1.5 py-0.5 text-[8px] text-muted">{tpManual ? "CUSTOM" : "AUTO"}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={0.05}
                    step={0.05}
                    value={takeProfit}
                    onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) { setTpManual(true); setTakeProfit(next); takeProfitRef.current = next; } }}
                    onBlur={() => setTakeProfit(clamp(takeProfit, 0.05, 100))}
                    className="w-24 rounded border border-line bg-ink px-2 py-1 font-mono text-[10px] text-slate-100 outline-none focus:border-accent/60"
                  />
                  <span className="font-mono text-[9px] text-muted">{currencyCode}</span>
                  <button type="button" onClick={resetTakeProfit} className="ml-auto text-[8px] text-accent hover:underline">Reset to Auto</button>
                </div>
                <p className="mt-1 text-[9px] leading-relaxed text-muted">Auto SL is 6 × the $0.35 floor = ${QUANT_AUTO_STOP_LOSS.toFixed(2)}; auto TP is ${QUANT_AUTO_TAKE_PROFIT.toFixed(2)}. A hit pauses the session and opens the risk advisor.</p>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-line bg-panel/60 p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-slate-100">Session</h2>
              <span className="text-[8px] uppercase tracking-widest text-muted">{paused ? "paused" : armed ? "armed" : "manual"}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Stat label="Realized P&L" value={(pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " " + currencyCode} tone={pnl >= 0 ? "text-accent" : "text-danger"} />
              <Stat label="Win rate" value={winRate === null ? "—" : (winRate * 100).toFixed(0) + "%"} />
              <Stat label="Trades settled" value={totalSettled} />
              <Stat label="W / L" value={wins + " / " + losses} />
            </div>
            <div className="mt-2">
              <div className="flex items-center justify-between text-[9px] text-muted">
                <span>Circuit-breaker sample</span>
                <span className="font-mono">{Math.min(totalSettled, QUANT_BREAKER_MIN_TRADES)}/{QUANT_BREAKER_MIN_TRADES}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink">
                <div className="h-full rounded-full bg-amber-400" style={{ width: Math.min(100, (totalSettled / QUANT_BREAKER_MIN_TRADES) * 100).toFixed(1) + "%" }} />
              </div>
              <p className="mt-1 text-[9px] leading-relaxed text-muted">At 15+ settled trades, a rolling win rate more than 15 points below average implied breakeven pauses the desk.</p>
            </div>
            <div className="mt-3 border-t border-line pt-2 text-[9px] text-muted">
              <p>Account: {selectedAccount ? selectedAccount.kind.toUpperCase() + " · " + selectedAccount.id : "not connected"}</p>
              <p className="mt-0.5">Currency: {currencyCode} · stake cap ${stakeCap.toFixed(2)} · one open contract max</p>
            </div>
          </section>
        </aside>
      </div>

      <footer className="rounded border border-line bg-ink/30 px-3 py-2 text-[9px] leading-relaxed text-muted">
        Quant probabilities are finite-sample estimates, not guarantees. Deriv binaries can expire worthless even when the model edge is positive. This is an execution tool, not financial advice. Demo-test the routed contracts before committing real capital.
      </footer>

      <Modal
        open={confirmIntent !== null}
        title={confirmIntent?.kind === "arm" ? "Confirm real-money arming" : "Confirm real-money execution"}
        onClose={() => { setConfirmIntent(null); setConfirmChecked(false); }}
      >
        {confirmIntent ? (
          <div className="mt-3 space-y-3 text-[11px] leading-relaxed text-slate-300">
            <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
              This action can spend real funds on account <span className="font-mono">{accountId}</span>. The confirmation is valid only for the account currently selected.
            </p>
            {confirmIntent.kind === "execute" && confirmPlan ? (
              <div className="rounded border border-line bg-ink/50 p-2.5 font-mono text-[10px] text-slate-200">
                <p>{confirmPlan.symbol} · {confirmPlan.contract} · {formatQuantDuration(confirmPlan.duration, confirmPlan.unit)} · barrier {confirmPlan.barrier ?? "none"}</p>
                <p className="mt-1">P<sub>realized</sub> {confirmPlan.pRealized.toFixed(3)} · EV {confirmQuote?.evPct.toFixed(1) ?? "—"}% · stake {confirmQuote?.stake.toFixed(2) ?? "—"} {currencyCode}</p>
              </div>
            ) : null}
            <label className="flex items-start gap-2 rounded border border-line bg-ink/40 px-3 py-2">
              <input type="checkbox" checked={confirmChecked} onChange={(event) => setConfirmChecked(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-red-400" />
              <span>I understand this is <span className="font-semibold text-danger">real money</span>, that the model edge can be wrong, and that the contract can expire worthless. I have verified the account, stake, and setup.</span>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setConfirmIntent(null); setConfirmChecked(false); }} className="rounded border border-line px-3 py-1.5 text-[10px] text-muted hover:text-slate-100">Cancel</button>
              <button type="button" onClick={confirmReal} disabled={!confirmChecked} className="rounded bg-danger px-3 py-1.5 text-[10px] font-semibold text-ink hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40">
                Confirm {confirmIntent.kind === "arm" ? "Arming" : "Execution"}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <SessionAdvisorModal
        open={advisor !== null}
        state={advisor}
        currency={currencyCode}
        variant="quant"
        onDismiss={() => setAdvisor(null)}
        onReset={resetSession}
      />
    </div>
  );
}
