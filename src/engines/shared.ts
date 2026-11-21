import type { ContractType } from "@/lib/markets";
import { conditionalHits, lastDigit, shrunkProbability } from "./stats";
import type { Candidate } from "./types";

/**
 * Tick-contract timing used in all back-tests: a contract bought at tick i
 * has its entry spot at i+1 and its exit spot `duration` ticks later, at
 * i + 1 + duration (Deriv uses the next tick after purchase as entry).
 */
export const exitIndex = (i: number, duration: number) => i + 1 + duration;

export function digitsOf(prices: number[], decimals: number): number[] {
  return prices.map((p) => lastDigit(p, decimals));
}

interface DigitSpec {
  type: ContractType;
  barrier?: number;
  /** Win condition on the settlement digit. */
  wins: (d: number) => boolean;
  /** Fair probability under a uniform digit distribution. */
  p0: number;
}

/** All 1-condition digit contracts: Even/Odd, Over 0–8, Under 1–9, Matches/Differs 0–9. */
export function digitSpecs(): DigitSpec[] {
  const specs: DigitSpec[] = [
    { type: "DIGITEVEN", wins: (d) => d % 2 === 0, p0: 0.5 },
    { type: "DIGITODD", wins: (d) => d % 2 === 1, p0: 0.5 },
  ];
  for (let b = 0; b <= 8; b++) specs.push({ type: "DIGITOVER", barrier: b, wins: (d) => d > b, p0: (9 - b) / 10 });
  for (let b = 1; b <= 9; b++) specs.push({ type: "DIGITUNDER", barrier: b, wins: (d) => d < b, p0: b / 10 });
  for (let b = 0; b <= 9; b++) specs.push({ type: "DIGITMATCH", barrier: b, wins: (d) => d === b, p0: 0.1 });
  for (let b = 0; b <= 9; b++) specs.push({ type: "DIGITDIFF", barrier: b, wins: (d) => d !== b, p0: 0.9 });
  return specs;
}

export function candidateKey(type: ContractType, duration: number, barrier?: string | number) {
  return `${type}|${barrier ?? ""}|${duration}`;
}

/**
 * Walk-forward digit model. The live window frequency is only a *description*
 * of the recent sample; what matters is whether that state has predicted the
 * next settlement digit. So for every contract we back-test:
 *   when(i):  the trailing-`window` win count at tick i is at least as extreme
 *             (same side of n·p₀) as it is right now;
 *   win(i):   the digit at the settlement tick i + 1 + duration satisfies the contract.
 * P_model = (k + α·p₀) / (n + α) over those historical occurrences.
 * Under the RNG null (iid uniform digits) P_model → p₀ whatever the window shows.
 */
export function frequencyDigitCandidates(
  digits: number[],
  window: number,
  alpha: number,
  duration: number,
  why: (spec: DigitSpec, k: number, n: number, curHits: number, curN: number) => string,
): Candidate[] {
  const N = digits.length;
  const w = Math.min(window, N);
  return digitSpecs().map((s) => {
    // trailing[i] = wins among digits[i-w+1..i]  (running sum, O(N)).
    const hit = digits.map((d) => (s.wins(d) ? 1 : 0));
    const trailing: number[] = Array(N).fill(NaN);
    let run = 0;
    for (let i = 0; i < N; i++) {
      run += hit[i];
      if (i >= w) run -= hit[i - w];
      if (i >= w - 1) trailing[i] = run;
    }
    const cur = N ? trailing[N - 1] : NaN;
    const hot = cur >= w * s.p0;
    const { k, n } = conditionalHits(
      N,
      (i) => Number.isFinite(trailing[i]) && (hot ? trailing[i] >= cur : trailing[i] <= cur),
      (i) => {
        const e = exitIndex(i, duration);
        return e < N ? hit[e] === 1 : null;
      },
    );
    return {
      key: candidateKey(s.type, duration, s.barrier),
      contractType: s.type,
      barrier: s.barrier?.toString(),
      duration,
      pModel: shrunkProbability(k, n, s.p0, alpha),
      pTheory: s.p0,
      k,
      n,
      active: true,
      rationale: why(s, k, n, Number.isFinite(cur) ? cur : 0, w),
    };
  });
}

/**
 * Baseline Rise/Fall probability from the buffer: the share of non-tie moves,
 * halved. Deriv Rise/Fall loses on a tie (exit == entry), so on coarse-pip
 * indices the fair win-rate is ½·(1 − P(tie)), not ½.
 */
export function riseFallBaseline(prices: number[], duration: number): number {
  let ties = 0;
  let n = 0;
  for (let i = 0; exitIndex(i, duration) < prices.length; i++) {
    n++;
    if (prices[exitIndex(i, duration)] === prices[i + 1]) ties++;
  }
  return n === 0 ? 0.5 : 0.5 * (1 - ties / n);
}

/** Back-test a directional rule: P(win) of CALL/PUT bought whenever `when(i)` holds. */
export function backtestDirection(
  prices: number[],
  type: "CALL" | "PUT",
  duration: number,
  when: (i: number) => boolean,
) {
  return conditionalHits(prices.length, when, (i) => {
    const e = exitIndex(i, duration);
    if (e >= prices.length) return null;
    return type === "CALL" ? prices[e] > prices[i + 1] : prices[e] < prices[i + 1];
  });
}
