/**
 * Pure math and state helpers for the multi-symbol Paroli sniper.
 *
 * A burst is always funded by a single base stake. After a winning step the
 * payout is rolled forward, so a later losing step can only give back house
 * money plus the original base stake.
 */

export type ParoliTail = "over" | "under";
export type ParoliDirection = "both" | "over" | "under";
export type ParoliOutcome =
  | "PAROLI_JACKPOT"
  | "STEP_2_BREAK"
  | "STEP_3_BREAK"
  | "STEP_1_MISS"
  | "ROLL_ABORTED";

export interface DroughtState {
  high: number;
  low: number;
  lastDigit: number | null;
  ticks: number;
}

export interface RadarDrought {
  symbol: string;
  high: number;
  low: number;
  enabled: boolean;
  ready: boolean;
  /** False only when contracts_for explicitly says the tail is unsupported. */
  overAvailable: boolean;
  underAvailable: boolean;
  order: number;
}

export interface TriggerCandidate {
  symbol: string;
  tail: ParoliTail;
  drought: number;
}

export interface ParoliPlanStep {
  step: number;
  stake: number;
  payout: number;
  profit: number;
  cumulativeStake: number;
  cumulativePayout: number;
}

export interface ParoliPlan {
  baseStake: number;
  steps: ParoliPlanStep[];
  maxRisk: number;
  totalStake: number;
  totalPayout: number;
  finalPayout: number;
  netProfit: number;
  roiPct: number;
  breakevenMisses: number;
  autoStopLoss: number;
  autoTakeProfit: number;
}

export const PAROLI_MIN_STAKE = 0.35;
export const PAROLI_DEFAULT_STAKE = 0.35;
export const PAROLI_FALLBACK_MULTIPLE = 2.92;
export const PAROLI_DEFAULT_STEPS = 2;
export const PAROLI_MAX_STEPS = 3;
export const PAROLI_DEFAULT_REINVEST_PCT = 100;
export const PAROLI_MIN_REINVEST_PCT = 75;
export const PAROLI_DEFAULT_THRESHOLD = 8;
export const PAROLI_MIN_THRESHOLD = 4;
export const PAROLI_MAX_THRESHOLD = 20;
export const PAROLI_SL_MULTIPLE = 8;
export const PAROLI_TP_MULTIPLE = 2;
export const PAROLI_COOLDOWN_MS = 1500;

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampThreshold(value: number): number {
  return Math.round(clamp(value, PAROLI_MIN_THRESHOLD, PAROLI_MAX_THRESHOLD));
}

export function clampReinvestPct(value: number): number {
  return Math.round(clamp(value, PAROLI_MIN_REINVEST_PCT, 100));
}

export function clampSteps(value: number): number {
  return Math.round(clamp(value, 2, PAROLI_MAX_STEPS));
}

export function clampStake(value: number): number {
  return round2(clamp(value, PAROLI_MIN_STAKE, 100));
}

export function highTail(digit: number): boolean {
  return digit === 7 || digit === 8 || digit === 9;
}

export function lowTail(digit: number): boolean {
  return digit === 0 || digit === 1 || digit === 2;
}

/** Fixed-width extraction keeps a trailing zero from 1794.20. */
export function digitFromQuote(quote: number, decimals: number): number | null {
  if (!Number.isFinite(quote) || quote < 0) return null;
  const places = Math.round(clamp(decimals, 0, 8));
  const text = quote.toFixed(places);
  const last = text.slice(-1);
  if (last < "0" || last > "9") return null;
  return Number(last);
}

export function decimalsFromPip(pip: number): number {
  if (!Number.isFinite(pip) || pip <= 0) return 2;
  return Math.round(clamp(-Math.log10(pip), 0, 8));
}

export function emptyDrought(): DroughtState {
  return { high: 0, low: 0, lastDigit: null, ticks: 0 };
}

export function advanceDrought(previous: DroughtState, digit: number | null): DroughtState {
  if (digit === null) return previous;
  return {
    high: highTail(digit) ? 0 : previous.high + 1,
    low: lowTail(digit) ? 0 : previous.low + 1,
    lastDigit: digit,
    ticks: previous.ticks + 1,
  };
}

export function seedDroughts(quotes: readonly number[], decimals: number): DroughtState {
  let state = emptyDrought();
  for (const quote of quotes) {
    const digit = digitFromQuote(quote, decimals);
    if (digit !== null) state = advanceDrought(state, digit);
  }
  return state;
}

export function directionAllows(direction: ParoliDirection, tail: ParoliTail): boolean {
  return direction === "both" || direction === tail;
}

