import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Account, DerivSession, SymbolInfo, Tick } from "@/deriv";
import { DerivError } from "@/deriv";
import SessionAdvisorModal from "@/components/SessionAdvisorModal";
import type { SessionAdvisorState } from "@/components/SessionAdvisorModal";
import PhoenixPayoffVisualizer from "@/components/PhoenixPayoffVisualizer";
import type { PhoenixGeometry } from "@/components/PhoenixPayoffVisualizer";
import {
  PHOENIX_DEFAULT_DANGER_TRIGGER,
  PHOENIX_DEFAULT_STAGNATION_TICKS,
  PHOENIX_MIN_STAKE,
  PHOENIX_SYMBOLS,
  autoStopLoss,
  autoTakeProfit,
  chooseImpulseDirection,
  gearRoundRisk,
  microPhoenixRequests,
  phoenixCsv,
  rangeBoxRequest,
  routePhoenixGear,
  round2,
  turbinePhoenixRequests,
  vanillaRequests,
  expectedPhoenixScenarios,
} from "@/utils/phoenixMath";
import type {
  PhoenixDirection,
  PhoenixExitStatus,
  PhoenixGear,
  PhoenixLegRequest,
  PhoenixQuoteSnapshot,
  PhoenixRoundLog,
} from "@/utils/phoenixMath";

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
  status?: unknown;
  payout?: unknown;
}

interface PhoenixLegState {
  contractId: number;
  watchId: string;
  contractType: PhoenixLegRequest["contractType"];
  barrier: string | undefined;
  stake: number;
  buyPrice: number;
  bidPrice: number;
  payout: number;
  sold: boolean;
  sellSent: boolean;
  pnl: number;
}

interface PhoenixRound {
  id: number;
  symbol: string;
  gear: PhoenixGear;
  direction: PhoenixDirection;
  startSpot: number;
  startAt: number;
  ticksElapsed: number;
  legs: PhoenixLegState[];
  exitStatus: PhoenixExitStatus;
  dangerShieldSent: boolean;
}

