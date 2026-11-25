import type { Signal, StepAnalysis, Tick } from "../types";

const MAX_TICKS = 1000;
const DIGIT_COUNT = 10;
const TRANSITION_PRIOR = 1;

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

function emptyMatrix(): number[][] {
  return Array.from({ length: DIGIT_COUNT }, () => Array<number>(DIGIT_COUNT).fill(0));
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

function conservativeProbability(probability: number): number {
  return clamp(0.5 + (probability - 0.5) * 0.8, 0.01, 0.99);
}

function makeSignal(
  symbol: string,
  contractType: Signal["contractType"],
  direction: Signal["direction"],
  probability: number,
  confidence: number,
  score: number,
  reasons: string[],
  createdAt: number,
  barrier: number,
): Signal {
  return {
    id: `step:${symbol}:${contractType}:${createdAt}:${barrier}:1`,
    symbol,
    family: "step",
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

export function analyzeStep(symbol: string, ticks: Tick[]): StepAnalysis {
  const sample = validatedSample(ticks);
  const digits = sample.map((tick) => tick.digit);
  const transitionCounts = emptyMatrix();
  const observedSteps: number[] = [];

  for (let index = 1; index < digits.length; index += 1) {
    const previousDigit = digits[index - 1];
    const currentDigit = digits[index];
    transitionCounts[previousDigit][currentDigit] += 1;
    observedSteps.push(Math.abs(currentDigit - previousDigit));
  }

  const transitionMatrix = transitionCounts.map((row) => {
    const rowTotal = row.reduce((total, count) => total + count, 0);
    return row.map((count) => (count + TRANSITION_PRIOR) / (rowTotal + DIGIT_COUNT * TRANSITION_PRIOR));
  });

  const currentDigit = digits.at(-1) ?? 0;
  const currentRow = transitionMatrix[currentDigit];
  const rowObservations = transitionCounts[currentDigit].reduce((total, count) => total + count, 0);

  let lowProbabilityBarrier = 0;
  for (let digit = 1; digit < DIGIT_COUNT; digit += 1) {
    if (currentRow[digit] < currentRow[lowProbabilityBarrier]) lowProbabilityBarrier = digit;
  }

  const allowedSteps = new Set(observedSteps);
  let highProbabilityNeighbor = -1;
  let neighborProbability = 0;
  for (let digit = 0; digit < DIGIT_COUNT; digit += 1) {
    if (digit === currentDigit) continue;
    if (allowedSteps.size > 0 && !allowedSteps.has(Math.abs(digit - currentDigit))) continue;
    if (currentRow[digit] > neighborProbability) {
      highProbabilityNeighbor = digit;
      neighborProbability = currentRow[digit];
    }
  }

  let streak = 0;
  let streakDirection: StepAnalysis["streakDirection"] = "none";
  if (digits.length > 1) {
    const latestStep = digits[digits.length - 1] - digits[digits.length - 2];
    if (latestStep !== 0) {
      const direction = latestStep > 0 ? 1 : -1;
      streakDirection = direction > 0 ? "up" : "down";
      for (let index = digits.length - 1; index > 0; index -= 1) {
        const step = digits[index] - digits[index - 1];
        if (Math.sign(step) !== direction) break;
        streak += 1;
      }
    }
  }

  const signedSteps: number[] = [];
  for (let index = 1; index < digits.length; index += 1) {
    signedSteps.push(digits[index] - digits[index - 1]);
  }
  let reversals = 0;
  let reversalComparisons = 0;
  for (let index = 1; index < signedSteps.length; index += 1) {
    if (signedSteps[index] === 0 || signedSteps[index - 1] === 0) continue;
    reversalComparisons += 1;
    if (Math.sign(signedSteps[index]) === -Math.sign(signedSteps[index - 1])) reversals += 1;
  }
  const meanReversionScore = reversalComparisons > 0 ? reversals / reversalComparisons : 0;

  const signals: Signal[] = [];
  const createdAt = sample.at(-1)?.epoch ?? 0;
  const sampleConfidence = 1 - Math.exp(-rowObservations / 30);
  const matchProbability = currentRow[currentDigit];
  const lowBarrierProbability = currentRow[lowProbabilityBarrier];
  const differsProbability = 1 - lowBarrierProbability;
  const matchEdge = Math.max(0, matchProbability - 0.1);
  const differsEdge = Math.max(0, 0.1 - lowBarrierProbability);
  const matchConfidence = sampleConfidence * clamp01(matchEdge / 0.2);
  const differsConfidence = sampleConfidence * clamp01(differsEdge / 0.08);

  if (rowObservations >= 12 && matchConfidence >= 0.1) {
    signals.push(
      makeSignal(
        symbol,
        "DIGITMATCH",
        "match",
        conservativeProbability(matchProbability),
        matchConfidence,
        matchConfidence * clamp01(matchEdge / 0.25),
        [
          `Bayesian-smoothed repeat probability ${matchProbability.toFixed(4)}`,
          `${rowObservations} observed transitions from digit ${currentDigit}`,
          "empirical transition estimate, not a deterministic prediction",
        ],
        createdAt,
        currentDigit,
      ),
    );
  }

  if (rowObservations >= 12 && differsConfidence >= 0.1) {
    signals.push(
      makeSignal(
        symbol,
        "DIGITDIFF",
        "differ",
        conservativeProbability(differsProbability),
        differsConfidence,
        differsConfidence * clamp01(differsEdge / 0.1),
        [
          `Bayesian-smoothed probability of avoiding low-probability digit ${lowProbabilityBarrier}: ${differsProbability.toFixed(4)}`,
          `${rowObservations} observed transitions from digit ${currentDigit}`,
          "empirical transition estimate, not a deterministic prediction",
        ],
        createdAt,
        lowProbabilityBarrier,
      ),
    );
  }

  let riseProbability = 0;
  let fallProbability = 0;
  for (let digit = 0; digit < DIGIT_COUNT; digit += 1) {
    if (digit > currentDigit) riseProbability += currentRow[digit];
    if (digit < currentDigit) fallProbability += currentRow[digit];
  }
  const riseBaseline = (9 - currentDigit) / DIGIT_COUNT;
  const fallBaseline = currentDigit / DIGIT_COUNT;
  const riseEdge = riseProbability - riseBaseline;
  const fallEdge = fallProbability - fallBaseline;
  const riseConfidence = sampleConfidence * clamp01(riseEdge / 0.25);
  const fallConfidence = sampleConfidence * clamp01(fallEdge / 0.25);

  if (rowObservations >= 12 && riseEdge >= 0.06 && riseConfidence >= 0.1 && highProbabilityNeighbor > currentDigit) {
    signals.push(
      makeSignal(
        symbol,
        "CALL",
        "up",
        conservativeProbability(riseProbability),
        riseConfidence,
        riseConfidence * clamp01(riseEdge / 0.3),
        [
          `one-tick rise probability ${riseProbability.toFixed(4)} versus uniform ${riseBaseline.toFixed(4)}`,
          `current directional streak ${streakDirection} ${streak}`,
          `high-probability observed-step neighbor ${highProbabilityNeighbor} at ${neighborProbability.toFixed(4)}`,
          "empirical transition estimate, not a deterministic prediction",
        ],
        createdAt,
        currentDigit,
      ),
    );
  }

  if (rowObservations >= 12 && fallEdge >= 0.06 && fallConfidence >= 0.1 && highProbabilityNeighbor >= 0 && highProbabilityNeighbor < currentDigit) {
    signals.push(
      makeSignal(
        symbol,
        "PUT",
        "down",
        conservativeProbability(fallProbability),
        fallConfidence,
        fallConfidence * clamp01(fallEdge / 0.3),
        [
          `one-tick fall probability ${fallProbability.toFixed(4)} versus uniform ${fallBaseline.toFixed(4)}`,
          `current directional streak ${streakDirection} ${streak}`,
          `high-probability observed-step neighbor ${highProbabilityNeighbor} at ${neighborProbability.toFixed(4)}`,
          "empirical transition estimate, not a deterministic prediction",
        ],
        createdAt,
        currentDigit,
      ),
    );
  }

  return {
    transitionMatrix,
    transitionCounts,
    observedSteps,
    maxObservedStep: observedSteps.length > 0 ? Math.max(...observedSteps) : 0,
    currentDigit,
    lowProbabilityBarrier,
    highProbabilityNeighbor,
    neighborProbability,
    streak,
    streakDirection,
    lagAutocorrelation: lagOneCorrelation(digits),
    meanReversionScore,
    signals,
  };
}