export function tailLabel(tail: ParoliTail): string {
  return tail === "over" ? "Over 6 (7,8,9)" : "Under 3 (0,1,2)";
}

export function tailShort(tail: ParoliTail): string {
  return tail === "over" ? "Over 6" : "Under 3";
}

export function manualTail(direction: ParoliDirection, high: number, low: number): ParoliTail {
  if (direction === "over") return "over";
  if (direction === "under") return "under";
  return high >= low ? "over" : "under";
}

/**
 * The card that reached the threshold with the longest drought wins. Ties
 * follow the visible pool order, then Over 6 for a same-tick tie.
 */
export function findTrigger(
  cards: readonly RadarDrought[],
  threshold: number,
  direction: ParoliDirection,
): TriggerCandidate | null {
  const limit = clampThreshold(threshold);
  const candidates: TriggerCandidate[] = [];
  for (const card of cards) {
    if (!card.enabled || !card.ready) continue;
    if (directionAllows(direction, "over") && card.overAvailable && card.high >= limit) {
      candidates.push({ symbol: card.symbol, tail: "over", drought: card.high });
    }
    if (directionAllows(direction, "under") && card.underAvailable && card.low >= limit) {
      candidates.push({ symbol: card.symbol, tail: "under", drought: card.low });
    }
  }
  candidates.sort((a, b) => {
    if (b.drought !== a.drought) return b.drought - a.drought;
    const cardA = cards.find((card) => card.symbol === a.symbol);
    const cardB = cards.find((card) => card.symbol === b.symbol);
    const order = (cardA?.order ?? 0) - (cardB?.order ?? 0);
    if (order !== 0) return order;
    return a.tail === b.tail ? 0 : a.tail === "over" ? -1 : 1;
  });
  return candidates[0] ?? null;
}

export function stepStakeFor(payout: number, reinvestPct: number): number {
  return round2(Math.max(PAROLI_MIN_STAKE, payout * (clampReinvestPct(reinvestPct) / 100)));
}

export function roundQuarter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 4) / 4;
}

export function autoStopLoss(baseStake: number): number {
  return round2(clampStake(baseStake) * PAROLI_SL_MULTIPLE);
}

export function autoTakeProfit(netBurstProfit: number): number {
  return Math.max(0.25, roundQuarter(Math.max(0, netBurstProfit) * PAROLI_TP_MULTIPLE));
}

export function buildParoliPlan(
  baseStake: number,
  steps: number,
  reinvestPct: number,
  payoutMultiple: number,
): ParoliPlan {
  const safeBase = clampStake(baseStake);
  const count = clampSteps(steps);
  const pct = clampReinvestPct(reinvestPct);
  const multiple = clamp(payoutMultiple, 1.01, 20);
  const planSteps: ParoliPlanStep[] = [];
  let stake = safeBase;
  let cumulativeStake = 0;
  let cumulativePayout = 0;
  for (let step = 1; step <= count; step += 1) {
    const payout = round2(stake * multiple);
    cumulativeStake = round2(cumulativeStake + stake);
    cumulativePayout = round2(cumulativePayout + payout);
    planSteps.push({
      step,
      stake,
      payout,
      profit: round2(payout - stake),
      cumulativeStake,
      cumulativePayout,
    });
    stake = stepStakeFor(payout, pct);
  }
  const totalStake = cumulativeStake;
  const totalPayout = cumulativePayout;
  const netProfit = round2(totalPayout - totalStake);
  return {
    baseStake: safeBase,
    steps: planSteps,
    maxRisk: safeBase,
    totalStake,
    totalPayout,
    finalPayout: planSteps[planSteps.length - 1]?.payout ?? 0,
    netProfit,
    roiPct: safeBase > 0 ? round2((netProfit / safeBase) * 100) : 0,
    breakevenMisses: safeBase > 0 ? netProfit / safeBase : 0,
    autoStopLoss: autoStopLoss(safeBase),
    autoTakeProfit: autoTakeProfit(netProfit),
  };
}

export const OUTCOME_LABEL: Record<ParoliOutcome, string> = {
  PAROLI_JACKPOT: "PAROLI JACKPOT",
  STEP_2_BREAK: "STEP 2 BREAK",
  STEP_3_BREAK: "STEP 3 BREAK",
  STEP_1_MISS: "STEP 1 MISS",
  ROLL_ABORTED: "ROLL ABORTED",
};

export function isBreakOutcome(outcome: ParoliOutcome): boolean {
  return outcome === "STEP_2_BREAK" || outcome === "STEP_3_BREAK" || outcome === "STEP_1_MISS";
}
