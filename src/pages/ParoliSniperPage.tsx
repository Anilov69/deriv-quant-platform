import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { DerivError } from "@/deriv";
import type { Account, DerivSession, Quote, SymbolInfo, Tick } from "@/deriv";
import MultiSymbolRadarGrid from "@/components/MultiSymbolRadarGrid";
import type { BurstView, RadarCardView } from "@/components/MultiSymbolRadarGrid";
import SessionAdvisorModal from "@/components/SessionAdvisorModal";
import type { SessionAdvisorMode, SessionAdvisorState } from "@/components/SessionAdvisorModal";
import {
  OUTCOME_LABEL,
  PAROLI_COOLDOWN_MS,
  PAROLI_DEFAULT_REINVEST_PCT,
  PAROLI_DEFAULT_STAKE,
  PAROLI_DEFAULT_THRESHOLD,
  PAROLI_FALLBACK_MULTIPLE,
  PAROLI_MAX_THRESHOLD,
  PAROLI_MIN_STAKE,
  PAROLI_MIN_THRESHOLD,
  PAROLI_SL_MULTIPLE,
  PAROLI_TP_MULTIPLE,
  advanceDrought,
  buildParoliPlan,
  clamp,
  clampReinvestPct,
  clampStake,
  clampThreshold,
  decimalsFromPip,
  digitFromQuote,
  emptyDrought,
  findTrigger,
  manualTail,
  round2,
  seedDroughts,
  stepStakeFor,
  tailLabel,
  tailShort,
} from "@/utils/paroliMath";
import type { DroughtState, ParoliDirection, ParoliOutcome, ParoliTail, RadarDrought } from "@/utils/paroliMath";

const HZ_SYMBOLS = ["1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"] as const;
const JUMP_SYMBOLS = ["JD10", "JD25", "JD50", "JD75", "JD100"] as const;
const SETTLEMENT_TIMEOUT_MS = 45000;
const PREVIEW_REFRESH_MS = 15000;

type StepResult = "WIN" | "LOSS" | "ABORT" | "-";
type ConfirmIntent = { kind: "arm" } | { kind: "snipe"; symbol: string };

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

interface CardState extends DroughtState {
  quote: number | null;
  digit: number | null;
  decimals: number;
  ready: boolean;
  streaming: boolean;
  overAvailable: boolean;
  underAvailable: boolean;
  shared: boolean;
  error: string | null;
}

interface SeedBuffer {
  token: number;
  ticks: Array<{ epoch: number; quote: number; digit: number }>;
}

interface BurstLeg {
  step: number;
  stake: number;
  payout: number;
  contractId: number;
  watchId: string;
  profit: number;
  status: "open" | "won" | "lost";
}

interface ActiveBurst {
  id: number;
  symbol: string;
  tail: ParoliTail;
  triggerDrought: number;
  totalSteps: number;
  reinvestPct: number;
  baseStake: number;
  multiple: number;
  startedAt: number;
  step: number;
  stepStake: number;
  stepPayout: number;
  legs: BurstLeg[];
}

interface BurstRow {
  id: number;
  time: number;
  symbol: string;
  tail: ParoliTail;
  triggerDrought: number;
  stepResults: StepResult[];
  outcome: ParoliOutcome;
  maxRisk: number;
  profit: number;
}

interface Preview {
  multiple: number;
}

interface ContractPayload {
  contract_id?: unknown;
  is_sold?: unknown;
  profit?: unknown;
  status?: unknown;
}

interface SettlementWaiter {
  resolve: (payload: unknown) => void;
  timer: number;
}

const inputClass =
  "w-full rounded border border-line bg-ink px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent disabled:opacity-50";

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="text-[10px] text-muted">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-lg border border-line bg-panel p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-tight text-slate-100">{title}</h2>
          <button type="button" onClick={onClose} className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-slate-100">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function emptyCard(_symbol: string, _name: string, decimals: number): CardState {
  return { ...emptyDrought(), quote: null, digit: null, decimals, ready: false, streaming: false, overAvailable: true, underAvailable: true, shared: false, error: null };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadySubscribed(error: unknown): boolean {
  const code = error instanceof DerivError ? error.code : String((error as { code?: unknown } | null)?.code ?? "");
  return code.toLowerCase().includes("alreadysubscribed") || errorText(error).toLowerCase().includes("already subscribed");
}

function isSold(payload: ContractPayload): boolean {
  return Number(payload.is_sold) === 1 || payload.is_sold === true || String(payload.is_sold) === "1";
}

function asContract(raw: unknown): ContractPayload {
  return typeof raw === "object" && raw !== null ? (raw as ContractPayload) : {};
}

function phaseTone(phase: string): string {
  const text = phase.toLowerCase();
  if (text.includes("timeout") || text.includes("error") || text.includes("rejected") || text.includes("failed") || text.includes("locked")) return "border-danger/50 bg-danger/10 text-danger";
  if (text.includes("burst") || text.includes("jackpot")) return "border-emerald-400/50 bg-emerald-400/10 text-emerald-200";
  if (text.includes("cooldown") || text.includes("paused") || text.includes("cooling")) return "border-amber-400/50 bg-amber-400/10 text-amber-200";
  return "border-line bg-ink/60 text-muted";
}

