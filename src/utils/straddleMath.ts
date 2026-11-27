import type { ContractOffer, Quote } from "@/deriv";

/** Symbols the straddle page advertises. Deriv still has the final say via contracts_for. */
export const TOUCH_SYMBOL_GROUPS = [
  {
    label: "Continuous / Volatility",
    family: "continuous" as const,
    symbols: ["1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V", "R_10", "R_25", "R_50", "R_75", "R_100"],
  },
  {
    label: "Jump",
    family: "jump" as const,
    symbols: ["JD10", "JD25", "JD50", "JD75", "JD100"],
  },
  { label: "Step", family: "step" as const, symbols: ["stpRNG"] },
] as const;

export const TOUCH_SYMBOLS: readonly string[] = TOUCH_SYMBOL_GROUPS.flatMap((group) => [...group.symbols]);
const TOUCH_SYMBOL_SET = new Set<string>(TOUCH_SYMBOLS);

export function isTouchSymbol(symbol: string): boolean {
  return TOUCH_SYMBOL_SET.has(symbol);
}

export const MIN_LEG_STAKE = 0.35;
export const STAKE_STEP = 0.05;
export const DEFAULT_DURATION_TICKS = 5;
export const MAX_DURATION_TICKS = 15;
export const DEFAULT_DURATION_SECONDS = 30;
export const DEFAULT_DURATION_MINUTES = 2;
export const MAX_DURATION_SECONDS = 86400;
export const MAX_DURATION_MINUTES = 1440;
export const ATR_FAST_WINDOW = 10;
export const ATR_BASELINE_WINDOW = 50;
export const ATR_BUFFER_SIZE = 100;
export const VISUAL_TICK_COUNT = 40;
export const DEFAULT_SQUEEZE_THRESHOLD = 0.75;
export const DEFAULT_MARTINGALE_MULTIPLIER = 1.65;
export const DEFAULT_MAX_LEVELS = 2;
export const MAX_LEVELS = 5;
export const MARTINGALE_MULTIPLIERS = [1.5, 1.65, 1.8, 2.0] as const;

export type BarrierPreset = "tight" | "balanced" | "wide" | "custom";

export const BARRIER_PRESETS: readonly {
  id: BarrierPreset;
  label: string;
  factor: number;
  blurb: string;
}[] = [
  { id: "tight", label: "Tight Scalp", factor: 0.75, blurb: "0.75x default offset - more touches, lower payout per leg." },
  { id: "balanced", label: "Balanced Straddle", factor: 1, blurb: "1.00x default offset - the default corridor." },
  { id: "wide", label: "Wide Breakout", factor: 1.35, blurb: "1.35x default offset - room for spikes and jump indices." },
  { id: "custom", label: "Custom Offset", factor: 1, blurb: "Enter an absolute +/- offset; proposal validates it." },
];

export function barrierPresetFactor(preset: BarrierPreset): number {
  return BARRIER_PRESETS.find((entry) => entry.id === preset)?.factor ?? 1;
}

export function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  for (let decimals = 0; decimals <= 8; decimals += 1) {
    const scaled = step * Math.pow(10, decimals);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-8) return decimals;
  }
  return 8;
}

export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

export function round2(value: number): number {
  return roundTo(value, 2);
}

export function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  return roundTo(Math.round(value / step) * step, decimalsForStep(step));
}

/** Rounds a stop to the next $0.05 without over-rounding 9.75 to 9.80. */
export function ceilToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  return roundTo(Math.ceil(value / step - 1e-9) * step, decimalsForStep(step));
}

export function roundQuarter(value: number): number {
  return Math.max(0.25, roundToStep(value, 0.25));
}

export type TouchDurationUnit = "t" | "s" | "m";

export interface TouchDuration {
  value: number;
  unit: TouchDurationUnit;
}

export function parseTouchContractDuration(value: string): TouchDuration | null {
  const match = /^(\d+(?:\.\d+)?)\s*([tsm])$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { value: amount, unit: match[2].toLowerCase() as TouchDurationUnit };
}

export function durationUnitLabel(unit: TouchDurationUnit): string {
  return unit === "t" ? "ticks" : unit === "s" ? "seconds" : "minutes";
}

