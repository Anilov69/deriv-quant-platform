"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeContinuous } from "@/engines/continuous";
import { analyzeJump } from "@/engines/jump";
import { analyzeStep } from "@/engines/step";
import { calculateEv, evaluateKillSwitches, nextStake, progressionPreview } from "@/risk/martingale";
import { clearStoredCredentials, loadStoredCredentials, saveCredentials } from "@/services/credentialStore";
import { DerivClient, familyForSymbol, type DerivClientEvents } from "@/services/derivApi";
import type {
  ConnectionStatus,
  ContinuousAnalysis,
  ContractType,
  DataMode,
  DerivAccount,
  EvEstimate,
  JumpAnalysis,
  MarketFamily,
  MarketSymbol,
  Proposal,
  RiskSettings,
  Signal,
  StepAnalysis,
  Tick,
  TradeRecord,
} from "@/types";

export type ContractFilter = "ALL" | "MATCH" | "DIFFERS" | "RISE_FALL";

export interface TradeReview {
  signal: Signal;
  proposal: Proposal;
  ev: EvEstimate;
  stake: number;
  currency: string;
}

interface ToastMessage {
  id: number;
  tone: "info" | "success" | "error";
  message: string;
}

const DEFAULT_RISK: RiskSettings = {
  baseStake: 1,
  martingale: false,
  multiplier: 2,
  maxStep: 5,
  mode: "next-signal",
  kellyFraction: 0.05,
  dailyStopLoss: 100,
  dailyTakeProfit: 200,
  maxConsecutiveLosses: 4,
};

const FALLBACK_SYMBOLS: MarketSymbol[] = [
  ...["R_10", "R_25", "R_50", "R_75", "R_100"].map((symbol) => ({ symbol, displayName: `Volatility ${symbol.slice(2)} Index`, family: "continuous" as const, decimals: 3, pip: 0.001, available: true })),
  ...["1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"].map((symbol) => ({ symbol, displayName: `Volatility ${symbol.slice(3, -1)} (1s) Index`, family: "continuous" as const, decimals: 3, pip: 0.001, available: true })),
  { symbol: "stpRNG", displayName: "Step Index", family: "step", decimals: 3, pip: 0.001, available: true },
  { symbol: "stpRNG2", displayName: "Step Index 2", family: "step", decimals: 3, pip: 0.001, available: true },
  ...["JD10", "JD25", "JD50", "JD75", "JD100"].map((symbol) => ({ symbol, displayName: `Jump ${symbol.slice(2)} Index`, family: "jump" as const, decimals: 3, pip: 0.001, available: true })),
];

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function tickDigits(quote: number, decimals = 3): number {
  return Math.floor((Math.round(Math.abs(quote) * 10 ** decimals) % 10) + Number.EPSILON);
}

function generateSimulation(symbol: string, count = 1_000): Tick[] {
  const family = familyForSymbol(symbol) ?? "continuous";
  const random = seededRandom(hashSeed(symbol));
  const interval = symbol.startsWith("1HZ") ? 1_000 : 2_000;
  const end = Math.floor(Date.now() / interval) * interval;
  const ticks: Tick[] = [];
  let quote = 1_000 + random() * 500;
  let step = 0.1;
  let quietTicks = 0;
  for (let index = 0; index < count; index += 1) {
    if (family === "continuous") {
      const drift = Math.sin(index / 37) * 0.018;
      quote += (random() - 0.5) * (symbol.endsWith("100") || symbol.endsWith("100V") ? 0.32 : 0.16) + drift;
    } else if (family === "step") {
      if (random() < 0.16) step = random() < 0.5 ? 0.09 : 0.11;
      const digit = tickDigits(quote);
      const nextDigit = random() < 0.28 ? (digit + (random() < 0.5 ? 1 : 9)) % 10 : Math.floor(random() * 10);
      quote = Math.floor(quote * 10) / 10 + step + nextDigit / 1_000;
    } else {
      quietTicks += 1;
      quote += (random() - 0.5) * 0.08;
      if (quietTicks > 85 && random() < 0.035) {
        quote += (random() < 0.5 ? -1 : 1) * (0.7 + random() * 1.8);
        quietTicks = 0;
      }
    }
    const normalized = Number(quote.toFixed(3));
    ticks.push({ epoch: end - (count - 1 - index) * interval, quote: normalized, digit: tickDigits(normalized) });
  }
  return ticks;
}

