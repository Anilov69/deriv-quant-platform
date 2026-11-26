/**
 * Auto-trade engine.
 *
 * The concurrency rule is structural rather than a flag check: the run loop
 * awaits the settlement of the contract it bought before it can look for another
 * signal. There is no path from "buy" to "buy" that skips `awaitSettlement`.
 *
 * Money is never committed by the UI; every stake goes through planStake(), and
 * every settlement goes through settleBook(), both pure functions tested on their
 * own.
 */

import { isRateLimit } from "@/deriv";
import type { Family } from "@/deriv";
import { buildCandidates } from "@/ladder";
import type { Candidate } from "@/ladder";

export const MIN_STAKE = 0.35;

export type AutoState = "OFF" | "SCANNING" | "FETCHING" | "EXECUTING" | "OPEN" | "COOLDOWN" | "HALTED";

export interface TradeTypeFilters {
  riseFall: boolean;
  evenOdd: boolean;
  overUnder: boolean;
  matchDiff: boolean;
}

export interface AutoConfig {
  filters: TradeTypeFilters;
  metric: "ev" | "win";
  minEvPct: number;
  minWinPct: number;
  cooldownMode: "seconds" | "ticks";
  cooldownSeconds: number;
  cooldownTicks: number;
  dailyLossLimit: number;
  dailyProfitTarget: number;
}

export interface MartingaleConfig {
  enabled: boolean;
  mode: "payout" | "multiplier";
  baseStake: number;
  multiplier: number;
  maxSteps: number;
}

export interface MartingaleBook {
  step: number;
  cumulativeLoss: number;
  netProfit: number;
}

export interface StepPreview {
  step: number;
  stake: number;
  cumulativeRisk: number;
  streakProbability: number;
}

export interface Settlement {
  profit: number;
  status: string;
}

export interface Snapshot {
  symbol: string;
  family: Family;
  probabilities: number[];
  currentDigit: number;
  momentumZ: number;
}

export interface Quote {
  id: string;
  ask: number;
  payout: number;
}

export interface Ports {
  snapshot: () => Snapshot | null;
  quote: (input: { contract: string; barrier?: string; duration: number; stake: number }) => Promise<Quote>;
  buy: (id: string, price: number) => Promise<number>;
  watch: (contractId: number) => Promise<void>;
  balance: () => number | null;
  currency: () => string;
}

export interface Clock {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const realClock: Clock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export class HaltSignal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaltSignal";
  }
}

export const EMPTY_BOOK: MartingaleBook = { step: 0, cumulativeLoss: 0, netProfit: 0 };

export const DEFAULT_FILTERS: TradeTypeFilters = {
  riseFall: true,
  evenOdd: true,
  overUnder: true,
  matchDiff: true,
};

export const DEFAULT_AUTO: AutoConfig = {
  filters: DEFAULT_FILTERS,
  metric: "ev",
  minEvPct: 2,
  minWinPct: 52,
  cooldownMode: "seconds",
  cooldownSeconds: 3,
  cooldownTicks: 2,
  dailyLossLimit: 25,
  dailyProfitTarget: 25,
};

export const DEFAULT_MARTINGALE: MartingaleConfig = {
  enabled: false,
  mode: "payout",
  baseStake: 1,
  multiplier: 2.1,
  maxSteps: 3,
};

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Total payout ratio: 8.93x for a one-tick digit, ~1.95x for Rise/Fall. */
export function payoutRatioOf(quote: { ask: number; payout: number }): number {
  return quote.ask > 0 ? quote.payout / quote.ask : 0;
}

/** Net profit multiplier b = Net Profit / Stake, used by the recovery formula. */
export function netMultiplier(ratio: number): number {
  return ratio - 1;
}