export function durationUnitSuffix(unit: TouchDurationUnit): string {
  return unit;
}

export function formatTouchDuration(value: number, unit: TouchDurationUnit): string {
  const label = durationUnitLabel(unit);
  return value === 1 ? value + " " + label.slice(0, -1) : value + " " + label;
}

export function formatTouchDurationShort(value: number, unit: TouchDurationUnit): string {
  return value + durationUnitSuffix(unit);
}

export function touchDurationToSeconds(value: number, unit: TouchDurationUnit): number | null {
  if (unit === "s") return value;
  if (unit === "m") return value * 60;
  return null;
}

export function maxTouchDuration(unit: TouchDurationUnit): number {
  if (unit === "t") return MAX_DURATION_TICKS;
  if (unit === "s") return MAX_DURATION_SECONDS;
  return MAX_DURATION_MINUTES;
}

function parseBarrierOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value.replace("+", ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

export interface TouchContractSpec {
  minDuration: number;
  maxDuration: number;
  unit: TouchDurationUnit;
  defaultBarrier: number;
  pipSize: number;
  offer: ContractOffer;
  /** Other ONETOUCH tenors the symbol offers, useful for a precise capability warning. */
  otherTenors: string[];
}

interface TouchDurationCandidate {
  offer: ContractOffer;
  min: TouchDuration;
  max: TouchDuration;
  unit: TouchDurationUnit;
}

function durationInUnit(duration: TouchDuration, unit: TouchDurationUnit): number | null {
  if (duration.unit === unit) return duration.value;
  if (duration.unit === "t" || unit === "t") return null;
  if (unit === "s") return duration.value * 60;
  return duration.value / 60;
}

function durationCandidate(offer: ContractOffer): TouchDurationCandidate | null {
  const min = parseTouchContractDuration(offer.minContractDuration);
  const max = parseTouchContractDuration(offer.maxContractDuration);
  if (!min || !max) return null;
  // Some symbols publish a seconds minimum with a minutes maximum. Normalise
  // cross-unit bounds to seconds so the published window remains usable.
  const unit: TouchDurationUnit = min.unit === max.unit ? min.unit : min.unit === "t" || max.unit === "t" ? min.unit : "s";
  const minValue = durationInUnit(min, unit);
  const maxValue = durationInUnit(max, unit);
  if (minValue === null || maxValue === null || !Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue <= 0 || maxValue <= 0 || minValue > maxValue) {
    return null;
  }
  const upper = Math.min(maxValue, maxTouchDuration(unit));
  if (minValue > upper) return null;
  return { offer, min: { value: minValue, unit }, max: { value: upper, unit }, unit };
}

/**
 * Finds an ONETOUCH contract with a duration this page can price. Tick
 * ONETOUCH is preferred for the tick monitor, but some symbols publish only
 * seconds or minutes, so those tenors are a first-class fallback.
 */
export function selectOnetouchSpec(offers: readonly ContractOffer[], fallbackPip = 0.01): TouchContractSpec | null {
  const touch = offers.filter((offer) => offer.contractType.toUpperCase() === "ONETOUCH");
  const candidates = touch
    .map(durationCandidate)
    .filter((entry): entry is TouchDurationCandidate => entry !== null);
  const ticks = candidates.filter((entry) => entry.unit === "t").sort((a, b) => a.min.value - b.min.value || a.max.value - b.max.value);
  const timed = candidates
    .filter((entry) => entry.unit !== "t")
    .sort((a, b) => {
      const left = (touchDurationToSeconds(a.min.value, a.unit) ?? Number.MAX_SAFE_INTEGER);
      const right = (touchDurationToSeconds(b.min.value, b.unit) ?? Number.MAX_SAFE_INTEGER);
      return left - right || a.min.value - b.min.value;
    });
  const selected = ticks[0] ?? timed[0];
  if (!selected) return null;
  const pipSize = selected.offer.pipSize > 0 ? selected.offer.pipSize : fallbackPip > 0 ? fallbackPip : 0.01;
  return {
    minDuration: selected.min.value,
    maxDuration: selected.max.value,
    unit: selected.unit,
    defaultBarrier: parseBarrierOffset(selected.offer.barrier),
    pipSize,
    offer: selected.offer,
    otherTenors: touch
      .filter((offer) => offer !== selected.offer)
      .map((offer) => offer.expiryType + " (" + offer.minContractDuration + "-" + offer.maxContractDuration + ")"),
  };
}

export function defaultTouchDuration(spec: TouchContractSpec): number {
  const preferred = spec.unit === "t" ? DEFAULT_DURATION_TICKS : spec.unit === "s" ? DEFAULT_DURATION_SECONDS : DEFAULT_DURATION_MINUTES;
  return clampTouchDuration(preferred, spec);
}

export function clampTouchDuration(requested: number, spec: TouchContractSpec | null): number {
  if (!spec) return Math.min(MAX_DURATION_TICKS, Math.max(1, Math.round(requested)));
  return Math.min(spec.maxDuration, Math.max(spec.minDuration, Math.round(requested)));
}

export function formatTouchDurationRange(spec: TouchContractSpec): string {
  return spec.minDuration + "-" + spec.maxDuration + " " + durationUnitLabel(spec.unit);
}

export function barrierOffsetFor(
  defaultOffset: number,
  preset: BarrierPreset,
  customOffset: number,
  pipSize: number,
): number {
  const step = pipSize > 0 ? pipSize : 0.01;
  const factor = preset === "custom" ? 1 : barrierPresetFactor(preset);
  const raw = preset === "custom" ? Math.abs(customOffset) : Math.abs(defaultOffset) * factor;
  return roundToStep(Math.max(step, raw), step);
}

export function formatSignedBarrier(offset: number, decimals: number, side: "upper" | "lower"): string {
  return (side === "upper" ? "+" : "-") + Math.abs(offset).toFixed(decimals);
}

export interface AtrSqueeze {
  fastAtr: number;
  baselineAtr: number;
  squeezeRatio: number;
  fastSamples: number;
  baselineSamples: number;
  ready: boolean;
}

/**
 * ATR is the average absolute tick-to-tick move. The ratio uses the most recent
 * deltas, not including the seed boundary, and falls back to 1 until the
 * 50-tick baseline exists so a cold buffer can never look like a squeeze.
 */
export function computeAtrSqueeze(
  prices: readonly number[],
  fastWindow = ATR_FAST_WINDOW,
  baselineWindow = ATR_BASELINE_WINDOW,
): AtrSqueeze {
  const clean = prices.filter((price) => Number.isFinite(price) && price > 0);
  const deltas: number[] = [];
  for (let index = 1; index < clean.length; index += 1) deltas.push(Math.abs(clean[index] - clean[index - 1]));
  const fast = deltas.slice(-Math.max(1, fastWindow));
  const baseline = deltas.slice(-Math.max(1, baselineWindow));
  const average = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const fastAtr = average(fast);
  const baselineAtr = average(baseline);
  const squeezeRatio = baselineAtr > 0 ? fastAtr / baselineAtr : 1;
  return {
    fastAtr,
    baselineAtr,
    squeezeRatio,
    fastSamples: fast.length,
    baselineSamples: baseline.length,
    ready: baseline.length >= baselineWindow,
  };
}

export function isSqueezeReady(atr: AtrSqueeze, threshold: number, required: boolean): boolean {
  if (!atr.ready) return false;
  if (!required) return true;
  return atr.squeezeRatio <= Math.max(0.1, threshold);
}

export interface StraddleLevel {
  level: number;
  multiplier: number;
  legStake: number;
  straddleCost: number;
  cumulativeCost: number;
}

export interface StraddleRiskInput {
  baseStake: number;
  martingaleEnabled: boolean;
  multiplier: number;
  maxLevels: number;
  /** Smallest of the two live leg payouts, if proposals are available. */
  singleSidePayout?: number | null;
}

export interface StraddleRiskPlan {
  levels: StraddleLevel[];
  effectiveMaxLevels: number;
  effectiveMultiplier: number;
  initialCost: number;
  rawCycleCost: number;
  autoStopLoss: number;
  singleSideNet: number | null;
  autoTakeProfit: number;
  recommendedBuffer: number;
}

export function computeStraddleRiskPlan(input: StraddleRiskInput): StraddleRiskPlan {
  const baseStake = Math.max(MIN_LEG_STAKE, round2(input.baseStake));
  const effectiveMaxLevels = input.martingaleEnabled ? Math.max(1, Math.min(MAX_LEVELS, Math.round(input.maxLevels))) : 0;
  const effectiveMultiplier = input.martingaleEnabled ? Math.max(1.01, input.multiplier) : 1;
  const levels: StraddleLevel[] = [];
  let cumulative = 0;
  for (let level = 0; level <= effectiveMaxLevels; level += 1) {
    const multiplier = roundTo(Math.pow(effectiveMultiplier, level), 4);
    const legStake = round2(baseStake * multiplier);
    const straddleCost = round2(legStake * 2);
    cumulative = round2(cumulative + straddleCost);
    levels.push({ level, multiplier, legStake, straddleCost, cumulativeCost: cumulative });
  }
  const initialCost = levels[0]?.straddleCost ?? round2(baseStake * 2);
  const rawCycleCost = cumulative;
  const autoStopLoss = input.martingaleEnabled ? ceilToStep(rawCycleCost, 0.05) : ceilToStep(initialCost * 4, 0.05);
  const singleSidePayout = input.singleSidePayout;
  const singleSideNet =
    typeof singleSidePayout === "number" && Number.isFinite(singleSidePayout) && singleSidePayout > 0
      ? round2(singleSidePayout - initialCost)
      : null;
  const rawTakeProfit = Math.max((singleSideNet ?? 0) * 3, autoStopLoss * 0.65);
  const autoTakeProfit = roundQuarter(rawTakeProfit);
  return {
    levels,
    effectiveMaxLevels,
    effectiveMultiplier,
    initialCost,
    rawCycleCost,
    autoStopLoss,
    singleSideNet,
    autoTakeProfit,
    recommendedBuffer: round2(autoStopLoss * 3.5),
  };
}

export function nextStraddleLevel(current: number, won: boolean, enabled: boolean, maxLevels: number): number {
  if (!enabled) return 0;
  if (won) return 0;
  return Math.min(Math.max(1, maxLevels), Math.max(0, current) + 1);
}

export function nextStraddleCost(plan: StraddleRiskPlan, level: number): number {
  const index = Math.min(plan.levels.length - 1, Math.max(0, level));
  return plan.levels[index]?.straddleCost ?? plan.initialCost;
}

export type StraddleOutcome = "WHIPSAW_2X" | "ONE_SIDE_WIN" | "RANGE_LOSS";

export function classifyStraddleOutcome(legsWon: number): StraddleOutcome {
  if (legsWon >= 2) return "WHIPSAW_2X";
  if (legsWon === 1) return "ONE_SIDE_WIN";
  return "RANGE_LOSS";
}

export const OUTCOME_LABEL: Record<StraddleOutcome, string> = {
  WHIPSAW_2X: "WHIPSAW 2×",
  ONE_SIDE_WIN: "1-SIDE WIN",
  RANGE_LOSS: "RANGE LOSS",
};

export interface StraddlePayoutPreview {
  cost: number;
  upperPayout: number;
  lowerPayout: number;
  doublePayout: number;
  upperNet: number;
  lowerNet: number;
  doubleNet: number;
  upperRoi: number;
  lowerRoi: number;
  doubleRoi: number;
  quietNet: number;
}

export function buildStraddlePayoutPreview(upper: Quote, lower: Quote): StraddlePayoutPreview {
  const cost = round2(upper.ask + lower.ask);
  const doublePayout = round2(upper.payout + lower.payout);
  const percent = (net: number): number => (cost > 0 ? roundTo((net / cost) * 100, 1) : 0);
  const upperNet = round2(upper.payout - cost);
  const lowerNet = round2(lower.payout - cost);
  const doubleNet = round2(doublePayout - cost);
  return {
    cost,
    upperPayout: round2(upper.payout),
    lowerPayout: round2(lower.payout),
    doublePayout,
    upperNet,
    lowerNet,
    doubleNet,
    upperRoi: percent(upperNet),
    lowerRoi: percent(lowerNet),
    doubleRoi: percent(doubleNet),
    quietNet: round2(-cost),
  };
}

export function signedMoney(value: number, currency: string): string {
  return (value >= 0 ? "+" : "") + value.toFixed(2) + " " + currency;
}
