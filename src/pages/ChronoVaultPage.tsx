import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Account, DerivSession, SymbolInfo, Tick } from "@/deriv";
import { DerivError } from "@/deriv";
import SessionAdvisorModal from "@/components/SessionAdvisorModal";
import type { SessionAdvisorState } from "@/components/SessionAdvisorModal";
import ChronoCorridorVisualizer from "@/components/ChronoCorridorVisualizer";
import {
  CHRONO_DEFAULT_ACCU_TICKS,
  CHRONO_DEFAULT_GROWTH_RATE,
  CHRONO_DEFAULT_VAULT_THRESHOLD,
  CHRONO_MIN_STAKE,
  CHRONO_SYMBOLS,
  accumulatorRequest,
  analyzeMicrostructure,
  atrFrom,
  chooseChronoWeapon,
  chronoAutoStopLoss,
  chronoAutoTakeProfit,
  chronoCsv,
  efficiencyRatio,
  rollingAsianMean,
  round2,
  staggeredAnchorRequest,
  staggeredTrapRequest,
  virtualProbeRequests,
} from "@/utils/chronoMath";
import type {
  ChronoDirection,
  ChronoLegRequest,
  ChronoOutcome,
  ChronoRoundLog,
  ChronoWeapon,
  ChronoWeaponMode,
} from "@/utils/chronoMath";

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

interface ContractPayload {
  contract_id?: unknown;
  is_sold?: unknown;
  is_valid_to_sell?: unknown;
  bid_price?: unknown;
  buy_price?: unknown;
  profit?: unknown;
  payout?: unknown;
  status?: unknown;
  tick_count?: unknown;
}

interface ChronoLegState {
  contractId: number;
  watchId: string;
  contractType: ChronoLegRequest["contractType"];
  buyPrice: number;
  bidPrice: number;
  payout: number;
  sold: boolean;
  sellSent: boolean;
  pnl: number;
  stake: number;
}

interface ChronoRound {
  id: number;
  symbol: string;
  tier: 1 | 2;
  weapon: ChronoWeapon;
  direction: ChronoDirection;
  entryStrike: number;
  rollingMean: number;
  resetTarget: number | null;
  legs: ChronoLegState[];
  startAt: number;
}

interface ChronoCapability {
  symbol: string;
  ready: boolean;
  error: string | null;
  asianUp: boolean;
  asianDown: boolean;
  resetCall: boolean;
  resetPut: boolean;
  resetTickSupported: boolean;
  resetMinTicks: number;
  accumulator: boolean;
  growthRates: number[];
  minAccumulatorStake: number;
}

