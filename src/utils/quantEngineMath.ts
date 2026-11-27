/**
 * Pure statistics and risk math for the Quant Desk.
 *
 * Everything in this module is deterministic and side-effect free so the
 * scanner, the contract router and the execution page all share one source
 * of truth. Only public Deriv types are imported; no socket calls live here.
 */
import type { ContractOffer, Quote, Tick } from "@/deriv";

export type QuantFamily = "volatility" | "drift" | "jump";
export type QuantDurationUnit = "t" | "s" | "m";
export type QuantContractKind = "NOTOUCH" | "ONETOUCH" | "CALL" | "PUT";
export type QuantRegimeId = 1 | 2 | 3 | 4;

export interface QuantMarket {
  symbol: string;
  label: string;
  family: QuantFamily;
}

export const QUANT_UNIVERSE: readonly QuantMarket[] = [
  { symbol: "1HZ10V", label: "1HZ10V", family: "volatility" },
  { symbol: "1HZ25V", label: "1HZ25V", family: "volatility" },
  { symbol: "1HZ50V", label: "1HZ50V", family: "volatility" },
  { symbol: "1HZ75V", label: "1HZ75V", family: "volatility" },
  { symbol: "1HZ100V", label: "1HZ100V", family: "volatility" },
  { symbol: "DSI10", label: "DSI10", family: "drift" },
  { symbol: "DSI20", label: "DSI20", family: "drift" },
  { symbol: "DSI30", label: "DSI30", family: "drift" },
  { symbol: "JD75", label: "JD75", family: "jump" },
  { symbol: "JD100", label: "JD100", family: "jump" },
] as const;

export const QUANT_SYMBOLS: readonly string[] = QUANT_UNIVERSE.map((market) => market.symbol);
export const QUANT_BUFFER_SIZE = 150;
export const QUANT_ATR_FAST = 15;
export const QUANT_ATR_SLOW = 100;
export const QUANT_ER_WINDOW = 30;
export const QUANT_HURST_WINDOW = 100;
export const QUANT_JUMP_LOOKBACK = 100;
export const QUANT_JUMP_MULTIPLE = 18;
export const QUANT_MIN_STAKE = 0.35;
export const QUANT_STAKE_STEP = 0.05;
export const QUANT_MAX_STAKE = 1.5;
export const QUANT_BALANCE_STAKE_PCT = 0.025;
export const QUANT_DEFAULT_MIN_EV = 6;
export const QUANT_MIN_EV_FLOOR = 2;
export const QUANT_MAX_EV_FLOOR = 20;
export const QUANT_DEFAULT_CAPTURE_PCT = 65;
export const QUANT_CAPTURE_FLOOR = 40;
export const QUANT_CAPTURE_CEILING = 90;
export const QUANT_AUTO_STOP_LOSS = 2.1;
export const QUANT_AUTO_TAKE_PROFIT = 3;
export const QUANT_COOLDOWN_MS = 1800;
export const QUANT_BREAKER_MIN_TRADES = 15;
export const QUANT_BREAKER_DROP = 0.15;
export const QUANT_BREAKER_WINDOW = 20;
const MIN_RANGE = 1e-12;

export function quantMarket(symbol: string): QuantMarket | null {
  return QUANT_UNIVERSE.find((market) => market.symbol === symbol) ?? null;
}

