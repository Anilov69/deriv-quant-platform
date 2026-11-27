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
  | "STEP3_MEGA_JACKPOT"
  | "CUSHION_DOUBLE_JACKPOT"
  | "CUSHION_LOCK_WIN"
  | "PARACHUTE_BREAK_EVEN"
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
  STEP3_MEGA_JACKPOT: "3-STEP MEGA JACKPOT",
  CUSHION_DOUBLE_JACKPOT: "CUSHION DOUBLE JACKPOT",
  CUSHION_LOCK_WIN: "CUSHION LOCK WIN",
  PARACHUTE_BREAK_EVEN: "PARACHUTE BREAK-EVEN",
  STEP_2_BREAK: "STEP 2 BREAK",
  STEP_3_BREAK: "STEP 3 BREAK",
  STEP_1_MISS: "STEP 1 MISS",
  ROLL_ABORTED: "ROLL ABORTED",
};

export function isBreakOutcome(outcome: ParoliOutcome): boolean {
  return outcome === "STEP_2_BREAK" || outcome === "STEP_3_BREAK" || outcome === "STEP_1_MISS";
}

/* ------------------------------------------------------------------ */
/* Progression modes, contract ladders and step-2 radar hopping        */
/* ------------------------------------------------------------------ */

export type ProgressionMode = "widening_funnel" | "paroli_cushion" | "classic_tail" | "parachute_skim";
export type DigitContract = "DIGITOVER" | "DIGITUNDER";

export const PROGRESSION_MODES: readonly ProgressionMode[] = [
  "widening_funnel",
  "paroli_cushion",
  "classic_tail",
  "parachute_skim",
];

export const PROGRESSION_LABEL: Record<ProgressionMode, string> = {
  widening_funnel: "Widening Funnel",
  paroli_cushion: "Paroli x Cushion",
  classic_tail: "Classic Tail Sniper",
  parachute_skim: "Parachute Skim",
};

export const PROGRESSION_HINT: Record<ProgressionMode, string> = {
  widening_funnel: "30% -> 50%: Step 2 widens to a half-board single contract.",
  paroli_cushion: "100% guaranteed after Step 1: simultaneous Over 3 + Under 6 lock.",
  classic_tail: "30% -> 30%: every step repeats Over 6 or Under 3.",
  parachute_skim: "Zero-risk Step 2: only the banked profit is staked.",
};

/** Indicative payouts: three-digit tail, half board, and the six-digit cushion legs. */
export const PAROLI_TAIL_MULTIPLE = 2.92;
export const PAROLI_HALF_MULTIPLE = 1.95;
export const PAROLI_CUSHION_MULTIPLE = 1.51;

export const PAROLI_DEFAULT_CLUSTER = 4;
export const PAROLI_MIN_CLUSTER = 2;
export const PAROLI_MAX_CLUSTER = 12;
export const PAROLI_DEFAULT_CENTER = 6;
export const PAROLI_MIN_CENTER = 3;
export const PAROLI_MAX_CENTER = 15;
export const PAROLI_AUTO_TP_FLOOR = 1;

export function clampCluster(value: number): number {
  return Math.round(clamp(value, PAROLI_MIN_CLUSTER, PAROLI_MAX_CLUSTER));
}

export function clampCenter(value: number): number {
  return Math.round(clamp(value, PAROLI_MIN_CENTER, PAROLI_MAX_CENTER));
}

export function modeSteps(mode: ProgressionMode, steps: number): number {
  if (mode === "paroli_cushion" || mode === "parachute_skim") return 2;
  return clampSteps(steps);
}

export function modeAllowsThirdStep(mode: ProgressionMode): boolean {
  return mode === "widening_funnel" || mode === "classic_tail";
}

/** Consecutive cluster counters used by the Step-2 radar scan. */
export interface ClusterState {
  /** Consecutive digits in 0-4 (feeds Over 4). */
  lowStreak: number;
  /** Consecutive digits in 5-9 (feeds Under 5). */
  highStreak: number;
  /** Consecutive ticks without a 4 or a 5 (feeds the cushion lock). */
  centerDrought: number;
}

export function emptyCluster(): ClusterState {
  return { lowStreak: 0, highStreak: 0, centerDrought: 0 };
}

export function advanceCluster(previous: ClusterState, digit: number | null): ClusterState {
  if (digit === null) return previous;
  return {
    lowStreak: digit <= 4 ? previous.lowStreak + 1 : 0,
    highStreak: digit >= 5 ? previous.highStreak + 1 : 0,
    centerDrought: digit === 4 || digit === 5 ? 0 : previous.centerDrought + 1,
  };
}

export function seedClusters(quotes: readonly number[], decimals: number): ClusterState {
  let state = emptyCluster();
  for (const quote of quotes) {
    const digit = digitFromQuote(quote, decimals);
    if (digit !== null) state = advanceCluster(state, digit);
  }
  return state;
}