export function planStake(input: {
  martingale: MartingaleConfig;
  book: MartingaleBook;
  payoutRatio: number;
}): { stake: number } {
  const min = Math.max(MIN_STAKE, round2(input.martingale.baseStake));
  const config = input.martingale;
  if (!config.enabled || input.book.step <= 0) return { stake: min };

  if (config.mode === "multiplier") {
    return { stake: Math.max(min, round2(config.baseStake * Math.pow(Math.max(1.01, config.multiplier), input.book.step))) };
  }

  const b = netMultiplier(input.payoutRatio);
  if (!(b > 0.02)) {
    throw new HaltSignal("This payout is too close to the stake to recover losses; auto-trade halted.");
  }
  const next = (input.book.cumulativeLoss + config.baseStake * b) / b;
  return { stake: Math.max(min, round2(next)) };
}

export function settleBook(
  book: MartingaleBook,
  config: MartingaleConfig,
  trade: { stake: number; profit: number },
): { book: MartingaleBook; note: "win" | "loss" | "cap" | "flat" } {
  const netProfit = round2(book.netProfit + trade.profit);
  if (trade.profit > 0) {
    return { book: { step: 0, cumulativeLoss: 0, netProfit }, note: "win" };
  }
  if (!config.enabled) {
    return { book: { step: 0, cumulativeLoss: 0, netProfit }, note: "flat" };
  }
  const nextStep = book.step + 1;
  const cumulativeLoss = round2(book.cumulativeLoss + Math.abs(trade.profit));
  if (nextStep > Math.max(0, config.maxSteps)) {
    return { book: { step: 0, cumulativeLoss: 0, netProfit }, note: "cap" };
  }
  return { book: { step: nextStep, cumulativeLoss, netProfit }, note: "loss" };
}

/**
 * Step 0..maxSteps with the exact stake each step would use. In payout mode the
 * growth ratio is p/(p-1), because every step must recover the whole ladder plus
 * one base profit unit at the payout the contract actually pays.
 */
export function previewSteps(input: {
  martingale: MartingaleConfig;
  payoutRatio: number;
  winProbability: number;
}): StepPreview[] {
  const maxSteps = Math.max(0, Math.min(6, Math.round(input.martingale.maxSteps)));
  const ratio = input.martingale.mode === "payout"
    ? (input.payoutRatio > 1.02 ? input.payoutRatio / (input.payoutRatio - 1) : 2)
    : Math.max(1.01, input.martingale.multiplier);
  const win = Math.min(0.999, Math.max(0.001, input.winProbability));
  const rows: StepPreview[] = [];
  let stake = Math.max(MIN_STAKE, round2(input.martingale.baseStake));
  let risk = 0;
  for (let step = 0; step <= maxSteps; step += 1) {
    if (step > 0) stake = Math.max(MIN_STAKE, round2(stake * ratio));
    risk = round2(risk + stake);
    rows.push({ step, stake, cumulativeRisk: risk, streakProbability: Math.pow(1 - win, step + 1) });
  }
  return rows;
}

function isSettled(payload: any): boolean {
  return Number(payload?.is_sold) === 1 || ["sold", "won", "lost"].includes(String(payload?.status ?? ""));
}

const SETTLE_TIMEOUT_MS = 180_000;
const TICK_COOLDOWN_FALLBACK_MS = 30_000;

export class AutoTrader {
  state: AutoState = "OFF";
  book: MartingaleBook = { ...EMPTY_BOOK };
  dayProfit = 0;
  wins = 0;
  losses = 0;
  lastPayoutRatio = 1.95;
  lastTrade: { contract: string; stake: number; profit: number; at: number } | null = null;
  activeContractId: number | null = null;

  onState: ((state: AutoState, note: string) => void) | null = null;
  onBook: ((book: MartingaleBook, dayProfit: number) => void) | null = null;
  onLog: ((message: string, tone: "info" | "good" | "bad") => void) | null = null;
  onHalt: ((reason: string) => void) | null = null;
  onContract: ((payload: any) => void) | null = null;

  private config: AutoConfig = { ...DEFAULT_AUTO };
  private martingale: MartingaleConfig = { ...DEFAULT_MARTINGALE };
  private running = false;
  private settleWaiter: { contractId: number; resolve: (value: Settlement) => void } | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private tickWaiters: Array<{ remaining: number; resolve: () => void }> = [];
  private dayKey = "";
  private scanDelay = 1200;
  private rateLimited = 0;
  private payoutCache = new Map<string, number>();
  private lastLog: { message: string; at: number } | null = null;

