/**
 * Estimators behind the ladder. Everything here is deliberately simple to state,
 * and every quantity is returned in a form the UI can explain:
 *
 *  - recency-weighted digit posterior (Dirichlet prior, exponential age weights)
 *  - Jeffreys repeat probability for the "same digit twice" event
 *  - EWMA z-score for mean reversion on CALL/PUT
 *  - jump intensity as a Poisson rate, so "quiet ticks" is exp(-lambda * k)
 */

export function digitsFrom(quotes: number[], decimals: number): number[] {
  const scale = Math.pow(10, Math.max(0, Math.min(8, decimals)));
  return quotes.map((quote) => {
    const scaled = Math.round(Math.abs(quote) * scale);
    return Math.floor((scaled % 10) + Number.EPSILON);
  });
}

export function weightedDigitCounts(digits: number[], halfLife = 80): number[] {
  const decay = Math.pow(0.5, 1 / Math.max(1, halfLife));
  const counts = new Array<number>(10).fill(0);
  for (let index = 0; index < digits.length; index += 1) {
    const age = digits.length - 1 - index;
    counts[Math.abs(digits[index]) % 10] += Math.pow(decay, age);
  }
  return counts;
}

export function posterior(counts: number[], prior = 0.5): number[] {
  const total = counts.reduce((sum, value) => sum + value, 0) + prior * 10;
  return counts.map((count) => (count + prior) / total);
}

export function entropyBits(probabilities: number[]): number {
  return probabilities.reduce((sum, probability) => {
    return probability > 0 ? sum - probability * Math.log2(probability) : sum;
  }, 0);
}

export function repeatProbability(digits: number[]): number {
  if (digits.length < 2) return 0.1;
  let repeats = 0;
  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index] === digits[index - 1]) repeats += 1;
  }
  return (repeats + 0.5) / (digits.length - 1 + 1);
}

export function momentumZ(quotes: number[], halfLife = 60): number {
  if (quotes.length < 20) return 0;
  const decay = Math.pow(0.5, 1 / Math.max(1, halfLife));
  let mean = 0;
  let weight = 0;
  for (let index = 0; index < quotes.length; index += 1) {
    const w = Math.pow(decay, quotes.length - 1 - index);
    mean += quotes[index] * w;
    weight += w;
  }
  mean /= weight;
  let variance = 0;
  for (let index = 0; index < quotes.length; index += 1) {
    const w = Math.pow(decay, quotes.length - 1 - index);
    variance += (quotes[index] - mean) * (quotes[index] - mean) * w;
  }
  const sigma = Math.sqrt(variance / weight);
  if (!(sigma > 0)) return 0;
  return (quotes[quotes.length - 1] - mean) / sigma;
}

export interface JumpProfile {
  intensity: number;
  sinceLast: number;
  threshold: number;
}

export function jumpProfile(quotes: number[], window = 100, multiple = 3): JumpProfile {
  if (quotes.length < 20) return { intensity: 0, sinceLast: Math.max(0, quotes.length - 1), threshold: 0 };
  const changes: number[] = [];
  let jumps = 0;
  let lastJump = -1;
  let threshold = 0;
  for (let index = 1; index < quotes.length; index += 1) {
    const change = Math.abs(quotes[index] - quotes[index - 1]);
    const average = changes.length > 0 ? changes.slice(-window).reduce((a, b) => a + b, 0) / Math.min(changes.length, window) : 0;
    threshold = Math.max(average * multiple, 1e-9);
    if (changes.length >= 5 && change > threshold) {
      jumps += 1;
      lastJump = index;
    }
    changes.push(change);
  }
  const intervals = Math.max(1, quotes.length - 1);
  return {
    intensity: jumps / intervals,
    sinceLast: lastJump >= 0 ? quotes.length - 1 - lastJump : intervals,
    threshold,
  };
}

/** P(no jump in the next k ticks) under a Poisson rate. */
export function quietProbability(intensity: number, k: number): number {
  return Math.exp(-Math.max(0, intensity) * Math.max(0, k));
}

export function evPerStake(probability: number, ask: number, payout: number): number {
  return probability * payout - ask;
}
