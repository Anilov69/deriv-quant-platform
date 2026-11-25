import type { ContinuousAnalysis, Signal, Tick } from "../types";

const MAX_TICKS = 1000;
const Z_SCORE_WINDOW = 300;
const VOLATILITY_WINDOW = 100;
const MOMENTUM_WINDOW = 5;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function populationStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  let squaredDeviations = 0;
  for (const value of values) {
    const deviation = value - average;
    squaredDeviations += deviation * deviation;
  }
  return Math.sqrt(squaredDeviations / values.length);
}

function lagOneCorrelation(values: readonly number[]): number {
  if (values.length < 3) return 0;
  const previous = values.slice(0, -1);
  const current = values.slice(1);
  const previousMean = mean(previous);
  const currentMean = mean(current);
  let covariance = 0;
  let previousVariance = 0;
  let currentVariance = 0;

  for (let index = 0; index < previous.length; index += 1) {
    const previousDeviation = previous[index] - previousMean;
    const currentDeviation = current[index] - currentMean;
    covariance += previousDeviation * currentDeviation;
    previousVariance += previousDeviation * previousDeviation;
    currentVariance += currentDeviation * currentDeviation;
  }

  if (previousVariance === 0 || currentVariance === 0) return 0;
  return clamp(covariance / Math.sqrt(previousVariance * currentVariance), -1, 1);
}

function digitCounts(digits: readonly number[]): number[] {
  const counts = Array<number>(10).fill(0);
  for (const digit of digits) counts[digit] += 1;
  return counts;
}