export function quantFamily(symbol: string): QuantFamily | null {
  return quantMarket(symbol)?.family ?? null;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function roundToStep(value: number, step: number): number {
  const safe = step > 0 ? step : 0.01;
  return Math.round((value + Number.EPSILON) / safe) * safe;
}

export function roundStake(value: number): number {
  return Number(Math.max(QUANT_MIN_STAKE, roundToStep(value, QUANT_STAKE_STEP)).toFixed(2));
}

export function round2(value: number): number {
  return Number(value.toFixed(2));
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function absoluteChanges(prices: readonly number[]): number[] {
  const changes: number[] = [];
  for (let index = 1; index < prices.length; index += 1) changes.push(Math.abs(prices[index] - prices[index - 1]));
  return changes;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function atrAt(prices: readonly number[], period: number): number {
  if (prices.length < 2) return 0;
  const changes = absoluteChanges(prices.slice(Math.max(0, prices.length - period - 1)));
  return average(changes);
}

function atrRatioAt(prices: readonly number[]): number | null {
  if (prices.length < QUANT_ATR_SLOW + 1) return null;
  const slow = atrAt(prices, QUANT_ATR_SLOW);
  if (slow <= MIN_RANGE) return 1;
  return atrAt(prices, QUANT_ATR_FAST) / slow;
}

/**
 * Hurst exponent proxy using a single-window rescaled-range estimator on
 * the last 100 log returns. A flat/zero-variance window is deliberately
 * treated as a random walk rather than as a perfect trend.
 */
export function hurstExponentProxy(prices: readonly number[]): number | null {
  if (prices.length < QUANT_HURST_WINDOW + 1) return null;
  const sample = prices.slice(-(QUANT_HURST_WINDOW + 1));
  const returns: number[] = [];
  for (let index = 1; index < sample.length; index += 1) {
    const prior = sample[index - 1];
    if (prior <= 0 || sample[index] <= 0) continue;
    returns.push(Math.log(sample[index] / prior));
  }
  if (returns.length < 20) return null;
  const mean = average(returns);
  let cumulative = 0;
  let rangeMax = -Infinity;
  let rangeMin = Infinity;
  let squared = 0;
  for (const value of returns) {
    cumulative += value - mean;
    rangeMax = Math.max(rangeMax, cumulative);
    rangeMin = Math.min(rangeMin, cumulative);
    squared += (value - mean) ** 2;
  }
  const range = rangeMax - rangeMin;
  const deviation = Math.sqrt(squared / returns.length);
  if (!finite(range) || !finite(deviation) || range <= MIN_RANGE || deviation <= MIN_RANGE) return 0.5;
  const hurst = Math.log(range / deviation) / Math.log(returns.length);
  return finite(hurst) ? clamp(hurst, 0, 1) : 0.5;
}

export interface QuantFeatures {
  samples: number;
  ready: boolean;
  spot: number;
  atr15: number;
  atr100: number;
  atrRatio: number | null;
  efficiency30: number | null;
  hurst: number | null;
  medianTickRange: number;
  ticksSinceJump: number | null;
  jumpDirection: -1 | 0 | 1;
  price30Ago: number | null;
  change30: number | null;
  impulse: number;
  atr15Prior: number;
  impulseVsAtr: number;
  priorAtrRatio: number | null;
}

export function computeQuantFeatures(ticks: readonly Tick[]): QuantFeatures {
  const clean = ticks.filter((tick) => finite(tick.quote) && tick.quote > 0).slice(-QUANT_BUFFER_SIZE);
  const prices = clean.map((tick) => tick.quote);
  const samples = prices.length;
  const spot = samples > 0 ? prices[prices.length - 1] : 0;
  const changes = absoluteChanges(prices);
  const atr15 = average(changes.slice(-QUANT_ATR_FAST));
  const atr100 = average(changes.slice(-QUANT_ATR_SLOW));
  const atrRatio = samples >= QUANT_ATR_SLOW + 1
    ? atr100 <= MIN_RANGE ? 1 : atr15 / atr100
    : null;
  let efficiency30: number | null = null;
  if (samples > QUANT_ER_WINDOW) {
    const start = prices[samples - QUANT_ER_WINDOW - 1];
    const net = Math.abs(spot - start);
    const travelled = changes.slice(-QUANT_ER_WINDOW).reduce((total, value) => total + value, 0);
    efficiency30 = travelled <= MIN_RANGE ? 0 : clamp(net / travelled, 0, 1);
  }
  const hurst = hurstExponentProxy(prices);
  const windowChanges = changes.slice(-QUANT_JUMP_LOOKBACK);
  const medianTickRange = median(windowChanges);
  const jumpThreshold = medianTickRange * QUANT_JUMP_MULTIPLE;
  let jumpIndex = -1;
  let jumpDirection: -1 | 0 | 1 = 0;
  if (medianTickRange > MIN_RANGE && jumpThreshold > MIN_RANGE) {
    for (let index = 0; index < changes.length; index += 1) {
      if (changes[index] < jumpThreshold) continue;
      jumpIndex = index;
      const from = prices[index];
      const to = prices[index + 1];
      jumpDirection = to > from ? 1 : to < from ? -1 : 0;
    }
  }
  const ticksSinceJump = jumpIndex >= 0 ? changes.length - jumpIndex - 1 : null;
  const priorChanges = changes.slice(0, Math.max(0, changes.length - 1));
  const atr15Prior = average(priorChanges.slice(-QUANT_ATR_FAST));
  const impulse = changes.length > 0 ? prices[prices.length - 1] - prices[prices.length - 2] : 0;
  const impulseVsAtr = atr15Prior > MIN_RANGE ? Math.abs(impulse) / atr15Prior : 0;
  const priorPrices = prices.slice(0, Math.max(0, prices.length - 10));
  const price30Ago = samples > QUANT_ER_WINDOW ? prices[samples - QUANT_ER_WINDOW - 1] : null;
  return {
    samples,
    ready: samples >= QUANT_HURST_WINDOW + 1,
    spot,
    atr15,
    atr100,
    atrRatio,
    efficiency30,
    hurst,
    medianTickRange,
    ticksSinceJump,
    jumpDirection,
    price30Ago,
    change30: price30Ago === null ? null : spot - price30Ago,
    impulse,
    atr15Prior,
    impulseVsAtr,
    priorAtrRatio: atrRatioAt(priorPrices),
  };
}

export interface QuantRegimeSignal {
  regime: QuantRegimeId;
  key: "vacuum" | "drift" | "post_jump" | "coil";
  label: string;
  contract: QuantContractKind;
  preferredContracts: QuantContractKind[];
  direction: -1 | 0 | 1;
  posterior: number;
  condition: string;
}

const REGIME_LABELS: Record<QuantRegimeId, string> = {
  1: "VOLATILITY VACUUM",
  2: "LOCKED DRIFT",
  3: "POST-JUMP CALM",
  4: "COIL BREAKOUT",
};

function regimePrior(regime: QuantRegimeId, family: QuantFamily | null): number {
  if (family === "jump") return regime === 3 ? 0.6 : regime === 4 ? 0.25 : 0.075;
  if (family === "drift") return regime === 2 ? 0.55 : regime === 1 ? 0.1 : regime === 4 ? 0.2 : 0.15;
  return regime === 1 ? 0.3 : regime === 2 ? 0.2 : regime === 4 ? 0.45 : 0.05;
}

function regimeScore(regime: QuantRegimeId, features: QuantFeatures): number {
  const ratio = features.atrRatio ?? 1;
  const efficiency = features.efficiency30 ?? 0;
  const hurst = features.hurst ?? 0.5;
  if (regime === 1) return clamp((0.65 - ratio) / 0.65, -1, 1) * 2 + clamp((0.45 - hurst) / 0.45, -1, 1) * 2;
  if (regime === 2) return clamp((efficiency - 0.62) / 0.38, -1, 1) * 2 + clamp((hurst - 0.55) / 0.45, -1, 1) * 2;
  if (regime === 3) {
    const ticks = features.ticksSinceJump;
    if (ticks === null) return -2;
    return 1 + clamp((2 - ticks) / 2, -1, 1) * 2;
  }
  const prior = features.priorAtrRatio ?? 1;
  return clamp((features.impulseVsAtr - 2.2) / 2, -1, 1) * 2 + clamp((0.7 - prior) / 0.7, -1, 1) * 2;
}

/**
 * Rule-gated Bayesian router. The four regime priors and evidence
 * likelihoods produce a posterior over all four states; a state must also
 * satisfy its strict microstructure condition to become executable.
 */
export function classifyQuantRegime(features: QuantFeatures, symbol: string): QuantRegimeSignal | null {
  if (!features.ready || features.hurst === null || features.atrRatio === null) return null;
  const family = quantFamily(symbol);
  const eligible: QuantRegimeId[] = [];
  if (family === "volatility" && features.atrRatio <= 0.65 && features.hurst < 0.45) eligible.push(1);
  if (family !== "jump" && (features.efficiency30 ?? 0) >= 0.62 && features.hurst > 0.55) eligible.push(2);
  if (family === "jump" && features.ticksSinceJump !== null && features.ticksSinceJump <= 2) eligible.push(3);
  if (family === "volatility" && features.priorAtrRatio !== null && features.priorAtrRatio <= 0.7 && features.impulseVsAtr > 2.2 && features.impulse !== 0) eligible.push(4);
  if (eligible.length === 0) return null;
  const priority: QuantRegimeId[] = [3, 4, 2, 1];
  const selected = priority.find((regime) => eligible.includes(regime))!;
  const weights = ([1, 2, 3, 4] as QuantRegimeId[]).map((regime) => {
    const prior = regimePrior(regime, family);
    const score = regimeScore(regime, features);
    const likelihood = Math.exp(clamp(score, -4, 4));
    return prior * likelihood * (eligible.includes(regime) ? 1 : 1e-9);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const posterior = total > 0 ? weights[selected - 1] / total : 0;
  if (selected === 1) {
    return {
      regime: 1, key: "vacuum", label: REGIME_LABELS[1], contract: "NOTOUCH", preferredContracts: ["NOTOUCH"], direction: 0,
      posterior: clamp(posterior, 0, 1),
      condition: "ATR15/ATR100 <= 0.65 and H < 0.45 on a 1HZ index",
    };
  }
  if (selected === 2) {
    const direction: -1 | 1 = (features.change30 ?? 0) > 0 ? 1 : -1;
    return {
      regime: 2, key: "drift", label: REGIME_LABELS[2], contract: direction > 0 ? "CALL" : "PUT", preferredContracts: [direction > 0 ? "CALL" : "PUT"], direction,
      posterior: clamp(posterior, 0, 1),
      condition: "ER30 >= 0.62 and H > 0.55, routed with the P(t) vs P(t-30) direction",
    };
  }
  if (selected === 3) {
    const direction: -1 | 1 = features.jumpDirection === 1 ? -1 : 1;
    return {
      regime: 3, key: "post_jump", label: REGIME_LABELS[3], contract: direction > 0 ? "CALL" : "PUT", preferredContracts: [direction > 0 ? "CALL" : "PUT", "NOTOUCH"], direction,
      posterior: clamp(posterior, 0, 1),
      condition: "JD index with ticksSinceJump <= 2; fade the discharged jump or use NOTOUCH",
    };
  }
  const direction: -1 | 1 = features.impulse > 0 ? 1 : -1;
  return {
    regime: 4, key: "coil", label: REGIME_LABELS[4], contract: "ONETOUCH", preferredContracts: ["ONETOUCH"], direction,
    posterior: clamp(posterior, 0, 1),
    condition: "prior ATR ratio <= 0.70 and current impulse > 2.2 x prior ATR15",
  };
}

export interface QuantDuration {
  value: number;
  unit: QuantDurationUnit;
}

export interface QuantCapability {
  contract: QuantContractKind;
  duration: QuantDuration;
  maxDuration: QuantDuration;
  barrier: string | null;
  barrierOffset: number;
  pipSize: number;
}

export type QuantCapabilities = Partial<Record<QuantContractKind, QuantCapability>>;

export function parseQuantDuration(value: string): QuantDuration | null {
  const match = /^(\d+(?:\.\d+)?)\s*([tsm])$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!finite(amount) || amount <= 0) return null;
  return { value: amount, unit: match[2].toLowerCase() as QuantDurationUnit };
}

export function durationUnitLabel(unit: QuantDurationUnit): string {
  if (unit === "t") return "ticks";
  if (unit === "s") return "seconds";
  return "minutes";
}

export function formatQuantDuration(duration: number, unit: QuantDurationUnit): string {
  return duration + unit;
}

function durationInUnit(duration: QuantDuration, unit: QuantDurationUnit): number | null {
  if (duration.unit === unit) return duration.value;
  if (duration.unit === "t" || unit === "t") return null;
  if (unit === "s") return duration.value * 60;
  return duration.value / 60;
}

interface QuantDurationCandidate {
  offer: ContractOffer;
  min: QuantDuration;
  max: QuantDuration;
  unit: QuantDurationUnit;
}

function durationCandidate(offer: ContractOffer): QuantDurationCandidate | null {
  const min = parseQuantDuration(offer.minContractDuration);
  const max = parseQuantDuration(offer.maxContractDuration);
  if (!min || !max) return null;
  const unit: QuantDurationUnit = min.unit === max.unit ? min.unit : min.unit === "t" || max.unit === "t" ? min.unit : "s";
  const minValue = durationInUnit(min, unit);
  const maxValue = durationInUnit(max, unit);
  if (minValue === null || maxValue === null || minValue <= 0 || maxValue <= 0 || minValue > maxValue) return null;
  return { offer, min: { value: minValue, unit }, max: { value: maxValue, unit }, unit };
}

function barrierOffsetOf(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value.replace("+", ""));
  return finite(parsed) ? Math.abs(parsed) : 0;
}

function unitRank(unit: QuantDurationUnit): number {
  return unit === "t" ? 0 : unit === "s" ? 1 : 2;
}

/** Extract the fastest valid duration offered for each of the four weapons. */
export function extractQuantCapabilities(offers: readonly ContractOffer[]): QuantCapabilities {
  const kinds: QuantContractKind[] = ["NOTOUCH", "ONETOUCH", "CALL", "PUT"];
  const result: QuantCapabilities = {};
  for (const kind of kinds) {
    const candidates = offers
      .filter((offer) => offer.contractType.toUpperCase() === kind)
      .map(durationCandidate)
      .filter((entry): entry is QuantDurationCandidate => entry !== null)
      .sort((left, right) => unitRank(left.unit) - unitRank(right.unit) || left.min.value - right.min.value);
    const selected = candidates[0];
    if (!selected) continue;
    // The fastest entry may publish a short max window while another entry of
    // the same weapon widens it. Preserve the widest tick/time window in the
    // selected unit so a 5-tick locked-drift route is not falsely rejected.
    const maxValue = candidates
      .filter((entry) => entry.unit === selected.unit)
      .reduce((highest, entry) => Math.max(highest, entry.max.value), selected.max.value);
    const pipSize = selected.offer.pipSize > 0 ? selected.offer.pipSize : 0.01;
    result[kind] = {
      contract: kind,
      duration: { value: selected.min.value, unit: selected.min.unit },
      maxDuration: { value: maxValue, unit: selected.unit },
      barrier: selected.offer.barrier,
      barrierOffset: barrierOffsetOf(selected.offer.barrier),
      pipSize,
    };
  }
  return result;
}

export interface QuantTradePlan {
  key: string;
  symbol: string;
  family: QuantFamily;
  regime: QuantRegimeId;
  regimeLabel: string;
  condition: string;
  contract: QuantContractKind;
  direction: -1 | 0 | 1;
  duration: number;
  unit: QuantDurationUnit;
  barrier: string | null;
  barrierOffset: number;
  pipSize: number;
  pRealized: number;
  posterior: number;
}

function decimalsForPip(pip: number): number {
  if (!finite(pip) || pip <= 0) return 2;
  return clamp(Math.ceil(-Math.log10(pip)), 0, 8);
}

function roundBarrierOffset(offset: number, pip: number): number {
  const step = pip > 0 ? pip : 0.01;
  return Math.max(step, roundToStep(offset, step));
}

function signedBarrier(offset: number, pip: number, sign: "+" | "-"): string {
  const safePip = pip > 0 ? pip : 0.01;
  const rounded = roundBarrierOffset(offset, safePip);
  return sign + rounded.toFixed(decimalsForPip(safePip));
}

function barrierFor(kind: QuantContractKind, capability: QuantCapability, direction: -1 | 0 | 1, atr15: number): { barrier: string | null; offset: number } {
  if (kind === "CALL" || kind === "PUT") return { barrier: null, offset: 0 };
  const pip = capability.pipSize > 0 ? capability.pipSize : 0.01;
  const fallback = Math.max(pip * 10, atr15 * (kind === "NOTOUCH" ? 1 : 0.8));
  // contracts_for may publish either a relative offset ("+0.50") or an
  // absolute barrier (an index level in the thousands). Only accept a
  // broker offset that is plausibly local to the current tick distribution;
  // otherwise use the ATR-derived relative barrier so the proposal stays
  // valid instead of asking for a +4000-point move.
  const offered = capability.barrierOffset;
  const saneCeiling = Math.max(pip * 100, atr15 * 20);
  const chosen = offered > 0 && offered <= saneCeiling ? offered : fallback;
  const offset = roundBarrierOffset(chosen, pip);
  if (kind === "ONETOUCH") return { barrier: signedBarrier(offset, pip, direction < 0 ? "-" : "+"), offset };
  const raw = capability.barrier?.trim() ?? "";
  return { barrier: signedBarrier(offset, pip, raw.startsWith("-") ? "-" : "+"), offset };
}

export interface QuantPlanInput {
  symbol: string;
  features: QuantFeatures;
  signal: QuantRegimeSignal;
  capabilities: QuantCapabilities;
  history: readonly Tick[];
}

function chooseRoute(signal: QuantRegimeSignal, capabilities: QuantCapabilities): { contract: QuantContractKind; capability: QuantCapability; duration: number; unit: QuantDurationUnit } | null {
  for (const contract of signal.preferredContracts) {
    const capability = capabilities[contract];
    if (!capability) continue;
    if (signal.regime === 2) {
      if (capability.duration.unit !== "t") continue;
      if (capability.duration.value > 5 || capability.maxDuration.value < 5 || capability.maxDuration.unit !== "t") continue;
      return { contract, capability, duration: 5, unit: "t" };
    }
    return { contract, capability, duration: capability.duration.value, unit: capability.duration.unit };
  }
  return null;
}

export function buildQuantTradePlan(input: QuantPlanInput): QuantTradePlan | null {
  const family = quantFamily(input.symbol);
  if (!family || !input.features.ready || input.features.hurst === null) return null;
  const route = chooseRoute(input.signal, input.capabilities);
  if (!route) return null;
  const barrier = barrierFor(route.contract, route.capability, input.signal.direction, input.features.atr15);
  const pRealized = estimateQuantRealizedProbability({
    kind: route.contract,
    regime: input.signal.regime,
    direction: input.signal.direction,
    history: input.history,
    duration: route.duration,
    unit: route.unit,
    barrierOffset: barrier.offset,
    features: input.features,
  });
  const key = [input.symbol, route.contract, input.signal.direction, route.duration + route.unit, barrier.barrier ?? "none"].join("|");
  return {
    key,
    symbol: input.symbol,
    family,
    regime: input.signal.regime,
    regimeLabel: input.signal.label,
    condition: input.signal.condition,
    contract: route.contract,
    direction: input.signal.direction,
    duration: route.duration,
    unit: route.unit,
    barrier: barrier.barrier,
    barrierOffset: barrier.offset,
    pipSize: route.capability.pipSize > 0 ? route.capability.pipSize : 0.01,
    pRealized,
    posterior: input.signal.posterior,
  };
}

function horizonTicks(duration: number, unit: QuantDurationUnit): number {
  if (unit === "t") return Math.max(1, Math.round(duration));
  if (unit === "m") return Math.max(1, Math.round(duration * 60));
  return Math.max(1, Math.round(duration));
}

function cleanHistory(history: readonly Tick[]): Tick[] {
  return history.filter((tick) => finite(tick.quote) && tick.quote > 0).slice(-QUANT_BUFFER_SIZE);
}

export interface RealizedProbabilityInput {
  kind: QuantContractKind;
  regime: QuantRegimeId;
  direction: -1 | 0 | 1;
  history: readonly Tick[];
  duration: number;
  unit: QuantDurationUnit;
  barrierOffset: number;
  features: QuantFeatures;
}

function notouchSurvival(history: readonly Tick[], horizon: number, offset: number): number | null {
  if (history.length < horizon + 8 || offset <= 0) return null;
  const lastStart = history.length - horizon - 1;
  const firstStart = Math.max(1, history.length - 100 - horizon);
  let wins = 0;
  let windows = 0;
  for (let start = firstStart; start <= lastStart && windows < 100; start += 1) {
    const entry = history[start].quote;
    const upper = entry + offset;
    const lower = entry - offset;
    let touched = false;
    for (let index = start + 1; index <= start + horizon; index += 1) {
      const quote = history[index].quote;
      if (quote >= upper || quote <= lower) { touched = true; break; }
    }
    windows += 1;
    if (!touched) wins += 1;
  }
  return windows >= 8 ? wins / windows : null;
}

function directionalFrequency(history: readonly Tick[], horizon: number, direction: -1 | 0 | 1): number | null {
  if (history.length < horizon + 8 || direction === 0) return null;
  const first = Math.max(0, history.length - 120);
  const last = history.length - horizon - 1;
  let matches = 0;
  let samples = 0;
  for (let index = first; index <= last; index += 1) {
    const delta = history[index + horizon].quote - history[index].quote;
    if (delta === 0) continue;
    samples += 1;
    if ((direction > 0 && delta > 0) || (direction < 0 && delta < 0)) matches += 1;
  }
  return samples >= 8 ? matches / samples : null;
}

function onetouchFrequency(history: readonly Tick[], horizon: number, direction: -1 | 0 | 1, offset: number): number | null {
  if (history.length < horizon + 8 || offset <= 0 || direction === 0) return null;
  const lastStart = history.length - horizon - 1;
  const firstStart = Math.max(0, history.length - 100 - horizon);
  let hits = 0;
  let windows = 0;
  for (let start = firstStart; start <= lastStart && windows < 100; start += 1) {
    const entry = history[start].quote;
    const target = direction > 0 ? entry + offset : entry - offset;
    let touched = false;
    for (let index = start + 1; index <= start + horizon; index += 1) {
      const quote = history[index].quote;
      if (direction > 0 ? quote >= target : quote <= target) { touched = true; break; }
    }
    windows += 1;
    if (touched) hits += 1;
  }
  return windows >= 8 ? hits / windows : null;
}

export function estimateQuantRealizedProbability(input: RealizedProbabilityInput): number {
  const history = cleanHistory(input.history);
  const horizon = Math.min(60, Math.max(1, horizonTicks(input.duration, input.unit)));
  let raw: number | null = null;
  if (input.kind === "NOTOUCH") {
    raw = notouchSurvival(history, horizon, input.barrierOffset);
    return clamp(raw ?? 0.6, 0.5, 0.92);
  }
  if (input.kind === "ONETOUCH") {
    raw = onetouchFrequency(history, horizon, input.direction, input.barrierOffset);
    return clamp(raw ?? 0.55, 0.35, 0.88);
  }
  raw = directionalFrequency(history, Math.max(2, horizon), input.direction);
  if (input.regime === 2) return clamp(raw ?? 0.55, 0.45, 0.72);
  if (input.regime === 3) return clamp(raw ?? 0.56, 0.5, 0.78);
  return clamp(raw ?? 0.52, 0.45, 0.72);
}

export interface QuantQuoteMetrics {
  ask: number;
  payout: number;
  pImplied: number;
  evPct: number;
}

export function quantQuoteMetrics(quote: Pick<Quote, "ask" | "payout">, pRealized: number): QuantQuoteMetrics {
  const ask = quote.ask > 0 ? quote.ask : 0;
  const payout = quote.payout > 0 ? quote.payout : 0;
  const pImplied = ask > 0 && payout > 0 ? clamp(ask / payout, 0, 1) : 0;
  const evPct = ask > 0 ? ((clamp(pRealized, 0, 1) * payout - ask) / ask) * 100 : 0;
  return { ask, payout, pImplied, evPct };
}

export function quantKellyFraction(pRealized: number, payout: number, ask: number): number {
  if (payout <= ask || ask <= 0) return 0;
  const netOdds = (payout - ask) / ask;
  if (netOdds <= MIN_RANGE) return 0;
  const fraction = (netOdds * clamp(pRealized, 0, 1) - (1 - clamp(pRealized, 0, 1))) / netOdds;
  return clamp(fraction, 0, 1);
}

export function quantStakeCap(balance: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return QUANT_MIN_STAKE;
  const percentage = balance * QUANT_BALANCE_STAKE_PCT;
  return Math.max(QUANT_MIN_STAKE, Math.min(QUANT_MAX_STAKE, percentage));
}

export interface QuantSizingInput {
  mode: "kelly" | "fixed";
  balance: number;
  quote: Pick<Quote, "ask" | "payout">;
  pRealized: number;
  fixedStake: number;
}

export function sizeQuantStake(input: QuantSizingInput): number {
  const cap = quantStakeCap(input.balance);
  const roundBelowCap = (value: number): number => {
    // Deriv stakes are cent-denominated, but the hard cap can itself land
    // between nickels (e.g. 2.5% of a $15 balance). Round the cap down to a
    // five-cent step first so rounding can never pierce the risk ceiling.
    const capStep = Math.max(QUANT_MIN_STAKE, Math.floor((cap + 1e-9) / QUANT_STAKE_STEP) * QUANT_STAKE_STEP);
    return Number(Math.min(capStep, roundStake(clamp(value, QUANT_MIN_STAKE, cap))).toFixed(2));
  };
  if (input.mode === "fixed") return roundBelowCap(input.fixedStake);
  const fraction = quantKellyFraction(input.pRealized, input.quote.payout, input.quote.ask);
  const raw = Math.max(0, input.balance) * 0.25 * Math.max(0, fraction);
  return roundBelowCap(raw);
}

export function quantAutoStopLoss(): number {
  return Number(roundToStep(QUANT_MIN_STAKE * 6, QUANT_STAKE_STEP).toFixed(2));
}

export function quantAutoTakeProfit(): number {
  return QUANT_AUTO_TAKE_PROFIT;
}

export interface HarvestDecisionInput {
  enabled: boolean;
  targetCapturePct: number;
  buyPrice: number;
  payout: number;
  bidPrice: number;
  isValidToSell: boolean;
  isSold: boolean;
}

export function shouldHarvest(input: HarvestDecisionInput): boolean {
  if (!input.enabled || input.isSold || !input.isValidToSell || input.buyPrice <= 0 || input.payout <= 0) return false;
  const maxNetProfit = input.payout - input.buyPrice;
  const unrealized = input.bidPrice - input.buyPrice;
  const target = maxNetProfit * clamp(input.targetCapturePct, QUANT_CAPTURE_FLOOR, QUANT_CAPTURE_CEILING) / 100;
  return maxNetProfit > 0 && unrealized >= 0.04 && unrealized >= target;
}

export interface QuantSettledObservation {
  won: boolean;
  pImplied: number;
}

export interface EdgeDriftResult {
  triggered: boolean;
  winRate: number;
  breakeven: number;
  trades: number;
}

export function edgeDriftBreaker(observations: readonly QuantSettledObservation[]): EdgeDriftResult {
  const window = observations.slice(-QUANT_BREAKER_WINDOW).filter((row) => finite(row.pImplied) && row.pImplied > 0);
  if (window.length < QUANT_BREAKER_MIN_TRADES) return { triggered: false, winRate: 0, breakeven: 0, trades: window.length };
  const wins = window.filter((row) => row.won).length;
  const winRate = wins / window.length;
  const breakeven = clamp(average(window.map((row) => row.pImplied)), 0, 1);
  return { triggered: winRate < breakeven - QUANT_BREAKER_DROP, winRate, breakeven, trades: window.length };
}
