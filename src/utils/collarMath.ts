import type { ContractOffer } from "@/deriv";

export const COLLAR_MIN_STAKE = 0.35;
export const COLLAR_STAKE_STEP = 0.05;
export const COLLAR_DEFAULT_STAKE = 0.35;
export const COLLAR_WEIGHTED_LEG1 = 0.7;
export const COLLAR_DEFAULT_DURATION = 10;
export const COLLAR_MIN_DURATION = 8;
export const COLLAR_MAX_DURATION = 20;
export const COLLAR_MIN_CONTRACT_TICKS = 5;
export const COLLAR_DEFAULT_MIN_LOCK_TICK = 3;
export const COLLAR_BUFFER_SIZE = 60;
export const COLLAR_VISUAL_TICKS = 40;
export const COLLAR_ATR_WINDOW = 20;
export const COLLAR_IMPULSE_LOOKBACK = 5;
export const COLLAR_DEFAULT_IMPULSE = 1.2;
export const COLLAR_DEFAULT_CORRIDOR = 0.8;
export const COLLAR_SL_MULTIPLE = 6;
export const COLLAR_TP_MULTIPLE = 4;
export const COLLAR_DEFAULT_MARTINGALE = 1.6;
export const COLLAR_MAX_MARTINGALE_LEVELS = 2;
export const COLLAR_FALLBACK_MULTIPLE = 1.94;
export const COLLAR_COOLDOWN_MS = 1800;

export type CollarDirectionMode = "auto" | "bullish" | "bearish";
export type CollarSide = "call" | "put";
export type CollarPreset = "symmetric" | "weighted" | "custom";
export type CollarOutcome = "CORRIDOR_2X" | "COLLAR_SCRATCH" | "COLLAR_LOSS" | "SOLO_WIN" | "SAVED_MISS";

export const COLLAR_OUTCOME_LABEL: Record<CollarOutcome, string> = {
  CORRIDOR_2X: "CORRIDOR 2×",
  COLLAR_SCRATCH: "COLLAR SCRATCH",
  COLLAR_LOSS: "COLLAR LOSS",
  SOLO_WIN: "SOLO WIN",
  SAVED_MISS: "SAVED MISS",
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  return round2(Math.round(value / step) * step);
}

export function ceilToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  return round2(Math.ceil(value / step - 1e-9) * step);
}

export function roundQuarter(value: number): number {
  return Math.max(0.25, roundToStep(value, 0.25));
}

export function roundStake(value: number): number {
  return Math.max(COLLAR_MIN_STAKE, roundToStep(value, COLLAR_STAKE_STEP));
}

export function decimalsForPip(pip: number): number {
  if (!Number.isFinite(pip) || pip <= 0) return 2;
  const text = pip.toFixed(8).replace(/0+$/, "");
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : Math.min(8, text.length - dot - 1);
}

export function formatPrice(value: number, decimals: number): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : "-";
}

export interface CollarImpulse {
  delta5: number;
  atr20: number;
  ratio: number;
  samples: number;
  ready: boolean;
  direction: "up" | "down" | "flat";
}

export function computeCollarImpulse(prices: readonly number[]): CollarImpulse {
  const clean = prices.filter((price) => Number.isFinite(price) && price > 0);
  const samples = clean.length;
  const last = samples > 0 ? clean[samples - 1] : 0;
  const prior = samples > COLLAR_IMPULSE_LOOKBACK ? clean[samples - 1 - COLLAR_IMPULSE_LOOKBACK] : last;
  const delta5 = last - prior;
  const deltas: number[] = [];
  for (let index = Math.max(1, samples - COLLAR_ATR_WINDOW); index < samples; index += 1) {
    deltas.push(Math.abs(clean[index] - clean[index - 1]));
  }
  const atr20 = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
  const ratio = atr20 > 0 ? delta5 / atr20 : 0;
  return {
    delta5,
    atr20,
    ratio,
    samples,
    ready: samples >= COLLAR_BUFFER_SIZE && atr20 > 0,
    direction: ratio > 0.000001 ? "up" : ratio < -0.000001 ? "down" : "flat",
  };
}

/**
 * Auto follows the signed impulse. Directional modes only fire in their own
 * direction, so a negative ratio cannot ever start a Bullish collar.
 */