interface CapabilityRow {
  symbol: string;
  ready: boolean;
  error: string | null;
  call: boolean;
  put: boolean;
  oneTouch: boolean;
  noTouch: boolean;
  turboLong: boolean;
  turboShort: boolean;
  vanillaCall: boolean;
  vanillaPut: boolean;
  minContractDuration: string;
  barriers: string[];
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

function isSold(payload: ContractPayload): boolean {
  return Number(payload.is_sold) === 1 || payload.is_sold === true || String(payload.is_sold) === "1";
}

function asContract(raw: unknown): ContractPayload {
  return typeof raw === "object" && raw !== null ? raw as ContractPayload : {};
}

function numberFrom(value: unknown): number {
  const valueNumber = Number(value);
  return Number.isFinite(valueNumber) ? valueNumber : 0;
}

function signedMoney(value: number, currency: string): string {
  return (value >= 0 ? "+$" : "-$") + Math.abs(value).toFixed(2) + " " + currency;
}

function csvDownload(rows: readonly PhoenixRoundLog[]): void {
  const blob = new Blob([phoenixCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "phoenix-engine-rounds.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function PhoenixEnginePage(props: Props): ReactElement {
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

  const [primaryGear, setPrimaryGear] = useState<1 | 2 | 3>(1);
  const [autoRouter, setAutoRouter] = useState(true);
  const [baseStake, setBaseStake] = useState(PHOENIX_MIN_STAKE);
  const [turboStake, setTurboStake] = useState(1);
  const [dangerTriggerPct, setDangerTriggerPct] = useState(PHOENIX_DEFAULT_DANGER_TRIGGER);
  const [dangerShield, setDangerShield] = useState(true);
  const [trailingLock, setTrailingLock] = useState(true);
  const [stagnationTicks, setStagnationTicks] = useState(PHOENIX_DEFAULT_STAGNATION_TICKS);
  const [armed, setArmed] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [round, setRound] = useState<PhoenixRound | null>(null);
  const [logs, setLogs] = useState<PhoenixRoundLog[]>([]);
  const [pnl, setPnl] = useState(0);
  const [phase, setPhase] = useState("Warming the Phoenix market console.");
  const [selectedSymbol, setSelectedSymbol] = useState<string>("1HZ10V");
  const [capabilities, setCapabilities] = useState<Record<string, CapabilityRow>>({});
  const [history, setHistory] = useState<Tick[]>([]);
  const [warmBufferStatus, setWarmBufferStatus] = useState<string | null>(null);
  const [spot, setSpot] = useState<number>(0);
  const [atr15, setAtr15] = useState<number>(0);
  const [atr100, setAtr100] = useState<number>(0);
  const [touchOffset, setTouchOffset] = useState<number>(0);
  const [koOffset, setKoOffset] = useState<number>(0);
  const [stopLoss, setStopLoss] = useState(2.8);
  const [takeProfit, setTakeProfit] = useState(3.25);
  const [isSlManual, setIsSlManual] = useState(false);
  const [isTpManual, setIsTpManual] = useState(false);
  const [advisor, setAdvisor] = useState<SessionAdvisorState | null>(null);

  const aliveRef = useRef(true);
  const connectedRef = useRef(connected);
  const accountIdRef = useRef(accountId);
  const currencyRef = useRef(currency);
  const selectedRef = useRef(selectedSymbol);
  const baseRef = useRef(baseStake);
  const turboRef = useRef(turboStake);
  const primaryGearRef = useRef(primaryGear);
  const autoRouterRef = useRef(autoRouter);
  const dangerShieldRef = useRef(dangerShield);
  const dangerPctRef = useRef(dangerTriggerPct);
  const trailingLockRef = useRef(trailingLock);
  const stagnationRef = useRef(stagnationTicks);
  const stopLossRef = useRef(stopLoss);
  const takeProfitRef = useRef(takeProfit);
  const armedRef = useRef(false);
  const execRef = useRef(false);
  const coolingRef = useRef(false);
  const roundRef = useRef<PhoenixRound | null>(null);
  const pnlRef = useRef(0);
  const roundSeqRef = useRef(0);
  const activePhoenixIdsRef = useRef<Set<number>>(new Set<number>());
  const peakBidRef = useRef<Map<number, number>>(new Map<number, number>());
  const buyPriceRef = useRef<Map<number, number>>(new Map<number, number>());
  const sellSentRef = useRef<Set<number>>(new Set<number>());
  const ticksRef = useRef<Tick[]>([]);
  const tickCacheRef = useRef<Record<string, number[]>>({});
  const radarSubsRef = useRef<Map<string, string>>(new Map<string, string>());
  const reqIdCounterRef = useRef(0);
  const cooldownTimerRef = useRef<number | undefined>(undefined);
  const gearRef = useRef<PhoenixGear>(1);

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
    baseRef.current = baseStake;
    turboRef.current = turboStake;
    primaryGearRef.current = primaryGear;
    autoRouterRef.current = autoRouter;
    dangerShieldRef.current = dangerShield;
    dangerPctRef.current = dangerTriggerPct;
    trailingLockRef.current = trailingLock;
    stagnationRef.current = stagnationTicks;
    stopLossRef.current = stopLoss;
    takeProfitRef.current = takeProfit;
  }, [accountId, autoRouter, baseStake, connected, currency, dangerShield, dangerTriggerPct, primaryGear, selectedSymbol, stagnationTicks, stopLoss, takeProfit, trailingLock, turboStake]);

  useEffect(() => {
    const gear = gearRef.current;
    const maxRisk = gearRoundRisk(gear, baseRef.current, turboRef.current);
    const expected = gear === 1 ? 1.10 : gear === 2 ? 5 : gear === 3 ? 0.50 : 1.10;
    if (!isSlManual) {
      const next = autoStopLoss(maxRisk);
      stopLossRef.current = next;
      setStopLoss(next);
    }
    if (!isTpManual) {
      const next = autoTakeProfit(expected);
      takeProfitRef.current = next;
      setTakeProfit(next);
    }
  }, [baseStake, isSlManual, isTpManual, primaryGear, turboStake]);

  const runDecision = useMemo(
    () => routePhoenixGear(primaryGear, autoRouter, atr15, atr100, touchOffset),
    [atr15, atr100, autoRouter, primaryGear, touchOffset],
  );

  useEffect(() => {
    gearRef.current = runDecision.gear;
  }, [runDecision.gear]);

  const stopEngine = useCallback((label: string) => {
    armedRef.current = false;
    setArmed(false);
    setPhase(label);
  }, []);

  const showAdvisor = useCallback((mode: "TP_HIT" | "SL_PARTIAL_WINS" | "SL_ZERO_WINS") => {
    stopEngine(mode === "TP_HIT" ? "Take profit hit - Phoenix stopped" : "Stop loss hit - Phoenix stopped");
    setAdvisor({
      mode,
      pnl: round2(pnlRef.current),
      wins: 0,
      losses: 0,
      peakLevel: gearRef.current,
      stopLoss: Math.abs(stopLossRef.current),
      takeProfit: takeProfitRef.current,
    });
  }, [stopEngine]);

  const finalizeRound = useCallback((status: PhoenixExitStatus) => {
    const current = roundRef.current;
    if (!current) return;
    const leg1 = current.legs.find((leg) => leg.contractType === "CALL" || leg.contractType === "PUT" || leg.contractType === "TURBOSLONG" || leg.contractType === "TURBOSSHORT" || leg.contractType === "VANILLALONGCALL");
    const leg2 = current.legs.find((leg, index) => index > 0);
    const leg1Pnl = leg1?.pnl ?? 0;
    const leg2Pnl = leg2?.pnl ?? 0;
    const net = round2(leg1Pnl + leg2Pnl);
    pnlRef.current = round2(pnlRef.current + net);
    setPnl(pnlRef.current);
    setLogs((previous) => [{
      id: current.id,
      timestamp: Date.now(),
      symbol: current.symbol,
      gear: current.gear,
      direction: current.direction,
      exitStatus: status,
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
    setPhase(status + " · post-round cooldown");
    if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = window.setTimeout(() => {
      coolingRef.current = false;
      setCooling(false);
      if (pnlRef.current >= takeProfitRef.current) showAdvisor("TP_HIT");
      else if (pnlRef.current <= -Math.abs(stopLossRef.current)) showAdvisor("SL_ZERO_WINS");
      else if (armedRef.current) setPhase("Phoenix armed · scanning active feeds");
      else setPhase("Round settled · arm when ready");
    }, 1800);
  }, [showAdvisor]);

  const sellContract = useCallback((contractId: number) => {
    if (sellSentRef.current.has(contractId)) return;
    sellSentRef.current.add(contractId);
    void sessionRef.current?.sell(contractId, 0).catch((error: unknown) => {
      sellSentRef.current.delete(contractId);
      onNotice("Phoenix sell was not confirmed: " + (error instanceof Error ? error.message : String(error)), "bad");
    });
  }, [onNotice, sessionRef]);

  const handleContract = useCallback((raw: unknown) => {
    const data = asContract(raw);
    const contractId = numberFrom(data.contract_id);
    if (contractId <= 0 || !activePhoenixIdsRef.current.has(contractId)) return;
    const current = roundRef.current;
    if (!current) return;
    const legIndex = current.legs.findIndex((leg) => leg.contractId === contractId);
    if (legIndex < 0) return;

    const bid = numberFrom(data.bid_price);
    const buyPrice = numberFrom(data.buy_price) || buyPriceRef.current.get(contractId) || 1;
    buyPriceRef.current.set(contractId, buyPrice);
    if (bid > 0) {
      const peak = Math.max(peakBidRef.current.get(contractId) ?? 0, bid);
      peakBidRef.current.set(contractId, peak);
      const leg = current.legs[legIndex];
      const updatedLeg = { ...leg, bidPrice: bid, buyPrice, payout: numberFrom(data.payout) || leg.payout };
      const legs = current.legs.map((item, index) => index === legIndex ? updatedLeg : item);
      roundRef.current = { ...current, ticksElapsed: current.ticksElapsed + 1, legs };
      setRound(roundRef.current);

      if (current.gear === 4 && numberFrom(data.is_valid_to_sell) === 1) {
        const payout = numberFrom(data.payout) || leg.payout;
        const unrealized = bid - buyPrice;
        if (unrealized >= (payout - buyPrice) * 0.65) {
          sellContract(contractId);
          roundRef.current = { ...roundRef.current, exitStatus: "RANGE 65% LOCK" };
          setRound(roundRef.current);
        }
      }

      if (current.gear === 2 && trailingLockRef.current && numberFrom(data.is_valid_to_sell) === 1) {
        const peaked = peakBidRef.current.get(contractId) ?? 0;
        if (peaked >= buyPrice * 1.50 && bid <= peaked * 0.80) sellContract(contractId);
        if (current.ticksElapsed >= stagnationRef.current && bid < buyPrice * 1.15) sellContract(contractId);
      }

      if (current.gear === 3) {
        const winning = roundRef.current.legs.find((item) => item.contractId === contractId);
        const straddleCost = roundRef.current.legs.reduce((sum, item) => sum + item.buyPrice, 0);
        if (winning && bid >= straddleCost * 1.25) sellContract(contractId);
      }
    }

    if (isSold(data)) {
      activePhoenixIdsRef.current.delete(contractId);
      const legs = current.legs.map((leg) => leg.contractId === contractId ? {
        ...leg,
        sold: true,
        pnl: numberFrom(data.profit) !== 0 ? round2(numberFrom(data.profit)) : leg.pnl,
      } : leg);
      roundRef.current = { ...current, legs };
      setRound(roundRef.current);
      if (activePhoenixIdsRef.current.size === 0) {
        let status: PhoenixExitStatus = roundRef.current.exitStatus;
        if (current.gear === 2) {
          const leg = legs.find((item) => item.contractType === "TURBOSLONG" || item.contractType === "TURBOSSHORT");
          if (leg && leg.pnl > 0) status = "CLEAN RUNNER";
          else if (leg && leg.bidPrice > 0 && leg.bidPrice < leg.buyPrice * 1.15) status = "CHOP SALVAGE";
        }
        if (current.gear === 3) status = legs.some((leg) => leg.pnl > 0) ? "PEEL LOCKED" : status;
        if (current.gear === 4) status = roundRef.current.exitStatus === "RANGE 65% LOCK" ? "RANGE 65% LOCK" : "RANGE 65% LOCK";
        finalizeRound(status);
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
    try {
      ++reqIdCounterRef.current;
      // Deriv contracts_for discovery intentionally sends only the symbol.
      const offers = await session.contractsFor(symbol);
      if (!aliveRef.current) return;
      const types = new Set(offers.map((offer) => offer.contractType.toUpperCase()));
      const barriers = offers.flatMap((offer) => [
        ...(offer.barrier ? [offer.barrier] : []),
        ...(offer.barrierChoices ?? []),
      ]).filter((barrier, index, all) => all.indexOf(barrier) === index);
      setCapabilities((previous) => ({
        ...previous,
        [symbol]: {
          symbol,
          ready: true,
          error: null,
          call: types.has("CALL"),
          put: types.has("PUT"),
          oneTouch: types.has("ONETOUCH"),
          noTouch: types.has("NOTOUCH"),
          turboLong: types.has("TURBOSLONG"),
          turboShort: types.has("TURBOSSHORT"),
          vanillaCall: types.has("VANILLALONGCALL"),
          vanillaPut: types.has("VANILLALONGPUT"),
          minContractDuration: offers.find((offer) => offer.minContractDuration)?.minContractDuration ?? "",
          barriers: barriers.sort((a, b) => Math.abs(Number(a)) - Math.abs(Number(b))).slice(0, 20),
        },
      }));
    } catch (error) {
      setCapabilities((previous) => ({
        ...previous,
        [symbol]: {
          symbol,
          ready: false,
          error: error instanceof Error ? error.message : String(error),
          call: false,
          put: false,
          oneTouch: false,
          noTouch: false,
          turboLong: false,
          turboShort: false,
          vanillaCall: false,
          vanillaPut: false,
          minContractDuration: "",
          barriers: [],
        },
      }));
    }
  }, [sessionRef]);

  useEffect(() => {
    if (!connected) return;
    void discoverCapabilities(selectedSymbol);
  }, [connected, selectedSymbol, discoverCapabilities]);

  const startFeed = useCallback(async (symbol: string): Promise<void> => {
    const session = sessionRef.current;
    if (!session || !connectedRef.current) return;

    const oldSubscriptionId = radarSubsRef.current.get(symbol);
    if (oldSubscriptionId) {
      ++reqIdCounterRef.current;
      await session.forget(oldSubscriptionId);
      radarSubsRef.current.delete(symbol);
    }

    const cachedQuotes = tickCacheRef.current[symbol];
    if (cachedQuotes && cachedQuotes.length > 0) {
      const cachedTicks = cachedQuotes.map((quote, index) => ({ quote, epoch: Date.now() - (cachedQuotes.length - index) }));
      ticksRef.current = cachedTicks;
      setHistory(cachedTicks);
      const range = (rows: readonly number[]): number => {
        if (rows.length < 2) return 0;
        let sum = 0;
        for (let index = 1; index < rows.length; index += 1) sum += Math.abs(rows[index] - rows[index - 1]);
        return sum / (rows.length - 1);
      };
      setAtr15(range(cachedQuotes.slice(-15)));
      setAtr100(range(cachedQuotes.slice(-100)));
      setSpot(cachedQuotes[cachedQuotes.length - 1] ?? 0);
      setWarmBufferStatus(null);
    } else {
      try {
        ++reqIdCounterRef.current;
        const historyTicks = await session.history(symbol, 100, "ticks");
        if (!aliveRef.current || selectedRef.current !== symbol) return;
        const quotes = historyTicks.map((tick) => tick.quote).filter((quote) => Number.isFinite(quote) && quote > 0).slice(-120);
        tickCacheRef.current[symbol] = quotes;
        ticksRef.current = historyTicks.slice(-120);
        setHistory(historyTicks.slice(-120));
        const range = (rows: readonly number[]): number => {
          if (rows.length < 2) return 0;
          let sum = 0;
          for (let index = 1; index < rows.length; index += 1) sum += Math.abs(rows[index] - rows[index - 1]);
          return sum / (rows.length - 1);
        };
        setAtr15(range(quotes.slice(-15)));
        setAtr100(range(quotes.slice(-100)));
        if (quotes.length > 0) setSpot(quotes[quotes.length - 1]);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code ?? "";
        if (String(code).toLowerCase() === "ratelimit") {
          setWarmBufferStatus("Warming live buffer: 0/15 ticks...");
        } else {
          setWarmBufferStatus("Warming live buffer: 0/15 ticks...");
        }
      }
    }

    try {
      ++reqIdCounterRef.current;
      const subscriptionId = await session.subscribeTicksFor(symbol);
      if (!aliveRef.current || selectedRef.current !== symbol) {
        if (subscriptionId) void session.forget(subscriptionId);
        return;
      }
      if (subscriptionId) radarSubsRef.current.set(symbol, subscriptionId);
    } catch (error) {
      onNotice("Phoenix tick stream failed for " + symbol + ": " + (error instanceof Error ? error.message : String(error)), "bad");
    }
  }, [onNotice, sessionRef]);

  useEffect(() => {
    if (!connected) return;
    const session = sessionRef.current;
    if (!session) return;
    const handler = (symbol: string, tick: Tick): void => {
      if (symbol !== selectedRef.current) return;
      const previous = ticksRef.current[ticksRef.current.length - 1]?.quote ?? tick.quote;
      const quote = Number(tick.quote);
      if (!Number.isFinite(quote) || quote <= 0) return;
      ticksRef.current = [...ticksRef.current.slice(-119), { ...tick, quote }];
      setHistory(ticksRef.current);
      setSpot(quote);
      const quotes = tickCacheRef.current[selectedRef.current]
        ? [...tickCacheRef.current[selectedRef.current], quote].slice(-120)
        : ticksRef.current.map((item) => item.quote).slice(-120);
      tickCacheRef.current[selectedRef.current] = quotes;
      if (warmBufferStatus !== null) {
        const liveCount = quotes.length;
        if (liveCount >= 15) setWarmBufferStatus(null);
        else setWarmBufferStatus("Warming live buffer: " + liveCount + "/15 ticks...");
      }
      const range = (rows: readonly number[]): number => {
        if (rows.length < 2) return 0;
        let sum = 0;
        for (let index = 1; index < rows.length; index += 1) sum += Math.abs(rows[index] - rows[index - 1]);
        return sum / (rows.length - 1);
      };
      setAtr15(range(quotes.slice(-15)));
      setAtr100(range(quotes));
      const currentRound = roundRef.current;
      if (currentRound) {
        const nextRound = { ...currentRound, ticksElapsed: currentRound.ticksElapsed + 1 };
        if (
          nextRound.gear === 2
          && dangerShieldRef.current
          && !nextRound.dangerShieldSent
          && koOffset !== 0
        ) {
          const directionSign = nextRound.direction === "LONG" ? 1 : -1;
          const pullbackDistance = Math.abs(tick.quote - nextRound.startSpot);
          const koDistance = Math.abs(koOffset);
          const triggerDistance = koDistance * (dangerPctRef.current / 100);
          const awayFromStart = directionSign * (tick.quote - nextRound.startSpot);
          if (awayFromStart >= triggerDistance) {
            const touch = resolveBarrier(nextRound.symbol, "ONETOUCH", "touch");
            void placeBundle(nextRound.symbol, 2, [{
              contractType: "ONETOUCH",
              barrier: String(touch),
              duration: 5,
              durationUnit: "t",
              stake: PHOENIX_MIN_STAKE,
              label: "Contingent interior ONETOUCH shield",
            }]).finally(() => {
              if (roundRef.current) {
                const fired = { ...roundRef.current, dangerShieldSent: true };
                roundRef.current = fired;
                setRound(fired);
              }
            });
          }
        }
        roundRef.current = nextRound;
        setRound(nextRound);
      }
      if (armedRef.current && !execRef.current && !coolingRef.current) {
        const direction = chooseImpulseDirection(tick.quote - previous, previous, tick.quote);
        if (runDecision.reachable || runDecision.gear === 4) void fireRound(direction);
      }
    };
    session.onTickFor = handler;
    void startFeed(selectedSymbol);
    return () => {
      if (session.onTickFor === handler) session.onTickFor = null;
      const subscriptionId = radarSubsRef.current.get(selectedSymbol);
      if (subscriptionId) {
        ++reqIdCounterRef.current;
        void session.forget(subscriptionId);
        radarSubsRef.current.delete(selectedSymbol);
      }
    };
  }, [connected, selectedSymbol]);

  const resolveBarrier = useCallback((symbol: string, contractType: "TURBOSLONG" | "TURBOSSHORT" | "ONETOUCH" | "NOTOUCH" | "VANILLA", side: "ko" | "touch" | "atm"): number => {
    void symbol;
    const row = capabilities[symbol];
    const numeric = row?.barriers.map((barrier) => Number(barrier)).filter((barrier) => Number.isFinite(barrier)) ?? [];
    if (side === "ko") {
      const positive = numeric.filter((barrier) => barrier > 0);
      return positive.length > 0 ? positive[0] : 0.001;
    }
    if (side === "touch") {
      const inside = numeric.filter((barrier) => Math.abs(barrier) > 0 && Math.abs(barrier) < Math.abs(koOffset)).sort((a, b) => Math.abs(a) - Math.abs(b));
      return inside.length > 0 ? inside[0] : 0.0005;
    }
    return 0;
  }, [capabilities, koOffset]);

  const placeBundle = useCallback(async (symbol: string, gear: PhoenixGear, requests: PhoenixLegRequest[]): Promise<void> => {
    const session = sessionRef.current;
    if (!session) throw new Error("No Deriv session.");
    const quotes = await session.quoteBundle(requests.map((request) => ({
      symbol,
      contract: request.contractType,
      barrier: request.barrier,
      duration: request.duration,
      durationUnit: request.durationUnit,
      stake: request.stake,
      currency: currencyRef.current,
    })));
    const ids = await Promise.all(quotes.map((quote, index) => session.buy(quote.id, quote.ask).then((contractId) => {
      activePhoenixIdsRef.current.add(contractId);
      const request = requests[index];
      const leg: PhoenixLegState = {
        contractId,
        watchId: "",
        contractType: request.contractType,
        barrier: request.barrier,
        stake: request.stake,
        buyPrice: quote.ask,
        bidPrice: 0,
        payout: round2(quote.payout),
        sold: false,
        sellSent: false,
        pnl: 0,
      };
      return leg;
    })));
    const current = roundRef.current;
    if (!current) return;
    const next = { ...current, gear, legs: [...current.legs, ...ids] };
    roundRef.current = next;
    setRound(next);
    buyPriceRef.current = new Map(ids.map((leg) => [leg.contractId, leg.buyPrice]));
    await Promise.all(ids.map(async (leg) => {
      ++reqIdCounterRef.current;
      const watchId = await session.watch(leg.contractId);
      leg.watchId = watchId;
    }));
  }, [sessionRef]);

  const fireRound = useCallback(async (direction: "LONG" | "SHORT" = "LONG"): Promise<void> => {
    if (!connectedRef.current || execRef.current || coolingRef.current || roundRef.current || activePhoenixIdsRef.current.size > 0) return;
    const session = sessionRef.current;
    if (!session) { onConnect(); return; }
    const symbol = selectedRef.current;
    const gear = runDecision.gear;
    gearRef.current = gear;
    const id = ++roundSeqRef.current;
    const current: PhoenixRound = {
      id,
      symbol,
      gear,
      direction: gear === 3 ? "LONG_SHORT" : direction,
      startSpot: spot,
      startAt: Date.now(),
      ticksElapsed: 0,
      legs: [],
      exitStatus: "ROUND ACTIVE",
      dangerShieldSent: false,
    };
    roundRef.current = current;
    setRound(current);
    execRef.current = true;
    setExecuting(true);

    try {
      if (gear === 1) {
        const requests = microPhoenixRequests(direction, spot, baseRef.current, touchOffset);
        setPhase("Gear 1 · buying CALL/PUT impulse + opposite-side interior shield");
        await placeBundle(symbol, gear, requests);
      } else if (gear === 2) {
        const ko = resolveBarrier(symbol, "TURBOSLONG", "ko");
        const touch = resolveBarrier(symbol, "ONETOUCH", "touch");
        setKoOffset(ko);
        setTouchOffset(touch);
        const requests = turbinePhoenixRequests(direction, ko, touch, turboRef.current, PHOENIX_MIN_STAKE);
        setPhase(dangerShieldRef.current ? "Gear 2 · Turbo-only T0; interior shield waits for danger pullback" : "Gear 2 · buying Turbo + interior ONETOUCH simultaneously");
        await placeBundle(symbol, gear, dangerShieldRef.current ? [requests[0]] : requests);
      } else if (gear === 3) {
        setPhase("Gear 3 · buying ATM Vanilla call + put simultaneously");
        await placeBundle(symbol, gear, vanillaRequests(1));
      } else {
        setPhase("Gear 4 · buying minimum-duration NOTOUCH range box");
        await placeBundle(symbol, gear, [rangeBoxRequest(baseRef.current)]);
      }
    } catch (error) {
      if (activePhoenixIdsRef.current.size > 0) {
        setPhase("Phoenix contract lock held · verify open position in Deriv");
        onNotice("The Phoenix round has open legs: " + (error instanceof DerivError ? error.message : String(error)), "bad");
      } else {
        roundRef.current = null;
        setRound(null);
        execRef.current = false;
        setExecuting(false);
        onNotice("Phoenix round could not be placed: " + (error instanceof Error ? error.message : String(error)), "bad");
      }
    }
  }, [connectedRef, onConnect, onNotice, placeBundle, resolveBarrier, runDecision, spot, touchOffset]);

  const armEngine = useCallback(() => {
    if (!connectedRef.current) { onConnect(); return; }
    armedRef.current = true;
    setArmed(true);
    setPhase("Phoenix armed · " + runDecision.reason);
  }, [onConnect, runDecision.reason]);

  const toggleArmed = useCallback(() => {
    if (armedRef.current) stopEngine("Phoenix paused · no new round entry");
    else armEngine();
  }, [armEngine, stopEngine]);

  const resetSession = useCallback(() => {
    if (execRef.current || roundRef.current || activePhoenixIdsRef.current.size > 0) return;
    stopEngine("Session reset · Phoenix idle");
    pnlRef.current = 0;
    setPnl(0);
    setLogs([]);
    setAdvisor(null);
  }, [stopEngine]);

  const geometry = useMemo<PhoenixGeometry>(() => {
    const current = round;
    const turboLeg = current?.legs.find((leg) => leg.contractType === "TURBOSLONG" || leg.contractType === "TURBOSSHORT");
    const peak = turboLeg ? peakBidRef.current.get(turboLeg.contractId) ?? null : null;
    const floor = peak !== null && trailingLock && peak >= (turboLeg?.buyPrice ?? 0) * 1.50
      ? peak * 0.80
      : null;
    return {
      spot,
      koBarrierOffset: koOffset,
      touchBarrierOffset: touchOffset,
      dangerTriggerPct,
      trailingFloor: floor,
      peakBid: peak,
      buyPrice: turboLeg?.buyPrice ?? baseStake,
      peakBidPrice: peak,
    };
  }, [baseStake, dangerTriggerPct, round, spot, trailingLock, koOffset, touchOffset]);

  const scenarioCards = useMemo(
    () => expectedPhoenixScenarios(runDecision.gear, gearRoundRisk(runDecision.gear, baseStake, turboStake)),
    [baseStake, runDecision.gear, turboStake],
  );

  useEffect(() => {
    document.title = "Phoenix Engine | Deriv Quant Platform";
    return () => { document.title = "Deriv Quant Platform"; };
  }, []);

  return (
    <div className="min-h-full p-3 sm:p-4">
      <div className="mx-auto max-w-[1500px] space-y-3">
        <header className="rounded-lg border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-emerald-300">Page 7 · Final Boss</span>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-slate-100 sm:text-2xl">Phoenix Engine</h1>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">Cross-engine arbitrage and gamma harvesting across synthetic markets.</p>
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
          {warmBufferStatus ? (
            <div className="mt-3 rounded border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
              {warmBufferStatus}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-line bg-ink/50 px-3 py-2">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-widest text-muted">Engine phase</p>
              <p className="mt-0.5 font-mono text-[11px] text-slate-200">{phase}</p>
            </div>
            <span className={"rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest " + (armed ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" : "border-line text-muted")}>{executing ? "ROUND LOCKED" : armed ? "ARMED" : "IDLE"}</span>
          </div>
        </header>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_370px]">
          <div className="space-y-3">
            <PhoenixPayoffVisualizer gear={runDecision.gear} geometry={geometry} scenarios={scenarioCards} active={Boolean(round)} />

            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Phoenix market console</h2>
                  <p className="text-[10px] text-muted">Live spot and ATR routing across the 10 supported markets.</p>
                </div>
                <span className="rounded border border-line px-2 py-1 font-mono text-[10px] text-slate-300">Spot ${spot > 0 ? spot.toFixed(3) : "—"}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["ATR 15", atr15.toFixed(5)],
                  ["ATR 100", atr100.toFixed(5)],
                  ["Compression", atr100 > 0 ? (atr15 / atr100).toFixed(3) : "—"],
                  ["Touch reach", atr15 * 4 >= Math.abs(touchOffset) ? "Reachable" : "Dead chop"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded border border-line bg-ink/50 px-2 py-1.5">
                    <p className="text-[8px] uppercase tracking-widest text-muted">{label}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-200">{value}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="space-y-3">
            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">Gear control</h2>
                <span className="rounded border border-line px-2 py-0.5 text-[9px] uppercase tracking-widest text-muted">{runDecision.gear === 4 ? "Range box" : "Gear " + runDecision.gear}</span>
              </div>
              <div className="mt-3">
                <p className="text-[9px] uppercase tracking-widest text-muted">Market</p>
                <select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value)} disabled={executing || round !== null} className={inputClass}>
                  {PHOENIX_SYMBOLS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
                </select>
              </div>
              <div className="mt-2">
                <p className="text-[9px] uppercase tracking-widest text-muted">Primary gear</p>
                <div className="mt-1 grid grid-cols-3 gap-1 rounded border border-line bg-ink/60 p-1">
                  {([1, 2, 3] as const).map((gear) => (
                    <button key={gear} type="button" onClick={() => setPrimaryGear(gear)} disabled={executing || round !== null} className={"rounded px-2 py-1.5 text-[10px] font-semibold disabled:opacity-50 " + (primaryGear === gear ? "bg-accent text-ink" : "text-muted hover:text-slate-100")}>Gear {gear}</button>
                  ))}
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between rounded border border-line bg-ink/50 p-2">
                <div><p className="text-[10px] font-semibold text-slate-200">Auto-regime router</p><p className="text-[9px] text-muted">Dead-flat routes to Gear 4.</p></div>
                <button type="button" onClick={() => setAutoRouter((value) => !value)} disabled={executing || round !== null} className={"rounded border px-2.5 py-1 text-[10px] font-semibold " + (autoRouter ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" : "border-line text-muted")}>{autoRouter ? "ON" : "OFF"}</button>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Base stake"><input type="number" min={PHOENIX_MIN_STAKE} step={0.01} value={baseStake} disabled={executing || round !== null} onChange={(event) => setBaseStake(Math.max(PHOENIX_MIN_STAKE, Number(event.target.value) || PHOENIX_MIN_STAKE))} className={inputClass} /></Field>
                <Field label="Turbo stake"><input type="number" min={PHOENIX_MIN_STAKE} step={0.01} value={turboStake} disabled={executing || round !== null} onChange={(event) => setTurboStake(Math.max(PHOENIX_MIN_STAKE, Number(event.target.value) || 1))} className={inputClass} /></Field>
              </div>

              {primaryGear === 2 ? (
                <div className="mt-2 space-y-2 rounded border border-line bg-ink/50 p-2">
                  <div className="flex items-center justify-between"><div><p className="text-[10px] font-semibold text-slate-200">Contingent danger shield</p><p className="text-[9px] text-muted">Auto-fire ONETOUCH after pullback.</p></div><button type="button" onClick={() => setDangerShield((value) => !value)} disabled={executing || round !== null} className={"rounded border px-2 py-1 text-[9px] font-semibold " + (dangerShield ? "border-emerald-400/50 text-emerald-300" : "border-line text-muted")}>{dangerShield ? "ON" : "OFF"}</button></div>
                  <Field label="Danger trigger %"><input type="number" min={1} max={100} step={1} value={dangerTriggerPct} disabled={executing || round !== null} onChange={(event) => setDangerTriggerPct(Math.max(1, Math.min(100, Number(event.target.value) || PHOENIX_DEFAULT_DANGER_TRIGGER)))} className={inputClass} /></Field>
                </div>
              ) : null}

              <div className="mt-2 grid grid-cols-2 gap-2 rounded border border-line bg-ink/50 p-2">
                <button type="button" onClick={() => setTrailingLock((value) => !value)} disabled={executing || round !== null} className={"rounded border px-2 py-1 text-[9px] font-semibold " + (trailingLock ? "border-emerald-400/50 text-emerald-300" : "border-line text-muted")}>Peak lock {trailingLock ? "ON" : "OFF"}</button>
                <Field label="Stagnation ticks"><input type="number" min={5} max={100} step={1} value={stagnationTicks} disabled={executing || round !== null} onChange={(event) => setStagnationTicks(Math.max(5, Math.min(100, Number(event.target.value) || PHOENIX_DEFAULT_STAGNATION_TICKS)))} className={inputClass} /></Field>
              </div>

              <div className="mt-3 flex gap-2">
                <button type="button" onClick={toggleArmed} disabled={!connected || executing || round !== null || cooling} className={"flex-1 rounded px-3 py-2 text-xs font-bold disabled:opacity-40 " + (armed ? "border border-amber-400/50 bg-amber-400/10 text-amber-200" : "border border-accent bg-accent text-ink")}>{connected ? (armed ? "Pause Phoenix" : "Arm Phoenix") : "Connect"}</button>
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
              <h2 className="text-sm font-semibold tracking-tight">Session telemetry</h2>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded border border-line bg-ink/50 px-2 py-1.5"><p className="text-[8px] uppercase tracking-widest text-muted">Session P&amp;L</p><p className={"mt-0.5 font-mono text-sm " + (pnl >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(pnl, currency)}</p></div>
                <div className="rounded border border-line bg-ink/50 px-2 py-1.5"><p className="text-[8px] uppercase tracking-widest text-muted">Rounds</p><p className="mt-0.5 font-mono text-sm text-slate-200">{logs.length}</p></div>
              </div>
            </section>
          </aside>
        </div>

        <section className="rounded-lg border border-line bg-panel p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold tracking-tight">Grouped Phoenix round log</h2><p className="text-[10px] text-muted">Settled rounds with shield and exit status.</p></div><button type="button" onClick={() => csvDownload(logs)} disabled={logs.length === 0} className="rounded border border-line px-2.5 py-1.5 text-[10px] font-semibold text-muted hover:text-slate-100 disabled:opacity-40">Export CSV</button></div>
          {logs.length === 0 ? <p className="mt-3 rounded border border-dashed border-line px-3 py-6 text-center text-[11px] text-muted">No Phoenix rounds settled yet.</p> : (
            <div className="mt-3 overflow-auto"><table className="w-full min-w-[820px] text-left text-[11px]"><thead className="text-[9px] uppercase tracking-widest text-muted"><tr className="border-b border-line"><th className="py-1.5 pr-2">Timestamp</th><th className="py-1.5 pr-2">Symbol</th><th className="py-1.5 pr-2">Gear</th><th className="py-1.5 pr-2">Direction</th><th className="py-1.5 pr-2">Exit status</th><th className="py-1.5 pr-2 text-right">Leg 1</th><th className="py-1.5 pr-2 text-right">Leg 2</th><th className="py-1.5 text-right">Net</th></tr></thead><tbody>{logs.map((row) => <tr key={row.id} className="border-b border-line/60 last:border-0"><td className="py-1.5 pr-2 font-mono text-[9px] text-muted">{new Date(row.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td><td className="py-1.5 pr-2 font-mono text-slate-200">{row.symbol}</td><td className="py-1.5 pr-2">Gear {row.gear}</td><td className="py-1.5 pr-2">{row.direction}</td><td className="py-1.5 pr-2 text-emerald-300">{row.exitStatus}</td><td className="py-1.5 pr-2 text-right font-mono">{signedMoney(row.leg1Pnl, currency)}</td><td className="py-1.5 pr-2 text-right font-mono">{signedMoney(row.leg2Pnl, currency)}</td><td className={"py-1.5 text-right font-mono " + (row.netPnl >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(row.netPnl, currency)}</td></tr>)}</tbody></table></div>
          )}
        </section>
      </div>

      <SessionAdvisorModal open={advisor !== null} state={advisor} currency={currency} onDismiss={() => setAdvisor(null)} onReset={resetSession} variant="paroli" />
    </div>
  );
}
