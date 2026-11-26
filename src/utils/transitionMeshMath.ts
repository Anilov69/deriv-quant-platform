/**
 * Pure math for the transition mesh and the 3-digit DIGITMATCH hedge.
 *
 * Digits are always extracted from a *formatted* quote string, never by
 * slicing a raw JS number: 1234.50 stringifies as 1234.5 and the trailing
 * zero becomes a bogus last digit. Callers pass the symbol precision
 * (decimal places from pip size) into `digitsFromQuotes`.
 */

export interface MeshWindow {
  lookback: number;
  /** Digits actually used (may be shorter than lookback while warming up). */
  total: number;
  counts: number[];
  percentages: number[];
  /** transitions[from][to] inside the window. */
  transitions: number[][];
  hottest: number;
  hottestCount: number;
  runnerUp: number;
  runnerUpCount: number;
  coldest: number[];
}

export type ConsensusKind = "triple" | "strong" | "weak";

export interface Consensus {
  kind: ConsensusKind;
  /** The aligned digit, or null when the windows disagree. */
  digit: number | null;
  hot: number[];
}

export interface RankedDigit {
  digit: number;
  score: number;
  /** Normalised average share of the three windows (0..1). */
  frequency: number;
  /** Empirical P(next = digit | current digit) from the largest window. */
  transition: number;
}

export interface MeshEvaluation {
  digits: number[];
  meshes: MeshWindow[];
  center: number;
  consensus: Consensus;
  ranked: RankedDigit[];
}

export const MIN_STAKE = 0.35;
export const UNIFORM_THREE_DIGIT = 0.3;

export const PREDICTION_COUNTS = [3, 4, 5] as const;
export type PredictionCount = (typeof PREDICTION_COUNTS)[number];

/** Default minimum combined P(hit) gate, scaled with the number of picks. */
export const DEFAULT_DOMINANCE_PERCENT: Record<PredictionCount, number> = {
  3: 36,
  4: 47,
  5: 58,
};

/** Uniform random hit rate for K picks out of ten digits. */
export const UNIFORM_BASELINE: Record<PredictionCount, number> = {
  3: 0.3,
  4: 0.4,
  5: 0.5,
};

/** Auto-matched recovery multiplier, smaller as coverage gets wider. */
export const AUTO_MULTIPLIER: Record<PredictionCount, number> = {
  3: 1.6,
  4: 1.9,
  5: 2.4,
};

export const ROI_BADGE: Record<PredictionCount, string> = {
  3: "Sweet Spot · ~197% ROI",
  4: "Balanced · ~123% ROI",
  5: "High Coverage · ~78% ROI",
};

export const MAX_MARTINGALE_LEVELS = 6;
export const MIN_MULTIPLIER = 1.1;
export const MAX_MULTIPLIER = 5;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function decimalsFromPip(pip: number): number {
  if (!Number.isFinite(pip) || pip <= 0) return 2;
  return Math.min(8, Math.max(0, Math.round(-Math.log10(pip))));
}

export function formatQuote(quote: number, decimals: number): string {
  if (!Number.isFinite(quote)) return "0";
  return quote.toFixed(decimals);
}

export function lastDigit(quote: number, decimals: number): number {
  const text = formatQuote(quote, decimals);
  const digit = Number(text.slice(-1));
  return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit : 0;
}

export function digitsFromQuotes(quotes: number[], decimals: number): number[] {
  return quotes.map((quote) => lastDigit(quote, decimals));
}

export function buildMesh(digits: number[], lookback: number): MeshWindow {
  const width = Math.max(1, Math.floor(lookback));
  const window = digits.slice(-width);
  const counts: number[] = new Array<number>(10).fill(0);
  for (const digit of window) {
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit] += 1;
  }
  const total = window.length;
  const percentages = counts.map((count) => (total > 0 ? (count / total) * 100 : 0));
  const transitions: number[][] = [];
  for (let from = 0; from < 10; from += 1) transitions.push(new Array<number>(10).fill(0));
  for (let index = 1; index < window.length; index += 1) {
    const from = window[index - 1];
    const to = window[index];
    if (from >= 0 && from <= 9 && to >= 0 && to <= 9) transitions[from][to] += 1;
  }
  let hottest = 0;
  for (let digit = 1; digit < 10; digit += 1) {
    if (counts[digit] > counts[hottest]) hottest = digit;
  }
  let runnerUp = hottest === 0 ? 1 : 0;
  for (let digit = 0; digit < 10; digit += 1) {
    if (digit === hottest) continue;
    if (counts[digit] > counts[runnerUp]) runnerUp = digit;
  }
  const coldest: number[] = [];
  if (total > 0) {
    const minCount = Math.min(...counts);
    for (let digit = 0; digit < 10; digit += 1) {
      if (counts[digit] === minCount) coldest.push(digit);
    }
  }
  return {
    lookback: width,
    total,
    counts,
    percentages,
    transitions,
    hottest,
    hottestCount: counts[hottest],
    runnerUp,
    runnerUpCount: counts[runnerUp],
    coldest,
  };
}

export type NodeTone = "hot" | "runner" | "cold" | "mid";

export function nodeTone(mesh: MeshWindow, digit: number): NodeTone {
  if (mesh.total <= 0) return "mid";
  if (digit === mesh.hottest) return "hot";
  if (digit === mesh.runnerUp) return "runner";
  if (mesh.coldest.includes(digit)) return "cold";
  return "mid";
}

