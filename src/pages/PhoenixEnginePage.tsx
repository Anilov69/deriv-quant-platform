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
  cleanBarrierOffset,
  decimalsFromLatestQuote,
  formatBarrierOffset,
  phoenixEntryGate,
  parsePhoenixDuration,
  pipSizeFromDecimals,
  syntheticTouchOffset,
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

interface PhoenixFeedMetrics {
  quotes: number[];
  spot: number;
  atr15: number;
  atr100: number;
  decimals: number;
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
  barrierChoicesByType: Record<string, string[]>;
  minStakeByType: Record<string, number>;
  minDurationByType: Record<string, string>;
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

function rangeAtr(quotes: readonly number[]): number {
  if (quotes.length < 2) return 0;
  let sum = 0;
  for (let index = 1; index < quotes.length; index += 1) sum += Math.abs(quotes[index] - quotes[index - 1]);
  return sum / (quotes.length - 1);
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
  const [selectedSymbol, setSelectedSymbol] = useState<string>("1HZ75V");
  const [secondarySymbol, setSecondarySymbol] = useState<string>("1HZ100V");
  const [feedTelemetry, setFeedTelemetry] = useState<Record<string, PhoenixFeedMetrics>>({});
  const [capabilities, setCapabilities] = useState<Record<string, CapabilityRow>>({});
  const [minimumStakeBySymbol, setMinimumStakeBySymbol] = useState<Record<string, { turbo: number; vanilla: number }>>({});
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
  const secondaryRef = useRef(secondarySymbol);
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
  const validatedTouchOffsetRef = useRef<Record<string, number>>({});
  const discoveredTurboMinStakeRef = useRef<Record<string, number>>({});
  const discoveredVanillaMinStakeRef = useRef<Record<string, number>>({});
  const buyPriceRef = useRef<Map<number, number>>(new Map<number, number>());
  const sellSentRef = useRef<Set<number>>(new Set<number>());
  const ticksRef = useRef<Tick[]>([]);
  const ticksBySymbolRef = useRef<Record<string, Tick[]>>({});
  const tickCacheRef = useRef<Record<string, number[]>>({});
  const feedMetricsRef = useRef<Record<string, PhoenixFeedMetrics>>({});
  const capabilityCacheRef = useRef<Record<string, CapabilityRow>>({});
  const radarSubsRef = useRef<Map<string, string>>(new Map<string, string>());
  const reqIdCounterRef = useRef(0);
  const cooldownTimerRef = useRef<number | undefined>(undefined);
  const gearRef = useRef<PhoenixGear>(1);
  const runDecisionRef = useRef({ gear: 1 as PhoenixGear, reason: "Warming", reachable: false });
  const fireRoundRef = useRef<(direction: "LONG" | "SHORT", symbol: string) => void>(() => undefined);
  const resolveBarrierRef = useRef<(
    symbol: string,
    contractType: "TURBOSLONG" | "TURBOSSHORT" | "ONETOUCH" | "NOTOUCH" | "VANILLA" | "VANILLALONGCALL" | "VANILLALONGPUT",
    side: "ko" | "touch" | "atm",
    spotValue?: number,
    atr15Value?: number,
  ) => string>(() => "+0.01");
  const touchOffsetRef = useRef(0);
  const koOffsetRef = useRef(0);
  const placeBundleRef = useRef<(symbol: string, gear: PhoenixGear, requests: PhoenixLegRequest[]) => Promise<void>>(async () => undefined);

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
    touchOffsetRef.current = touchOffset;
    koOffsetRef.current = koOffset;
  }, [accountId, autoRouter, baseStake, connected, currency, dangerShield, dangerTriggerPct, koOffset, primaryGear, secondarySymbol, selectedSymbol, stagnationTicks, stopLoss, takeProfit, touchOffset, trailingLock, turboStake]);

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
    runDecisionRef.current = runDecision;
  }, [runDecision]);

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
          roundRef.current = { ...roundRef.current, exitStatus: "TRAILING / RANGE LOCK" };
          setRound(roundRef.current);
        }
      }

      if (current.gear === 2 && trailingLockRef.current && numberFrom(data.is_valid_to_sell) === 1) {
        const peaked = peakBidRef.current.get(contractId) ?? 0;
        const trailingHit = peaked >= buyPrice * 1.50 && bid <= peaked * 0.80;
        const stagnationHit = current.ticksElapsed >= stagnationRef.current && bid < buyPrice * 1.15;
        if (trailingHit || stagnationHit) {
          sellContract(contractId);
          roundRef.current = { ...roundRef.current, exitStatus: "TRAILING / RANGE LOCK" };
          setRound(roundRef.current);
        }
      }

      if (current.gear === 3) {
        const winning = roundRef.current.legs.find((item) => item.contractId === contractId);
        const straddleCost = roundRef.current.legs.reduce((sum, item) => sum + item.buyPrice, 0);
        if (winning && bid >= straddleCost * 1.25) {
          sellContract(contractId);
          roundRef.current = { ...roundRef.current, exitStatus: "TRAILING / RANGE LOCK" };
          setRound(roundRef.current);
        }
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
        const settledRound = roundRef.current;
        const netPnl = round2(legs.reduce((sum, leg) => sum + leg.pnl, 0));
        const directionalLeg = legs.find((leg) =>
          leg.contractType === "CALL"
          || leg.contractType === "PUT"
          || leg.contractType === "TURBOSLONG"
          || leg.contractType === "TURBOSSHORT"
          || leg.contractType === "VANILLALONGCALL"
          || leg.contractType === "VANILLALONGPUT",
        );
        const shieldLeg = legs.find((leg) => leg.contractType === "ONETOUCH" || leg.contractType === "NOTOUCH");
        let status: PhoenixExitStatus;
        if ((settledRound?.exitStatus === "TRAILING / RANGE LOCK" || settledRound?.exitStatus === "RANGE 65% LOCK") && netPnl > 0) {
          status = "TRAILING / RANGE LOCK";
        } else if (directionalLeg && shieldLeg) {
          if (directionalLeg.pnl > 0 && shieldLeg.pnl > 0) status = "DOUBLE-DIP";
          else if (directionalLeg.pnl <= 0 && shieldLeg.pnl > 0) status = "CRASH RESCUED";
          else if (directionalLeg.pnl > 0 && shieldLeg.pnl <= 0) status = "MICRO-SCRATCH";
          else status = "DOUBLE MISS";
        } else if (current.gear === 3 && legs.length >= 2) {
          status = legs.every((leg) => leg.pnl > 0) ? "DOUBLE-DIP" : legs.some((leg) => leg.pnl > 0) ? "PEEL LOCKED" : "DOUBLE MISS";
        } else if (current.gear === 2) {
          const turbo = legs.find((leg) => leg.contractType === "TURBOSLONG" || leg.contractType === "TURBOSSHORT");
          status = turbo && turbo.pnl > 0 ? "CLEAN RUNNER" : "CHOP SALVAGE";
        } else if (current.gear === 4) {
          status = "TRAILING / RANGE LOCK";
        } else {
          status = netPnl > 0 ? "DOUBLE-DIP" : "DOUBLE MISS";
        }
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
    const cached = capabilityCacheRef.current[symbol];
    if (cached?.ready) {
      const turboMin = Math.max(1, cached.minStakeByType.TURBOSLONG ?? 1, cached.minStakeByType.TURBOSSHORT ?? 1);
      const vanillaMin = Math.max(1, cached.minStakeByType.VANILLALONGCALL ?? 1, cached.minStakeByType.VANILLALONGPUT ?? 1);
      setMinimumStakeBySymbol((previous) => ({ ...previous, [symbol]: { turbo: turboMin, vanilla: vanillaMin } }));
      setCapabilities((previous) => ({ ...previous, [symbol]: cached }));
      return;
    }
    try {
      ++reqIdCounterRef.current;
      // Deriv contracts_for discovery intentionally sends only the symbol.
      const offers = await session.contractsFor(symbol);
      if (!aliveRef.current) return;
      const types = new Set(offers.map((offer) => offer.contractType.toUpperCase()));
      const barrierChoicesByType: Record<string, string[]> = {};
      const minStakeByType: Record<string, number> = {};
      const minDurationByType: Record<string, string> = {};
      for (const offer of offers) {
        const contractType = offer.contractType.toUpperCase();
        if (offer.defaultStake > 0) minStakeByType[contractType] = offer.defaultStake;
        if (offer.minContractDuration) minDurationByType[contractType] = offer.minContractDuration;
        const choices = [...(offer.barrier ? [offer.barrier] : []), ...(offer.barrierChoices ?? [])]
          .map((choice) => String(choice).trim())
          .filter((choice) => choice.length > 0);
        barrierChoicesByType[contractType] = Array.from(new Set([...(barrierChoicesByType[contractType] ?? []), ...choices]));
      }
      const barriers = Object.values(barrierChoicesByType).flat().filter((barrier, index, all) => all.indexOf(barrier) === index);
      const capability: CapabilityRow = {
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
        barrierChoicesByType,
        minStakeByType,
        minDurationByType,
      };
      capabilityCacheRef.current[symbol] = capability;
      const turboMin = Math.max(1, minStakeByType.TURBOSLONG ?? 1, minStakeByType.TURBOSSHORT ?? 1);
      const vanillaMin = Math.max(1, minStakeByType.VANILLALONGCALL ?? 1, minStakeByType.VANILLALONGPUT ?? 1);
      setMinimumStakeBySymbol((previous) => ({ ...previous, [symbol]: { turbo: turboMin, vanilla: vanillaMin } }));
      setCapabilities((previous) => ({ ...previous, [symbol]: capability }));
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
          barrierChoicesByType: {},
          minStakeByType: {},
          minDurationByType: {},
        },
      }));
    }
  }, [sessionRef]);

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
      ticksBySymbolRef.current[symbol] = cachedTicks;
      const cachedAtr15 = rangeAtr(cachedQuotes.slice(-15));
      const cachedAtr100 = rangeAtr(cachedQuotes.slice(-100));
      const cachedSpot = cachedQuotes[cachedQuotes.length - 1] ?? 0;
      const decimals = decimalsFromLatestQuote(cachedSpot);
      const metric = { quotes: cachedQuotes.slice(-120), spot: cachedSpot, atr15: cachedAtr15, atr100: cachedAtr100, decimals };
      feedMetricsRef.current[symbol] = metric;
      setFeedTelemetry((previous) => ({ ...previous, [symbol]: metric }));
      if (symbol === selectedRef.current) {
        ticksRef.current = cachedTicks;
        setHistory(cachedTicks);
        setAtr15(cachedAtr15);
        setAtr100(cachedAtr100);
        setSpot(cachedSpot);
        setWarmBufferStatus(null);
      }
    } else {
      try {
        ++reqIdCounterRef.current;
        const historyTicks = await session.history(symbol, 100, "ticks");
        if (!aliveRef.current || ![selectedRef.current, secondaryRef.current].includes(symbol)) return;
        const cachedTicks = historyTicks.slice(-120);
        const quotes = cachedTicks.map((tick) => tick.quote).filter((quote) => Number.isFinite(quote) && quote > 0).slice(-120);
        tickCacheRef.current[symbol] = quotes;
        ticksBySymbolRef.current[symbol] = cachedTicks;
        const feedSpot = quotes[quotes.length - 1] ?? 0;
        const feedAtr15 = rangeAtr(quotes.slice(-15));
        const feedAtr100 = rangeAtr(quotes.slice(-100));
        const metric = { quotes, spot: feedSpot, atr15: feedAtr15, atr100: feedAtr100, decimals: decimalsFromLatestQuote(feedSpot) };
        feedMetricsRef.current[symbol] = metric;
        setFeedTelemetry((previous) => ({ ...previous, [symbol]: metric }));
        if (symbol === selectedRef.current) {
          ticksRef.current = cachedTicks;
          setHistory(cachedTicks);
          setAtr15(feedAtr15);
          setAtr100(feedAtr100);
          if (feedSpot > 0) setSpot(feedSpot);
        }
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
      if (!aliveRef.current || ![selectedRef.current, secondaryRef.current].includes(symbol)) {
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
    let cancelled = false;
    let staggerTimer: number | undefined;
    const activeSymbols = Array.from(new Set([selectedSymbol, secondarySymbol].filter((symbol) => symbol && symbol !== "NONE")));
    const handler = (symbol: string, tick: Tick): void => {
      if (!activeSymbols.includes(symbol)) return;
      const quote = Number(tick.quote);
      if (!Number.isFinite(quote) || quote <= 0) return;
      const symbolTicks = [...(ticksBySymbolRef.current[symbol] ?? []).slice(-119), { ...tick, quote }];
      ticksBySymbolRef.current[symbol] = symbolTicks;
      const quotes = [...(tickCacheRef.current[symbol] ?? []), quote].slice(-120);
      tickCacheRef.current[symbol] = quotes;
      const atr15Live = rangeAtr(quotes.slice(-15));
      const atr100Live = rangeAtr(quotes.slice(-100));
      const metric = { quotes, spot: quote, atr15: atr15Live, atr100: atr100Live, decimals: decimalsFromLatestQuote(quote) };
      feedMetricsRef.current[symbol] = metric;
      setFeedTelemetry((previous) => ({ ...previous, [symbol]: metric }));

      if (symbol === selectedRef.current) {
        ticksRef.current = symbolTicks;
        setHistory(symbolTicks);
        setSpot(quote);
        setAtr15(atr15Live);
        setAtr100(atr100Live);
        if (warmBufferStatus !== null) {
          if (quotes.length >= 15) setWarmBufferStatus(null);
          else setWarmBufferStatus("Warming live buffer: " + quotes.length + "/15 ticks...");
        }
      }

      const currentRound = roundRef.current;
      if (currentRound && currentRound.symbol === symbol) {
        const nextRound = { ...currentRound, ticksElapsed: currentRound.ticksElapsed + 1 };
        if (nextRound.gear === 2 && dangerShieldRef.current && !nextRound.dangerShieldSent && koOffsetRef.current !== 0) {
          const directionSign = nextRound.direction === "LONG" ? 1 : -1;
          const triggerDistance = Math.abs(koOffsetRef.current) * (dangerPctRef.current / 100);
          const awayFromStart = directionSign * (quote - nextRound.startSpot);
          if (awayFromStart >= triggerDistance) {
            const touch = resolveBarrierRef.current(nextRound.symbol, "ONETOUCH", "touch");
            void placeBundleRef.current(nextRound.symbol, 2, [{
              contractType: "ONETOUCH",
              barrier: touch,
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
        const quoteDecimals = decimalsFromLatestQuote(quote);
        const exactOffset = cleanBarrierOffset(resolveBarrierRef.current(symbol, "ONETOUCH", "touch", quote, atr15Live), quoteDecimals);
        const barrierOffset = exactOffset > 0
          ? exactOffset
          : syntheticTouchOffset(atr15Live, pipSizeFromDecimals(quoteDecimals), quoteDecimals);
        const gate = phoenixEntryGate(quotes, atr15Live, atr100Live, barrierOffset);
        if (!gate.allowed) {
          setPhase(gate.reason + " · " + symbol);
        } else {
          fireRoundRef.current(gate.impulseMove >= 0 ? "LONG" : "SHORT", symbol);
        }
      }
    };
    session.onTickAny = handler;

    const seedActiveMarkets = async (): Promise<void> => {
      const primary = activeSymbols[0];
      if (!primary) return;
      await discoverCapabilities(primary);
      if (cancelled) return;
      await startFeed(primary);
      if (activeSymbols.length < 2) return;
      await new Promise<void>((resolve) => {
        staggerTimer = window.setTimeout(resolve, 400);
      });
      if (cancelled) return;
      const secondary = activeSymbols[1];
      await discoverCapabilities(secondary);
      if (cancelled) return;
      await startFeed(secondary);
    };
    void seedActiveMarkets();

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

  const resolveBarrier = useCallback((symbol: string, contractType: "TURBOSLONG" | "TURBOSSHORT" | "ONETOUCH" | "NOTOUCH" | "VANILLA" | "VANILLALONGCALL" | "VANILLALONGPUT", side: "ko" | "touch" | "atm", spotValue = spot, atr15Value = atr15): string => {
    const row = capabilities[symbol];
    const choices = row?.barrierChoicesByType[
      contractType === "VANILLA" ? "VANILLALONGCALL" : contractType
    ] ?? row?.barriers ?? [];
    const decimals = decimalsFromLatestQuote(spotValue);
    const pipSize = pipSizeFromDecimals(decimals);

    if (side === "atm") {
      const atm = choices.find((choice) => Number(choice.replace(/[^0-9.-]/g, "")) === 0)
        ?? choices.find((choice) => choice === "+0.0" || choice === "0.0" || choice === "0")
        ?? "+0.0";
      return String(atm).trim();
    }

    const numericChoices = choices
      .map((choice) => ({ raw: choice, value: cleanBarrierOffset(choice, decimals) }))
      .filter((choice) => choice.value >= pipSize * 5)
      .sort((a, b) => a.value - b.value);

    if (side === "ko") {
      if (numericChoices.length > 0) return formatBarrierOffset(numericChoices[numericChoices.length - 1].raw, decimals, true);
      return formatBarrierOffset(pipSize * 20, decimals, true);
    }

    const koAbs = Math.abs(koOffset);
    const inside = numericChoices
      .filter((choice) => choice.value >= pipSize * 5 && (koAbs <= 0 || choice.value < koAbs))
      .sort((a, b) => a.value - b.value);

    if (inside.length > 0) {
      const desired = inside[Math.floor(inside.length / 2)]?.raw ?? inside[0].raw;
      const validated = validatedTouchOffsetRef.current[symbol];
      const desiredOffset = cleanBarrierOffset(desired, decimals);
      const maxInterior = koAbs > 0 ? koAbs * 0.75 : desiredOffset;
      const workingOffset = validated && validated > 0
        ? Math.min(maxInterior, Math.max(validated, pipSize * 20))
        : Math.min(maxInterior, desiredOffset);
      return formatBarrierOffset(workingOffset, decimals, true);
    }

    const validated = validatedTouchOffsetRef.current[symbol];
    const synthetic = syntheticTouchOffset(atr15Value, pipSize, decimals, validated);
    const koLimited = koAbs > 0 ? Math.min(synthetic, koAbs * 0.75) : synthetic;
    const safeOffset = Math.min(koAbs > 0 ? koAbs * 0.75 : Number.MAX_SAFE_INTEGER, Math.max(pipSize * 20, koLimited));
    return formatBarrierOffset(safeOffset, decimals, true);
  }, [atr15, capabilities, koOffset, spot]);

  useEffect(() => {
    resolveBarrierRef.current = resolveBarrier;
  }, [resolveBarrier]);

  const placeBundle = useCallback(async (symbol: string, gear: PhoenixGear, requests: PhoenixLegRequest[]): Promise<void> => {
    const session = sessionRef.current;
    if (!session) throw new Error("No Deriv session.");
    const payloadRequests = requests.map((request) => {
      const contractType = request.contractType;
      const basePayload: {
        symbol: string;
        contract: string;
        duration: number;
        durationUnit: "t" | "s" | "m";
        stake: number;
        currency: string;
        barrier?: string;
        barrier2?: never;
      } = {
        symbol,
        contract: contractType,
        duration: request.duration,
        durationUnit: request.durationUnit,
        stake: request.stake,
        currency: currencyRef.current,
      };

      delete (basePayload as { barrier2?: never }).barrier2;

      if (contractType === "CALL" || contractType === "PUT") {
        delete (basePayload as { barrier?: string }).barrier;
        return basePayload;
      }

      if (typeof request.barrier !== "string" || request.barrier.trim().length === 0) {
        throw new Error(contractType + ": pre-flight barrier is missing");
      }
      basePayload.barrier = request.barrier.trim();
      return basePayload;
    });

    let quotes;
    let minimumStakeRetried = false;
    const raiseDiscoveredMinimumStake = (error: unknown): boolean => {
      if (minimumStakeRetried || (gear !== 2 && gear !== 3)) return false;
      const message = error instanceof Error ? error.message : String(error);
      const match = message.match(/at least\s+\$?([0-9]+(?:\.[0-9]+)?)/i);
      if (!match) return false;
      const minimum = Number(match[1]);
      if (!Number.isFinite(minimum) || minimum <= 0) return false;
      const targetIndex = payloadRequests.findIndex((request) => gear === 2
        ? request.contract === "TURBOSLONG" || request.contract === "TURBOSSHORT"
        : request.contract === "VANILLALONGCALL" || request.contract === "VANILLALONGPUT");
      if (targetIndex < 0 || minimum <= payloadRequests[targetIndex].stake) return false;
      const contract = payloadRequests[targetIndex].contract;
      payloadRequests[targetIndex] = { ...payloadRequests[targetIndex], stake: minimum };
      requests[targetIndex].stake = minimum;
      minimumStakeRetried = true;
      if (gear === 2) {
        discoveredTurboMinStakeRef.current[symbol] = minimum;
        setMinimumStakeBySymbol((previous) => ({ ...previous, [symbol]: { turbo: minimum, vanilla: previous[symbol]?.vanilla ?? 1 } }));
      } else {
        discoveredVanillaMinStakeRef.current[symbol] = minimum;
        setMinimumStakeBySymbol((previous) => ({ ...previous, [symbol]: { turbo: previous[symbol]?.turbo ?? 1, vanilla: minimum } }));
      }
      setPhase("MIN STAKE: $" + minimum.toFixed(2) + " · retrying " + contract);
      return true;
    };
    const barrierContractIndex = payloadRequests.findIndex((request) => request.contract === "ONETOUCH" || request.contract === "NOTOUCH");

    if (barrierContractIndex >= 0) {
      let workingPayloads = payloadRequests;
      let escalation = 1;
      let barrierRetries = 0;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          quotes = await session.quoteBundle(workingPayloads);
          const workingRequest = workingPayloads[barrierContractIndex];
          if (typeof workingRequest?.barrier === "string") {
            const workingOffset = cleanBarrierOffset(workingRequest.barrier, decimalsFromLatestQuote(feedMetricsRef.current[symbol]?.spot ?? spot));
            if (workingOffset > 0) validatedTouchOffsetRef.current[symbol] = workingOffset;
          }
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const detail = error instanceof Error ? error.message : String(error);
          if (raiseDiscoveredMinimumStake(error)) {
            workingPayloads = payloadRequests;
            continue;
          }
          const distanceError = /away from the spot|pip|barrier.*distance|minimum.*barrier/i.test(detail);
          if (!distanceError || barrierRetries >= 3) break;

          barrierRetries += 1;
          escalation *= 2.5;
          const decimals = decimalsFromLatestQuote(feedMetricsRef.current[symbol]?.spot ?? spot);
          workingPayloads = workingPayloads.map((request) => {
            if (request.contract !== "ONETOUCH" && request.contract !== "NOTOUCH") return request;
            if (typeof request.barrier !== "string") return request;
            const currentOffset = cleanBarrierOffset(request.barrier, decimals);
            const nextOffset = Number((currentOffset * escalation).toFixed(decimals));
            return { ...request, barrier: formatBarrierOffset(nextOffset, decimals, request.barrier.trim().startsWith("+")) };
          });
        }
      }
      if (!quotes) {
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        const failedRequest = payloadRequests[barrierContractIndex];
        const failedBarrier = typeof failedRequest?.barrier === "string" ? failedRequest.barrier : "<none>";
        throw new Error(failedRequest.contract + " (" + failedBarrier + "): " + detail);
      }
    } else {
      try {
        quotes = await session.quoteBundle(payloadRequests);
      } catch (error) {
        if (raiseDiscoveredMinimumStake(error)) {
          try {
            quotes = await session.quoteBundle(payloadRequests);
          } catch (retryError) {
            const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
            const failedRequest = payloadRequests.find((request) => request.contract !== "CALL" && request.contract !== "PUT") ?? payloadRequests[0];
            throw new Error(failedRequest.contract + " (" + (failedRequest.barrier ?? "<none>") + "): " + retryDetail);
          }
        } else {
          const detail = error instanceof Error ? error.message : String(error);
          const failedRequest = payloadRequests.find((request) => request.contract !== "CALL" && request.contract !== "PUT") ?? payloadRequests[0];
          const failedBarrier = typeof failedRequest?.barrier === "string" ? failedRequest.barrier : "<none>";
          throw new Error(failedRequest.contract + " (" + failedBarrier + "): " + detail);
        }
      }
    }
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

  useEffect(() => {
    placeBundleRef.current = placeBundle;
  }, [placeBundle]);

  const fireRound = useCallback(async (direction: "LONG" | "SHORT" = "LONG", symbol = selectedRef.current): Promise<void> => {
    if (!connectedRef.current || execRef.current || coolingRef.current || roundRef.current || activePhoenixIdsRef.current.size > 0) return;
    const session = sessionRef.current;
    if (!session) { onConnect(); return; }
    const symbolMetrics = feedMetricsRef.current[symbol];
    const spotNow = symbolMetrics?.spot ?? spot;
    const atr15Now = symbolMetrics?.atr15 ?? atr15;
    const atr100Now = symbolMetrics?.atr100 ?? atr100;
    const touchOffsetNow = symbol === selectedRef.current ? touchOffsetRef.current : Math.max(atr15Now * 1.8, 0);
    const symbolDecision = routePhoenixGear(primaryGearRef.current, autoRouterRef.current, atr15Now, atr100Now, touchOffsetNow);
    const gear = symbolDecision.gear;
    gearRef.current = gear;
    const id = ++roundSeqRef.current;
    const current: PhoenixRound = {
      id,
      symbol,
      gear,
      direction: gear === 3 ? "LONG_SHORT" : direction,
      startSpot: spotNow,
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
        const requests = microPhoenixRequests(direction, spotNow, baseRef.current, touchOffsetNow);
        const exactTouchBarrier = resolveBarrier(symbol, "ONETOUCH", "touch", spotNow, atr15Now);
        const shield = requests[1];
        if (shield) shield.barrier = exactTouchBarrier;
        setPhase("Gear 1 · buying CALL/PUT impulse + opposite-side interior shield");
        await placeBundle(symbol, gear, requests);
      } else if (gear === 2) {
        const turboType = direction === "LONG" ? "TURBOSLONG" : "TURBOSSHORT";
        const koBarrier = resolveBarrier(symbol, turboType, "ko", spotNow, atr15Now);
        const decimals = decimalsFromLatestQuote(spotNow);
        const pipSize = pipSizeFromDecimals(decimals);
        const ko = cleanBarrierOffset(koBarrier, decimals);
        const discoveredTouchBarrier = resolveBarrier(symbol, "ONETOUCH", "touch", spotNow, atr15Now);
        const discoveredTouch = cleanBarrierOffset(discoveredTouchBarrier, decimals);
        const minimumInterior = Math.max(pipSize * 20, atr15Now * 1.8);
        const maxInterior = ko - pipSize;
        if (maxInterior < minimumInterior) throw new Error("No interior ONETOUCH barrier is safely inside the selected Turbo KO barrier.");
        const touch = Math.min(maxInterior, Math.max(minimumInterior, discoveredTouch));
        const touchBarrier = formatBarrierOffset(touch, decimals, true);
        const signedKo = ko * (koBarrier.trim().startsWith("-") ? -1 : 1);
        const signedTouch = touch * (touchBarrier.trim().startsWith("-") ? -1 : 1);
        koOffsetRef.current = signedKo;
        touchOffsetRef.current = signedTouch;
        setKoOffset(signedKo);
        setTouchOffset(signedTouch);
        const turboMinimum = Math.max(
          1,
          capabilities[symbol]?.minStakeByType[turboType] ?? 1,
          discoveredTurboMinStakeRef.current[symbol] ?? 1,
        );
        const effectiveTurboStake = Math.max(turboRef.current, turboMinimum);
        const turboDuration = parsePhoenixDuration(capabilities[symbol]?.minDurationByType[turboType], { duration: 1, durationUnit: "t" });
        const requests = turbinePhoenixRequests(direction, koBarrier, touchBarrier, effectiveTurboStake, PHOENIX_MIN_STAKE, turboDuration.duration, turboDuration.durationUnit);
        setPhase(dangerShieldRef.current ? "Gear 2 · Turbo-only T0; interior shield waits for danger pullback" : "Gear 2 · buying Turbo + interior ONETOUCH simultaneously");
        await placeBundle(symbol, gear, dangerShieldRef.current ? [requests[0]] : requests);
      } else if (gear === 3) {
        setPhase("Gear 3 · buying ATM Vanilla call + put simultaneously");
        const atmCallBarrier = resolveBarrier(symbol, "VANILLALONGCALL", "atm", spotNow, atr15Now);
        const atmPutBarrier = resolveBarrier(symbol, "VANILLALONGPUT", "atm", spotNow, atr15Now);
        const vanillaMinimum = Math.max(
          1,
          capabilities[symbol]?.minStakeByType.VANILLALONGCALL ?? 1,
          capabilities[symbol]?.minStakeByType.VANILLALONGPUT ?? 1,
          discoveredVanillaMinStakeRef.current[symbol] ?? 1,
        );
        const effectiveVanillaStake = Math.max(baseRef.current, vanillaMinimum);
        const callDuration = parsePhoenixDuration(capabilities[symbol]?.minDurationByType.VANILLALONGCALL);
        const putDuration = parsePhoenixDuration(capabilities[symbol]?.minDurationByType.VANILLALONGPUT);
        const requests = vanillaRequests(effectiveVanillaStake, atmCallBarrier).map((request, index) => {
          const duration = index === 0 ? callDuration : putDuration;
          return {
            ...request,
            barrier: index === 0 ? atmCallBarrier : atmPutBarrier,
            duration: duration.duration,
            durationUnit: duration.durationUnit,
          };
        });
        await placeBundle(symbol, gear, requests);
      } else {
        setPhase("Gear 4 · buying minimum-duration NOTOUCH range box");
        const noTouchBarrier = resolveBarrier(symbol, "NOTOUCH", "touch", spotNow, atr15Now);
        await placeBundle(symbol, gear, [rangeBoxRequest(baseRef.current, noTouchBarrier)]);
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
  }, [atr15, atr100, connectedRef, onConnect, onNotice, placeBundle, resolveBarrier, runDecision, spot, touchOffset]);

  useEffect(() => {
    fireRoundRef.current = (direction, symbol) => { void fireRound(direction, symbol); };
  }, [fireRound]);

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
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {[selectedSymbol, ...(secondarySymbol !== "NONE" && secondarySymbol !== selectedSymbol ? [secondarySymbol] : [])].map((symbol, index) => {
                  const metric = feedTelemetry[symbol];
                  const gate = metric
                    ? phoenixEntryGate(metric.quotes, metric.atr15, metric.atr100, Math.max(Math.abs(touchOffset), metric.atr15 * 1.8))
                    : null;
                  return (
                    <div key={symbol} className="flex items-center justify-between gap-2 rounded border border-line bg-ink/50 px-2 py-1.5">
                      <div>
                        <p className="text-[8px] uppercase tracking-widest text-muted">{index === 0 ? "Primary" : "Secondary"} · {symbol}</p>
                        <p className="mt-0.5 font-mono text-[9px] text-slate-300">{metric ? "ATR15 " + metric.atr15.toFixed(5) + " / ATR100 " + metric.atr100.toFixed(5) : "Warming feed…"}</p>
                      </div>
                      <span className={"rounded border px-1.5 py-0.5 text-[8px] font-semibold " + (gate?.allowed ? "border-emerald-400/40 text-emerald-300" : "border-amber-400/40 text-amber-200")}>
                        {gate?.allowed ? "IMPULSE READY" : gate?.reason ?? "WARMING"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <aside className="space-y-3">
            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">Gear control</h2>
                <span className="rounded border border-line px-2 py-0.5 text-[9px] uppercase tracking-widest text-muted">{runDecision.gear === 4 ? "Range box" : "Gear " + runDecision.gear}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Field label="Primary market">
                  <select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value)} disabled={executing || round !== null} className={inputClass}>
                    {PHOENIX_SYMBOLS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
                  </select>
                </Field>
                <Field label="Secondary radar">
                  <select value={secondarySymbol} onChange={(event) => setSecondarySymbol(event.target.value)} disabled={executing || round !== null} className={inputClass}>
                    <option value="NONE">NONE</option>
                    {PHOENIX_SYMBOLS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
                  </select>
                </Field>
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
                  <p className="inline-flex rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[9px] font-semibold text-amber-200">
                    MIN STAKE: ${(minimumStakeBySymbol[selectedSymbol]?.turbo ?? 1).toFixed(2)}
                  </p>
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
