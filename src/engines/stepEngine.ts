/**
 * Module B — Step Indices (stpRNG, stpRNG2…5).
 *
 * Market model: a discrete random walk. Every tick moves by exactly ±s
 * (s = 0.1 for Step 100, 0.2 for Step 200, …) with P(up) = P(down) = ½,
 * independently. Consequences:
 *   • streak lengths are geometric: P(streak ≥ k) = 0.5^k (for a fresh run);
 *   • the next last digit is a *deterministic* function of the current digit and
 *     the step direction (d → d ± s·10 mod 10), so parity transitions are known
 *     exactly — which is why Deriv does not offer digit contracts on these indices.
 *     The engine still models them and the UI marks them "not offered" via
 *     `contracts_for`.
 */
import { autocorr1, shrunkProbability } from "./stats";
import { backtestDirection, candidateKey, digitSpecs, digitsOf, riseFallBaseline } from "./shared";
import type { Candidate, EngineInput, EngineOutput } from "./types";

export interface StepInsights {
  digits: number[];
  /** Observed step sizes (in price units) and their frequencies. */
  stepSizes: { size: number; count: number }[];
  streak: number;
  streakDir: 1 | -1 | 0;
  /** P(streak ≥ k) = 0.5^k under the fair random-walk null. */
  streakTailP: number;
  /** Lag-1 autocorrelation ρ(1) of step directions (≈0 under the null). */
  rho1: number;
  /** Strategy mode implied by ρ(1): reversion when ρ<−0.05, continuation when ρ>0.05. */
  mode: "reversion" | "continuation" | "neutral";
  /** Observed run-length histogram: runs[k] = number of completed runs of length k. */
  runs: number[];
  /** 10×10 last-digit transition counts over the contract horizon. */
  transitions: number[][];
  /** Empirical P(next digit = j | current digit), row for the current digit. */
  nextDigitDist: number[];
  currentDigit: number;
}

export function runStepEngine(input: EngineInput): EngineOutput<StepInsights> {
  const { prices, decimals, settings: st } = input;
  const scale = Math.pow(10, decimals);
  // Steps rounded to the pip grid to kill float noise: Δₜ = round((Sₜ − Sₜ₋₁)·10^dec)/10^dec.
  const steps = prices.slice(1).map((p, i) => Math.round((p - prices[i]) * scale) / scale);
  const signs = steps.map((s) => Math.sign(s) as 1 | -1 | 0);

  const sizeMap = new Map<number, number>();
  for (const s of steps) sizeMap.set(Math.abs(s), (sizeMap.get(Math.abs(s)) ?? 0) + 1);
  const stepSizes = [...sizeMap.entries()].sort((a, b) => a[0] - b[0]).map(([size, count]) => ({ size, count }));

  // Run lengths: streak[i] = number of consecutive same-direction steps ending at price index i.
  const streakAt: number[] = Array(prices.length).fill(0);
  const dirAt: number[] = Array(prices.length).fill(0);
  const runs: number[] = Array(30).fill(0);
  for (let i = 1; i < prices.length; i++) {
    const s = signs[i - 1];
    if (s !== 0 && s === dirAt[i - 1]) streakAt[i] = streakAt[i - 1] + 1;
    else {
      if (streakAt[i - 1] > 0) runs[Math.min(29, streakAt[i - 1])]++;
      streakAt[i] = s === 0 ? 0 : 1;
    }
    dirAt[i] = s;
  }
  const last = prices.length - 1;
  const streak = last >= 0 ? streakAt[last] : 0;
  const streakDir = (last >= 0 ? dirAt[last] : 0) as 1 | -1 | 0;
  const rho1 = autocorr1(signs.slice(-500).map(Number));
  const mode = rho1 < -0.05 ? "reversion" : rho1 > 0.05 ? "continuation" : "neutral";

  const candidates: Candidate[] = [];
  const kMin = st.minStreak;
  const active = streak >= kMin;
  // Rise/Fall after an extreme streak. Back-test both directions conditioned on
  // the *direction* of the streak, so the data decides reversion vs continuation.
  for (const d of st.riseFallDurations) {
    const p0 = riseFallBaseline(prices, d);
    for (const type of ["CALL", "PUT"] as const) {
      // Condition: a ≥kMin streak in the same direction as the current one ends at i.
      const when = (i: number) => streakAt[i] >= kMin && dirAt[i] === (streakDir || 1);
      const { k, n } = backtestDirection(prices, type, d, when);
      const reverting = (type === "CALL" && streakDir === -1) || (type === "PUT" && streakDir === 1);
      candidates.push({
        key: candidateKey(type, d),
        contractType: type,
        duration: d,
        pModel: shrunkProbability(k, n, p0, st.priorStrength),
        pTheory: p0,
        k,
        n,
        active: active && (mode === "neutral" || (mode === "reversion") === reverting),
        rationale: `${reverting ? "Reversion" : "Continuation"} after ≥${kMin}-step ${streakDir >= 0 ? "up" : "down"} streak (P=${(0.5 ** kMin * 100).toFixed(2)}%): ${k}/${n} wins over ${d}t, ρ(1)=${rho1.toFixed(3)}`,
      });
    }
  }

  // Digit transition model over the contract horizon h = duration + 1 ticks.
  const digits = digitsOf(prices, decimals);
  const h = st.digitDuration + 1;
  const transitions = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 0; i + h < digits.length; i++) transitions[digits[i]][digits[i + h]]++;
  const currentDigit = digits[last] ?? 0;
  const row = transitions[currentDigit];
  const rowN = row.reduce((a, b) => a + b, 0);
  const nextDigitDist = row.map((c) => (rowN ? c / rowN : 0.1));
  for (const s of digitSpecs()) {
    // P_model = P(win | current digit) from the empirical transition row.
    const k = row.reduce((acc, c, j) => acc + (s.wins(j) ? c : 0), 0);
    candidates.push({
      key: candidateKey(s.type, st.digitDuration, s.barrier),
      contractType: s.type,
      barrier: s.barrier?.toString(),
      duration: st.digitDuration,
      pModel: shrunkProbability(k, rowN, s.p0, st.priorStrength),
      pTheory: s.p0,
      k,
      n: rowN,
      active: true,
      rationale: `Transition from digit ${currentDigit} over ${h} steps: ${k}/${rowN} historical wins`,
    });
  }

  return {
    family: "step",
    candidates,
    warmingUp: prices.length < 100,
    insights: {
      digits,
      stepSizes,
      streak,
      streakDir,
      streakTailP: Math.pow(0.5, streak),
      rho1,
      mode,
      runs,
      transitions,
      nextDigitDist,
      currentDigit,
    },
  };
}