export function consensusOf(meshes: MeshWindow[]): Consensus {
  const hot = meshes.map((mesh) => mesh.hottest);
  if (meshes.some((mesh) => mesh.total === 0)) return { kind: "weak", digit: null, hot };
  if (meshes.length >= 3 && hot[0] === hot[1] && hot[1] === hot[2]) {
    return { kind: "triple", digit: hot[0], hot };
  }
  if (meshes.length >= 3) {
    const pairs: Array<[number, number, number]> = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 2, 0],
    ];
    for (const [first, second, third] of pairs) {
      if (hot[first] === hot[second] && meshes[third].runnerUp === hot[first]) {
        return { kind: "strong", digit: hot[first], hot };
      }
    }
  }
  return { kind: "weak", digit: null, hot };
}

export function transitionRow(mesh: MeshWindow, from: number): number[] {
  if (from < 0 || from > 9) return new Array<number>(10).fill(0);
  return mesh.transitions[from].slice();
}

export function transitionProbabilities(mesh: MeshWindow, from: number): number[] {
  const row = transitionRow(mesh, from);
  const total = row.reduce((sum, count) => sum + count, 0);
  return row.map((count) => (total > 0 ? count / total : 0));
}

export function scoreDigits(meshes: MeshWindow[], center: number, stepFilter: boolean): RankedDigit[] {
  const frequency: number[] = new Array<number>(10).fill(0);
  for (const mesh of meshes) {
    if (mesh.total <= 0) continue;
    for (let digit = 0; digit < 10; digit += 1) {
      frequency[digit] += mesh.counts[digit] / mesh.total;
    }
  }
  const totalFrequency = frequency.reduce((sum, value) => sum + value, 0);
  if (totalFrequency > 0) {
    for (let digit = 0; digit < 10; digit += 1) frequency[digit] /= totalFrequency;
  }
  const largest = meshes.reduce((best, mesh) => (mesh.total > best.total ? mesh : best), meshes[0]);
  const transitions = largest ? transitionProbabilities(largest, center) : new Array<number>(10).fill(0);
  const ranked: RankedDigit[] = [];
  for (let digit = 0; digit < 10; digit += 1) {
    let score = 0.6 * frequency[digit] + 0.4 * transitions[digit];
    if (stepFilter && transitions[digit] <= 0) score = 0;
    ranked.push({ digit, score, frequency: frequency[digit], transition: transitions[digit] });
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.digit - b.digit));
  return ranked;
}

export function topDigits(ranked: RankedDigit[], count = 3): RankedDigit[] {
  return ranked.filter((entry) => entry.score > 0).slice(0, count);
}

export function combinedProbability(top: RankedDigit[]): number {
  return top.reduce((sum, entry) => sum + entry.transition, 0);
}

export function dominanceShare(combined: number, baseline = UNIFORM_THREE_DIGIT): number {
  if (!Number.isFinite(baseline) || baseline <= 0) return 0;
  return combined / baseline;
}

/**
 * Flat: every leg at the per-digit stake.
 * Weighted: leg #1 gets a further 1.5x of the per-digit stake; legs #2..K stay
 * at the per-digit stake. Every leg is clamped to the 0.35 Deriv minimum.
 */
export function splitStakes(base: number, weighted: boolean, count = 3): number[] {
  const clean = round2(Math.max(MIN_STAKE, Number.isFinite(base) ? base : MIN_STAKE));
  const legs = Math.max(1, Math.min(PREDICTION_COUNTS[PREDICTION_COUNTS.length - 1], Math.floor(count)));
  if (!weighted) return new Array<number>(legs).fill(clean);
  const boosted = round2(Math.max(MIN_STAKE, clean + clean * 1.5));
  const stakes = new Array<number>(legs).fill(clean);
  stakes[0] = boosted;
  return stakes;
}

/** stepStakePerDigit = +(base * multiplier^level).toFixed(2), floored at 0.35. */
export function martingaleStake(base: number, multiplier: number, level: number): number {
  const cleanBase = Number.isFinite(base) ? base : MIN_STAKE;
  const factor = Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, Number.isFinite(multiplier) ? multiplier : 1.6));
  const step = Math.max(0, Math.floor(level));
  return round2(Math.max(MIN_STAKE, cleanBase * Math.pow(factor, step)));
}

/** A win resets to 0; a loss at the cap also resets instead of going past it. */
export function nextMartingaleLevel(level: number, maxLevels: number, lost: boolean): number {
  if (!lost) return 0;
  const cap = Math.max(1, Math.min(MAX_MARTINGALE_LEVELS, Math.floor(maxLevels)));
  const current = Math.max(0, Math.min(cap, Math.floor(level)));
  return current >= cap ? 0 : current + 1;
}

/** Probability of missing level + 1 rounds in a row. */
export function streakMissProbability(combined: number, level: number): number {
  const miss = Math.min(1, Math.max(0, 1 - (Number.isFinite(combined) ? combined : 0)));
  return Math.pow(miss, Math.max(0, Math.floor(level)) + 1);
}

export function bundleTotal(stakes: readonly number[]): number {
  return round2(stakes.reduce((sum, stake) => sum + stake, 0));
}

export function evaluateMesh(
  quotes: number[],
  decimals: number,
  lookbacks: readonly number[],
  stepFilter: boolean,
): MeshEvaluation {
  const digits = digitsFromQuotes(quotes, decimals);
  const meshes = lookbacks.map((lookback) => buildMesh(digits, lookback));
  const center = digits.length > 0 ? digits[digits.length - 1] : -1;
  return {
    digits,
    meshes,
    center,
    consensus: consensusOf(meshes),
    ranked: scoreDigits(meshes, center, stepFilter),
  };
}