function appendTick(previous: Tick[], tick: Tick): Tick[] {
  if (previous.at(-1)?.epoch === tick.epoch) return [...previous.slice(0, -1), tick];
  return [...previous, tick].slice(-1_000);
}

function payoutFor(contractType: ContractType): number {
  if (contractType === "DIGITMATCH") return 11.7;
  if (contractType === "DIGITDIFF") return 1.095;
  return 1.91;
}

function simulationProposal(symbol: string, contractType: ContractType, barrier: string | undefined, duration: number, amount: number, currency: string): Proposal {
  return {
    id: `sim-${Date.now()}-${contractType}`,
    contractType,
    symbol,
    barrier,
    duration,
    durationUnit: "t",
    askPrice: amount,
    payout: Number((amount * payoutFor(contractType)).toFixed(3)),
    spot: 0,
    currency,
    receivedAt: Date.now(),
  };
}

export function useQuantPlatform() {
  const clientRef = useRef<DerivClient | null>(null);
  const simulationTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const executingRef = useRef(false);
  const lastAutoSignalRef = useRef<string | null>(null);
  const toastSequence = useRef(0);
  const accountKindRef = useRef<DerivAccount["kind"]>("demo");
  const symbolRef = useRef("R_100");
  const baselineReadyRef = useRef(true);
  const settledContractsRef = useRef(new Set<string>());
  const riskRef = useRef<RiskSettings>(DEFAULT_RISK);
  const balanceRef = useRef(10_000);
  const activeProbabilityRef = useRef(0.5);
  const activePayoutRef = useRef(2);
  const ticksRef = useRef<Tick[]>([]);
  const [mode, setMode] = useState<DataMode>("simulation");
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [symbols, setSymbols] = useState<MarketSymbol[]>(FALLBACK_SYMBOLS);
  const [accounts, setAccounts] = useState<DerivAccount[]>([{ loginid: "VRTC-SIMULATION", currency: "USD", kind: "demo", name: "Simulation account" }]);
  const [account, setAccount] = useState<DerivAccount>(accounts[0]);
  const [balance, setBalance] = useState(10_000);
  const [startBalance, setStartBalance] = useState(10_000);
  const [latency, setLatency] = useState(0);
  const [family, setFamily] = useState<MarketFamily>("continuous");
  const [symbol, setSymbol] = useState("R_100");
  const [ticks, setTicks] = useState<Tick[]>(() => generateSimulation("R_100"));
  const [contractFilter, setContractFilter] = useState<ContractFilter>("ALL");
  const [preferredContract, setPreferredContract] = useState<ContractType>("DIGITMATCH");
  const [selectedBarrier, setSelectedBarrier] = useState(5);
  const [riseFallDuration, setRiseFallDuration] = useState(3);
  const [risk, setRisk] = useState<RiskSettings>(DEFAULT_RISK);
  const [stake, setStake] = useState(DEFAULT_RISK.baseStake);
  const [proposals, setProposals] = useState<Partial<Record<ContractType, Proposal>>>({});
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [autoTrade, setAutoTrade] = useState(false);
  const [emergencyStop, setEmergencyStop] = useState(false);
  const [killReason, setKillReason] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    accountKindRef.current = account.kind;
    symbolRef.current = symbol;
    ticksRef.current = ticks;
  }, [account.kind, symbol, ticks]);

  const pushToast = useCallback((message: string, tone: ToastMessage["tone"] = "info") => {
    const id = ++toastSequence.current;
    setToasts((current) => [...current.slice(-3), { id, tone, message }]);
    const timer = setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4_500);
    simulationTimers.current.add(timer);
  }, []);

  useEffect(() => {
    const client = new DerivClient();
    clientRef.current = client;
    const cleanups: Array<() => void> = [];
    const bind = <K extends keyof DerivClientEvents>(event: K, handler: (payload: DerivClientEvents[K]) => void) => {
      cleanups.push(client.on(event, handler));
    };
    bind("status", setStatus);
    bind("authorized", ({ loginId }) => {
      baselineReadyRef.current = false;
      setMode("live");
      setAutoTrade(false);
      setEmergencyStop(false);
      setKillReason(null);
      setConsecutiveLosses(0);
      setAccounts((current) => {
        const match = current.find((item) => item.loginid === loginId);
        if (match) setAccount(match);
        return current;
      });
    });
    bind("accounts", (nextAccounts) => {
      setAccounts(nextAccounts);
      setAccount((current) => nextAccounts.find((item) => item.loginid === current.loginid) ?? nextAccounts.find((item) => item.kind === "demo") ?? nextAccounts[0] ?? current);
    });
    bind("balance", (nextBalance) => {
      setBalance(nextBalance.balance);
      setAccount((current) => current.loginid === nextBalance.loginId ? current : { loginid: nextBalance.loginId, currency: nextBalance.currency, kind: nextBalance.loginId.startsWith("VRTC") ? "demo" : "real", name: nextBalance.loginId });
      if (!baselineReadyRef.current) {
        baselineReadyRef.current = true;
        setStartBalance(nextBalance.balance);
      }
    });
    bind("symbols", (nextSymbols) => {
      setSymbols(nextSymbols.length ? nextSymbols : FALLBACK_SYMBOLS);
      setSymbol((current) => nextSymbols.some((item) => item.symbol === current) ? current : nextSymbols[0]?.symbol ?? current);
    });
    bind("history", ({ symbol: historySymbol, ticks: historyTicks }) => {
      if (historySymbol === symbolRef.current) setTicks(historyTicks);
    });
    bind("tick", (tick) => {
      if (tick.symbol === symbolRef.current) setTicks((current) => appendTick(current, tick));
    });
    bind("latency", setLatency);
    bind("proposal", (proposal) => setProposals((current) => ({ ...current, [proposal.contractType]: proposal })));
    bind("bought", ({ contractId, proposal, buyPrice }) => {
      const record: TradeRecord = {
        id: `deriv-${contractId}`,
        contractId,
        symbol: proposal.symbol,
        contractType: proposal.contractType,
        barrier: proposal.barrier,
        direction: proposal.contractType === "CALL" ? "up" : proposal.contractType === "PUT" ? "down" : proposal.contractType === "DIGITMATCH" ? "match" : "differ",
        durationTicks: proposal.duration,
        stake: buyPrice,
        payout: proposal.payout,
        profit: 0,
        status: "open",
        mode: "live",
        accountKind: accountKindRef.current,
        openedAt: Date.now(),
        entrySpot: proposal.spot,
        proposalId: proposal.id,
      };
      setTrades((current) => [record, ...current].slice(0, 250));
    });
    bind("contract", (contract) => {
      setTrades((current) => current.map((trade) => trade.contractId === contract.contractId || trade.id === contract.id ? contract : trade));
      const settlementKey = contract.contractId === undefined ? contract.id : String(contract.contractId);
      if (["won", "lost", "sold"].includes(contract.status) && !settledContractsRef.current.has(settlementKey)) {
        settledContractsRef.current.add(settlementKey);
        setConsecutiveLosses((current) => {
          const nextLosses = contract.status === "lost" ? current + 1 : 0;
          const payout = contract.payout > 0 ? contract.payout : activePayoutRef.current;
          const nextAmount = nextStake(riskRef.current, balanceRef.current, nextLosses, activeProbabilityRef.current, payout);
          setStake(Math.min(balanceRef.current, Math.max(riskRef.current.baseStake, nextAmount)));
          if (nextLosses >= riskRef.current.maxConsecutiveLosses) {
            setAutoTrade(false);
            setEmergencyStop(true);
            setKillReason("Consecutive-loss limit reached.");
          }
          return nextLosses;
        });
        pushToast(`${contract.symbol} ${contract.contractType}: ${contract.status.toUpperCase()} ${contract.profit >= 0 ? "+" : ""}${contract.profit.toFixed(2)}`, contract.profit >= 0 ? "success" : "error");
      }
    });
    bind("error", (error) => pushToast(error.message, "error"));
    return () => {
      for (const cleanup of cleanups) cleanup();
      for (const timer of simulationTimers.current) clearTimeout(timer);
      simulationTimers.current.clear();
      client.clearCredentials();
      clientRef.current = null;
    };
  }, [pushToast]);

  useEffect(() => {
    if (mode !== "simulation") return;
    setTicks(generateSimulation(symbol));
    const interval = symbol.startsWith("1HZ") ? 1_000 : 2_000;
    const timer = setInterval(() => {
      setTicks((current) => {
        const last = current.at(-1);
        if (!last) return current;
        const random = seededRandom(hashSeed(`${symbol}:${Date.now()}`));
        let quote = last.quote;
        if (family === "continuous") quote += (random() - 0.5) * 0.18 + Math.sin(Date.now() / 30_000) * 0.01;
        else if (family === "step") quote += random() < 0.5 ? 0.09 : 0.11;
        else quote += random() < 0.025 ? (random() < 0.5 ? -1.4 : 1.4) : (random() - 0.5) * 0.08;
        quote = Number(quote.toFixed(3));
        return appendTick(current, { epoch: Date.now(), quote, digit: tickDigits(quote) });
      });
    }, interval);
    return () => clearInterval(timer);
  }, [family, mode, symbol]);

  useEffect(() => {
    if (mode !== "live" || status !== "connected" || !clientRef.current) return;
    let cancelled = false;
    void clientRef.current.subscribeTicks(symbol).catch((error: Error) => {
      if (!cancelled) pushToast(error.message, "error");
    });
    return () => {
      cancelled = true;
      void clientRef.current?.unsubscribe(symbol);
    };
  }, [mode, status, symbol, pushToast]);

  const symbolMeta = symbols.find((item) => item.symbol === symbol);
  const analysis = useMemo(() => {
    if (family === "step") {
      const step = analyzeStep(symbol, ticks);
      return { kind: "step" as const, step };
    }
    if (family === "jump") {
      const jump = analyzeJump(symbol, ticks);
      return { kind: "jump" as const, jump };
    }
    const continuous = analyzeContinuous(symbol, ticks);
    return { kind: "continuous" as const, continuous };
  }, [family, symbol, ticks]);

  const allSignals = useMemo<Signal[]>(() => {
    if (analysis.kind === "continuous") return analysis.continuous.signals;
    if (analysis.kind === "step") return analysis.step.signals;
    return analysis.jump.signals;
  }, [analysis]);

  const filteredSignals = useMemo(() => allSignals.filter((signal) => {
    if (contractFilter === "ALL") return true;
    if (contractFilter === "MATCH") return signal.contractType === "DIGITMATCH";
    if (contractFilter === "DIFFERS") return signal.contractType === "DIGITDIFF";
    return signal.contractType === "CALL" || signal.contractType === "PUT";
  }).sort((a, b) => b.score - a.score), [allSignals, contractFilter]);

  const activeSignal = useMemo(() => filteredSignals.find((signal) =>
    signal.contractType === preferredContract &&
    (signal.contractType === "DIGITMATCH" || signal.contractType === "DIGITDIFF" ? signal.barrier === String(selectedBarrier) : signal.durationTicks === riseFallDuration),
  ) ?? filteredSignals[0] ?? null, [filteredSignals, preferredContract, riseFallDuration, selectedBarrier]);

  const proposalTypes = useMemo<ContractType[]>(() => {
    if (contractFilter === "MATCH") return ["DIGITMATCH"];
    if (contractFilter === "DIFFERS") return ["DIGITDIFF"];
    if (contractFilter === "RISE_FALL") return ["CALL", "PUT"];
    return ["DIGITMATCH", "DIGITDIFF", "CALL", "PUT"];
  }, [contractFilter]);

  useEffect(() => {
    if (mode === "live") {
      setProposals({});
      return;
    }
    const refresh = () => {
      const next: Partial<Record<ContractType, Proposal>> = {};
      for (const contractType of proposalTypes) {
        const isDigit = contractType === "DIGITMATCH" || contractType === "DIGITDIFF";
        next[contractType] = simulationProposal(symbol, contractType, isDigit ? String(selectedBarrier) : undefined, isDigit ? 1 : riseFallDuration, stake, account.currency);
      }
      setProposals(next);
    };
    refresh();
    const timer = setInterval(refresh, 1_500);
    return () => clearInterval(timer);
  }, [account.currency, mode, proposalTypes, riseFallDuration, selectedBarrier, stake, symbol]);

  useEffect(() => {
    if (mode !== "live" || status !== "connected" || !clientRef.current) return;
    let cancelled = false;
    const subscribe = async () => {
      await clientRef.current?.clearProposals();
      if (cancelled || !clientRef.current) return;
      for (const contractType of proposalTypes) {
        const isDigit = contractType === "DIGITMATCH" || contractType === "DIGITDIFF";
        await clientRef.current.subscribeProposal({
          symbol,
          contractType,
          barrier: isDigit ? String(selectedBarrier) : undefined,
          duration: isDigit ? 1 : riseFallDuration,
          amount: stake,
          currency: account.currency,
        });
      }
    };
    void subscribe().catch((error: Error) => {
      if (!cancelled) pushToast(error.message, "error");
    });
    return () => {
      cancelled = true;
      void clientRef.current?.clearProposals();
    };
  }, [account.currency, mode, proposalTypes, riseFallDuration, selectedBarrier, stake, status, symbol, pushToast]);

  const activeProposal = activeSignal ? proposals[activeSignal.contractType] ?? null : null;
  const proposalMatchesSignal = Boolean(activeProposal && activeSignal &&
    activeProposal.symbol === activeSignal.symbol &&
    activeProposal.barrier === activeSignal.barrier &&
    activeProposal.duration === activeSignal.durationTicks);
  const ev: EvEstimate | null = activeSignal && activeProposal
    ? calculateEv(activeSignal.probability, activeProposal.payout, activeProposal.askPrice)
    : null;

  useEffect(() => {
    riskRef.current = risk;
    balanceRef.current = balance;
    activeProbabilityRef.current = activeSignal?.probability ?? 0.5;
    activePayoutRef.current = activeProposal?.payout ?? 2;
  }, [activeProposal?.payout, activeSignal?.probability, balance, risk]);

  const progression = useMemo(() => progressionPreview(risk, balance, activeSignal?.probability ?? 0.5, activeProposal?.payout ?? 2, Math.max(2, risk.maxStep + 1)), [activeProposal?.payout, activeSignal?.probability, balance, risk]);

  const killSwitch = useMemo(() => evaluateKillSwitches(startBalance, balance, risk), [balance, risk, startBalance]);
  useEffect(() => {
    if (!killSwitch.stopped || emergencyStop) return;
    setEmergencyStop(true);
    setAutoTrade(false);
    setKillReason(killSwitch.reason ?? "Daily risk limit reached.");
  }, [emergencyStop, killSwitch.reason, killSwitch.stopped]);

  const settledTrades = useMemo(() => trades.filter((trade) => ["won", "lost", "sold"].includes(trade.status)), [trades]);
  const openPositions = useMemo(() => trades.filter((trade) => trade.status === "open" || trade.status === "pending").length, [trades]);
  const analytics = useMemo(() => {
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    const curve = [0];
    for (const trade of settledTrades) {
      cumulative += trade.profit;
      peak = Math.max(peak, cumulative);
      maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
      curve.push(Number(cumulative.toFixed(2)));
    }
    const wins = settledTrades.filter((trade) => trade.profit > 0).length;
    return {
      pnl: cumulative,
      winRate: settledTrades.length ? wins / settledTrades.length * 100 : 0,
      maxDrawdown,
      curve,
      trades: settledTrades.length,
      averageProfit: settledTrades.length ? cumulative / settledTrades.length : 0,
    };
  }, [settledTrades]);

  const selectFamily = useCallback((nextFamily: MarketFamily) => {
    const next = symbols.find((item) => item.family === nextFamily && item.available) ?? symbols.find((item) => item.family === nextFamily);
    setFamily(nextFamily);
    if (next) setSymbol(next.symbol);
  }, [symbols]);

  const selectSymbol = useCallback((nextSymbol: string) => {
    const next = symbols.find((item) => item.symbol === nextSymbol);
    if (!next) return;
    setSymbol(nextSymbol);
    setFamily(next.family);
    setAutoTrade(false);
  }, [symbols]);

  const connect = useCallback(async (token: string, appId: string, remember = false) => {
    setAuthBusy(true);
    try {
      if (!clientRef.current) throw new Error("The trading client is not ready.");
      await clientRef.current.connect(token, appId);
      saveCredentials({ token: token.trim(), appId: appId.trim(), remember });
      setAuthOpen(false);
      setStartBalance(10_000);
      setBalance(10_000);
      pushToast("Deriv authorized. Live market data connected.", "success");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Deriv authorization failed.", "error");
      throw error;
    } finally {
      setAuthBusy(false);
    }
  }, [pushToast]);

  const restoreAttemptedRef = useRef(false);

  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    const stored = loadStoredCredentials();
    if (!stored) return;
    void connect(stored.token, stored.appId, stored.remember).catch(() => undefined);
  }, [connect]);

  const switchAccount = useCallback(async (loginId: string) => {
    if (!clientRef.current || mode !== "live") return;
    try {
      await clientRef.current.switchAccount(loginId);
      const next = accounts.find((item) => item.loginid === loginId);
      if (next) {
        baselineReadyRef.current = false;
        setAccount(next);
        setStartBalance(10_000);
        setConsecutiveLosses(0);
        setAutoTrade(false);
        setEmergencyStop(false);
        setKillReason(null);
        setStake(risk.baseStake);
      }
      pushToast(`Switched to ${next?.kind.toUpperCase() ?? "selected"} account.`, "success");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Account switch failed.", "error");
    }
  }, [accounts, mode, pushToast, risk.baseStake]);

  const startSimulation = useCallback(() => {
    clearStoredCredentials();
    clientRef.current?.clearCredentials();
    setMode("simulation");
    setStatus("disconnected");
    setAccounts([{ loginid: "VRTC-SIMULATION", currency: "USD", kind: "demo", name: "Simulation account" }]);
    setAccount({ loginid: "VRTC-SIMULATION", currency: "USD", kind: "demo", name: "Simulation account" });
    setSymbols(FALLBACK_SYMBOLS);
    setBalance(10_000);
    setStartBalance(10_000);
    setAutoTrade(false);
    setEmergencyStop(false);
    setKillReason(null);
    setConsecutiveLosses(0);
    setStake(risk.baseStake);
  }, [risk.baseStake]);

  const updateRisk = useCallback((patch: Partial<RiskSettings>) => {
    setRisk((current) => {
      const next = { ...current, ...patch };
      next.baseStake = Math.min(10_000, Math.max(0.35, Number.isFinite(next.baseStake) ? next.baseStake : current.baseStake));
      next.multiplier = Math.min(5, Math.max(1.01, Number.isFinite(next.multiplier) ? next.multiplier : current.multiplier));
      next.maxStep = Math.min(12, Math.max(1, Math.round(next.maxStep)));
      next.kellyFraction = Math.min(0.25, Math.max(0.01, next.kellyFraction));
      next.dailyStopLoss = Math.max(1, next.dailyStopLoss);
      next.dailyTakeProfit = Math.max(1, next.dailyTakeProfit);
      next.maxConsecutiveLosses = Math.min(20, Math.max(1, Math.round(next.maxConsecutiveLosses)));
      return next;
    });
    if (patch.baseStake !== undefined && consecutiveLosses === 0) setStake(patch.baseStake);
  }, [consecutiveLosses]);

  const stopTrading = useCallback((reason = "Emergency stop engaged.") => {
    setAutoTrade(false);
    setEmergencyStop(true);
    setKillReason(reason);
    setStake(risk.baseStake);
    pushToast(reason, "error");
  }, [pushToast, risk.baseStake]);

  const resetEmergency = useCallback(() => {
    if (killSwitch.stopped) {
      pushToast("Reset the session baseline or adjust daily limits before resuming.", "error");
      return;
    }
    setEmergencyStop(false);
    setKillReason(null);
    setStake(risk.baseStake);
    setConsecutiveLosses(0);
  }, [killSwitch.stopped, pushToast, risk.baseStake]);

  const resetDailyBaseline = useCallback(() => {
    setAutoTrade(false);
    setStartBalance(balance);
    setEmergencyStop(false);
    setKillReason(null);
    setConsecutiveLosses(0);
    setStake(risk.baseStake);
    settledContractsRef.current.clear();
    pushToast(`New session baseline set at ${balance.toFixed(2)} ${account.currency}.`, "info");
  }, [account.currency, balance, pushToast, risk.baseStake]);

  const executeSignal = useCallback(async (realConfirmed = false, review?: TradeReview): Promise<boolean> => {
    if (executingRef.current) return false;
    if (!activeSignal || !activeProposal || !proposalMatchesSignal || !ev) {
      pushToast("No live proposal matches the selected signal.", "error");
      return false;
    }
    if (emergencyStop || killSwitch.stopped) {
      pushToast(killReason ?? "Trading is stopped.", "error");
      return false;
    }
    if (openPositions >= 3) {
      pushToast("Open-position limit reached.", "error");
      return false;
    }
    if (!ev.actionable) {
      pushToast("Signal is not ACTIONABLE: expected value is not positive.", "error");
      return false;
    }
    if (mode === "live" && status !== "connected") {
      pushToast("Deriv is disconnected.", "error");
      return false;
    }
    if (mode === "live" && account.kind === "real" && !realConfirmed) {
      pushToast("Real-account trades require explicit confirmation.", "error");
      return false;
    }
    if (review && (
      review.proposal.id !== activeProposal.id ||
      review.signal.symbol !== activeSignal.symbol ||
      review.signal.contractType !== activeSignal.contractType ||
      review.signal.barrier !== activeSignal.barrier ||
      review.signal.durationTicks !== activeSignal.durationTicks ||
      review.stake !== stake
    )) {
      pushToast("The reviewed quote changed. Open a fresh trade review.", "error");
      return false;
    }
    if (Date.now() - activeProposal.receivedAt > 4_000 && mode === "live") {
      pushToast("Proposal expired. Waiting for a fresh quote.", "error");
      return false;
    }
    if (stake > balance) {
      pushToast("Stake exceeds the available account balance.", "error");
      return false;
    }
    executingRef.current = true;
    try {
      if (mode === "live" && clientRef.current) {
        await clientRef.current.buyProposal(activeProposal);
        pushToast(`${activeSignal.contractType} contract opened on ${account.kind.toUpperCase()}.`, "success");
      } else {
        const id = `sim-trade-${Date.now()}`;
        const record: TradeRecord = {
          id,
          symbol,
          contractType: activeSignal.contractType,
          barrier: activeSignal.barrier,
          direction: activeSignal.direction,
          durationTicks: activeSignal.durationTicks,
          stake: activeProposal.askPrice,
          payout: activeProposal.payout,
          profit: 0,
          status: "open",
          mode: "simulation",
          accountKind: "demo",
          openedAt: Date.now(),
          entrySpot: ticks.at(-1)?.quote ?? 0,
          proposalId: activeProposal.id,
        };
        setTrades((current) => [record, ...current].slice(0, 250));
        const random = seededRandom(hashSeed(id));
        const won = random() < activeSignal.probability;
        const timer = setTimeout(() => {
          simulationTimers.current.delete(timer);
          const profit = won ? activeProposal.payout - activeProposal.askPrice : -activeProposal.askPrice;
          setTrades((current) => current.map((trade) => trade.id === id ? { ...trade, status: won ? "won" : "lost", profit, closedAt: Date.now(), exitSpot: ticksRef.current.at(-1)?.quote ?? trade.entrySpot } : trade));
          setBalance((current) => current + profit);
          setConsecutiveLosses((current) => {
            const nextLosses = won ? 0 : current + 1;
            const nextAmount = nextStake(risk, balance + profit, nextLosses, activeSignal.probability, activeProposal.payout);
            setStake(Math.min(balance + profit, Math.max(risk.baseStake, nextAmount)));
            if (nextLosses >= risk.maxConsecutiveLosses) stopTrading("Consecutive-loss limit reached.");
            return nextLosses;
          });
          pushToast(`${record.contractType}: ${won ? "WON" : "LOST"} ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}`, won ? "success" : "error");
        }, activeSignal.durationTicks * (symbol.startsWith("1HZ") ? 1_000 : 2_000));
        simulationTimers.current.add(timer);
      }
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Trade execution failed.", "error");
      return false;
    } finally {
      executingRef.current = false;
    }
  }, [account.kind, activeProposal, activeSignal, balance, ev, emergencyStop, killReason, killSwitch.stopped, mode, openPositions, proposalMatchesSignal, pushToast, risk, stake, status, stopTrading, symbol]);

  useEffect(() => {
    if (account.kind === "real" && autoTrade) {
      setAutoTrade(false);
      pushToast("Auto-trade is disabled on Real accounts; confirm each trade manually.", "error");
    }
  }, [account.kind, autoTrade, pushToast]);

  useEffect(() => {
    if (!autoTrade || !activeSignal || emergencyStop || killSwitch.stopped || account.kind === "real") return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (risk.mode === "next-signal" && activeSignal.id === lastAutoSignalRef.current) return;
      void executeSignal(false).then((executed) => {
        if (executed && risk.mode === "next-signal") lastAutoSignalRef.current = activeSignal.id;
      });
    }, 1_500);
    return () => clearInterval(timer);
  }, [account.kind, activeSignal, autoTrade, emergencyStop, executeSignal, killSwitch.stopped, risk.mode]);

  const canTrade = Boolean(activeSignal && activeProposal && proposalMatchesSignal && ev?.actionable && !emergencyStop && !killSwitch.stopped && openPositions < 3 && (mode === "simulation" || status === "connected") && stake <= balance);

  return {
    mode, status, symbols, account, accounts, balance, startBalance, latency,
    family, symbol, symbolMeta, ticks, contractFilter, preferredContract,
    selectedBarrier, riseFallDuration, risk, stake, proposals, activeSignal,
    activeProposal, ev, progression, trades, settledTrades, analytics,
    consecutiveLosses, autoTrade, emergencyStop, killReason, authOpen,
    authBusy, toasts, openPositions, canTrade, analysis,
    setAuthOpen, setContractFilter, setPreferredContract, setSelectedBarrier,
    setRiseFallDuration, setAutoTrade, selectFamily, selectSymbol, connect,
    switchAccount, startSimulation, updateRisk, stopTrading, resetEmergency,
    resetDailyBaseline, executeSignal,
    dismissToast: (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)),
  };
}

export type QuantPlatform = ReturnType<typeof useQuantPlatform>;