export function selectImpulseSide(
  impulse: CollarImpulse,
  mode: CollarDirectionMode,
  requireFilter: boolean,
  threshold: number,
): CollarSide | null {
  if (!impulse.ready) return null;
  const limit = Math.max(0.1, threshold);
  if (requireFilter) {
    if (mode === "auto") {
      if (impulse.ratio >= limit) return "call";
      if (impulse.ratio <= -limit) return "put";
      return null;
    }
    if (mode === "bullish") return impulse.ratio >= limit ? "call" : null;
    return impulse.ratio <= -limit ? "put" : null;
  }
  if (mode === "bullish") return "call";
  if (mode === "bearish") return "put";
  if (impulse.ratio > 0) return "call";
  if (impulse.ratio < 0) return "put";
  return null;
}

export interface CollarLockWindow {
  start: number;
  end: number;
  valid: boolean;
}

export function collarLockWindow(
  duration: number,
  minLockTick = COLLAR_DEFAULT_MIN_LOCK_TICK,
  minLeg2Ticks = COLLAR_MIN_CONTRACT_TICKS,
): CollarLockWindow {
  const gap = Math.max(COLLAR_MIN_CONTRACT_TICKS, Math.round(minLeg2Ticks));
  const end = Math.max(1, Math.floor(duration) - gap);
  const start = clamp(Math.round(minLockTick), 1, end);
  return { start, end, valid: duration - gap >= start };
}

export function clampLockStart(value: number, duration: number, minLeg2Ticks = COLLAR_MIN_CONTRACT_TICKS): number {
  const window = collarLockWindow(duration, COLLAR_DEFAULT_MIN_LOCK_TICK, minLeg2Ticks);
  return clamp(Math.round(value), 1, Math.max(1, window.end));
}

export function leg2DurationFor(duration: number, ticksElapsed: number): number | null {
  const remaining = Math.floor(duration) - Math.max(0, Math.floor(ticksElapsed));
  return remaining >= COLLAR_MIN_CONTRACT_TICKS ? remaining : null;
}

export function targetSpotFor(entrySpot: number, side: CollarSide, atr20: number, multiple: number): number {
  const distance = Math.max(0, atr20) * Math.max(0.1, multiple);
  return side === "call" ? entrySpot + distance : entrySpot - distance;
}

export function lockConditionMet(
  side: CollarSide,
  spot: number,
  entrySpot: number,
  atr20: number,
  multiple: number,
): boolean {
  if (!Number.isFinite(spot) || !Number.isFinite(entrySpot) || entrySpot <= 0) return false;
  const target = targetSpotFor(entrySpot, side, atr20, multiple);
  return side === "call" ? spot >= target : spot <= target;
}

export function corridorWidth(entrySpot: number, lockSpot: number): number {
  return Math.abs(lockSpot - entrySpot);
}

export function parseTickDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(?:t|ticks?)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : null;
}

export interface CollarContractSpec {
  symbol: string;
  call: ContractOffer;
  put: ContractOffer;
  minTickDuration: number;
  maxTickDuration: number;
  pip: number;
  category: string;
}

/**
 * CALL and PUT must both be present with a tick duration. The page sends only
 * { contracts_for: symbol }; this selection is the capability check.
 */
export function selectCollarSpec(offers: readonly ContractOffer[], symbol: string, fallbackPip: number): CollarContractSpec | null {
  // Deriv labels plain rise/fall as "callput" (older payloads and fixtures use
  // "rise_fall"). Barrier CALL/PUT offers belong to higher/lower families.
  const isRiseFall = (offer: ContractOffer): boolean =>
    (!offer.contractCategory || offer.contractCategory === "callput" || offer.contractCategory === "rise_fall") &&
    (offer.barrier === null || offer.barrier.trim() === "");
  const call = offers.find((offer) => offer.contractType.toUpperCase() === "CALL" && isRiseFall(offer));
  const put = offers.find((offer) => offer.contractType.toUpperCase() === "PUT" && isRiseFall(offer));
  if (!call || !put) return null;
  const callMin = parseTickDuration(call.minContractDuration);
  const putMin = parseTickDuration(put.minContractDuration);
  const callMax = parseTickDuration(call.maxContractDuration);
  const putMax = parseTickDuration(put.maxContractDuration);
  if (!callMin || !putMin || !callMax || !putMax) return null;
  const minTickDuration = Math.max(COLLAR_MIN_CONTRACT_TICKS, callMin, putMin);
  const maxTickDuration = Math.min(COLLAR_MAX_DURATION, callMax, putMax);
  // A lock needs at least one elapsed tick left for Leg 2. If the market's
  // maximum tick duration cannot fit minTickDuration after that first tick,
  // no contingent two-leg collar can ever lock on this symbol.
  if (maxTickDuration < COLLAR_MIN_DURATION || maxTickDuration < minTickDuration + 1) return null;
  const pip = call.pipSize > 0 ? call.pipSize : put.pipSize > 0 ? put.pipSize : fallbackPip;
  return {
    symbol,
    call,
    put,
    minTickDuration,
    maxTickDuration,
    pip: pip > 0 ? pip : fallbackPip,
    category: call.contractCategory || put.contractCategory || "rise_fall",
  };
}