const inputClass = "w-full rounded border border-line bg-ink px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent disabled:opacity-50";

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="text-[10px] text-muted">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function numberFrom(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asContract(raw: unknown): ContractPayload {
  return typeof raw === "object" && raw !== null ? raw as ContractPayload : {};
}

function isSold(payload: ContractPayload): boolean {
  return Number(payload.is_sold) === 1 || payload.is_sold === true || String(payload.is_sold) === "1";
}

function signedMoney(value: number, currency: string): string {
  return (value >= 0 ? "+$" : "-$") + Math.abs(value).toFixed(2) + " " + currency;
}

export default function ChronoVaultPage(props: Props): ReactElement {
  const {
    sessionRef,
    connected,
    symbols,
    accounts,
    accountId,
    accountKind,
    balance,
    currency,
    onConnect,
    onAccountChange,
    onNotice,
    bindContractListener,
  } = props;

  const [selectedSymbol, setSelectedSymbol] = useState<string>("1HZ75V");
  const [secondarySymbol, setSecondarySymbol] = useState<string>("1HZ100V");
  const [feedTelemetry, setFeedTelemetry] = useState<Record<string, { spot: number; atr15: number; atr100: number; impulseMove: number; efficiency: number }>>({});
  const [weaponMode, setWeaponMode] = useState<ChronoWeaponMode>("asymmetric_corridor");
  const [baseLegStake, setBaseLegStake] = useState(CHRONO_MIN_STAKE);
  const [vaultEnabled, setVaultEnabled] = useState(true);
  const [vaultUnlockThreshold, setVaultUnlockThreshold] = useState(CHRONO_DEFAULT_VAULT_THRESHOLD);
  const [growthRate, setGrowthRate] = useState(CHRONO_DEFAULT_GROWTH_RATE);
  const [targetAccuTicks, setTargetAccuTicks] = useState(CHRONO_DEFAULT_ACCU_TICKS);
  const [stopLoss, setStopLoss] = useState(chronoAutoStopLoss());
  const [takeProfit, setTakeProfit] = useState(chronoAutoTakeProfit());
  const [isSlManual, setIsSlManual] = useState(false);
  const [isTpManual, setIsTpManual] = useState(false);
  const [armed, setArmed] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [phase, setPhase] = useState("Warming the Chrono-Vault market console.");
  const [round, setRound] = useState<ChronoRound | null>(null);
  const [logs, setLogs] = useState<ChronoRoundLog[]>([]);
  const [tier1BankedProfit, setTier1BankedProfit] = useState(0);
  const [pnl, setPnl] = useState(0);
  const [advisor, setAdvisor] = useState<SessionAdvisorState | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, ChronoCapability>>({});
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [spot, setSpot] = useState(0);
  const [atr15, setAtr15] = useState(0);
  const [atr100, setAtr100] = useState(0);
  const [entryStrike, setEntryStrike] = useState(0);
  const [resetTarget, setResetTarget] = useState<number | null>(null);

  const aliveRef = useRef(true);
  const connectedRef = useRef(connected);
  const accountIdRef = useRef(accountId);
  const currencyRef = useRef(currency);
  const selectedRef = useRef(selectedSymbol);
  const secondaryRef = useRef(secondarySymbol);
  const baseStakeRef = useRef(baseLegStake);
  const weaponModeRef = useRef<ChronoWeaponMode>(weaponMode);
  const vaultEnabledRef = useRef(vaultEnabled);
  const vaultThresholdRef = useRef(vaultUnlockThreshold);
  const growthRateRef = useRef(growthRate);
  const accuTicksRef = useRef(targetAccuTicks);
  const stopLossRef = useRef(stopLoss);
  const takeProfitRef = useRef(takeProfit);
  const armedRef = useRef(false);
  const execRef = useRef(false);
  const coolingRef = useRef(false);
  const roundRef = useRef<ChronoRound | null>(null);
  const tier1BankedProfitRef = useRef(0);
  const pnlRef = useRef(0);
  const roundSeqRef = useRef(0);
  const reqIdCounterRef = useRef(0);
  const activeChronoIdsRef = useRef<Set<number>>(new Set<number>());
  const sellSentRef = useRef<Set<number>>(new Set<number>());
  const buyPriceRef = useRef<Map<number, number>>(new Map<number, number>());
  const peakBidRef = useRef<Map<number, number>>(new Map<number, number>());
  const ticksRef = useRef<Tick[]>([]);
  const ticksBySymbolRef = useRef<Record<string, Tick[]>>({});
  const tickCacheRef = useRef<Record<string, number[]>>({});
  const capabilityCacheRef = useRef<Record<string, ChronoCapability>>({});
  const scanAndFireRef = useRef<(quotes: readonly number[], symbol: string, localAtr15: number, localAtr100: number) => Promise<void>>(async () => undefined);
  const radarSubsRef = useRef<Map<string, string>>(new Map<string, string>());
  const cooldownTimerRef = useRef<number | undefined>(undefined);
  const virtualS0Ref = useRef<Record<string, number>>({});
  const anchorSpotRef = useRef<Record<string, number>>({});
  const anchorDirectionRef = useRef<Record<string, ChronoDirection>>({});
  const ticksSinceAnchorRef = useRef<Record<string, number>>({});
  const pendingTrapRef = useRef<Record<string, boolean>>({});
  const setPendingAccuRef = useRef(false);
  const pendingAccuSymbolRef = useRef<string | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current);
      const session = sessionRef.current;
      for (const id of radarSubsRef.current.values()) if (id) void session?.forget(id);
    };
  }, [sessionRef]);

  useEffect(() => {
    connectedRef.current = connected;
    accountIdRef.current = accountId;
    currencyRef.current = currency;
    selectedRef.current = selectedSymbol;
    secondaryRef.current = secondarySymbol;
    baseStakeRef.current = baseLegStake;
    weaponModeRef.current = weaponMode;
    vaultEnabledRef.current = vaultEnabled;
    vaultThresholdRef.current = vaultUnlockThreshold;
    growthRateRef.current = growthRate;
    accuTicksRef.current = targetAccuTicks;
    stopLossRef.current = stopLoss;
    takeProfitRef.current = takeProfit;
  }, [accountId, baseLegStake, connected, currency, growthRate, secondarySymbol, selectedSymbol, stopLoss, targetAccuTicks, takeProfit, vaultEnabled, vaultUnlockThreshold, weaponMode]);

  useEffect(() => {
    if (!isSlManual) {
      const next = chronoAutoStopLoss();
      stopLossRef.current = next;
      setStopLoss(next);
    }
    if (!isTpManual) {
      const next = chronoAutoTakeProfit();
      takeProfitRef.current = next;
      setTakeProfit(next);
    }
  }, [isSlManual, isTpManual]);

  const stopEngine = useCallback((label: string) => {
    armedRef.current = false;
    setArmed(false);
    setPhase(label);
  }, []);

  const showAdvisor = useCallback((mode: "TP_HIT" | "SL_ZERO_WINS") => {
    stopEngine(mode === "TP_HIT" ? "Take profit hit - Chrono-Vault stopped" : "Stop loss hit - Chrono-Vault stopped");
    setAdvisor({
      mode,
      pnl: round2(pnlRef.current),
      wins: 0,
      losses: 0,
      peakLevel: 2,
      stopLoss: Math.abs(stopLossRef.current),
      takeProfit: takeProfitRef.current,
    });
  }, [stopEngine]);

  const sellContract = useCallback((contractId: number) => {
    if (sellSentRef.current.has(contractId)) return;
    sellSentRef.current.add(contractId);
    void sessionRef.current?.sell(contractId, 0).catch((error: unknown) => {
      sellSentRef.current.delete(contractId);
      onNotice("Chrono sell was not confirmed: " + (error instanceof Error ? error.message : String(error)), "bad");
    });
  }, [onNotice, sessionRef]);

  const finalizeRound = useCallback((outcome: ChronoOutcome) => {
    const current = roundRef.current;
    if (!current) return;
    const leg1 = current.legs[0];
    const leg2 = current.legs[1];
    const leg1Pnl = leg1?.pnl ?? 0;
    const leg2Pnl = leg2?.pnl ?? 0;
    const net = round2(leg1Pnl + leg2Pnl);
    pnlRef.current = round2(pnlRef.current + net);
    setPnl(pnlRef.current);

    if (current.tier === 1 && net >= 0.50) {
      tier1BankedProfitRef.current = round2(tier1BankedProfitRef.current + net * 0.50);
      setTier1BankedProfit(tier1BankedProfitRef.current);
      setPendingAccuRef.current = true;
      pendingAccuSymbolRef.current = current.symbol;
    }

    setLogs((previous) => [{
      id: current.id,
      timestamp: Date.now(),
      symbol: current.symbol,
      tier: current.tier,
      weapon: current.weapon,
      outcome,
      leg1Pnl: round2(leg1Pnl),
      leg2Pnl: round2(leg2Pnl),
      netPnl: net,
    }, ...previous].slice(0, 300));

    roundRef.current = null;
    setRound(null);
    execRef.current = false;
    setExecuting(false);
    coolingRef.current = true;
    setCooling(true);
    setPhase(outcome + " · Chrono post-round cooldown");
    if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = window.setTimeout(() => {
      coolingRef.current = false;
      setCooling(false);
      if (pnlRef.current >= takeProfitRef.current) showAdvisor("TP_HIT");
      else if (pnlRef.current <= -Math.abs(stopLossRef.current)) showAdvisor("SL_ZERO_WINS");
      else if (armedRef.current) setPhase("Chrono-Vault armed · scanning path microstructure");
      else setPhase("Round settled · arm when ready");
    }, 1800);
  }, [showAdvisor]);

  const handleContract = useCallback((raw: unknown) => {
    const data = asContract(raw);
    const contractId = numberFrom(data.contract_id);
    if (contractId <= 0 || !activeChronoIdsRef.current.has(contractId)) return;
    const current = roundRef.current;
    if (!current) return;
    const legIndex = current.legs.findIndex((leg) => leg.contractId === contractId);
    if (legIndex < 0) return;

    const bid = numberFrom(data.bid_price);
    const buyPrice = numberFrom(data.buy_price) || buyPriceRef.current.get(contractId) || 1;
    buyPriceRef.current.set(contractId, buyPrice);
    if (bid > 0) {
      peakBidRef.current.set(contractId, Math.max(peakBidRef.current.get(contractId) ?? 0, bid));
      const legs = current.legs.map((leg) => leg.contractId === contractId ? { ...leg, bidPrice: bid, buyPrice, payout: numberFrom(data.payout) || leg.payout } : leg);
      roundRef.current = { ...current, legs };
      setRound(roundRef.current);

      if (current.tier === 2 && current.weapon === "ACCU 5% CANNON") {
        const tickCount = numberFrom(data.tick_count);
        if (tickCount >= accuTicksRef.current && numberFrom(data.is_valid_to_sell) === 1) {
          sellContract(contractId);
        }
      }
    }

    if (isSold(data)) {
      activeChronoIdsRef.current.delete(contractId);
      const legs = current.legs.map((leg) => leg.contractId === contractId ? {
        ...leg,
        sold: true,
        pnl: numberFrom(data.profit) !== 0 ? round2(numberFrom(data.profit)) : leg.pnl,
      } : leg);
      roundRef.current = { ...current, legs };
      setRound(roundRef.current);
      if (activeChronoIdsRef.current.size === 0) {
        const net = round2(legs.reduce((sum, leg) => sum + leg.pnl, 0));
        const outcome: ChronoOutcome = current.tier === 2
          ? net >= 0.38
            ? "ACCU CANNON HIT"
            : "ACCU KNOCKOUT (PROFIT LOCKED)"
          : current.weapon === "STAGGERED ANCHOR" && legs.length === 1
            ? net > 0 ? "SOLO ANCHOR WIN" : "SOLO ANCHOR MISS"
            : current.weapon === "STAGGERED ANCHOR" && legs.length === 2 && net >= 0.50
              ? "STAGGERED DOUBLE-WIN"
              : current.weapon === "STAGGERED ANCHOR" && legs.length === 2 && net > 0
                ? "TREND-LOCKED GREEN"
                : current.weapon === "STAGGERED ANCHOR" && legs.length === 2 && net >= -0.20
                  ? "REVERSAL SCRATCH"
                  : current.weapon === "VIRTUAL PROBE" && net >= 0.50
                    ? "VIRTUAL SNAP DOUBLE-WIN"
                    : current.weapon === "VIRTUAL PROBE" && net >= -0.20
                      ? "CALM DRIFT SCRATCH"
                      : "BREAKOUT MISS";
        finalizeRound(outcome);
      }
    }
  }, [finalizeRound, sellContract]);

  useEffect(() => {
    bindContractListener(handleContract);
    return () => bindContractListener(null);
  }, [bindContractListener, handleContract]);

  const discoverCapabilities = useCallback(async (symbol: string): Promise<void> => {
    const session = sessionRef.current;
    if (!session || !connectedRef.current) return;
    const cached = capabilityCacheRef.current[symbol];
    if (cached?.ready) {
      setCapabilities((previous) => ({ ...previous, [symbol]: cached }));
      return;
    }
    try {
      ++reqIdCounterRef.current;
      // contracts_for must contain only the symbol field.
      const offers = await session.contractsFor(symbol);
      if (!aliveRef.current) return;
      const types = new Set(offers.map((offer) => offer.contractType.toUpperCase()));
      const capability: ChronoCapability = {
        symbol,
        ready: true,
        error: null,
        asianUp: types.has("NOTOUCH"),
        asianDown: types.has("ONETOUCH"),
        resetCall: types.has("CALL"),
        resetPut: types.has("PUT"),
        resetTickSupported: types.has("CALL") && types.has("PUT"),
        resetMinTicks: 5,
        accumulator: types.has("ACCU"),
        growthRates: [0.01, 0.02, 0.03, 0.04, 0.05],
        minAccumulatorStake: 1,
      };
      capabilityCacheRef.current[symbol] = capability;
      setCapabilities((previous) => ({ ...previous, [symbol]: capability }));
    } catch (error) {
      setCapabilities((previous) => ({
        ...previous,
        [symbol]: {
          symbol,
          ready: false,
          error: error instanceof Error ? error.message : String(error),
          asianUp: false,
          asianDown: false,
          resetCall: false,
          resetPut: false,
          resetTickSupported: false,
          resetMinTicks: 0,
          accumulator: false,
          growthRates: [],
          minAccumulatorStake: 1,
        },
      }));
    }
  }, [sessionRef]);

  const startFeed = useCallback(async (symbol: string): Promise<void> => {
    const session = sessionRef.current;
    if (!session || !connectedRef.current || radarSubsRef.current.has(symbol)) return;
    try {
      let seededTicks = ticksBySymbolRef.current[symbol];
      if (!seededTicks || seededTicks.length === 0) {
        ++reqIdCounterRef.current;
        seededTicks = (await session.history(symbol, 100, "ticks")).slice(-120);
      }
      if (!aliveRef.current || ![selectedRef.current, secondaryRef.current].includes(symbol)) return;
      const quotes = seededTicks.map((tick) => tick.quote).filter((quote) => Number.isFinite(quote) && quote > 0).slice(-120);
      ticksBySymbolRef.current[symbol] = seededTicks;
      tickCacheRef.current[symbol] = quotes;
      const metric = { spot: quotes[quotes.length - 1] ?? 0, atr15: atrFrom(quotes.slice(-15)), atr100: atrFrom(quotes) };
      const signal = analyzeMicrostructure(quotes);
      setFeedTelemetry((previous) => ({
        ...previous,
        [symbol]: { ...metric, impulseMove: signal.momentumMove, efficiency: signal.efficiencyRatio },
      }));
      if (symbol === selectedRef.current) {
        ticksRef.current = seededTicks;
        setTicks(seededTicks);
        setSpot(metric.spot);
        setAtr15(metric.atr15);
        setAtr100(metric.atr100);
        setEntryStrike(metric.spot);
        setResetTarget(null);
      }
      ++reqIdCounterRef.current;
      const subscriptionId = await session.subscribeTicksFor(symbol);
      if (!subscriptionId) return;
      if (![selectedRef.current, secondaryRef.current].includes(symbol)) {
        void session.forget(subscriptionId);
        return;
      }
      radarSubsRef.current.set(symbol, subscriptionId);
    } catch (error) {
      onNotice("Chrono feed failed for " + symbol + ": " + (error instanceof Error ? error.message : String(error)), "bad");
    }
  }, [onNotice, sessionRef]);

  useEffect(() => {
    if (!connected) return;
    const session = sessionRef.current;
    if (!session) return;
    let cancelled = false;
    let staggerTimer: number | undefined;
    const activeSymbols = Array.from(new Set([selectedSymbol, secondarySymbol].filter((symbol) => symbol && symbol !== "NONE")));
    const handler = (symbol: string, tick: Tick): void => {
      if (!activeSymbols.includes(symbol)) return;
      const quote = Number(tick.quote);
      if (!Number.isFinite(quote) || quote <= 0) return;
      const nextTicks = [...(ticksBySymbolRef.current[symbol] ?? []).slice(-119), { ...tick, quote }];
      ticksBySymbolRef.current[symbol] = nextTicks;
      const quotes = [...(tickCacheRef.current[symbol] ?? []), quote].slice(-120);
      tickCacheRef.current[symbol] = quotes;
      const localAtr15 = atrFrom(quotes.slice(-15));
      const localAtr100 = atrFrom(quotes.slice(-100));
      const signal = analyzeMicrostructure(quotes);
      setFeedTelemetry((previous) => ({
        ...previous,
        [symbol]: { spot: quote, atr15: localAtr15, atr100: localAtr100, impulseMove: signal.momentumMove, efficiency: signal.efficiencyRatio },
      }));
      if (symbol === selectedRef.current) {
        ticksRef.current = nextTicks;
        setTicks(nextTicks);
        setSpot(quote);
        setAtr15(localAtr15);
        setAtr100(localAtr100);
        if (!entryStrike && quotes.length > 0) setEntryStrike(quote);
      }
      if (armedRef.current && !execRef.current && !coolingRef.current) {
        void scanAndFireRef.current(quotes, symbol, localAtr15, localAtr100);
      }
    };
    session.onTickAny = handler;

    const seedMarkets = async (): Promise<void> => {
      const primary = activeSymbols[0];
      if (!primary) return;
      await discoverCapabilities(primary);
      if (cancelled) return;
      await startFeed(primary);
      if (activeSymbols.length < 2) return;
      await new Promise<void>((resolve) => { staggerTimer = window.setTimeout(resolve, 400); });
      if (cancelled) return;
      const secondary = activeSymbols[1];
      await discoverCapabilities(secondary);
      if (cancelled) return;
      await startFeed(secondary);
    };
    void seedMarkets();
    return () => {
      cancelled = true;
      if (staggerTimer !== undefined) window.clearTimeout(staggerTimer);
      if (session.onTickAny === handler) session.onTickAny = null;
      for (const [symbol, subscriptionId] of Array.from(radarSubsRef.current.entries())) {
        if (!subscriptionId) continue;
        ++reqIdCounterRef.current;
        void session.forget(subscriptionId);
        radarSubsRef.current.delete(symbol);
      }
    };
  }, [accountId, connected, selectedSymbol, secondarySymbol]);

  const placeChronoPair = useCallback(async (symbol: string, tier: 1 | 2, weapon: ChronoWeapon, requests: ChronoLegRequest[]): Promise<void> => {
    const session = sessionRef.current;
    if (!session) throw new Error("No Deriv session.");

    const quoteRequests = requests.map((request) => {
      const payload: {
        symbol: string;
        contract: "CALL" | "PUT" | "NOTOUCH" | "ONETOUCH" | "ACCU";
        duration?: number;
        durationUnit?: "t";
        stake: number;
        currency: string;
        barrier?: string;
        growthRate?: number;
        limitTakeProfit?: number;
      } = {
        symbol,
        contract: request.contractType,
        stake: request.stake,
        currency: currencyRef.current,
      };
      if (request.contractType === "ACCU") {
        // Deriv rejects duration/duration_unit fields on ACCU proposals.
        payload.growthRate = request.growthRate;
        payload.limitTakeProfit = request.limitTakeProfit;
      } else {
        if (request.duration !== undefined) payload.duration = request.duration;
        if (request.durationUnit !== undefined) payload.durationUnit = request.durationUnit;
      }
      if (request.barrier !== undefined) payload.barrier = request.barrier;
      return payload;
    });

    const requestKeys = quoteRequests as unknown;
    void requestKeys;

    if (requests.some((request) => request.contractType === "ACCU")) {
      const request = requests[0];
      if (!request) throw new Error("Missing ACCU request.");
      // Dedicated duration-free ACCU proposal: duration/duration_unit are never serialized.
      const quote = await session.quoteAccumulator({
        symbol,
        stake: 0.35,
        currency: "USD",
        growthRate: 0.05,
        takeProfit: 0.38,
      });
      const contractId = await session.buy(quote.id, quote.ask);
      const leg: ChronoLegState = {
        contractId,
        watchId: "",
        contractType: "ACCU",
        buyPrice: quote.ask,
        bidPrice: 0,
        payout: round2(quote.payout),
        sold: false,
        sellSent: false,
        pnl: 0,
        stake: request.stake,
      };
      activeChronoIdsRef.current.add(contractId);
      const current = roundRef.current;
      if (!current) return;
      roundRef.current = { ...current, legs: [leg] };
      setRound(roundRef.current);
      ++reqIdCounterRef.current;
      leg.watchId = await session.watch(contractId);
      return;
    }

    const quotes = await session.quoteBundle(requests.map((request) => {
      const payload: Record<string, unknown> = {
        symbol,
        contract: request.contractType,
        stake: request.stake,
        currency: currencyRef.current,
        duration: request.duration ?? 5,
        durationUnit: request.durationUnit ?? "t",
      };
      if (request.contractType === "CALL" || request.contractType === "PUT") {
        delete payload.barrier;
      } else if (typeof request.barrier === "string" && request.barrier.trim()) {
        payload.barrier = request.barrier.trim();
      }
      return payload as never;
    }));
    const legs = await Promise.all(quotes.map(async (quote, index) => {
      const contractId = await session.buy(quote.id, quote.ask);
      activeChronoIdsRef.current.add(contractId);
      const request = requests[index];
      return {
        contractId,
        watchId: "",
        contractType: request.contractType,
        buyPrice: quote.ask,
        bidPrice: 0,
        payout: round2(quote.payout),
        sold: false,
        sellSent: false,
        pnl: 0,
        stake: request.stake,
      } satisfies ChronoLegState;
    }));
    const current = roundRef.current;
    if (!current) return;
    roundRef.current = { ...current, legs };
    setRound(roundRef.current);
    await Promise.all(legs.map(async (leg) => {
      ++reqIdCounterRef.current;
      leg.watchId = await session.watch(leg.contractId);
    }));
  }, [sessionRef]);

  const scanAndFire = useCallback(async (quotes: readonly number[], symbol: string, localAtr15: number, localAtr100: number): Promise<void> => {
    if (!connectedRef.current || execRef.current || coolingRef.current || roundRef.current || activeChronoIdsRef.current.size > 0) return;

    if (setPendingAccuRef.current && pendingAccuSymbolRef.current && !coolingRef.current) {
      const request = accumulatorRequest(0.35, 0.05, 0.38);
      const id = ++roundSeqRef.current;
      const current: ChronoRound = {
        id,
        symbol: pendingAccuSymbolRef.current,
        tier: 2,
        weapon: "ACCU 5% CANNON",
        direction: "neutral",
        entryStrike: quotes[quotes.length - 1] ?? 0,
        rollingMean: rollingAsianMean(quotes),
        resetTarget: null,
        legs: [],
        startAt: Date.now(),
      };
      setPendingAccuRef.current = false;
      pendingAccuSymbolRef.current = null;
      roundRef.current = current;
      setRound(current);
      execRef.current = true;
      setExecuting(true);
      setPhase("Tier 2 · instant 5% ACCU profit-split cannon");
      try {
        await placeChronoPair(symbol, 2, "ACCU 5% CANNON", [request]);
      } catch (error) {
        roundRef.current = null;
        setRound(null);
        execRef.current = false;
        setExecuting(false);
        onNotice("ACCU cannon unavailable: " + (error instanceof Error ? error.message : String(error)), "bad");
      }
      return;
    }

    const signal = analyzeMicrostructure(quotes);
    const decision = chooseChronoWeapon(weaponModeRef.current, signal);

    if (weaponModeRef.current === "virtual_probe") {
      if (!virtualS0Ref.current[symbol]) virtualS0Ref.current[symbol] = quotes[quotes.length - 1] ?? 0;
      const virtualS0 = virtualS0Ref.current[symbol];
      const currentSpot = quotes[quotes.length - 1] ?? 0;
      if (Math.abs(currentSpot - virtualS0) >= localAtr15 * 1.5 && decision.weapon === "VIRTUAL PROBE") {
        const decimals = 3;
        const pipSize = Math.pow(10, -decimals);
        const surgeUp = currentSpot > virtualS0;
        const noTouchOffset = Math.max(pipSize * 20, localAtr15 * 1.5).toFixed(decimals);
        const oneTouchOffset = Math.max(pipSize * 20, localAtr15 * 1.4).toFixed(decimals);
        const requests = virtualProbeRequests(surgeUp ? "bullish" : "bearish", (surgeUp ? "+" : "-") + noTouchOffset, (surgeUp ? "-" : "+") + oneTouchOffset);
        const id = ++roundSeqRef.current;
        const current: ChronoRound = {
          id, symbol, tier: 1, weapon: "VIRTUAL PROBE", direction: surgeUp ? "bullish" : "bearish",
          entryStrike: virtualS0, rollingMean: rollingAsianMean(quotes), resetTarget: null, legs: [], startAt: Date.now(),
        };
        roundRef.current = current;
        setRound(current);
        execRef.current = true;
        setExecuting(true);
        setPhase("Mode B · virtual probe snap-back corridor");
        try {
          await placeChronoPair(symbol, 1, "VIRTUAL PROBE", requests);
          virtualS0Ref.current[symbol] = currentSpot;
        } catch (error) {
          roundRef.current = null;
          setRound(null);
          execRef.current = false;
          setExecuting(false);
          onNotice("Virtual probe could not be placed: " + (error instanceof Error ? error.message : String(error)), "bad");
        }
      } else {
        setPhase(decision.reason);
      }
      return;
    }

    if (!decision.weapon) {
      setPhase(decision.reason);
      return;
    }

    const existingAnchor = anchorSpotRef.current[symbol];
    if (!existingAnchor) {
      const direction = decision.direction;
      if (direction !== "bullish" && direction !== "bearish") return;
      anchorSpotRef.current[symbol] = quotes[quotes.length - 1] ?? 0;
      anchorDirectionRef.current[symbol] = direction;
      ticksSinceAnchorRef.current[symbol] = 0;
      pendingTrapRef.current[symbol] = false;
      const request = staggeredAnchorRequest(direction);
      const id = ++roundSeqRef.current;
      const entry = anchorSpotRef.current[symbol];
      const current: ChronoRound = {
        id, symbol, tier: 1, weapon: "STAGGERED ANCHOR", direction,
        entryStrike: entry, rollingMean: rollingAsianMean(quotes), resetTarget: null, legs: [], startAt: Date.now(),
      };
      roundRef.current = current;
      setRound(current);
      execRef.current = true;
      setExecuting(true);
      setPhase("Mode A · T=0 $0.45 directional anchor");
      try {
        await placeChronoPair(symbol, 1, "STAGGERED ANCHOR", [request]);
      } catch (error) {
        anchorSpotRef.current[symbol] = 0;
        roundRef.current = null;
        setRound(null);
        execRef.current = false;
        setExecuting(false);
        onNotice("Staggered anchor could not be placed: " + (error instanceof Error ? error.message : String(error)), "bad");
      }
      return;
    }

    ticksSinceAnchorRef.current[symbol] = (ticksSinceAnchorRef.current[symbol] ?? 0) + 1;
    if (ticksSinceAnchorRef.current[symbol] !== 2 || pendingTrapRef.current[symbol]) return;
    const anchorSpot = anchorSpotRef.current[symbol];
    const direction = anchorDirectionRef.current[symbol];
    const currentSpot = quotes[quotes.length - 1] ?? 0;
    const signedMove = direction === "bullish" ? currentSpot - anchorSpot : anchorSpot - currentSpot;
    if (signedMove >= localAtr15 * 1.2) {
      pendingTrapRef.current[symbol] = true;
      const request = staggeredTrapRequest(direction === "bullish" ? "bullish" : "bearish");
      setPhase("Mode A · T=2 $0.35 peak trap armed");
      try {
        await placeChronoPair(symbol, 1, "STAGGERED ANCHOR", [request]);
      } catch (error) {
        pendingTrapRef.current[symbol] = false;
        onNotice("Peak trap could not be placed: " + (error instanceof Error ? error.message : String(error)), "bad");
      }
    } else if (signedMove <= -localAtr15 * 0.8) {
      const currentRound: ChronoRound | null = roundRef.current as ChronoRound | null;
      const leg1 = currentRound && Array.isArray(currentRound.legs) ? currentRound.legs[0] : undefined;
      if (leg1) {
        sellContract(leg1.contractId);
        setPhase("T2 EARLY CUT · adverse 0.8x ATR drop");
      }
    } else {
      setPhase("Mode A · neutral drift · anchor runs solo");
    }
  }, [onNotice, placeChronoPair, sellContract]);

  useEffect(() => {
    scanAndFireRef.current = scanAndFire;
  }, [scanAndFire]);

  const armEngine = useCallback(() => {
    if (!connectedRef.current) { onConnect(); return; }
    armedRef.current = true;
    setArmed(true);
    setPhase("Chrono-Vault armed · no Tier 1 entry until a corridor trigger fires");
  }, [onConnect]);

  const toggleArmed = useCallback(() => {
    if (armedRef.current) stopEngine("Chrono-Vault paused · no new round entry");
    else armEngine();
  }, [armEngine, stopEngine]);

  const resetSession = useCallback(() => {
    if (execRef.current || roundRef.current || activeChronoIdsRef.current.size > 0) return;
    stopEngine("Session reset · Chrono-Vault idle");
    pnlRef.current = 0;
    tier1BankedProfitRef.current = 0;
    setPnl(0);
    setTier1BankedProfit(0);
    setLogs([]);
    setAdvisor(null);
  }, [stopEngine]);

  const bankedLocked = tier1BankedProfit < vaultUnlockThreshold;
  const vaultArmed = vaultEnabled && !bankedLocked;
  const geometry = useMemo(() => ({
    spot,
    entryStrike,
    rollingAsianMean: rollingAsianMean(ticks.map((tick) => tick.quote)),
    resetTarget,
    corridorLow: Math.min(entryStrike || spot, rollingAsianMean(ticks.map((tick) => tick.quote)) || spot),
    corridorHigh: Math.max(entryStrike || spot, rollingAsianMean(ticks.map((tick) => tick.quote)) || spot),
    bankedProfit: tier1BankedProfit,
    vaultThreshold: vaultUnlockThreshold,
    protectedPrincipal: 13,
  }), [entryStrike, resetTarget, spot, tier1BankedProfit, ticks, vaultUnlockThreshold]);

  const downloadCsv = useCallback(() => {
    const blob = new Blob([chronoCsv(logs)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "chrono-vault-rounds.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  useEffect(() => {
    document.title = "Chrono-Vault | Deriv Quant Platform";
    return () => { document.title = "Deriv Quant Platform"; };
  }, []);

  return (
    <div className="min-h-full p-3 sm:p-4">
      <div className="mx-auto max-w-[1500px] space-y-3">
        <header className="rounded-lg border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span className="rounded-full border border-violet-400/40 bg-violet-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-violet-300">Page 8 · Standalone</span>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-slate-100 sm:text-2xl">Chrono-Vault</h1>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">Path-dependent Reset / Asian arbitrage with a protected principal and house-money accumulator cannon.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={"rounded-full border px-2.5 py-1 text-[10px] font-semibold " + (connected ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "border-line bg-ink/60 text-muted")}>{connected ? "WebSocket live" : "Disconnected"}</span>
              {!connected ? <button type="button" onClick={onConnect} className="rounded border border-accent bg-accent px-3 py-1.5 text-xs font-semibold text-ink">Connect</button> : null}
              <select value={accountId} onChange={(event) => onAccountChange(event.target.value)} disabled={executing || round !== null} className="rounded border border-line bg-ink px-2 py-1 font-mono text-[10px] text-slate-200">
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.kind.toUpperCase()}</option>)}
              </select>
              <span className="rounded border border-line bg-ink/60 px-2 py-1 font-mono text-[10px] text-slate-200">{balance === null ? "-" : "$" + balance.toFixed(2)} {currency}</span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-line bg-ink/50 px-3 py-2">
            <div><p className="text-[9px] font-bold uppercase tracking-widest text-muted">Engine phase</p><p className="mt-0.5 font-mono text-[11px] text-slate-200">{phase}</p></div>
            <span className={"rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest " + (armed ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" : "border-line text-muted")}>{executing ? "ROUND LOCKED" : armed ? "ARMED" : "IDLE"}</span>
          </div>
        </header>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_370px]">
          <div className="space-y-3">
            <ChronoCorridorVisualizer geometry={geometry} active={Boolean(round)} armed={vaultArmed} />

            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h2 className="text-sm font-semibold tracking-tight">Chrono microstructure</h2><p className="text-[10px] text-muted">Five-tick exhaustion, three-tick momentum and rolling Asian mean.</p></div>
                <span className="rounded border border-line px-2 py-1 font-mono text-[10px] text-slate-300">Spot ${spot > 0 ? spot.toFixed(3) : "—"}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["ATR 15", atr15.toFixed(5)],
                  ["ATR 100", atr100.toFixed(5)],
                  ["Compression", atr100 > 0 ? (atr15 / atr100).toFixed(3) : "—"],
                  ["Efficiency 3", ticks.length >= 4 ? efficiencyRatio(ticks.slice(-4).map((tick) => tick.quote)).toFixed(3) : "—"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded border border-line bg-ink/50 px-2 py-1.5"><p className="text-[8px] uppercase tracking-widest text-muted">{label}</p><p className="mt-0.5 font-mono text-[11px] text-slate-200">{value}</p></div>
                ))}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {[selectedSymbol, ...(secondarySymbol !== "NONE" && secondarySymbol !== selectedSymbol ? [secondarySymbol] : [])].map((symbol, index) => {
                  const metric = feedTelemetry[symbol];
                  const ready = Boolean(metric && metric.atr100 > 0 && metric.atr15 >= metric.atr100 * 0.90 && Math.abs(metric.impulseMove) >= metric.atr15 * 1.55 && metric.efficiency >= 0.65);
                  return (
                    <div key={symbol} className="flex items-center justify-between gap-2 rounded border border-line bg-ink/50 px-2 py-1.5">
                      <div><p className="text-[8px] uppercase tracking-widest text-muted">{index === 0 ? "Primary" : "Secondary"} · {symbol}</p><p className="mt-0.5 font-mono text-[9px] text-slate-300">{metric ? "ATR15 " + metric.atr15.toFixed(5) + " / ATR100 " + metric.atr100.toFixed(5) + " · ER3 " + metric.efficiency.toFixed(2) : "Warming feed…"}</p></div>
                      <span className={"rounded border px-1.5 py-0.5 text-[8px] font-semibold " + (ready ? "border-emerald-400/40 text-emerald-300" : "border-amber-400/40 text-amber-200")}>{ready ? "IMPULSE READY" : "WAITING · 1.35x/1.50x ATR"}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <aside className="space-y-3">
            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold tracking-tight">Chrono control</h2><span className="rounded border border-line px-2 py-0.5 text-[9px] uppercase tracking-widest text-muted">Tier 1 / Tier 2</span></div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Field label="Primary market"><select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value)} disabled={executing || round !== null} className={inputClass}>{CHRONO_SYMBOLS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}</select></Field>
                <Field label="Secondary radar"><select value={secondarySymbol} onChange={(event) => setSecondarySymbol(event.target.value)} disabled={executing || round !== null} className={inputClass}><option value="NONE">NONE</option>{CHRONO_SYMBOLS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}</select></Field>
              </div>
              <div className="mt-2">
                <p className="text-[9px] uppercase tracking-widest text-muted">Corridor mode</p>
                <div className="mt-1 grid grid-cols-2 gap-1 rounded border border-line bg-ink/60 p-1">
                  <button type="button" onClick={() => setWeaponMode("asymmetric_corridor")} disabled={executing || round !== null} className={"rounded px-2 py-1.5 text-[9px] font-semibold disabled:opacity-50 " + (weaponMode === "asymmetric_corridor" ? "bg-accent text-ink" : "text-muted hover:text-slate-100")}>Mode A · Staggered</button>
                  <button type="button" onClick={() => setWeaponMode("virtual_probe")} disabled={executing || round !== null} className={"rounded px-2 py-1.5 text-[9px] font-semibold disabled:opacity-50 " + (weaponMode === "virtual_probe" ? "bg-accent text-ink" : "text-muted hover:text-slate-100")}>Mode B · Virtual Probe</button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 rounded border border-line bg-ink/50 p-2">
                <Field label="Mode A anchor"><input value="$0.45" readOnly className={inputClass} /></Field>
                <Field label="Mode A trap"><input value="$0.35" readOnly className={inputClass} /></Field>
                <Field label="ACCU cannon"><input value="5% · $0.35" readOnly className={inputClass} /></Field>
              </div>
              <div className="mt-2 rounded border border-emerald-400/30 bg-emerald-400/5 p-2 text-[9px] leading-relaxed text-muted">
                50% of every Tier-1 net win ≥ $0.50 is locked permanently. Only the remaining house profit may fund a $0.35 ACCU 5% round.
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={toggleArmed} disabled={!connected || executing || round !== null || cooling} className={"flex-1 rounded px-3 py-2 text-xs font-bold disabled:opacity-40 " + (armed ? "border border-amber-400/50 bg-amber-400/10 text-amber-200" : "border border-accent bg-accent text-ink")}>{connected ? (armed ? "Pause Vault" : "Arm Vault") : "Connect"}</button>
                <button type="button" onClick={resetSession} disabled={executing || round !== null} className="rounded border border-line px-3 py-2 text-xs text-muted disabled:opacity-40">Reset</button>
              </div>
            </section>

            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold tracking-tight">Risk controls</h2><span className="text-[9px] text-muted">{isSlManual ? "Custom" : "Auto"} SL · {isTpManual ? "Custom" : "Auto"} TP</span></div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Field label="Stop loss"><input type="number" min={0} step={0.05} value={stopLoss} disabled={executing || round !== null} onChange={(event) => { setStopLoss(Math.max(0, Number(event.target.value) || 0)); setIsSlManual(true); }} className={inputClass} /></Field>
                <Field label="Take profit"><input type="number" min={0} step={0.25} value={takeProfit} disabled={executing || round !== null} onChange={(event) => { setTakeProfit(Math.max(0, Number(event.target.value) || 0)); setIsTpManual(true); }} className={inputClass} /></Field>
              </div>
            </section>

            <section className="rounded-lg border border-line bg-panel p-3">
              <h2 className="text-sm font-semibold tracking-tight">Two-tier telemetry</h2>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded border border-line bg-ink/50 px-2 py-1.5"><p className="text-[8px] uppercase tracking-widest text-muted">Tier 1 banked</p><p className={"mt-0.5 font-mono text-sm " + (tier1BankedProfit >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(tier1BankedProfit, currency)}</p></div>
                <div className="rounded border border-line bg-ink/50 px-2 py-1.5"><p className="text-[8px] uppercase tracking-widest text-muted">Session P&amp;L</p><p className={"mt-0.5 font-mono text-sm " + (pnl >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(pnl, currency)}</p></div>
              </div>
            </section>
          </aside>
        </div>

        <section className="rounded-lg border border-line bg-panel p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold tracking-tight">Grouped Chrono round log</h2><p className="text-[10px] text-muted">Tier and Weapon details with corridor outcome and P&amp;L.</p></div><button type="button" onClick={downloadCsv} disabled={logs.length === 0} className="rounded border border-line px-2.5 py-1.5 text-[10px] font-semibold text-muted hover:text-slate-100 disabled:opacity-40">Export CSV</button></div>
          {logs.length === 0 ? <p className="mt-3 rounded border border-dashed border-line px-3 py-6 text-center text-[11px] text-muted">No Chrono rounds settled yet.</p> : (
            <div className="mt-3 overflow-auto"><table className="w-full min-w-[820px] text-left text-[11px]"><thead className="text-[9px] uppercase tracking-widest text-muted"><tr className="border-b border-line"><th className="py-1.5 pr-2">Timestamp</th><th className="py-1.5 pr-2">Symbol</th><th className="py-1.5 pr-2">Tier &amp; Weapon</th><th className="py-1.5 pr-2">Outcome</th><th className="py-1.5 pr-2 text-right">Leg 1</th><th className="py-1.5 pr-2 text-right">Leg 2</th><th className="py-1.5 text-right">Net</th></tr></thead><tbody>{logs.map((row) => <tr key={row.id} className="border-b border-line/60 last:border-0"><td className="py-1.5 pr-2 font-mono text-[9px] text-muted">{new Date(row.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td><td className="py-1.5 pr-2 font-mono text-slate-200">{row.symbol}</td><td className="py-1.5 pr-2">T{row.tier}: {row.weapon}</td><td className="py-1.5 pr-2 text-emerald-300">{row.outcome}</td><td className="py-1.5 pr-2 text-right font-mono">{signedMoney(row.leg1Pnl, currency)}</td><td className="py-1.5 pr-2 text-right font-mono">{signedMoney(row.leg2Pnl, currency)}</td><td className={"py-1.5 text-right font-mono " + (row.netPnl >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(row.netPnl, currency)}</td></tr>)}</tbody></table></div>
          )}
        </section>
      </div>

      <SessionAdvisorModal open={advisor !== null} state={advisor} currency={currency} onDismiss={() => setAdvisor(null)} onReset={resetSession} variant="paroli" />
    </div>
  );
}