export interface LegRequest {
  contract: DigitContract;
  barrier: string;
  stake: number;
  label: string;
}

export interface ModeLeg extends LegRequest {
  payout: number;
}

export interface ModeStep {
  step: number;
  legs: ModeLeg[];
  stake: number;
  payout: number;
  profit: number;
  cumulativeStake: number;
  cumulativePayout: number;
}

export interface ModePlan {
  mode: ProgressionMode;
  baseStake: number;
  steps: ModeStep[];
  totalSteps: number;
  netProfit: number;
  /** Cushion only: the floor that one surviving leg guarantees. */
  guaranteedNet: number;
  maxRisk: number;
  step2MissPnL: number;
  step2MissLabel: string;
  roiPct: number;
  autoStopLoss: number;
  autoTakeProfit: number;
}

export function legMultiple(contract: DigitContract, barrier: string): number {
  if (contract === "DIGITOVER" && barrier === "6") return PAROLI_TAIL_MULTIPLE;
  if (contract === "DIGITUNDER" && barrier === "3") return PAROLI_TAIL_MULTIPLE;
  if (contract === "DIGITOVER" && barrier === "4") return PAROLI_HALF_MULTIPLE;
  if (contract === "DIGITUNDER" && barrier === "5") return PAROLI_HALF_MULTIPLE;
  return PAROLI_CUSHION_MULTIPLE;
}

export function tailLegRequest(tail: ParoliTail, stake: number): LegRequest {
  return tail === "over"
    ? { contract: "DIGITOVER", barrier: "6", stake: round2(stake), label: "Over 6" }
    : { contract: "DIGITUNDER", barrier: "3", stake: round2(stake), label: "Under 3" };
}

export function halfLegRequest(tail: ParoliTail, stake: number): LegRequest {
  return tail === "over"
    ? { contract: "DIGITOVER", barrier: "4", stake: round2(stake), label: "Over 4" }
    : { contract: "DIGITUNDER", barrier: "5", stake: round2(stake), label: "Under 5" };
}

export function step2Requests(
  mode: ProgressionMode,
  tail: ParoliTail,
  step1Payout: number,
  baseStake: number,
  reinvestPct: number,
): LegRequest[] {
  const pct = clampReinvestPct(reinvestPct);
  if (mode === "paroli_cushion") {
    const budget = round2(step1Payout * (pct / 100));
    const legA = Math.max(PAROLI_MIN_STAKE, round2(budget / 2));
    const legB = Math.max(PAROLI_MIN_STAKE, round2(budget - legA));
    return [
      { contract: "DIGITOVER", barrier: "3", stake: legA, label: "Over 3" },
      { contract: "DIGITUNDER", barrier: "6", stake: legB, label: "Under 6" },
    ];
  }
  if (mode === "parachute_skim") {
    const pureProfit = Math.max(PAROLI_MIN_STAKE, round2((step1Payout - clampStake(baseStake)) * (pct / 100)));
    return [halfLegRequest(tail, pureProfit)];
  }
  if (mode === "classic_tail") return [tailLegRequest(tail, stepStakeFor(step1Payout, pct))];
  return [halfLegRequest(tail, stepStakeFor(step1Payout, pct))];
}

export function step3Requests(mode: ProgressionMode, tail: ParoliTail, step2Payout: number, reinvestPct: number): LegRequest[] {
  void mode;
  return [tailLegRequest(tail, stepStakeFor(step2Payout, reinvestPct))];
}

/** The spec's auto target: max(1.00, quarter-rounded 2x the expected burst profit). */
export function modeAutoTakeProfit(netBurstProfit: number): number {
  return Math.max(PAROLI_AUTO_TP_FLOOR, roundQuarter(Math.max(0, netBurstProfit) * PAROLI_TP_MULTIPLE));
}

