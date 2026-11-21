/**
 * Module C — Jump Indices (JD10…JD100).
 *
 * Market model: Brownian diffusion plus a compound-Poisson jump component.
 * Jumps arrive with intensity λ ≈ 3/hour (λ ≈ 1/1200 s⁻¹) and are ~30× a
 * normal tick move. Two facts drive the engine:
 *   • Poisson arrivals are memoryless: P(jump in next T s) = 1 − e^(−λT)
 *     regardless of the time since the last jump. The "inter-jump timer" is
 *     shown for context, but it does not raise or lower the hazard.
 *   • A jump inside a short Rise/Fall contract dominates its outcome, so
 *     Rise/Fall is blocked when that hazard is above the user threshold.
 */
import { mean, shrunkProbability, std } from "./stats";
import { backtestDirection, candidateKey, digitsOf, frequencyDigitCandidates, riseFallBaseline } from "./shared";
import type { Candidate, EngineInput, EngineOutput } from "./types";

export interface JumpEvent {
  index: number;
  time: number;
  size: number;
}

export interface JumpInsights {
  digits: number[];
  jumps: JumpEvent[];
  atr20: number;
  /** σ of tick changes excluding detected jumps. */
  sigmaTick: number;
  /** Seconds since the last detected jump (null if none in buffer). */
  secondsSinceJump: number | null;
  ticksSinceJump: number | null;
  /** Posterior λ̂ (jumps/s) from a Gamma prior centred on the configured λ. */
  lambda: number;
  /** Mean seconds between ticks. */
  tickSeconds: number;
  /** Hazard per Rise/Fall duration: P(jump within d ticks). */
  hazard: { duration: number; p: number }[];
  /** 99.7% non-jump move over d ticks = 3·σ·√d (price units), the minimum safe barrier cushion. */
  cushion: { duration: number; price: number; pips: number }[];
  postJump: { active: boolean; drift: number; direction: 1 | -1 | 0 };
}


export function detectJumps(prices: number[], times: number[], multiple: number) {
  const diffs = prices.map((p, i) => (i === 0 ? 0 : p - prices[i - 1]));
  const jumps: JumpEvent[] = [];
  let atr20 = 0;
  for (let i = 21; i < prices.length; i++) {
    // ATR₂₀ = mean |ΔS| over the 20 ticks *before* i (so a jump does not inflate its own threshold).
    atr20 = mean(diffs.slice(i - 20, i).map(Math.abs));
    if (atr20 > 0 && Math.abs(diffs[i]) > multiple * atr20) jumps.push({ index: i, time: times[i], size: diffs[i] });
  }
  return { diffs, jumps, atr20 };
}

export function runJumpEngine(input: EngineInput): EngineOutput<JumpInsights> {
  const { prices, times, decimals, settings: st } = input;
  const { diffs, jumps, atr20 } = detectJumps(prices, times, st.jumpAtrMultiple);
  const jumpIdx = new Set(jumps.map((j) => j.index));
  const sigmaTick = std(diffs.slice(1).filter((_, i) => !jumpIdx.has(i + 1)));
  const last = prices.length - 1;
  const span = times.length > 1 ? times[last] - times[0] : 0;
  const tickSeconds = times.length > 1 ? span / last : 1;
  // Gamma(1, 1/λ₀) prior ≙ “1 jump observed in 1/λ₀ seconds”; posterior mean λ̂ = (1 + jumps) / (1/λ₀ + T).
  const lambda = (1 + jumps.length) / (1 / st.jumpLambda + span);
  const lastJump = jumps[jumps.length - 1];
  const ticksSinceJump = lastJump ? last - lastJump.index : null;
  const secondsSinceJump = lastJump ? times[last] - lastJump.time : null;

  const hazardFor = (d: number) => 1 - Math.exp(-lambda * d * tickSeconds);
  const hazard = st.riseFallDurations.map((d) => ({ duration: d, p: hazardFor(d) }));
  const pip = Math.pow(10, -decimals);
  const cushion = st.riseFallDurations.map((d) => {
    const price = 3 * sigmaTick * Math.sqrt(d);
    return { duration: d, price, pips: Math.ceil(price / pip) };
  });

  // Post-jump micro-trend: inside the 10–30 tick stabilisation window after a
  // jump, follow the sign of the drift accumulated since the jump.
  const jumpBefore = (i: number) => {
    for (let j = jumps.length - 1; j >= 0; j--) if (jumps[j].index <= i) return jumps[j];
    return undefined;
  };
  const postDir = (i: number): 1 | -1 | 0 => {
    const j = jumpBefore(i);
    if (!j) return 0;
    const since = i - j.index;
    if (since < 10 || since > 30) return 0;
    return Math.sign(prices[i] - prices[j.index]) as 1 | -1 | 0;
  };
  const dirNow = last >= 0 ? postDir(last) : 0;
  const drift = lastJump && dirNow !== 0 ? prices[last] - prices[lastJump.index] : 0;

  const candidates: Candidate[] = [];
  for (const d of st.riseFallDurations) {
    const p0 = riseFallBaseline(prices, d);
    const hz = hazardFor(d);
    for (const type of ["CALL", "PUT"] as const) {
      const want = type === "CALL" ? 1 : -1;
      const { k, n } = backtestDirection(prices, type, d, (i) => postDir(i) === want);
      candidates.push({
        key: candidateKey(type, d),
        contractType: type,
        duration: d,
        pModel: shrunkProbability(k, n, p0, st.priorStrength),
        pTheory: p0,
        k,
        n,
        active: dirNow === want,
        blocked: hz > st.jumpHazardBlock ? `Jump hazard ${(hz * 100).toFixed(2)}% > ${(st.jumpHazardBlock * 100).toFixed(2)}%` : undefined,
        rationale: `Post-jump drift follow (10–30t window): ${k}/${n} wins over ${d}t; P(jump in contract)=${(hz * 100).toFixed(2)}%`,
      });
    }
  }

  const digits = digitsOf(prices, decimals);
  candidates.push(
    ...frequencyDigitCandidates(digits, st.digitWindow, st.priorStrength, st.digitDuration, (s, k, n, cur, w) =>
      `Window ${cur}/${w} (theory ${(s.p0 * 100).toFixed(0)}%); walk-forward ${k}/${n} wins`,
    ),
  );

  return {
    family: "jump",
    candidates,
    warmingUp: prices.length < 50,
    insights: {
      digits,
      jumps,
      atr20,
      sigmaTick,
      secondsSinceJump,
      ticksSinceJump,
      lambda,
      tickSeconds,
      hazard,
      cushion,
      postJump: { active: dirNow !== 0, drift, direction: dirNow },
    },
  };
}