export function maxCollarDuration(spec: CollarContractSpec | null): number {
  return spec ? Math.max(COLLAR_MIN_DURATION, spec.maxTickDuration) : COLLAR_MAX_DURATION;
}

export function clampCollarDuration(value: number, spec: CollarContractSpec | null, minLockTick: number): number {
  const leg2Min = Math.max(COLLAR_MIN_CONTRACT_TICKS, spec?.minTickDuration ?? COLLAR_MIN_CONTRACT_TICKS);
  const lower = Math.max(
    COLLAR_MIN_DURATION,
    spec?.minTickDuration ?? COLLAR_MIN_CONTRACT_TICKS,
    Math.round(minLockTick) + leg2Min,
  );
  // Never return a duration above the live contract maximum. If the floor and
  // the market ceiling cannot meet, the page shows a lock-feasibility warning
  // and refuses to arm instead of buying a Leg 1 with a doomed second leg.
  const upper = maxCollarDuration(spec);
  return clamp(Math.round(value), Math.min(lower, upper), upper);
}

export function presetStakes(preset: CollarPreset, baseStake: number, customLeg1: number, customLeg2: number): { leg1: number; leg2: number } {
  if (preset === "symmetric") return { leg1: COLLAR_DEFAULT_STAKE, leg2: COLLAR_DEFAULT_STAKE };
  if (preset === "weighted") return { leg1: roundStake(baseStake * 2), leg2: roundStake(baseStake) };
  return { leg1: roundStake(customLeg1), leg2: roundStake(customLeg2) };
}

export interface CollarLevel {
  level: number;
  multiplier: number;
  leg1Stake: number;
  leg2Stake: number;
  roundCost: number;
  cumulativeCost: number;
}

export interface CollarRiskInput {
  leg1Stake: number;
  leg2Stake: number;
  martingaleEnabled: boolean;
  multiplier: number;
  maxLevels: number;
  leg1Multiple?: number | null;
  leg2Multiple?: number | null;
}

export interface CollarRiskPlan {
  levels: CollarLevel[];
  effectiveMaxLevels: number;
  effectiveMultiplier: number;
  initialCost: number;
  rawCycleCost: number;
  autoStopLoss: number;
  corridorNet: number;
  autoTakeProfit: number;
  recommendedBuffer: number;
}

