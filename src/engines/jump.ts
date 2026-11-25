import type { JumpAnalysis, Signal, Tick } from "../types";

const MAX_TICKS = 1000;

export const DEFAULT_JUMP_MULTIPLIER = 3;
export const DEFAULT_MIN_JUMP_CHANGE = 1e-8;
export const DEFAULT_ATR_WINDOW = 100;
export const DEFAULT_ELEVATED_HAZARD_THRESHOLD = 0.35;
export const DEFAULT_STABILIZATION_TICKS = 5;
export const DEFAULT_DRIFT_WINDOW = 20;

export interface JumpConfig {
  atrMultiplier: number;
  minJumpChange: number;
  atrWindow: number;
  elevatedHazardThreshold: number;
  stabilizationTicks: number;
  driftWindow: number;
}

export const DEFAULT_JUMP_CONFIG: Readonly<JumpConfig> = Object.freeze({
  atrMultiplier: DEFAULT_JUMP_MULTIPLIER,
  minJumpChange: DEFAULT_MIN_JUMP_CHANGE,
  atrWindow: DEFAULT_ATR_WINDOW,
  elevatedHazardThreshold: DEFAULT_ELEVATED_HAZARD_THRESHOLD,
  stabilizationTicks: DEFAULT_STABILIZATION_TICKS,
  driftWindow: DEFAULT_DRIFT_WINDOW,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let average = 0;
  for (let index = 0; index < values.length; index += 1) {
    average += (values[index] - average) / (index + 1);
  }
  return average;
}

function validatedSample(ticks: Tick[]): Tick[] {
  const sample = ticks.slice(-MAX_TICKS);
  for (let index = 0; index < sample.length; index += 1) {
    const tick = sample[index];
    if (!Number.isFinite(tick.epoch) || tick.epoch < 0) {
      throw new Error(`tick ${index} epoch must be a finite nonnegative number`);
    }
    if (!Number.isFinite(tick.quote) || tick.quote <= 0) {
      throw new Error(`tick ${index} quote must be finite and greater than zero`);
    }
    if (!Number.isInteger(tick.digit) || tick.digit < 0 || tick.digit > 9) {
      throw new Error(`tick ${index} digit must be an integer from 0 through 9`);
    }
  }
  return sample;
}

function resolveConfig(overrides: Partial<JumpConfig>): JumpConfig {
  const config = { ...DEFAULT_JUMP_CONFIG, ...overrides };
  if (!Number.isFinite(config.atrMultiplier) || config.atrMultiplier <= 0) {
    throw new Error("atrMultiplier must be finite and greater than zero");
  }
  if (!Number.isFinite(config.minJumpChange) || config.minJumpChange < 0) {
    throw new Error("minJumpChange must be finite and nonnegative");
  }
  if (!Number.isInteger(config.atrWindow) || config.atrWindow < 1 || config.atrWindow > MAX_TICKS) {
    throw new Error(`atrWindow must be an integer from 1 through ${MAX_TICKS}`);
  }
  if (
    !Number.isFinite(config.elevatedHazardThreshold) ||
    config.elevatedHazardThreshold <= 0 ||
    config.elevatedHazardThreshold > 1
  ) {
    throw new Error("elevatedHazardThreshold must be finite and in (0, 1]");
  }
  if (!Number.isInteger(config.stabilizationTicks) || config.stabilizationTicks < 0) {
    throw new Error("stabilizationTicks must be a finite nonnegative integer");
  }
  if (!Number.isInteger(config.driftWindow) || config.driftWindow < 1 || config.driftWindow > MAX_TICKS) {
    throw new Error(`driftWindow must be an integer from 1 through ${MAX_TICKS}`);
  }
  return config;
}

function digitCounts(digits: readonly number[]): number[] {
  const counts = Array<number>(10).fill(0);
  for (const digit of digits) counts[digit] += 1;
  return counts;
}

function binomialZScores(counts: readonly number[]): number[] {
  const sampleSize = counts.reduce((total, count) => total + count, 0);
  if (sampleSize === 0) return Array<number>(10).fill(0);
  const standardDeviation = Math.sqrt(sampleSize * 0.09);
  return counts.map((count) => (count - sampleSize / 10) / standardDeviation);
}

function conservativeProbability(probability: number): number {
  return clamp(0.5 + (probability - 0.5) * 0.8, 0.01, 0.99);
}

function makeDigitSignal(
  symbol: string,
  contractType: "DIGITMATCH" | "DIGITDIFF",
  direction: "match" | "differ",
  barrier: number,
  probability: number,
  confidence: number,
  score: number,
  reasons: string[],
  createdAt: number,
): Signal {
  return {
    id: `jump:${symbol}:${contractType}:${createdAt}:${barrier}`,
    symbol,
    family: "jump",
    contractType,
    barrier: String(barrier),
    direction,
    durationTicks: 1,
    probability: clamp01(probability),
    confidence: clamp01(confidence),
    score: clamp01(score),
    reasons,
    createdAt,
  };
}

function makeDriftSignal(
  symbol: string,
  direction: "up" | "down",
  durationTicks: number,
  probability: number,
  confidence: number,
  score: number,
  reasons: string[],
  createdAt: number,
): Signal {
  return {
    id: `jump:${symbol}:${direction === "up" ? "CALL" : "PUT"}:${createdAt}:${durationTicks}`,
    symbol,
    family: "jump",
    contractType: direction === "up" ? "CALL" : "PUT",
    direction,
    durationTicks,
    probability: clamp01(probability),
    confidence: clamp01(confidence),
    score: clamp01(score),
    reasons,
    createdAt,
  };
}

export function analyzeJump(
  symbol: string,
  ticks: Tick[],
  overrides: Partial<JumpConfig> = {},
): JumpAnalysis {
  const sample = validatedSample(ticks);
  const config = resolveConfig(overrides);
  const absoluteChanges: number[] = [];
  const logReturns: number[] = [];
  const recentChanges: number[] = [];
  const jumps: number[] = [];

  for (let index = 1; index < sample.length; index += 1) {
    const change = Math.abs(sample[index].quote - sample[index - 1].quote);
    const logReturn = Math.log(sample[index].quote) - Math.log(sample[index - 1].quote);
    absoluteChanges.push(change);
    logReturns.push(logReturn);

    // Trailing ATR excludes the candidate move so one jump cannot hide itself.
    const trailingAtr = mean(recentChanges);
    const threshold = Math.max(config.minJumpChange, trailingAtr * config.atrMultiplier);
    if (recentChanges.length > 0 && change > threshold) jumps.push(index);

    recentChanges.push(change);
    if (recentChanges.length > config.atrWindow) recentChanges.shift();
  }

  const atr = mean(absoluteChanges.slice(-config.atrWindow));
  const intervals = Math.max(0, sample.length - 1);
  const jumpIntensity = intervals > 0 ? jumps.length / intervals : 0;
  const ticksSinceJump = jumps.length > 0 ? sample.length - 1 - jumps[jumps.length - 1] : null;
  const elapsedTicks = ticksSinceJump ?? intervals;
  const hazard = intervals > 0 ? -Math.expm1(-jumpIntensity * elapsedTicks) : 0;
  const elevatedHazard = hazard >= config.elevatedHazardThreshold;
  const quietTicks = ticksSinceJump ?? intervals;
  const stabilized = intervals > 0 && quietTicks >= config.stabilizationTicks;
  const driftReturns = logReturns.slice(-config.driftWindow);
  const microDrift = mean(driftReturns);
  const driftDeviation = Math.sqrt(mean(driftReturns.map((value) => (value - microDrift) ** 2)));
  const driftZ = driftDeviation > Number.EPSILON && driftReturns.length > 1
    ? microDrift / (driftDeviation / Math.sqrt(driftReturns.length))
    : 0;

  const signals: Signal[] = [];
  if (!elevatedHazard && stabilized) {
    const digits = sample.map((tick) => tick.digit);
    const counts = digitCounts(digits.slice(-300));
    const sampleSize = counts.reduce((total, count) => total + count, 0);
    const probabilities = counts.map((count) => (count + 1) / (sampleSize + 10));
    const zScores = binomialZScores(counts);
    let hotDigit = 0;
    let coldDigit = 0;
    for (let digit = 1; digit < 10; digit += 1) {
      if (zScores[digit] > zScores[hotDigit]) hotDigit = digit;
      if (zScores[digit] < zScores[coldDigit]) coldDigit = digit;
    }

    const hotProbability = probabilities[hotDigit];
    const coldProbability = probabilities[coldDigit];
    const hotConfidence =
      clamp01((zScores[hotDigit] - 1.25) / 3) * clamp01((hotProbability - 0.1) / 0.15);
    const coldConfidence =
      clamp01((-zScores[coldDigit] - 1.25) / 3) * clamp01((0.1 - coldProbability) / 0.05);
    const createdAt = sample.at(-1)?.epoch ?? 0;

    if (sampleSize >= 30 && hotConfidence >= 0.15) {
      signals.push(
        makeDigitSignal(
          symbol,
          "DIGITMATCH",
          "match",
          hotDigit,
          conservativeProbability(hotProbability),
          hotConfidence,
          hotConfidence * clamp01((hotProbability - 0.1) / 0.2),
          [
            `post-stabilization smoothed digit probability ${hotProbability.toFixed(4)}`,
            `jump hazard ${hazard.toFixed(4)} is below elevated threshold`,
          ],
          createdAt,
        ),
      );
    }

    if (sampleSize >= 30 && coldConfidence >= 0.15) {
      const differsProbability = 1 - coldProbability;
      signals.push(
        makeDigitSignal(
          symbol,
          "DIGITDIFF",
          "differ",
          coldDigit,
          conservativeProbability(differsProbability),
          coldConfidence,
          coldConfidence * clamp01((0.1 - coldProbability) / 0.08),
          [
            `post-stabilization probability of avoiding digit ${coldDigit}: ${differsProbability.toFixed(4)}`,
            `jump hazard ${hazard.toFixed(4)} is below elevated threshold`,
          ],
          createdAt,
        ),
      );
    }

    const driftConfidence = clamp01((Math.abs(driftZ) - 1.25) / 3) * clamp01(sampleSize / 300);
    if (sampleSize >= 30 && driftConfidence >= 0.1) {
      const direction = microDrift >= 0 ? "up" : "down";
      const probability = clamp(0.5 + 0.06 * Math.tanh(Math.abs(driftZ)), 0.5, 0.68);
      const durationTicks = driftConfidence > 0.65 ? 5 : driftConfidence > 0.35 ? 4 : 3;
      signals.push(
        makeDriftSignal(
          symbol,
          direction,
          durationTicks,
          probability,
          driftConfidence,
          driftConfidence * clamp01((probability - 0.5) * 4),
          [
            `post-stabilization ${config.driftWindow}-tick micro-drift z ${driftZ.toFixed(3)}`,
            `jump hazard ${hazard.toFixed(4)} is below elevated threshold`,
          ],
          createdAt,
        ),
      );
    }
  }

  return {
    atr,
    jumps,
    jumpIntensity,
    hazard,
    elevatedHazard,
    ticksSinceJump,
    stabilized,
    microDrift,
    signals,
  };
}