export function buildModePlan(
  mode: ProgressionMode,
  baseStake: number,
  steps: number,
  reinvestPct: number,
  tail: ParoliTail = "over",
): ModePlan {
  const safeBase = clampStake(baseStake);
  const pct = clampReinvestPct(reinvestPct);
  const totalSteps = modeSteps(mode, steps);
  const planSteps: ModeStep[] = [];
  let cumulativeStake = 0;
  let cumulativePayout = 0;
  const pushStep = (step: number, requests: LegRequest[]): void => {
    const legs: ModeLeg[] = requests.map((request) => ({
      ...request,
      payout: round2(request.stake * legMultiple(request.contract, request.barrier)),
    }));
    const stake = round2(legs.reduce((sum, leg) => sum + leg.stake, 0));
    const payout = round2(legs.reduce((sum, leg) => sum + leg.payout, 0));
    cumulativeStake = round2(cumulativeStake + stake);
    cumulativePayout = round2(cumulativePayout + payout);
    planSteps.push({
      step,
      legs,
      stake,
      payout,
      profit: round2(payout - stake),
      cumulativeStake,
      cumulativePayout,
    });
  };

  pushStep(1, [tailLegRequest(tail, safeBase)]);
  const step1 = planSteps[0];
  pushStep(2, step2Requests(mode, tail, step1.payout, safeBase, pct));
  const step2 = planSteps[1];
  if (totalSteps >= 3) pushStep(3, step3Requests(mode, tail, step2.payout, pct));

  const netProfit = round2(cumulativePayout - cumulativeStake);
  const guaranteedNet =
    mode === "paroli_cushion"
      ? round2(step1.payout - safeBase - step2.stake + Math.min(...step2.legs.map((leg) => leg.payout)))
      : netProfit;
  const step2MissPnL = mode === "paroli_cushion" ? guaranteedNet : round2(step1.payout - safeBase - step2.stake);
  const step2MissLabel =
    mode === "paroli_cushion"
      ? "+$" + Math.abs(guaranteedNet).toFixed(2) + " guaranteed"
      : Math.abs(step2MissPnL) < 0.005
        ? "$0.00 break-even"
        : "-$" + Math.abs(step2MissPnL).toFixed(2);

  return {
    mode,
    baseStake: safeBase,
    steps: planSteps,
    totalSteps,
    netProfit,
    guaranteedNet,
    maxRisk: safeBase,
    step2MissPnL,
    step2MissLabel,
    roiPct: safeBase > 0 ? round2((netProfit / safeBase) * 100) : 0,
    autoStopLoss: autoStopLoss(safeBase),
    autoTakeProfit: modeAutoTakeProfit(mode === "paroli_cushion" ? guaranteedNet : netProfit),
  };
}

export interface Step2RadarCard {
  symbol: string;
  enabled: boolean;
  ready: boolean;
  order: number;
  lowStreak: number;
  highStreak: number;
  centerDrought: number;
  high: number;
  low: number;
}

export interface Step2Trigger {
  symbol: string;
  /** "cushion" fires both legs; "over"/"under" pick the single Step-2 leg. */
  kind: "cushion" | "over" | "under";
  metric: number;
}

export interface Step2Options {
  clusterThreshold: number;
  centerThreshold: number;
  droughtThreshold: number;
  direction: ParoliDirection;
  /** False only for the manual override, which fires the strongest card immediately. */
  requireThreshold?: boolean;
}

/**
 * Step-2 cross-symbol scan. The first eligible card to satisfy the mode's
 * condition wins; ties fall back to pool order, then the Over side.
 */
export function pickStep2Trigger(
  cards: readonly Step2RadarCard[],
  mode: ProgressionMode,
  options: Step2Options,
): Step2Trigger | null {
  const requireThreshold = options.requireThreshold !== false;
  const eligible = cards.filter((card) => card.enabled && card.ready).sort((a, b) => a.order - b.order);
  if (eligible.length === 0) return null;

  if (mode === "paroli_cushion") {
    const limit = requireThreshold ? clampCenter(options.centerThreshold) : 0;
    let best: Step2RadarCard | null = null;
    for (const card of eligible) {
      if (card.centerDrought >= limit && (!best || card.centerDrought > best.centerDrought)) best = card;
    }
    return best ? { symbol: best.symbol, kind: "cushion", metric: best.centerDrought } : null;
  }

  if (mode === "classic_tail") {
    const limit = requireThreshold ? clampThreshold(options.droughtThreshold) : 0;
    let best: { card: Step2RadarCard; kind: "over" | "under"; metric: number } | null = null;
    for (const card of eligible) {
      if (directionAllows(options.direction, "over") && card.high >= limit && (!best || card.high > best.metric)) {
        best = { card, kind: "over", metric: card.high };
      }
      if (directionAllows(options.direction, "under") && card.low >= limit && (!best || card.low > best.metric)) {
        best = { card, kind: "under", metric: card.low };
      }
    }
    return best ? { symbol: best.card.symbol, kind: best.kind, metric: best.metric } : null;
  }

  const limit = requireThreshold ? clampCluster(options.clusterThreshold) : 0;
  let best: { card: Step2RadarCard; kind: "over" | "under"; metric: number } | null = null;
  for (const card of eligible) {
    if (directionAllows(options.direction, "over") && card.lowStreak >= limit && (!best || card.lowStreak > best.metric)) {
      best = { card, kind: "over", metric: card.lowStreak };
    }
    if (directionAllows(options.direction, "under") && card.highStreak >= limit && (!best || card.highStreak > best.metric)) {
      best = { card, kind: "under", metric: card.highStreak };
    }
  }
  return best ? { symbol: best.card.symbol, kind: best.kind, metric: best.metric } : null;
}