export function computeCollarRiskPlan(input: CollarRiskInput): CollarRiskPlan {
  const base1 = roundStake(input.leg1Stake);
  const base2 = roundStake(input.leg2Stake);
  const effectiveMaxLevels = input.martingaleEnabled
    ? Math.max(1, Math.min(COLLAR_MAX_MARTINGALE_LEVELS, Math.round(input.maxLevels)))
    : 0;
  const effectiveMultiplier = input.martingaleEnabled ? Math.max(1.01, input.multiplier) : 1;
  const levels: CollarLevel[] = [];
  let cumulative = 0;
  for (let level = 0; level <= effectiveMaxLevels; level += 1) {
    const multiplier = Math.pow(effectiveMultiplier, level);
    const leg1Stake = roundStake(base1 * multiplier);
    const leg2Stake = roundStake(base2 * multiplier);
    const roundCost = round2(leg1Stake + leg2Stake);
    cumulative = round2(cumulative + roundCost);
    levels.push({ level, multiplier, leg1Stake, leg2Stake, roundCost, cumulativeCost: cumulative });
  }
  const initialCost = levels[0]?.roundCost ?? round2(base1 + base2);
  const rawCycleCost = input.martingaleEnabled ? cumulative : initialCost;
  const autoStopLoss = input.martingaleEnabled
    ? ceilToStep(rawCycleCost, 0.05)
    : ceilToStep(base1 * COLLAR_SL_MULTIPLE, 0.05);
  const m1 = typeof input.leg1Multiple === "number" && input.leg1Multiple > 0 ? input.leg1Multiple : COLLAR_FALLBACK_MULTIPLE;
  const m2 = typeof input.leg2Multiple === "number" && input.leg2Multiple > 0 ? input.leg2Multiple : COLLAR_FALLBACK_MULTIPLE;
  const corridorNet = round2(base1 * (m1 - 1) + base2 * (m2 - 1));
  const rawTakeProfit = Math.max(COLLAR_TP_MULTIPLE * corridorNet, autoStopLoss * 0.75);
  const autoTakeProfit = roundQuarter(rawTakeProfit);
  return {
    levels,
    effectiveMaxLevels,
    effectiveMultiplier,
    initialCost,
    rawCycleCost,
    autoStopLoss,
    corridorNet,
    autoTakeProfit,
    recommendedBuffer: round2(autoStopLoss * 3.5),
  };
}

export function stakesForLevel(plan: CollarRiskPlan, level: number): CollarLevel {
  const index = Math.min(plan.levels.length - 1, Math.max(0, Math.round(level)));
  return plan.levels[index] ?? plan.levels[0];
}

export function nextCollarLevel(current: number, net: number, enabled: boolean, maxLevels: number): number {
  if (!enabled) return 0;
  if (net < -0.05) return Math.min(COLLAR_MAX_MARTINGALE_LEVELS, Math.max(1, maxLevels), Math.max(0, current) + 1);
  return 0;
}

export interface CollarPayoffInput {
  leg1Stake: number;
  leg2Stake: number;
  leg1Multiple: number;
  leg2Multiple: number;
}

export interface CollarPayoffMatrix {
  leg1Payout: number;
  leg2Payout: number;
  totalCost: number;
  corridorProfit: number;
  corridorRoiPct: number;
  breakoutProfit: number;
  reversalProfit: number;
  lockedBest: number;
  lockedWorst: number;
  soloWinProfit: number;
  savedMissLoss: number;
}

export function buildCollarPayoffMatrix(input: CollarPayoffInput): CollarPayoffMatrix {
  const s1 = roundStake(input.leg1Stake);
  const s2 = roundStake(input.leg2Stake);
  const m1 = Math.max(1, input.leg1Multiple);
  const m2 = Math.max(1, input.leg2Multiple);
  const p1 = round2(s1 * m1);
  const p2 = round2(s2 * m2);
  const corridorProfit = round2(p1 - s1 + p2 - s2);
  const totalCost = round2(s1 + s2);
  const breakoutProfit = round2(p1 - s1 - s2);
  const reversalProfit = round2(p2 - s2 - s1);
  return {
    leg1Payout: p1,
    leg2Payout: p2,
    totalCost,
    corridorProfit,
    corridorRoiPct: totalCost > 0 ? round2((corridorProfit / totalCost) * 100) : 0,
    breakoutProfit,
    reversalProfit,
    lockedBest: Math.max(breakoutProfit, reversalProfit),
    lockedWorst: Math.min(breakoutProfit, reversalProfit),
    soloWinProfit: round2(p1 - s1),
    savedMissLoss: round2(-s1),
  };
}

export function classifyCollarOutcome(locked: boolean, leg1Profit: number, leg2Profit = 0): CollarOutcome {
  if (!locked) return leg1Profit > 0 ? "SOLO_WIN" : "SAVED_MISS";
  if (leg1Profit > 0 && leg2Profit > 0) return "CORRIDOR_2X";
  if (leg1Profit > 0 || leg2Profit > 0) return "COLLAR_SCRATCH";
  return "COLLAR_LOSS";
}

export function directionLabel(side: CollarSide): string {
  return side === "call" ? "RISE → FALL" : "FALL → RISE";
}

export function sideLabel(side: CollarSide): string {
  return side === "call" ? "CALL" : "PUT";
}

export function oppositeSide(side: CollarSide): CollarSide {
  return side === "call" ? "put" : "call";
}
