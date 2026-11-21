/**
 * Module A — Continuous (Volatility) Indices: R_10…R_100 and 1HZ variants.
 *
 * Market model: geometric Brownian motion with constant volatility σ, i.e. each
 * tick log-return rₜ = ln(Sₜ/Sₜ₋₁) ~ N(−σ²Δt/2, σ²Δt), independent across ticks.
 * Consequences the engine is built around:
 *   • the last decimal digit of a high-precision quote is ~uniform on 0–9;
 *   • direction over k ticks is ~a fair coin (minus ties).
 * Anything that looks like an edge must therefore be shown with its sample
 * size and significance, and is shrunk toward theory before EV is computed.
 */
import { binomialZ, chiSquareUniform, mean, shrunkProbability, std } from "./stats";
import {
  backtestDirection,
  candidateKey,
  digitsOf,
  frequencyDigitCandidates,
  riseFallBaseline,
} from "./shared";
import type { Candidate, EngineInput, EngineOutput } from "./types";

export const DIGIT_WINDOWS = [50, 100, 500, 1000] as const;

export interface DigitWindowStats {
  n: number;
  counts: number[];
  /** Empirical P(d) = countₐ / n. */
  freq: number[];
  /** Per-digit binomial z vs p = 0.10. */
  z: number[];
  chi2: number;
  pValue: number;
  evenRate: number;
  /** Even/Odd z vs p = 0.50. */
  evenZ: number;
  /** Digits with |Z| > 2 (short-term sample anomalies). */
  anomalies: number[];
}

export interface ContinuousInsights {
  digits: number[];
  windows: Record<number, DigitWindowStats>;
  /** Rolling Bollinger series aligned to prices (NaN while warming up). */
  bbMid: number[];
  bbUpper: number[];
  bbLower: number[];
  zNow: number;
  rNow: number;
  dRNow: number;
  /** Per-tick σ of log returns over the Bollinger window. */
  sigmaN: number;
  trigger: "fall" | "rise" | null;
}

export function digitWindowStats(digits: number[], window: number): DigitWindowStats {
  const recent = digits.slice(-window);
  const n = recent.length;
  const counts = Array(10).fill(0);
  for (const d of recent) counts[d]++;
  const freq = counts.map((c) => (n ? c / n : 0));
  const z = counts.map((c) => binomialZ(c, n, 0.1));
  const { chi2, pValue } = chiSquareUniform(counts);
  const even = counts[0] + counts[2] + counts[4] + counts[6] + counts[8];
  return {
    n,
    counts,
    freq,
    z,
    chi2,
    pValue,
    evenRate: n ? even / n : 0,
    evenZ: binomialZ(even, n, 0.5),
    anomalies: z.flatMap((v, d) => (Math.abs(v) > 2 ? [d] : [])),
  };
}

/**
 * Bollinger Z-score over the last N prices:  Zₜ = (Sₜ − μ_N) / σ_N,
 * where μ_N and σ_N are the rolling mean and standard deviation of price.
 */
export function bollinger(prices: number[], N: number) {
  const mid: number[] = [];
  const up: number[] = [];
  const lo: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i + 1 < N) {
      mid.push(NaN);
      up.push(NaN);
      lo.push(NaN);
      z.push(NaN);
      continue;
    }
    const w = prices.slice(i + 1 - N, i + 1);
    const m = mean(w);
    const s = std(w);
    mid.push(m);
    up.push(m + 2 * s);
    lo.push(m - 2 * s);
    z.push(s > 0 ? (prices[i] - m) / s : 0);
  }
  return { mid, up, lo, z };
}

export function runContinuousEngine(input: EngineInput): EngineOutput<ContinuousInsights> {
  const { prices, decimals, settings: st } = input;
  const digits = digitsOf(prices, decimals);
  const windows: Record<number, DigitWindowStats> = {};
  for (const w of DIGIT_WINDOWS) windows[w] = digitWindowStats(digits, w);

  const candidates: Candidate[] = frequencyDigitCandidates(
    digits,
    st.digitWindow,
    st.priorStrength,
    st.digitDuration,
    (s, k, n, cur, w) => {
      const z = binomialZ(cur, w, s.p0);
      return `Window: ${cur}/${w} (theory ${(s.p0 * 100).toFixed(0)}%, Z=${z.toFixed(2)}${Math.abs(z) > 2 ? " ⚑ anomaly" : ""}); walk-forward: ${k}/${n} wins when the window was this extreme`;
    },
  );

  // --- Rise/Fall: tick exhaustion + momentum deceleration ---------------------
  // rₜ = ln(Sₜ/Sₜ₋₁); Δrₜ = rₜ − rₜ₋₁ (“inflection” when it opposes the stretch).
  const r = prices.map((p, i) => (i === 0 ? 0 : Math.log(p / prices[i - 1])));
  const bb = bollinger(prices, st.bollingerN);
  const zThr = st.bollingerZ;
  // Up-exhaustion → expect Fall: price stretched above band AND last return smaller than previous (deceleration).
  const fallWhen = (i: number) => i >= 2 && bb.z[i] > zThr && r[i] - r[i - 1] < 0;
  // Down-exhaustion → expect Rise.
  const riseWhen = (i: number) => i >= 2 && bb.z[i] < -zThr && r[i] - r[i - 1] > 0;
  const last = prices.length - 1;
  const trigger = last >= 2 ? (fallWhen(last) ? "fall" : riseWhen(last) ? "rise" : null) : null;
  const rWindow = r.slice(-st.bollingerN);

  for (const d of st.riseFallDurations) {
    const p0 = riseFallBaseline(prices, d);
    for (const type of ["CALL", "PUT"] as const) {
      const when = type === "CALL" ? riseWhen : fallWhen;
      const { k, n } = backtestDirection(prices, type, d, when);
      candidates.push({
        key: candidateKey(type, d),
        contractType: type,
        duration: d,
        pModel: shrunkProbability(k, n, p0, st.priorStrength),
        pTheory: p0,
        k,
        n,
        active: trigger === (type === "CALL" ? "rise" : "fall"),
        rationale: `Mean-reversion after |Z|>${zThr} with Δr inflection: ${k}/${n} historical wins over ${d}t`,
      });
    }
  }

  return {
    family: "continuous",
    candidates,
    warmingUp: prices.length < Math.max(50, st.bollingerN + 2),
    insights: {
      digits,
      windows,
      bbMid: bb.mid,
      bbUpper: bb.up,
      bbLower: bb.lo,
      zNow: bb.z[last] ?? 0,
      rNow: r[last] ?? 0,
      dRNow: last >= 1 ? r[last] - r[last - 1] : 0,
      sigmaN: std(rWindow),
      trigger,
    },
  };
}
