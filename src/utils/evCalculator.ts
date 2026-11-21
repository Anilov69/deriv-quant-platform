/**
 * Payout & Expected Value maximiser.
 *
 * Notation (per contract):
 *   S  – stake (what you pay; Deriv `ask_price` for basis = "stake")
 *   W  – gross payout returned on a win (Deriv `payout`)
 *   N  – net profit on a win = W − S
 *   p  – model probability of winning (P_model), q = 1 − p
 */

/** Break-even probability P_be = S / W: the win-rate at which EV is exactly 0. */
export function breakEvenProbability(stake: number, payout: number): number {
  if (payout <= 0) return 1;
  return stake / payout;
}

/** Payout percentage shown by Deriv: net profit as % of stake = (W − S) / S · 100. */
export function payoutPercent(stake: number, payout: number): number {
  if (stake <= 0) return 0;
  return ((payout - stake) / stake) * 100;
}

/**
 * Expected value in currency for one contract:
 *   EV = p · N − q · S
 * EV > 0  ⇔  p > P_be.
 */
export function expectedValue(p: number, stake: number, payout: number): number {
  const net = payout - stake;
  return p * net - (1 - p) * stake;
}

/** EV per 1 unit of currency risked: EV / S = p · b − q, with b = N / S. */
export function evPerDollar(p: number, stake: number, payout: number): number {
  if (stake <= 0) return 0;
  return expectedValue(p, stake, payout) / stake;
}

/**
 * Full Kelly fraction for a binary bet with net odds b = N / S:
 *   f* = (b·p − q) / b
 * Negative or zero f* means “do not bet”.
 */
export function kellyFraction(p: number, stake: number, payout: number): number {
  const b = (payout - stake) / stake;
  if (!(b > 0)) return 0;
  return (b * p - (1 - p)) / b;
}

export interface StakeSuggestion {
  /** Full-Kelly fraction f* of bankroll (may be ≤ 0). */
  kelly: number;
  /** Fraction actually used: max(0, min(0.25·f*, maxRisk)). */
  fraction: number;
  /** Suggested stake in account currency, rounded to cents and clamped to [minStake, maxStake]; 0 if no edge. */
  stake: number;
  capped: boolean;
}

/**
 * Quarter-Kelly stake sizing, capped at the user's max risk per trade:
 *   f = min(0.25 · f*, maxRiskPct / 100),   stake = f · balance
 * The payout ratio W/S is assumed constant across stake sizes, which holds for
 * Deriv digital options within the min/max stake limits.
 */
export function suggestStake(
  p: number,
  refStake: number,
  refPayout: number,
  balance: number,
  maxRiskPct: number,
  kellyMultiplier = 0.25,
  minStake = 0.35,
): StakeSuggestion {
  const kelly = kellyFraction(p, refStake, refPayout);
  if (kelly <= 0 || balance <= 0) return { kelly, fraction: 0, stake: 0, capped: false };
  const cap = Math.max(0, maxRiskPct) / 100;
  const raw = kellyMultiplier * kelly;
  const fraction = Math.min(raw, cap);
  let stake = Math.floor(fraction * balance * 100) / 100;
  if (stake < minStake) stake = 0;
  return { kelly, fraction, stake, capped: raw > cap };
}