  constructor(private readonly ports: Ports, private readonly clock: Clock = realClock) {}

  get locked(): boolean {
    return this.activeContractId !== null;
  }

  configure(config: AutoConfig, martingale: MartingaleConfig): void {
    this.config = { ...config, filters: { ...config.filters } };
    this.martingale = { ...martingale };
  }

  start(): void {
    if (this.running) return;
    if (this.activeContractId !== null) {
      this.log("A contract is still open; wait for it to settle.", "bad");
      return;
    }
    this.running = true;
    this.log("Auto-trade armed.", "good");
    this.setState("SCANNING", "looking for an eligible signal");
    void this.run();
  }

  stop(reason = "Stopped"): void {
    if (!this.running && this.state === "OFF") return;
    this.running = false;
    this.releaseTickWaiters();
    this.setState("OFF", reason);
    this.log(reason + ".", "info");
  }

  resetMartingale(): void {
    this.book = { ...this.book, step: 0, cumulativeLoss: 0 };
    this.onBook?.(this.book, this.dayProfit);
    this.log("Martingale ladder reset to base stake.", "info");
  }

  resetSession(): void {
    this.book = { ...EMPTY_BOOK };
    this.dayProfit = 0;
    this.wins = 0;
    this.losses = 0;
    this.lastTrade = null;
    this.onBook?.(this.book, this.dayProfit);
    this.log("Session P&L cleared.", "info");
  }

  onTick(): void {
    if (this.tickWaiters.length === 0) return;
    const ready: Array<() => void> = [];
    this.tickWaiters = this.tickWaiters.filter((waiter) => {
      waiter.remaining -= 1;
      if (waiter.remaining <= 0) {
        ready.push(waiter.resolve);
        return false;
      }
      return true;
    });
    for (const resolve of ready) resolve();
  }