function signedMoney(value: number, currency: string): string {
  return (value >= 0 ? "+$" : "-$") + Math.abs(value).toFixed(2) + " " + currency;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export default function ParoliSniperPage(props: Props): ReactElement {
  const { sessionRef, connected, symbols, accounts, accountId, accountKind, balance, currency, onConnect, onAccountChange, onNotice, bindContractListener } = props;

  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(HZ_SYMBOLS));
  const [jumpEnabled, setJumpEnabled] = useState(false);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [burst, setBurst] = useState<ActiveBurst | null>(null);
  const [armed, setArmed] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [phase, setPhase] = useState("Connect to Deriv to open the radar pool.");
  const [baseStake, setBaseStake] = useState(PAROLI_DEFAULT_STAKE);
  const [threshold, setThreshold] = useState(PAROLI_DEFAULT_THRESHOLD);
  const [steps, setSteps] = useState(2);
  const [reinvestPct, setReinvestPct] = useState(PAROLI_DEFAULT_REINVEST_PCT);
  const [direction, setDirection] = useState<ParoliDirection>("both");
  const [pnl, setPnl] = useState(0);
  const [bursts, setBursts] = useState<BurstRow[]>([]);
  const [step1Wins, setStep1Wins] = useState(0);
  const [step1Misses, setStep1Misses] = useState(0);
  const [peakStep, setPeakStep] = useState(0);
  const [stopLoss, setStopLoss] = useState(2.8);
  const [takeProfit, setTakeProfit] = useState(5.25);
  const [isSlManual, setIsSlManual] = useState(false);
  const [isTpManual, setIsTpManual] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [advisor, setAdvisor] = useState<SessionAdvisorState | null>(null);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [realOk, setRealOk] = useState(false);

  const aliveRef = useRef(true);
  const cardsRef = useRef<Record<string, CardState>>({});
  const enabledRef = useRef(enabled);
  const jumpRef = useRef(jumpEnabled);
  const symbolsRef = useRef<SymbolInfo[]>(symbols);
  const connectedRef = useRef(connected);
  const accountIdRef = useRef(accountId);
  const baseRef = useRef(baseStake);
  const stepsRef = useRef(steps);
  const reinvestRef = useRef(reinvestPct);
  const thresholdRef = useRef(threshold);
  const directionRef = useRef(direction);
  const multipleRef = useRef(PAROLI_FALLBACK_MULTIPLE);
  const slRef = useRef(stopLoss);
  const tpRef = useRef(takeProfit);
  const realOkRef = useRef(realOk);
  const currencyRef = useRef(currency);
  const armedRef = useRef(false);
  const execRef = useRef(false);
  const coolingRef = useRef(false);
  const pnlRef = useRef(0);
  const step1WinsRef = useRef(0);
  const step1MissesRef = useRef(0);
  const peakStepRef = useRef(0);
  const burstRef = useRef<ActiveBurst | null>(null);
  const activeIdsRef = useRef<Set<number>>(new Set<number>());
  const settlementWaitersRef = useRef<Map<number, SettlementWaiter>>(new Map<number, SettlementWaiter>());
  const radarSubsRef = useRef<Map<string, string>>(new Map<string, string>());
  const pendingSubsRef = useRef<Map<string, number>>(new Map<string, number>());
  const seedBuffersRef = useRef<Map<string, SeedBuffer>>(new Map<string, SeedBuffer>());
  const subscriptionSeqRef = useRef(0);
  const radarGenerationRef = useRef(0);
  const cooldownTimerRef = useRef<number | undefined>(undefined);
  const scanRef = useRef<() => void>(() => undefined);
  const burstSeqRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current);
      for (const waiter of settlementWaitersRef.current.values()) window.clearTimeout(waiter.timer);
      settlementWaitersRef.current.clear();
      seedBuffersRef.current.clear();
      const session = sessionRef.current;
      if (session && burstRef.current) {
        for (const leg of burstRef.current.legs) if (leg.watchId) void session.forget(leg.watchId);
      }
    };
  }, []);

  useEffect(() => {
    connectedRef.current = connected;
    accountIdRef.current = accountId;
    symbolsRef.current = symbols;
    enabledRef.current = enabled;
    jumpRef.current = jumpEnabled;
    baseRef.current = baseStake;
    stepsRef.current = steps;
    reinvestRef.current = reinvestPct;
    thresholdRef.current = threshold;
    directionRef.current = direction;
    slRef.current = stopLoss;
    tpRef.current = takeProfit;
    realOkRef.current = realOk;
    currencyRef.current = currency;
  }, [accountId, baseStake, connected, currency, direction, enabled, jumpEnabled, reinvestPct, realOk, steps, stopLoss, symbols, takeProfit, threshold]);

  const multiple = preview?.multiple ?? PAROLI_FALLBACK_MULTIPLE;
  useEffect(() => {
    multipleRef.current = multiple;
  }, [multiple]);

  const plan = useMemo(
    () => buildParoliPlan(baseStake, steps, reinvestPct, multiple),
    [baseStake, multiple, reinvestPct, steps],
  );

  const commitCards = useCallback((next: Record<string, CardState>) => {
    cardsRef.current = next;
    setCards(next);
  }, []);

  const updateCard = useCallback(
    (symbol: string, patch: Partial<CardState>) => {
      const current = cardsRef.current[symbol];
      if (!current) return;
      commitCards({ ...cardsRef.current, [symbol]: { ...current, ...patch } });
    },
    [commitCards],
  );

  const clearCooldown = useCallback(() => {
    coolingRef.current = false;
    setCooling(false);
    if (cooldownTimerRef.current !== undefined) {
      window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = undefined;
    }
  }, []);

  const showAdvisor = useCallback(
    (mode: SessionAdvisorMode, guardCost?: number) => {
      armedRef.current = false;
      setArmed(false);
      clearCooldown();
      setAdvisor({
        mode,
        pnl: round2(pnlRef.current),
        wins: step1WinsRef.current,
        losses: step1MissesRef.current,
        peakLevel: peakStepRef.current,
        stopLoss: Math.abs(slRef.current),
        takeProfit: tpRef.current,
        nextBundleCost: guardCost,
      });
      setPhase(
        mode === "TP_HIT"
          ? "Take profit hit - sniper stopped"
          : mode === "SL_PARTIAL_WINS"
            ? "Stop loss hit after earlier wins - sniper stopped"
            : "Zero-win stop loss - sniper stopped",
      );
    },
    [clearCooldown],
  );

  const beginCooldown = useCallback(
    (label: string) => {
      coolingRef.current = true;
      setCooling(true);
      setPhase(label + " - 1.5s cooldown");
      if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = window.setTimeout(() => {
        cooldownTimerRef.current = undefined;
        coolingRef.current = false;
        setCooling(false);
        if (armedRef.current) {
          setPhase("Scanning " + enabledRef.current.size + " enabled symbols...");
          scanRef.current();
        } else {
          setPhase("Burst complete - start the sniper when ready");
        }
      }, PAROLI_COOLDOWN_MS);
    },
    [],
  );

  const stopEngine = useCallback(
    (label: string) => {
      armedRef.current = false;
      setArmed(false);
      if (!execRef.current) clearCooldown();
      setPhase(label);
    },
    [clearCooldown],
  );

  const finalizeBurst = useCallback(
    (current: ActiveBurst, outcome: ParoliOutcome) => {
      const net = round2(current.legs.reduce((sum, leg) => sum + leg.profit, 0));
      const stepResults: StepResult[] = ["-", "-", "-"];
      for (const leg of current.legs) {
        stepResults[leg.step - 1] = leg.status === "won" ? "WIN" : leg.status === "lost" ? "LOSS" : "ABORT";
      }
      if (outcome === "ROLL_ABORTED" && stepResults[current.step - 1] === "-") stepResults[current.step - 1] = "ABORT";
      const first = current.legs[0];
      if (first?.status === "won") {
        step1WinsRef.current += 1;
        setStep1Wins(step1WinsRef.current);
      } else if (first?.status === "lost") {
        step1MissesRef.current += 1;
        setStep1Misses(step1MissesRef.current);
      }
      peakStepRef.current = Math.max(peakStepRef.current, Math.max(current.step, current.legs.length));
      setPeakStep(peakStepRef.current);
      pnlRef.current = round2(pnlRef.current + net);
      setPnl(pnlRef.current);
      const row: BurstRow = {
        id: current.id,
        time: Date.now(),
        symbol: current.symbol,
        tail: current.tail,
        triggerDrought: current.triggerDrought,
        stepResults,
        outcome,
        maxRisk: current.baseStake,
        profit: net,
      };
      setBursts((previous) => [row, ...previous].slice(0, 300));
      burstRef.current = null;
      setBurst(null);
      execRef.current = false;
      setExecuting(false);
      if (pnlRef.current >= tpRef.current) {
        showAdvisor("TP_HIT");
        return;
      }
      if (pnlRef.current <= -Math.abs(slRef.current)) {
        showAdvisor(step1WinsRef.current > 0 ? "SL_PARTIAL_WINS" : "SL_ZERO_WINS");
        return;
      }
      beginCooldown(OUTCOME_LABEL[outcome]);
    },
    [beginCooldown, showAdvisor],
  );

  const cancelWait = useCallback((contractId: number) => {
    const waiter = settlementWaitersRef.current.get(contractId);
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    settlementWaitersRef.current.delete(contractId);
  }, []);

  const waitForSettlement = useCallback((contractId: number): Promise<unknown> => {
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        settlementWaitersRef.current.delete(contractId);
        reject(new Error("SettlementTimeout"));
      }, SETTLEMENT_TIMEOUT_MS);
      settlementWaitersRef.current.set(contractId, {
        timer,
        resolve: (payload: unknown) => {
          window.clearTimeout(timer);
          settlementWaitersRef.current.delete(contractId);
          resolve(payload);
        },
      });
    });
  }, []);

  const handleContract = useCallback(
    (raw: unknown) => {
      const data = asContract(raw);
      const id = Number(data.contract_id ?? 0);
      if (!Number.isFinite(id) || id <= 0 || !activeIdsRef.current.has(id)) return;
      const current = burstRef.current;
      if (!current) return;
      const index = current.legs.findIndex((leg) => leg.contractId === id);
      if (index < 0) return;
      if (isSold(data)) {
        const waiter = settlementWaitersRef.current.get(id);
        if (waiter) waiter.resolve(data);
        return;
      }
      const rawProfit = Number(data.profit);
      if (Number.isFinite(rawProfit)) {
        const legs = current.legs.map((leg) => (leg.contractId === id ? { ...leg, profit: round2(rawProfit) } : leg));
        const next = { ...current, legs };
        burstRef.current = next;
        setBurst(next);
      }
      setPhase("BURST LOCKED ON " + current.symbol + " · STEP " + current.step + " OF " + current.totalSteps + " - live");
    },
    [],
  );

  const releaseAborted = useCallback(
    (message: string) => {
      burstRef.current = null;
      setBurst(null);
      execRef.current = false;
      setExecuting(false);
      onNotice(message, "bad");
      beginCooldown("Burst aborted");
    },
    [beginCooldown, onNotice],
  );

  const executeBurst = useCallback(
    async (initial: ActiveBurst): Promise<void> => {
      const session = sessionRef.current;
      if (!session) return;
      let current = initial;
      let step = 1;
      let buyInFlight = false;
      try {
        while (step <= current.totalSteps) {
          if (!aliveRef.current) return;
          const stake = step === 1 ? current.baseStake : stepStakeFor(current.stepPayout, current.reinvestPct);
          const contract = current.tail === "over" ? "DIGITOVER" : "DIGITUNDER";
          const barrier = current.tail === "over" ? "6" : "3";
          current = { ...current, step, stepStake: stake, stepPayout: 0 };
          burstRef.current = current;
          setBurst(current);
          peakStepRef.current = Math.max(peakStepRef.current, step);
          setPeakStep(peakStepRef.current);
          setPhase("BURST LOCKED ON " + current.symbol + " · STEP " + step + " OF " + current.totalSteps + " - requesting quote");

          const quote = await session.quote({
            symbol: current.symbol,
            contract,
            barrier,
            duration: 1,
            stake,
            currency: currencyRef.current,
          });
          if (!aliveRef.current) return;
          current = { ...current, stepPayout: round2(quote.payout) };
          burstRef.current = current;
          setBurst(current);
          setPhase("BURST LOCKED ON " + current.symbol + " · STEP " + step + " OF " + current.totalSteps + " - buying");

          buyInFlight = true;
          const contractId = await session.buy(quote.id, quote.ask);
          buyInFlight = false;
          if (!aliveRef.current) return;
          activeIdsRef.current.add(contractId);
          const leg: BurstLeg = {
            step,
            stake,
            payout: round2(quote.payout),
            contractId,
            watchId: "",
            profit: 0,
            status: "open",
          };
          current = { ...current, legs: [...current.legs, leg] };
          burstRef.current = current;
          setBurst(current);

          // Register first so a settlement in the watch reply cannot be missed.
          const settlement = waitForSettlement(contractId);
          let watchId = "";
          try {
            watchId = await session.watch(contractId);
          } catch (error) {
            cancelWait(contractId);
            throw error;
          }
          if (watchId) {
            current = { ...current, legs: current.legs.map((item) => (item.contractId === contractId ? { ...item, watchId } : item)) };
            burstRef.current = current;
            setBurst(current);
          }
          const payload = await settlement;
          if (!aliveRef.current) return;
          const data = asContract(payload);
          const rawProfit = Number(data.profit);
          const statusText = String(data.status ?? "").toLowerCase();
          const won = (Number.isFinite(rawProfit) && rawProfit > 0) || statusText === "won";
          const profit = Number.isFinite(rawProfit) && rawProfit !== 0 ? round2(rawProfit) : won ? round2(quote.payout - stake) : -stake;
          activeIdsRef.current.delete(contractId);
          if (watchId) void session.forget(watchId);
          current = {
            ...current,
            legs: current.legs.map((item) => (item.contractId === contractId ? { ...item, profit: round2(profit), status: won ? "won" : "lost" } : item)),
          };
          burstRef.current = current;
          setBurst(current);
          if (!won) {
            const outcome: ParoliOutcome = step === 1 ? "STEP_1_MISS" : step === 2 ? "STEP_2_BREAK" : "STEP_3_BREAK";
            finalizeBurst(current, outcome);
            return;
          }
          if (step === current.totalSteps) {
            finalizeBurst(current, "PAROLI_JACKPOT");
            return;
          }
          step += 1;
        }
      } catch (error) {
        if (!aliveRef.current) return;
        const errorCode = error instanceof DerivError ? error.code : "";
        if (buyInFlight && (!(error instanceof DerivError) || errorCode === "Timeout" || errorCode === "Socket")) {
          armedRef.current = false;
          setArmed(false);
          setPhase("Buy acknowledgement missing - radar locked; verify the contract in Deriv before reloading");
          onNotice("The buy request did not return a contract id (" + errorText(error) + "). The radar lock is held; verify the contract in Deriv and reload after it settles.", "bad");
          return;
        }
        if (activeIdsRef.current.size > 0) {
          armedRef.current = false;
          setArmed(false);
          setPhase("Settlement lock held - verify the open contract in Deriv");
          onNotice(
            "A contract was bought but did not settle cleanly (" + errorText(error) + "). The radar lock is held; verify the open contract in Deriv and reload the page after it settles.",
            "bad",
          );
          return;
        }
        if (current.legs.some((leg) => leg.status === "won")) {
          onNotice("The next roll could not be placed: " + errorText(error) + ". The completed step was preserved.", "bad");
          finalizeBurst(current, "ROLL_ABORTED");
        } else {
          releaseAborted("Burst was not placed: " + errorText(error));
        }
      }
    },
    [cancelWait, finalizeBurst, onNotice, releaseAborted, sessionRef, waitForSettlement],
  );

  const fireBurst = useCallback(
    (mode: "auto" | "manual", symbol: string, tail: ParoliTail, triggerDrought: number) => {
      const session = sessionRef.current;
      if (!session || !connectedRef.current) { onConnect(); return; }
      if (!aliveRef.current || execRef.current || coolingRef.current || burstRef.current || activeIdsRef.current.size > 0) return;
      if (mode === "auto" && !armedRef.current) return;
      const card = cardsRef.current[symbol];
      if (!card || !card.ready || !card.streaming) return;
      if (tail === "over" && !card.overAvailable) return;
      if (tail === "under" && !card.underAvailable) return;
      const base = baseRef.current;
      if (pnlRef.current >= tpRef.current) {
        showAdvisor("TP_HIT");
        return;
      }
      const stop = Math.abs(slRef.current);
      if (pnlRef.current - base < -stop - 0.01) {
        showAdvisor(step1WinsRef.current > 0 ? "SL_PARTIAL_WINS" : "SL_ZERO_WINS", base);
        return;
      }
      const current: ActiveBurst = {
        id: ++burstSeqRef.current,
        symbol,
        tail,
        triggerDrought,
        totalSteps: stepsRef.current,
        reinvestPct: reinvestRef.current,
        baseStake: base,
        multiple: multipleRef.current,
        startedAt: Date.now(),
        step: 1,
        stepStake: base,
        stepPayout: 0,
        legs: [],
      };
      burstRef.current = current;
      execRef.current = true;
      setBurst(current);
      setExecuting(true);
      setPhase("BURST LOCKED ON " + symbol + " · STEP 1 OF " + current.totalSteps + " (" + tailShort(tail) + ")");
      void executeBurst(current);
    },
    [executeBurst, onConnect, sessionRef, showAdvisor],
  );

  const scanForTrigger = useCallback(() => {
    if (!armedRef.current || !aliveRef.current || !connectedRef.current || execRef.current || coolingRef.current || burstRef.current || activeIdsRef.current.size > 0) return;
    const candidates: RadarDrought[] = [];
    let order = 0;
    for (const symbol of enabledRef.current) {
      const card = cardsRef.current[symbol];
      if (!card || !card.ready || !card.streaming) continue;
      candidates.push({
        symbol,
        high: card.high,
        low: card.low,
        enabled: true,
        ready: true,
        overAvailable: card.overAvailable,
        underAvailable: card.underAvailable,
        order: order++,
      });
    }
    const trigger = findTrigger(candidates, thresholdRef.current, directionRef.current);
    if (!trigger) return;
    fireBurst("auto", trigger.symbol, trigger.tail, trigger.drought);
  }, [fireBurst]);

  useEffect(() => {
    scanRef.current = scanForTrigger;
  }, [scanForTrigger]);

  const handleTick = useCallback(
    (symbol: string, tick: Tick) => {
      if (!enabledRef.current.has(symbol) || !Number.isFinite(tick.quote) || tick.quote <= 0) return;
      const info = symbolsRef.current.find((item) => item.symbol === symbol);
      const existing = cardsRef.current[symbol];
      const decimals = info ? decimalsFromPip(info.pip) : existing?.decimals ?? 2;
      const digit = digitFromQuote(tick.quote, decimals);
      if (digit === null) return;
      const seeding = seedBuffersRef.current.get(symbol);
      if (seeding) {
        if (seeding.ticks.length < 120) seeding.ticks.push({ epoch: tick.epoch, quote: tick.quote, digit });
        return;
      }
      const current = existing ?? emptyCard(symbol, info?.name ?? symbol, decimals);
      const advanced = advanceDrought(current, digit);
      const next: CardState = { ...current, ...advanced, quote: tick.quote, digit, decimals, ready: true, streaming: true, error: null };
      commitCards({ ...cardsRef.current, [symbol]: next });
      scanRef.current();
    },
    [commitCards],
  );

  const loadSupport = useCallback(
    async (symbol: string, generation: number): Promise<void> => {
      const session = sessionRef.current;
      if (!session) return;
      try {
        const offers = await session.contractsFor(symbol);
        if (!aliveRef.current || generation !== radarGenerationRef.current || !enabledRef.current.has(symbol)) return;
        const types = new Set(offers.map((offer) => offer.contractType.toUpperCase()));
        updateCard(symbol, { overAvailable: types.has("DIGITOVER"), underAvailable: types.has("DIGITUNDER"), error: null });
      } catch (error) {
        if (aliveRef.current && generation === radarGenerationRef.current) {
          updateCard(symbol, { error: "tail check failed: " + errorText(error) });
        }
      }
    },
    [sessionRef, updateCard],
  );

  const stopSymbol = useCallback(
    (symbol: string) => {
      const id = radarSubsRef.current.get(symbol);
      radarSubsRef.current.delete(symbol);
      // Leave pendingSubs in place: an in-flight starter checks enabled again
      // before it subscribes, so a quick off/on toggle reuses that attempt.
      if (id) void sessionRef.current?.forget(id);
    },
    [sessionRef],
  );

  const startSymbol = useCallback(
    async (symbol: string): Promise<void> => {
      const session = sessionRef.current;
      if (!session || !connectedRef.current || !enabledRef.current.has(symbol)) return;
      if (radarSubsRef.current.has(symbol) || pendingSubsRef.current.has(symbol)) return;
      const generation = radarGenerationRef.current;
      const token = ++subscriptionSeqRef.current;
      pendingSubsRef.current.set(symbol, token);
      updateCard(symbol, { streaming: false, error: null });
      try {
        seedBuffersRef.current.set(symbol, { token, ticks: [] });
        let historyTicks: Tick[] = [];
        let seedError = "";
        try {
          const history = await session.history(symbol, 50, "ticks");
          historyTicks = history.filter((tick) => Number.isFinite(tick.quote) && tick.quote > 0).slice(-50);
        } catch (error) {
          seedError = errorText(error);
        }
        const buffered = seedBuffersRef.current.get(symbol);
        const bufferedTicks = buffered?.token === token ? buffered.ticks : [];
        if (buffered?.token === token) seedBuffersRef.current.delete(symbol);
        if (!aliveRef.current || generation !== radarGenerationRef.current || !enabledRef.current.has(symbol)) return;
        const info = symbolsRef.current.find((item) => item.symbol === symbol);
        const decimals = decimalsFromPip(info?.pip ?? 0.01);
        const live = cardsRef.current[symbol] ?? emptyCard(symbol, info?.name ?? symbol, decimals);
        let next: CardState;
        if (seedError) {
          next = { ...live, error: seedError || live.error };
          for (const tick of bufferedTicks) {
            next = { ...next, ...advanceDrought(next, tick.digit), quote: tick.quote, digit: tick.digit, decimals, ready: true };
          }
        } else {
          const quotes = historyTicks.map((tick) => tick.quote);
          const seed = seedDroughts(quotes, decimals);
          const lastQuote = historyTicks.length > 0 ? historyTicks[historyTicks.length - 1].quote : null;
          next = {
            ...live,
            ...seed,
            quote: lastQuote,
            digit: lastQuote === null ? null : digitFromQuote(lastQuote, decimals),
            decimals,
            ready: quotes.length > 0,
            streaming: false,
            error: null,
          };
          const lastEpoch = historyTicks.length > 0 ? historyTicks[historyTicks.length - 1].epoch : 0;
          for (const tick of bufferedTicks) {
            if (lastEpoch > 0 && tick.epoch > 0 && tick.epoch <= lastEpoch) continue;
            next = { ...next, ...advanceDrought(next, tick.digit), quote: tick.quote, digit: tick.digit, decimals, ready: true };
          }
        }
        commitCards({ ...cardsRef.current, [symbol]: next });
        scanRef.current();
        void loadSupport(symbol, generation);
        let subscriptionId = "";
        try {
          subscriptionId = await session.subscribeTicksFor(symbol);
        } catch (error) {
          if (isAlreadySubscribed(error)) {
            if (!aliveRef.current || generation !== radarGenerationRef.current || !enabledRef.current.has(symbol)) return;
            updateCard(symbol, { shared: true, streaming: true, ready: true, error: null });
            return;
          }
          throw error;
        }
        if (!aliveRef.current || generation !== radarGenerationRef.current || !enabledRef.current.has(symbol)) {
          if (subscriptionId) void session.forget(subscriptionId);
          return;
        }
        if (!subscriptionId) {
          updateCard(symbol, { error: "Deriv did not return a tick subscription id" });
          return;
        }
        radarSubsRef.current.set(symbol, subscriptionId);
        updateCard(symbol, { shared: false, streaming: true, error: null });
      } catch (error) {
        if (aliveRef.current && generation === radarGenerationRef.current && enabledRef.current.has(symbol)) {
          updateCard(symbol, { error: errorText(error), streaming: false });
          onNotice("Radar stream failed for " + symbol + ": " + errorText(error), "bad");
        }
      } finally {
        if (pendingSubsRef.current.get(symbol) === token) pendingSubsRef.current.delete(symbol);
        if (seedBuffersRef.current.get(symbol)?.token === token) seedBuffersRef.current.delete(symbol);
      }
    },
    [commitCards, loadSupport, onNotice, sessionRef, updateCard],
  );

  const toggleSymbol = useCallback(
    (symbol: string) => {
      if (execRef.current || burstRef.current) {
        onNotice("Wait for the active burst to settle before changing the radar pool.", "bad");
        return;
      }
      const next = new Set(enabledRef.current);
      const removing = next.has(symbol);
      if (removing) next.delete(symbol);
      else next.add(symbol);
      enabledRef.current = next;
      setEnabled(next);
      if (removing) stopSymbol(symbol);
      else void startSymbol(symbol);
    },
    [onNotice, startSymbol, stopSymbol],
  );

  const toggleJump = useCallback(
    () => {
      if (execRef.current || burstRef.current) {
        onNotice("Wait for the active burst to settle before changing the radar pool.", "bad");
        return;
      }
      const next = !jumpRef.current;
      const nextEnabled = new Set(enabledRef.current);
      for (const symbol of JUMP_SYMBOLS) {
        if (next) nextEnabled.add(symbol);
        else nextEnabled.delete(symbol);
      }
      jumpRef.current = next;
      setJumpEnabled(next);
      enabledRef.current = nextEnabled;
      setEnabled(nextEnabled);
      for (const symbol of JUMP_SYMBOLS) {
        if (next) void startSymbol(symbol);
        else stopSymbol(symbol);
      }
    },
    [onNotice, startSymbol, stopSymbol],
  );

  const armEngine = useCallback(
    () => {
      if (!connectedRef.current) { onConnect(); return; }
      if (execRef.current || burstRef.current || activeIdsRef.current.size > 0) return;
      clearCooldown();
      armedRef.current = true;
      setArmed(true);
      setPhase("Scanning " + enabledRef.current.size + " enabled symbols at " + thresholdRef.current + " ticks...");
      scanRef.current();
    },
    [clearCooldown, onConnect],
  );

  const requestArm = useCallback(
    () => {
      if (!connectedRef.current) { onConnect(); return; }
      if (armedRef.current) { stopEngine("Sniper paused - radar still scanning visually"); return; }
      if (execRef.current || burstRef.current) return;
      if (accountKind !== "demo" && !realOkRef.current) {
        setConfirmChecked(false);
        setConfirmIntent({ kind: "arm" });
        return;
      }
      armEngine();
    },
    [accountKind, armEngine, onConnect, stopEngine],
  );

  const snipeNow = useCallback(
    (symbol: string) => {
      const card = cardsRef.current[symbol];
      if (!card || !card.ready || !card.streaming) { onNotice("That radar is still warming up.", "bad"); return; }
      let tail = manualTail(directionRef.current, card.high, card.low);
      if (directionRef.current === "both") {
        if (tail === "over" && !card.overAvailable) tail = "under";
        if (tail === "under" && !card.underAvailable) tail = "over";
      }
      if ((tail === "over" && !card.overAvailable) || (tail === "under" && !card.underAvailable)) {
        onNotice("Deriv does not offer the selected digit tail on " + symbol + ".", "bad");
        return;
      }
      fireBurst("manual", symbol, tail, tail === "over" ? card.high : card.low);
    },
    [fireBurst, onNotice],
  );

  const requestSnipe = useCallback(
    (symbol: string) => {
      if (!connectedRef.current) { onConnect(); return; }
      if (execRef.current || burstRef.current || coolingRef.current) return;
      if (accountKind !== "demo" && !realOkRef.current) {
        setConfirmChecked(false);
        setConfirmIntent({ kind: "snipe", symbol });
        return;
      }
      snipeNow(symbol);
    },
    [accountKind, onConnect, snipeNow],
  );

  const confirmReal = useCallback(
    () => {
      if (!confirmIntent || !confirmChecked) return;
      realOkRef.current = true;
      setRealOk(true);
      const intent = confirmIntent;
      setConfirmIntent(null);
      setConfirmChecked(false);
      if (intent.kind === "arm") armEngine();
      else snipeNow(intent.symbol);
    },
    [armEngine, confirmChecked, confirmIntent, snipeNow],
  );

  const resetSession = useCallback(
    () => {
      if (execRef.current || burstRef.current || activeIdsRef.current.size > 0) return;
      stopEngine("Session reset - start when ready");
      pnlRef.current = 0;
      step1WinsRef.current = 0;
      step1MissesRef.current = 0;
      peakStepRef.current = 0;
      setPnl(0);
      setStep1Wins(0);
      setStep1Misses(0);
      setPeakStep(0);
      setBursts([]);
      setAdvisor(null);
    },
    [stopEngine],
  );

  const enabledKey = useMemo(() => Array.from(enabled).sort().join("|"), [enabled]);
  const visibleSymbols = useMemo<string[]>(() => (jumpEnabled ? [...HZ_SYMBOLS, ...JUMP_SYMBOLS] : [...HZ_SYMBOLS]), [jumpEnabled]);

  const cardsView: RadarCardView[] = useMemo(
    () =>
      visibleSymbols.map((symbol) => {
        const info = symbols.find((item) => item.symbol === symbol);
        const state = cards[symbol];
        const decimals = state?.decimals ?? decimalsFromPip(info?.pip ?? 0.01);
        return {
          symbol,
          name: info?.name ?? symbol,
          enabled: enabled.has(symbol),
          quote: state?.quote ?? null,
          digit: state?.digit ?? null,
          decimals,
          high: state?.high ?? 0,
          low: state?.low ?? 0,
          ready: Boolean(state?.ready && state.streaming),
          overAvailable: state?.overAvailable ?? true,
          underAvailable: state?.underAvailable ?? true,
          shared: state?.shared ?? false,
          error: state?.error ?? null,
        };
      }),
    [cards, enabled, symbols, visibleSymbols],
  );

  const burstView: BurstView | null = useMemo(() => {
    if (!burst) return null;
    const stepStates: Array<"won" | "lost" | "active" | "pending"> = Array.from({ length: burst.totalSteps }, (_, index) => {
      const leg = burst.legs.find((item) => item.step === index + 1);
      if (leg) return leg.status === "won" ? "won" : leg.status === "lost" ? "lost" : "active";
      return index + 1 === burst.step ? "active" : "pending";
    });
    return {
      symbol: burst.symbol,
      tail: burst.tail,
      step: burst.step,
      totalSteps: burst.totalSteps,
      stepStake: burst.stepStake,
      stepPayout: burst.stepPayout,
      stepStates,
    };
  }, [burst]);

  const busy = executing || burst !== null;
  const snipeDisabled = !connected || busy || cooling;
  const activeRadarCount = cardsView.filter((card) => card.enabled && card.ready).length;
  const sourceLabel = preview ? "live proposal" : "fallback multiple";

  useEffect(() => {
    document.title = "Multi-Symbol Paroli Sniper | Deriv Quant Platform";
    return () => {
      document.title = "Deriv Quant Platform";
    };
  }, []);

  useEffect(() => {
    bindContractListener(handleContract);
    return () => bindContractListener(null);
  }, [bindContractListener, handleContract]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!connected || !session) return;
    aliveRef.current = true;
    const handler = (symbol: string, tick: Tick): void => {
      handleTick(symbol, tick);
    };
    session.onTickAny = handler;
    radarGenerationRef.current += 1;
    for (const symbol of enabledRef.current) void startSymbol(symbol);
    return () => {
      if (session.onTickAny === handler) session.onTickAny = null;
      radarGenerationRef.current += 1;
      for (const [symbol, id] of Array.from(radarSubsRef.current.entries())) {
        radarSubsRef.current.delete(symbol);
        void session.forget(id);
      }
      pendingSubsRef.current.clear();
      seedBuffersRef.current.clear();
    };
  }, [accountId, connected, handleTick, sessionRef, startSymbol]);

  const previousAccountRef = useRef(accountId);
  useEffect(() => {
    if (previousAccountRef.current === accountId) return;
    previousAccountRef.current = accountId;
    realOkRef.current = false;
    setRealOk(false);
    setConfirmIntent(null);
    setConfirmChecked(false);
    if (armedRef.current) stopEngine("Sniper paused after account change");
  }, [accountId, stopEngine]);

  useEffect(() => {
    if (connected) return;
    setConfirmIntent(null);
    setConfirmChecked(false);
    if (burstRef.current || activeIdsRef.current.size > 0) {
      setPhase("Connection lost during burst - settlement lock held");
      return;
    }
    if (armedRef.current) {
      armedRef.current = false;
      setArmed(false);
      setPhase("Disconnected - reconnect and start the sniper when ready");
    }
  }, [connected]);

  useEffect(() => {
    if (isSlManual) return;
    const next = plan.autoStopLoss;
    slRef.current = next;
    setStopLoss(next);
  }, [isSlManual, plan.autoStopLoss]);

  useEffect(() => {
    if (isTpManual) return;
    const next = plan.autoTakeProfit;
    tpRef.current = next;
    setTakeProfit(next);
  }, [isTpManual, plan.autoTakeProfit]);

  useEffect(() => {
    if (!connected) return;
    const session = sessionRef.current;
    if (!session) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      if (execRef.current || burstRef.current || activeIdsRef.current.size > 0) return;
      const symbol = Array.from(enabledRef.current).find((candidate) => {
        const card = cardsRef.current[candidate];
        if (!card || !card.ready || !card.streaming) return false;
        if (direction === "over") return card.overAvailable;
        if (direction === "under") return card.underAvailable;
        return card.overAvailable || card.underAvailable;
      });
      if (!symbol) { setPreview(null); return; }
      const previewCard = cardsRef.current[symbol];
      const tail: ParoliTail = direction === "under" ? "under" : direction === "over" ? "over" : previewCard?.overAvailable ? "over" : "under";
      try {
        const quote = await session.quote({
          symbol,
          contract: tail === "over" ? "DIGITOVER" : "DIGITUNDER",
          barrier: tail === "over" ? "6" : "3",
          duration: 1,
          stake: baseStake,
          currency,
        });
        if (cancelled) return;
        const next = round2(clamp(quote.payout / Math.max(PAROLI_MIN_STAKE, baseStake), 1.01, 10));
        if (Number.isFinite(next) && next > 1) setPreview({ multiple: next });
      } catch {
        // Keep the previous multiple; proposals are advisory only.
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, PREVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accountId, baseStake, connected, currency, direction, enabledKey, sessionRef]);

  useEffect(() => {
    if (!burst) return;
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [burst]);

  const downloadCsv = useCallback(() => {
    const header = [
      "Timestamp",
      "Symbol",
      "Tail",
      "Trigger Drought",
      "Step 1 Result",
      "Step 2 Result",
      "Step 3 Result",
      "Outcome",
      "Max Risk",
      "Net Burst P&L",
    ];
    const rows = bursts.map((row) => [
      new Date(row.time).toISOString(),
      row.symbol,
      tailShort(row.tail),
      row.triggerDrought,
      row.stepResults[0] ?? "-",
      row.stepResults[1] ?? "-",
      row.stepResults[2] ?? "-",
      OUTCOME_LABEL[row.outcome],
      row.maxRisk.toFixed(2),
      row.profit.toFixed(2),
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "paroli-sniper-bursts.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [bursts]);

  return (
    <div className="min-h-full p-3 sm:p-4">
      <div className="mx-auto max-w-[1500px] space-y-3">
        <header className="rounded-lg border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-emerald-300">Page 4 · Multi-symbol</span>
                <span className="rounded-full border border-line px-2 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-muted">1-tick digit tails</span>
                <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-sky-300">House-money roll</span>
              </div>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-slate-100 sm:text-2xl">Multi-Symbol Paroli Sniper</h1>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
                Five 1HZ feeds run side by side. When a tail drought crosses your threshold, the sniper fires one base-stake
                DIGITOVER 6 or DIGITUNDER 3 contract and rolls the house-money payout forward only after the prior
                contract confirms <span className="font-mono text-slate-300">is_sold = 1</span>.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={"rounded-full border px-2.5 py-1 text-[10px] font-semibold " + (connected ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "border-line bg-ink/60 text-muted")}>
                <span className={"mr-1.5 inline-block h-1.5 w-1.5 rounded-full " + (connected ? "animate-pulse bg-emerald-400" : "bg-muted")} />
                {connected ? "WebSocket live" : "Disconnected"}
              </span>
              {!connected ? (
                <button type="button" onClick={onConnect} className="rounded border border-accent bg-accent px-3 py-1.5 text-xs font-semibold text-ink hover:bg-accent/90">
                  Connect
                </button>
              ) : null}
              <label className="flex items-center gap-1.5 text-[10px] text-muted">
                Account
                <select
                  value={accountId}
                  onChange={(event) => onAccountChange(event.target.value)}
                  disabled={busy || accounts.length === 0}
                  className="rounded border border-line bg-ink px-2 py-1 font-mono text-[10px] text-slate-200 outline-none focus:border-accent disabled:opacity-50"
                >
                  {accounts.length === 0 ? <option value="">No accounts</option> : null}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} · {account.kind.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <span className={"rounded border px-2 py-1 font-mono text-[10px] " + (accountKind === "real" ? "border-danger/40 bg-danger/10 text-danger" : "border-line bg-ink/60 text-muted")}>
                {accountKind === "real" ? "REAL MONEY" : accountKind === "demo" ? "DEMO" : "ACCOUNT"}
              </span>
              <span className="rounded border border-line bg-ink/60 px-2 py-1 font-mono text-[10px] text-slate-200">
                {balance === null ? "-" : "$" + balance.toFixed(2)} {currency}
              </span>
            </div>
          </div>

          <div className={"mt-3 flex flex-wrap items-start justify-between gap-2 rounded border px-3 py-2 " + phaseTone(phase)}>
            <div className="flex min-w-0 items-start gap-2">
              <span className={"mt-1 h-2 w-2 shrink-0 rounded-full " + (armed ? "animate-pulse bg-emerald-400" : executing ? "animate-pulse bg-amber-400" : "bg-muted")} />
              <div className="min-w-0">
                <p className="text-[9px] font-bold uppercase tracking-widest">Engine phase</p>
                <p className="mt-0.5 break-words font-mono text-[11px]">{phase}</p>
              </div>
            </div>
            <span className="rounded-full border border-current/30 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest">
              {executing ? "LOCKED" : armed ? "ARMED · SCANNING" : "IDLE"}
            </span>
          </div>
        </header>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_350px]">
          <div className="space-y-3">
            <MultiSymbolRadarGrid
              cards={cardsView}
              threshold={threshold}
              burst={burstView}
              busy={busy}
              snipeDisabled={snipeDisabled}
              onToggle={toggleSymbol}
              onSnipe={requestSnipe}
            />

            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Payout ladder · house-money roll</h2>
                  <p className="text-[10px] text-muted">
                    One burst funds every step. The only cash at risk is the base stake; later steps use the prior payout.
                  </p>
                </div>
                <span className="rounded-full border border-line bg-ink/60 px-2 py-0.5 font-mono text-[10px] text-slate-200">
                  {multiple.toFixed(2)}x · {sourceLabel}
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {plan.steps.map((step) => (
                  <div key={step.step} className={"rounded border p-2.5 " + (step.step === 1 ? "border-sky-400/40 bg-sky-400/5" : "border-emerald-400/30 bg-emerald-400/5")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-muted">Step {step.step}</span>
                      <span className={"rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider " + (step.step === 1 ? "bg-sky-400/15 text-sky-300" : "bg-emerald-400/15 text-emerald-300")}>
                        {step.step === 1 ? "base risk" : "house money"}
                      </span>
                    </div>
                    <div className="mt-2 font-mono text-lg text-slate-100">${step.stake.toFixed(2)}</div>
                    <div className="mt-0.5 text-[10px] text-muted">stake → est. <span className="font-mono text-slate-300">${step.payout.toFixed(2)}</span></div>
                    <div className="mt-1 font-mono text-[10px] text-emerald-300">+${step.profit.toFixed(2)} if this step wins</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Final jackpot payout", "$" + plan.finalPayout.toFixed(2)],
                  ["Net burst profit", "+$" + plan.netProfit.toFixed(2)],
                  ["Max cash risk", "$" + plan.maxRisk.toFixed(2)],
                  ["Breakeven", plan.breakevenMisses.toFixed(1) + " Step-1 misses"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded border border-line bg-ink/50 px-2 py-1.5">
                    <p className="text-[8px] uppercase tracking-widest text-muted">{label}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-200">{value}</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-muted">
                The live proposal multiple is advisory and only updates this preview. Every actual stake and payout is re-quoted immediately
                before purchase. A 100% reinvestment can only give back the base stake after a prior win; at 75% the give-back is smaller.
              </p>
            </section>
          </div>

          <aside className="space-y-3">
            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">Sniper control</h2>
                <span className={"rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest " + (armed ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" : "border-line bg-ink/60 text-muted")}>
                  {armed ? "armed" : "idle"}
                </span>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={requestArm}
                  disabled={!connected ? false : !armed && busy}
                  className={"flex-1 rounded px-3 py-2 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 " + (armed ? "border border-amber-400/50 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15" : "border border-accent bg-accent text-ink hover:bg-accent/90")}
                >
                  {!connected ? "Connect to start" : armed ? "Pause sniper" : "Start sniper"}
                </button>
                <button
                  type="button"
                  onClick={resetSession}
                  disabled={busy}
                  className="rounded border border-line px-3 py-2 text-xs text-muted hover:text-slate-100 disabled:opacity-40"
                >
                  Reset
                </button>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-muted">
                Auto mode picks the longest eligible drought at or above the threshold. Manual <span className="text-slate-300">Snipe</span> on any card
                fires the same one-burst ladder. Pausing stops new scans but never interrupts a contract that is already live. The radar cannot unlock until the active contract reports a sold status.
              </p>
              <div className="mt-3 rounded border border-line bg-ink/50 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-semibold text-slate-200">Jump indices</p>
                    <p className="text-[9px] text-muted">Optional JD10–JD100 feeds</p>
                  </div>
                  <button
                    type="button"
                    onClick={toggleJump}
                    disabled={busy || !symbols.some((item) => item.symbol.startsWith("JD"))}
                    className={"rounded border px-2.5 py-1 text-[10px] font-semibold disabled:opacity-40 " + (jumpEnabled ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" : "border-line bg-ink text-muted hover:text-slate-100")}
                  >
                    {jumpEnabled ? "Jump ON" : "Jump OFF"}
                  </button>
                </div>
                <p className="mt-1 text-[9px] text-muted">{activeRadarCount} of {cardsView.length} visible radars live · click a card to enable or pause it.</p>
              </div>
            </section>

            <section className="rounded-lg border border-line bg-panel p-3">
              <h2 className="text-sm font-semibold tracking-tight">Burst configuration</h2>
              <div className="mt-3">
                <p className="text-[9px] uppercase tracking-widest text-muted">Direction</p>
                <div className="mt-1 grid grid-cols-3 gap-1 rounded border border-line bg-ink/60 p-1">
                  {(["both", "over", "under"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => { directionRef.current = value; setDirection(value); }}
                      disabled={busy}
                      className={"rounded px-1 py-1.5 text-[10px] font-semibold disabled:opacity-50 " + (direction === value ? "bg-accent text-ink" : "text-muted hover:text-slate-100")}
                    >
                      {value === "both" ? "Both tails" : value === "over" ? "Over 6 only" : "Under 3 only"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Drought threshold">
                  <input
                    type="number"
                    min={PAROLI_MIN_THRESHOLD}
                    max={PAROLI_MAX_THRESHOLD}
                    step={1}
                    value={threshold}
                    disabled={busy}
                    onChange={(event) => { const next = clampThreshold(Number(event.target.value)); thresholdRef.current = next; setThreshold(next); }}
                    className={inputClass}
                  />
                </Field>
                <Field label="Base stake (USD)">
                  <input
                    type="number"
                    min={PAROLI_MIN_STAKE}
                    step={0.01}
                    value={baseStake}
                    disabled={busy}
                    onChange={(event) => { const next = clampStake(Number(event.target.value)); baseRef.current = next; setBaseStake(next); }}
                    className={inputClass}
                  />
                </Field>
              </div>
              <div className="mt-2">
                <p className="text-[9px] uppercase tracking-widest text-muted">Paroli depth</p>
                <div className="mt-1 grid grid-cols-2 gap-1 rounded border border-line bg-ink/60 p-1">
                  <button
                    type="button"
                    onClick={() => { stepsRef.current = 2; setSteps(2); }}
                    disabled={busy}
                    className={"rounded px-2 py-1.5 text-[10px] font-semibold disabled:opacity-50 " + (steps === 2 ? "bg-accent text-ink" : "text-muted hover:text-slate-100")}
                  >
                    2-step classic
                  </button>
                  <button
                    type="button"
                    onClick={() => { stepsRef.current = 3; setSteps(3); }}
                    disabled={busy}
                    className={"rounded px-2 py-1.5 text-[10px] font-semibold disabled:opacity-50 " + (steps === 3 ? "bg-accent text-ink" : "text-muted hover:text-slate-100")}
                  >
                    3-step house money
                  </button>
                </div>
              </div>
              <div className="mt-2">
                <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-muted">
                  <span>Reinvestment</span>
                  <span className="font-mono text-[10px] text-slate-200">{reinvestPct}%</span>
                </div>
                <input
                  type="range"
                  min={75}
                  max={100}
                  step={1}
                  value={reinvestPct}
                  disabled={busy}
                  onChange={(event) => { const next = clampReinvestPct(Number(event.target.value)); reinvestRef.current = next; setReinvestPct(next); }}
                  className="mt-2 w-full accent-emerald-400 disabled:opacity-50"
                />
                <div className="flex justify-between font-mono text-[9px] text-muted"><span>75%</span><span>100%</span></div>
              </div>
              <p className="mt-2 text-[9px] leading-relaxed text-muted">
                Step 2 stake = prior payout × reinvestment, minimum ${PAROLI_MIN_STAKE.toFixed(2)}. Step 3 repeats the rule.
              </p>
            </section>

            <section className="rounded-lg border border-line bg-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-tight">Risk controls</h2>
                <span className="rounded-full border border-line bg-ink/60 px-2 py-0.5 text-[9px] uppercase tracking-widest text-muted">
                  {isSlManual ? "Custom SL" : "Auto SL"} · {isTpManual ? "Custom TP" : "Auto TP"}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Field label="Stop loss (USD)">
                  <input
                    type="number"
                    min={0}
                    step={0.05}
                    value={stopLoss}
                    disabled={busy}
                    onChange={(event) => { const next = round2(Math.max(0, Number(event.target.value))); slRef.current = next; setStopLoss(next); setIsSlManual(true); }}
                    className={inputClass}
                  />
                </Field>
                <Field label="Take profit (USD)">
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={takeProfit}
                    disabled={busy}
                    onChange={(event) => { const next = round2(Math.max(0, Number(event.target.value))); tpRef.current = next; setTakeProfit(next); setIsTpManual(true); }}
                    className={inputClass}
                  />
                </Field>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { setIsSlManual(false); slRef.current = plan.autoStopLoss; setStopLoss(plan.autoStopLoss); }}
                  disabled={busy || !isSlManual}
                  className="rounded border border-line px-2 py-1 text-[9px] text-muted hover:text-slate-100 disabled:opacity-40"
                >
                  Reset SL to auto
                </button>
                <button
                  type="button"
                  onClick={() => { setIsTpManual(false); tpRef.current = plan.autoTakeProfit; setTakeProfit(plan.autoTakeProfit); }}
                  disabled={busy || !isTpManual}
                  className="rounded border border-line px-2 py-1 text-[9px] text-muted hover:text-slate-100 disabled:opacity-40"
                >
                  Reset TP to auto
                </button>
              </div>
              <p className="mt-2 text-[9px] leading-relaxed text-muted">
                Auto SL = {PAROLI_SL_MULTIPLE} × base (${plan.autoStopLoss.toFixed(2)}). Auto TP = {PAROLI_TP_MULTIPLE} × net burst profit
                (${plan.autoTakeProfit.toFixed(2)}), quarter-rounded. The pre-burst guard blocks a new burst when
                P&amp;L minus one base stake would breach <span className="font-mono">-SL - $0.01</span>.
              </p>
            </section>

            <section className="rounded-lg border border-line bg-panel p-3">
              <h2 className="text-sm font-semibold tracking-tight">Session telemetry</h2>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded border border-line bg-ink/50 px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-widest text-muted">Session P&amp;L</p>
                  <p className={"mt-0.5 font-mono text-sm " + (pnl >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(pnl, currency)}</p>
                </div>
                <div className="rounded border border-line bg-ink/50 px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-widest text-muted">Step 1 W / L</p>
                  <p className="mt-0.5 font-mono text-sm text-slate-200">{step1Wins} / {step1Misses}</p>
                </div>
                <div className="rounded border border-line bg-ink/50 px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-widest text-muted">Peak step</p>
                  <p className="mt-0.5 font-mono text-sm text-slate-200">{peakStep} / {steps}</p>
                </div>
                <div className="rounded border border-line bg-ink/50 px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-widest text-muted">Bursts logged</p>
                  <p className="mt-0.5 font-mono text-sm text-slate-200">{bursts.length}</p>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[9px] text-muted">
                <div className="rounded border border-line px-2 py-1">To TP: <span className="font-mono text-slate-300">${Math.max(0, takeProfit - pnl).toFixed(2)}</span></div>
                <div className="rounded border border-line px-2 py-1">To SL: <span className="font-mono text-slate-300">${Math.max(0, stopLoss + pnl).toFixed(2)}</span></div>
              </div>
              <p className="mt-2 text-[9px] leading-relaxed text-muted">
                A final losing step after prior wins gives back the base stake at 100% reinvestment. Automatic risk checks run
                after every settled burst, not mid-burst.
              </p>
            </section>
          </aside>
        </div>

        <section className="rounded-lg border border-line bg-panel p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Grouped burst history</h2>
              <p className="text-[10px] text-muted">One row per settled burst. Partial rolls preserve the steps that actually won.</p>
            </div>
            <button
              type="button"
              onClick={downloadCsv}
              disabled={bursts.length === 0}
              className="rounded border border-line px-2.5 py-1.5 text-[10px] font-semibold text-muted hover:text-slate-100 disabled:opacity-40"
            >
              Export CSV
            </button>
          </div>
          {bursts.length === 0 ? (
            <p className="mt-3 rounded border border-dashed border-line px-3 py-6 text-center text-[11px] text-muted">
              No settled bursts yet. Start the sniper or press Snipe on a live radar card.
            </p>
          ) : (
            <div className="mt-3 overflow-auto">
              <table className="w-full min-w-[840px] text-left text-[11px]">
                <thead className="text-[9px] uppercase tracking-widest text-muted">
                  <tr className="border-b border-line">
                    <th className="py-1.5 pr-2 font-medium">Time</th>
                    <th className="py-1.5 pr-2 font-medium">Symbol</th>
                    <th className="py-1.5 pr-2 font-medium">Tail</th>
                    <th className="py-1.5 pr-2 font-medium">Trigger</th>
                    <th className="py-1.5 pr-2 font-medium">Step chain</th>
                    <th className="py-1.5 pr-2 font-medium">Outcome</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Max risk</th>
                    <th className="py-1.5 text-right font-medium">Net burst P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {bursts.map((row) => (
                    <tr key={row.id} className="border-b border-line/60 last:border-0">
                      <td className="py-1.5 pr-2 font-mono text-[10px] text-muted">{new Date(row.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                      <td className="py-1.5 pr-2 font-mono text-slate-200">{row.symbol}</td>
                      <td className="py-1.5 pr-2 text-slate-300">{tailLabel(row.tail)}</td>
                      <td className="py-1.5 pr-2 font-mono text-slate-300">{row.triggerDrought} ticks</td>
                      <td className="py-1.5 pr-2">
                        <div className="flex flex-wrap gap-1">
                          {row.stepResults.map((result, index) => (
                            <span
                              key={index}
                              className={"rounded border px-1.5 py-0.5 font-mono text-[8px] " + (result === "WIN" ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" : result === "LOSS" ? "border-danger/50 bg-danger/10 text-danger" : result === "ABORT" ? "border-amber-400/50 bg-amber-400/10 text-amber-300" : "border-line bg-ink/60 text-muted")}
                            >
                              {index + 1}:{result}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className={"py-1.5 pr-2 text-[10px] font-semibold " + (row.outcome === "PAROLI_JACKPOT" ? "text-emerald-300" : row.outcome === "ROLL_ABORTED" ? "text-amber-300" : "text-danger")}>
                        {OUTCOME_LABEL[row.outcome]}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono text-slate-300">${row.maxRisk.toFixed(2)}</td>
                      <td className={"py-1.5 text-right font-mono " + (row.profit >= 0 ? "text-emerald-300" : "text-danger")}>{signedMoney(row.profit, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="rounded-lg border border-line bg-panel p-3 text-[10px] leading-relaxed text-muted">
          <p>
            <span className="font-semibold text-slate-300">Risk disclosure.</span> DIGITOVER 6 and DIGITUNDER 3 each cover three of ten digits.
            That is a negative-expectation house product; Paroli changes how winnings are rolled, not the underlying odds. Run on Demo first,
            keep the base stake small, and never treat a long drought as a guarantee. This page never trades on a real account until you explicitly
            confirm the real-money warning.
          </p>
        </footer>
      </div>

      {confirmIntent ? (
        <Modal title="Real account confirmation" onClose={() => setConfirmIntent(null)}>
          <div className="mt-3 rounded border border-danger/40 bg-danger/10 p-3 text-[11px] leading-relaxed text-slate-200">
            <p className="font-semibold text-danger">This will place real-money contracts.</p>
            <p className="mt-1">
              You are about to {confirmIntent.kind === "arm" ? "arm the automatic scanner" : "snipe " + confirmIntent.symbol} on the selected
              real account. Each burst risks the base stake of <span className="font-mono text-slate-100">${baseStake.toFixed(2)} {currency}</span>,
              and automated steps can continue without another prompt once the burst starts.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] text-muted">
              <li>The radar lock stays held until every bought contract reports <span className="font-mono">is_sold = 1</span>.</li>
              <li>Automatic stop loss and take profit are enforced only after a burst settles.</li>
              <li>You can pause the scanner, but an active burst is never interrupted by the pause button.</li>
            </ul>
          </div>
          <label className="mt-3 flex items-start gap-2 rounded border border-line bg-ink/50 p-2 text-[10px] leading-relaxed text-slate-200">
            <input type="checkbox" checked={confirmChecked} onChange={(event) => setConfirmChecked(event.target.checked)} className="mt-0.5" />
            <span>I understand this uses real funds and that digit contracts have a negative expected value.</span>
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmIntent(null)} className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:text-slate-100">Cancel</button>
            <button
              type="button"
              onClick={confirmReal}
              disabled={!confirmChecked}
              className="rounded border border-danger bg-danger px-3 py-1.5 text-xs font-semibold text-ink hover:bg-danger/90 disabled:opacity-40"
            >
              Confirm real money
            </button>
          </div>
        </Modal>
      ) : null}

      <SessionAdvisorModal
        open={advisor !== null}
        state={advisor}
        currency={currency}
        onDismiss={() => setAdvisor(null)}
        onReset={resetSession}
        variant="paroli"
      />
    </div>
  );
}