function shannonEntropy(counts: readonly number[]): number {
  const sampleSize = counts.reduce((total, count) => total + count, 0);
  if (sampleSize === 0) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / sampleSize;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function binomialZScores(counts: readonly number[]): number[] {
  const sampleSize = counts.reduce((total, count) => total + count, 0);
  if (sampleSize === 0) return Array<number>(10).fill(0);
  const expectedCount = sampleSize / 10;
  const standardDeviation = Math.sqrt(sampleSize * 0.1 * 0.9);
  if (standardDeviation === 0) return Array<number>(10).fill(0);
  return counts.map((count) => (count - expectedCount) / standardDeviation);
}

function smoothedDigitProbabilities(counts: readonly number[]): number[] {
  const sampleSize = counts.reduce((total, count) => total + count, 0);
  return counts.map((count) => (count + 1) / (sampleSize + 10));
}

function extremeDigit(scores: readonly number[], direction: "max" | "min"): number {
  let selected = 0;
  for (let digit = 1; digit < scores.length; digit += 1) {
    if (
      (direction === "max" && scores[digit] > scores[selected]) ||
      (direction === "min" && scores[digit] < scores[selected])
    ) {
      selected = digit;
    }
  }
  return selected;
}

function conservativeProbability(probability: number): number {
  return clamp(0.5 + (probability - 0.5) * 0.8, 0.01, 0.99);
}

function makeSignal(
  symbol: string,
  contractType: Signal["contractType"],
  direction: Signal["direction"],
  durationTicks: number,
  probability: number,
  confidence: number,
  score: number,
  reasons: string[],
  createdAt: number,
  barrier?: number,
): Signal {
  const key = `${barrier ?? direction}:${durationTicks}`;
  return {
    id: `continuous:${symbol}:${contractType}:${createdAt}:${key}`,
    symbol,
    family: "continuous",
    contractType,
    ...(barrier === undefined ? {} : { barrier: String(barrier) }),
    direction,
    durationTicks,
    probability: clamp01(probability),
    confidence: clamp01(confidence),
    score: clamp01(score),
    reasons,
    createdAt,
  };
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

export function analyzeContinuous(symbol: string, ticks: Tick[]): ContinuousAnalysis {
  const sample = validatedSample(ticks);
  const digits = sample.map((tick) => tick.digit);
  const counts100 = digitCounts(digits.slice(-100));
  const counts300 = digitCounts(digits.slice(-300));
  const counts1000 = digitCounts(digits.slice(-1000));

  // zScores use the 300-tick window; bollingerZ is on log returns, not quotes.
  const zScores = binomialZScores(counts300);
  const hotDigit = extremeDigit(zScores, "max");
  const coldDigit = extremeDigit(zScores, "min");

  let repeatedDigits = 0;
  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index] === digits[index - 1]) repeatedDigits += 1;
  }
  const repeatRate = digits.length > 1 ? repeatedDigits / (digits.length - 1) : 0;

  const logReturns: number[] = [];
  for (let index = 1; index < sample.length; index += 1) {
    logReturns.push(Math.log(sample[index].quote) - Math.log(sample[index - 1].quote));
  }
  const rollingReturns = logReturns.slice(-VOLATILITY_WINDOW);
  const volatility = populationStandardDeviation(rollingReturns);
  const rollingMean = mean(rollingReturns);
  const latestLogReturn = logReturns.at(-1) ?? 0;
  const bollingerZOnLogReturns =
    volatility > Number.EPSILON ? clamp((latestLogReturn - rollingMean) / volatility, -20, 20) : 0;

  const recentReturns = logReturns.slice(-MOMENTUM_WINDOW);
  const priorReturns = logReturns.slice(-MOMENTUM_WINDOW * 2, -MOMENTUM_WINDOW);
  const recentVelocity = mean(recentReturns.map((value) => Math.abs(value)));
  const priorVelocity = mean(priorReturns.map((value) => Math.abs(value)));
  const velocityDeceleration =
    priorVelocity > Number.EPSILON ? clamp((priorVelocity - recentVelocity) / priorVelocity, -1, 1) : 0;

  const signals: Signal[] = [];
  const createdAt = sample.at(-1)?.epoch ?? 0;
  const probabilities = smoothedDigitProbabilities(counts300);
  const hotProbability = probabilities[hotDigit];
  const coldDigitProbability = probabilities[coldDigit];
  const repeatReliability = clamp01(1 - Math.max(0, Math.max(repeatRate, lagOneCorrelation(digits)) - 0.1) / 0.6);
  const hotConfidence =
    clamp01((zScores[hotDigit] - 1.25) / 3) * clamp01((hotProbability - 0.1) / 0.15) * repeatReliability;
  const coldConfidence =
    clamp01((-zScores[coldDigit] - 1.25) / 3) * clamp01((0.1 - coldDigitProbability) / 0.05) * repeatReliability;

  if (digits.length >= 30 && hotConfidence >= 0.15) {
    signals.push(
      makeSignal(
        symbol,
        "DIGITMATCH",
        "match",
        1,
        conservativeProbability(hotProbability),
        hotConfidence,
        hotConfidence * clamp01((hotProbability - 0.1) / 0.2),
        [
          `300-tick smoothed digit probability ${hotProbability.toFixed(4)}`,
          `digit z-score ${zScores[hotDigit].toFixed(3)}`,
        ],
        createdAt,
        hotDigit,
      ),
    );
  }

  if (digits.length >= 30 && coldConfidence >= 0.15) {
    const differsProbability = 1 - coldDigitProbability;
    signals.push(
      makeSignal(
        symbol,
        "DIGITDIFF",
        "differ",
        1,
        conservativeProbability(differsProbability),
        coldConfidence,
        coldConfidence * clamp01((0.1 - coldDigitProbability) / 0.08),
        [
          `300-tick smoothed probability of avoiding digit ${coldDigit}: ${differsProbability.toFixed(4)}`,
          `digit z-score ${zScores[coldDigit].toFixed(3)}`,
        ],
        createdAt,
        coldDigit,
      ),
    );
  }

  const momentum = mean(recentReturns);
  const momentumScale = volatility > Number.EPSILON ? volatility : mean(logReturns.map((value) => Math.abs(value)));
  const momentumStrength = momentumScale > Number.EPSILON ? Math.abs(momentum) / momentumScale : 0;
  const meanReversionStrength = clamp01(Math.abs(bollingerZOnLogReturns) / 2);
  const hasMomentumReversionSetup =
    digits.length >= 30 &&
    logReturns.length >= MOMENTUM_WINDOW * 2 &&
    momentumStrength >= 0.1 &&
    Math.abs(bollingerZOnLogReturns) >= 0.25 &&
    Math.sign(momentum) === -Math.sign(bollingerZOnLogReturns);

  if (hasMomentumReversionSetup) {
    const direction = momentum > 0 ? "up" : "down";
    const confidence =
      clamp01((momentumStrength - 0.1) / 1.5) *
      meanReversionStrength *
      clamp01(digits.length / VOLATILITY_WINDOW);
    if (confidence >= 0.12) {
      const probability = clamp(
        0.5 + 0.06 * Math.tanh(momentumStrength) + 0.06 * meanReversionStrength,
        0.5,
        0.68,
      );
      const durationTicks = confidence > 0.65 ? 5 : confidence > 0.35 ? 4 : 3;
      signals.push(
        makeSignal(
          symbol,
          direction === "up" ? "CALL" : "PUT",
          direction,
          durationTicks,
          probability,
          confidence,
          confidence * clamp01((probability - 0.5) * 4),
          [
            `5-tick log-return momentum ${momentum.toExponential(3)}`,
            `log-return Bollinger z ${bollingerZOnLogReturns.toFixed(3)} confirms mean reversion`,
          ],
          createdAt,
        ),
      );
    }
  }

  return {
    digitCounts100: counts100,
    digitCounts300: counts300,
    digitCounts1000: counts1000,
    zScores,
    entropy100: shannonEntropy(counts100),
    entropy300: shannonEntropy(counts300),
    entropy1000: shannonEntropy(counts1000),
    hotDigit,
    coldDigit,
    repeatRate,
    lagAutocorrelation: lagOneCorrelation(digits),
    logReturn: latestLogReturn,
    volatility,
    bollingerZ: bollingerZOnLogReturns,
    velocityDeceleration,
    signals,
  };
}