  onContractUpdate(payload: any): void {
    this.onContract?.(payload);
    const waiter = this.settleWaiter;
    if (!waiter) return;
    if (Number(payload?.contract_id) !== waiter.contractId) return;
    if (!isSettled(payload)) return;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.settleWaiter = null;
    waiter.resolve({ profit: Number(payload?.profit ?? 0), status: String(payload?.status ?? "") });
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        this.rollDay();
        const prepared = await this.prepare();
        if (!prepared) {
          if (!this.running) break;
          await this.clock.sleep(this.scanDelay);
          continue;
        }
        if (!this.running) break;

        const balance = this.ports.balance();
        if (balance !== null && prepared.stake > balance) {
          throw new HaltSignal("Next stake " + prepared.stake.toFixed(2) + " exceeds the account balance.");
        }

        this.setState("EXECUTING", "buying " + prepared.candidate.contract);
        const contractId = await this.ports.buy(prepared.quote.id, prepared.quote.ask);
        this.activeContractId = contractId;
        this.lastPayoutRatio = payoutRatioOf(prepared.quote);
        this.log(
          "Bought " + prepared.candidate.label + " (" + prepared.candidate.contract + ") for " +
            prepared.stake.toFixed(2) + " " + this.ports.currency(),
          "info",
        );
        this.setState("OPEN", "contract " + contractId + " open");

        const settlement = await this.awaitSettlement(contractId);
        const settled = settleBook(this.book, this.martingale, { stake: prepared.stake, profit: settlement.profit });
        this.book = settled.book;
        this.dayProfit = round2(this.dayProfit + settlement.profit);
        if (settlement.profit > 0) this.wins += 1;
        else this.losses += 1;
        this.lastTrade = {
          contract: prepared.candidate.contract,
          stake: prepared.stake,
          profit: settlement.profit,
          at: this.clock.now(),
        };
        this.activeContractId = null;
        this.onBook?.(this.book, this.dayProfit);
        this.log(
          (settlement.profit > 0 ? "Won " : "Lost ") + Math.abs(settlement.profit).toFixed(2) +
            " on " + prepared.candidate.contract + (settled.note === "win" ? " - ladder reset." : ""),
          settlement.profit > 0 ? "good" : "bad",
        );
        if (settled.note === "cap") {
          this.log("Max martingale step reached; stake forced back to base.", "info");
        }

        this.checkKillSwitch();
        this.setState("COOLDOWN", "waiting " + this.cooldownLabel());
        await this.cooldown();
      } catch (error) {
        if (error instanceof HaltSignal) {
          this.halt(error.message);
          return;
        }
        if (!this.running) return;
        if (isRateLimit(error)) {
          this.rateLimited += 1;
          const wait = Math.min(60_000, 4000 * Math.pow(2, Math.min(3, this.rateLimited - 1)));
          this.setState("SCANNING", "Deriv rate limit - backing off " + Math.round(wait / 1000) + "s");
          this.log("Deriv rate-limited proposals; backing off " + Math.round(wait / 1000) + "s.", "bad");
          await this.clock.sleep(wait);
          continue;
        }
        this.log((error as Error).message, "bad");
        await this.clock.sleep(1500);
      }
    }
  }

  private async prepare(): Promise<{ candidate: Candidate; quote: Quote; stake: number } | null> {
    const snapshot = this.ports.snapshot();
    if (!snapshot) return null;
    const allowed = this.allowedContracts();
    if (allowed.length === 0) return null;

    const ranked = buildCandidates({
      family: snapshot.family,
      probabilities: snapshot.probabilities,
      currentDigit: snapshot.currentDigit,
      momentumZ: snapshot.momentumZ,
    })
      .filter((candidate) => allowed.includes(candidate.contract))
      .map((candidate) => ({ candidate, estimate: this.estimateEdge(candidate) }))
      .sort((a, b) => b.estimate - a.estimate);

    if (ranked.length === 0) return null;
    this.setState("SCANNING", "scanning " + snapshot.symbol);

    // One proposal per cycle. Quoting three candidates in a row is what tripped
    // Deriv's burst limit; a cached payout ratio is enough to pick the best one.
    const { candidate } = ranked[0];
    this.setState("FETCHING", "quote for " + candidate.contract);
    const prepared = await this.priceCandidate(candidate);
    if (!prepared) return null;
    const edge = prepared.candidate.probability * prepared.quote.payout - prepared.quote.ask;
    const passes = this.config.metric === "ev"
      ? (edge / prepared.quote.ask) * 100 >= this.config.minEvPct
      : prepared.candidate.probability * 100 >= this.config.minWinPct;
    return passes ? prepared : null;
  }

  private cacheKey(candidate: Candidate): string {
    return candidate.contract + "|" + (candidate.barrier ?? "");
  }

  private estimateEdge(candidate: Candidate): number {
    const cached = this.payoutCache.get(this.cacheKey(candidate));
    if (cached !== undefined) return candidate.probability * cached - 1;
    const fallback: Record<string, number> = {
      DIGITMATCH: 8.93,
      DIGITDIFF: 1.09,
      DIGITOVER: 2.4,
      DIGITUNDER: 2.4,
      DIGITODD: 1.95,
      DIGITEVEN: 1.95,
      CALL: 1.95,
      PUT: 1.95,
    };
    return candidate.probability * (fallback[candidate.contract] ?? 1.95) - 1;
  }

  private async priceCandidate(candidate: Candidate): Promise<{ candidate: Candidate; quote: Quote; stake: number } | null> {
    const payoutStep = this.martingale.enabled && this.martingale.mode === "payout" && this.book.step > 0;
    if (!payoutStep) {
      const stake = planStake({ martingale: this.martingale, book: this.book, payoutRatio: this.lastPayoutRatio }).stake;
      const quote = await this.ports.quote({ contract: candidate.contract, barrier: candidate.barrier, duration: candidate.duration, stake });
      this.rateLimited = 0;
      this.payoutCache.set(this.cacheKey(candidate), payoutRatioOf(quote));
      return { candidate, quote, stake };
    }
    // Probe at the base stake first: the recovery stake depends on the payout this
    // exact contract is paying right now, not on a cached guess.
    const probe = await this.ports.quote({
      contract: candidate.contract,
      barrier: candidate.barrier,
      duration: candidate.duration,
      stake: this.martingale.baseStake,
    });
    const stake = planStake({ martingale: this.martingale, book: this.book, payoutRatio: payoutRatioOf(probe) }).stake;
    const quote = Math.abs(stake - this.martingale.baseStake) < 0.01
      ? probe
      : await this.ports.quote({ contract: candidate.contract, barrier: candidate.barrier, duration: candidate.duration, stake });
    this.rateLimited = 0;
    this.payoutCache.set(this.cacheKey(candidate), payoutRatioOf(quote));
    return { candidate, quote, stake };
  }

  private awaitSettlement(contractId: number): Promise<Settlement> {
    return new Promise<Settlement>((resolve, reject) => {
      this.settleWaiter = { contractId, resolve };
      this.settleTimer = setTimeout(() => {
        this.settleWaiter = null;
        reject(new HaltSignal("No settlement from Deriv within 180s; auto-trade halted."));
      }, SETTLE_TIMEOUT_MS);
      this.ports.watch(contractId).catch((error: Error) => {
        this.log("Could not watch contract " + contractId + ": " + error.message, "bad");
      });
    });
  }

  private async cooldown(): Promise<void> {
    if (this.config.cooldownMode === "ticks") {
      const count = Math.max(1, Math.round(this.config.cooldownTicks));
      await new Promise<void>((resolve) => {
        let finished = false;
        const done = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(done, TICK_COOLDOWN_FALLBACK_MS);
        this.tickWaiters.push({ remaining: count, resolve: done });
      });
      return;
    }
    await this.clock.sleep(Math.max(0, this.config.cooldownSeconds) * 1000);
  }

  private checkKillSwitch(): void {
    const lossLimit = this.config.dailyLossLimit;
    const profitTarget = this.config.dailyProfitTarget;
    if (lossLimit > 0 && this.dayProfit <= -lossLimit) {
      throw new HaltSignal("Daily loss limit of " + lossLimit.toFixed(2) + " reached.");
    }
    if (profitTarget > 0 && this.dayProfit >= profitTarget) {
      throw new HaltSignal("Daily profit target of " + profitTarget.toFixed(2) + " reached.");
    }
  }

  private halt(reason: string): void {
    this.running = false;
    this.releaseTickWaiters();
    this.setState("HALTED", reason);
    this.log("HALTED: " + reason, "bad");
    this.onHalt?.(reason);
  }

  private allowedContracts(): string[] {
    const list: string[] = [];
    if (this.config.filters.riseFall) list.push("CALL", "PUT");
    if (this.config.filters.evenOdd) list.push("DIGITODD", "DIGITEVEN");
    if (this.config.filters.overUnder) list.push("DIGITOVER", "DIGITUNDER");
    if (this.config.filters.matchDiff) list.push("DIGITMATCH", "DIGITDIFF");
    return list;
  }

  private releaseTickWaiters(): void {
    const waiters = this.tickWaiters;
    this.tickWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  private cooldownLabel(): string {
    return this.config.cooldownMode === "ticks"
      ? this.config.cooldownTicks + " tick(s)"
      : this.config.cooldownSeconds + "s";
  }

  private rollDay(): void {
    const key = new Date(this.clock.now()).toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayProfit = 0;
      this.wins = 0;
      this.losses = 0;
      this.onBook?.(this.book, 0);
    }
  }

  private setState(state: AutoState, note: string): void {
    this.state = state;
    this.onState?.(state, note);
  }

  private log(message: string, tone: "info" | "good" | "bad"): void {
    const now = this.clock.now();
    if (this.lastLog && this.lastLog.message === message && now - this.lastLog.at < 15000) return;
    this.lastLog = { message, at: now };
    this.onLog?.(message, tone);
  }
}
