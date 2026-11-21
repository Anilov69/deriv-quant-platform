/**
 * Joins engine candidates with live Deriv quotes and contract availability,
 * then applies the EV & Kelly filter. Pure function → unit-testable.
 */
import type { Candidate } from "@/engines/types";
import { binomialZ } from "@/engines/stats";
import { breakEvenProbability, evPerDollar, expectedValue, payoutPercent, suggestStake } from "@/utils/evCalculator";
import type { Availability, Guardrails, Quote } from "@/store/useStore";

export type SignalStatus = "actionable" | "no-edge" | "waiting" | "blocked" | "low-sample" | "weak" | "not-offered" | "no-quote";

export interface SignalRow extends Candidate {
  quote?: Quote;
  pBe: number;
  payoutPct: number;
  /** EV in currency for the reference stake. */
  ev: number;
  /** EV per 1 unit staked. */
  evPerStake: number;
  kellyStake: number;
  /** Significance of the edge: Z of k/n against P_be. */
  edgeZ: number;
  kelly: number;
  capped: boolean;
  status: SignalStatus;
  reason: string;
}

export function isOffered(av: Availability | undefined, c: Pick<Candidate, "contractType" | "duration">): boolean {
  if (!av) return true; // unknown yet — don't hide
  const r = av[c.contractType];
  return !!r && c.duration >= r[0] && c.duration <= r[1];
}

export function buildSignals(
  candidates: Candidate[],
  quotes: Record<string, Quote>,
  av: Availability | undefined,
  g: Guardrails,
  balance: number | null,
): SignalRow[] {
  return candidates.map((c) => {
    const quote = quotes[c.key];
    const ok = quote && !quote.error && quote.payout > 0;
    const S = ok ? quote.stake : NaN;
    const W = ok ? quote.payout : NaN;
    const pBe = ok ? breakEvenProbability(S, W) : NaN;
    const ev = ok ? expectedValue(c.pModel, S, W) : NaN;
    const evPerStake = ok ? evPerDollar(c.pModel, S, W) : NaN;
    const sug = ok ? suggestStake(c.pModel, S, W, balance ?? 0, g.maxRiskPct, g.kellyMultiplier) : { kelly: NaN, stake: 0, capped: false };

    // H₀: true win rate = P_be. Multiple contracts are scanned at once, so a
    // high bar (default Z ≥ 2.5) guards against picking the luckiest row.
    const edgeZ = ok ? binomialZ(c.k, c.n, pBe) : NaN;
    let status: SignalStatus;
    let reason: string;
    if (!isOffered(av, c)) [status, reason] = ["not-offered", "Deriv does not offer this contract/duration on this market"];
    else if (!ok) [status, reason] = ["no-quote", quote?.error ?? "Waiting for live payout"];
    else if (c.blocked) [status, reason] = ["blocked", c.blocked];
    else if (evPerStake <= 0) [status, reason] = ["no-edge", `P_model ${(c.pModel * 100).toFixed(2)}% ≤ break-even ${(pBe * 100).toFixed(2)}%`];
    else if (c.n < g.minSample) [status, reason] = ["low-sample", `Only ${c.n} samples (< ${g.minSample})`];
    else if (!(edgeZ >= g.minEdgeZ)) [status, reason] = ["weak", `Edge not significant: Z=${edgeZ.toFixed(2)} vs P_be (need ≥ ${g.minEdgeZ})`];
    else if (!c.active) [status, reason] = ["waiting", "Positive EV but trigger condition not met right now"];
    else if (evPerStake < g.minEv) [status, reason] = ["no-edge", `EV ${(evPerStake * 100).toFixed(2)}% below minimum ${(g.minEv * 100).toFixed(2)}%`];
    else [status, reason] = ["actionable", "HIGH EDGE / ACTIONABLE: P_model > P_be and all filters passed"];

    return {
      ...c,
      quote,
      pBe,
      payoutPct: ok ? payoutPercent(S, W) : NaN,
      ev,
      evPerStake,
      kellyStake: sug.stake,
      edgeZ,
      kelly: sug.kelly,
      capped: sug.capped,
      status,
      reason,
    };
  });
}

/** Best actionable row by EV per unit stake. */
export function recommended(rows: SignalRow[]): SignalRow | null {
  let best: SignalRow | null = null;
  for (const r of rows) if (r.status === "actionable" && r.kellyStake > 0 && (!best || r.evPerStake > best.evPerStake)) best = r;
  return best;
}
