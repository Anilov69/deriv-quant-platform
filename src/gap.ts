export type GapMode = "momentum" | "meanrev";
export type GapSide = "CALL" | "PUT";

export interface GapStats {
  up: number;
  flat: number;
  down: number;
  /** Consecutive tick-to-tick intervals actually measured (N - 1). */
  total: number;
  upPct: number;
  flatPct: number;
  downPct: number;
  gapPp: number;
  leader: "up" | "down" | "balanced";
  ready: boolean;
}

export interface GapDecision {
  side: GapSide | null;
  stats: GapStats;
}

/**
 * Classify the last `lookback` ticks into up / flat / down buckets. Flat is
 * kept in the denominator on purpose: a stagnant tape has no up/down edge, and
 * counting flats is what stops a quiet market from looking directional.
 */
export function classifyGap(prices: number[], lookback: number): GapStats {
  const window = Math.max(2, Math.floor(lookback));
  const slice = prices.slice(-window);
  let up = 0;
  let flat = 0;
  let down = 0;
  for (let index = 1; index < slice.length; index += 1) {
    const previous = slice[index - 1];
    const current = slice[index];
    if (current > previous) up += 1;
    else if (current < previous) down += 1;
    else flat += 1;
  }
  const total = Math.max(0, slice.length - 1);
  const pct = (count: number) => (total === 0 ? 0 : (count / total) * 100);
  const upPct = pct(up);
  const downPct = pct(down);
  const leader = up > down ? "up" : down > up ? "down" : "balanced";
  return {
    up,
    flat,
    down,
    total,
    upPct,
    flatPct: pct(flat),
    downPct,
    gapPp: Math.abs(upPct - downPct),
    leader,
    ready: prices.length >= window && total > 0,
  };
}

export function gapSignal(stats: GapStats, mode: GapMode, minGapPp: number): GapDecision {
  if (!stats.ready || stats.leader === "balanced" || stats.gapPp < minGapPp) return { side: null, stats };
  const momentum: GapSide = stats.leader === "up" ? "CALL" : "PUT";
  const side: GapSide = mode === "momentum" ? momentum : momentum === "CALL" ? "PUT" : "CALL";
  return { side, stats };
}

/**
 * Stake for the next trade after a loss. Payout mode solves
 * (cumulativeLoss + base * b) / b with b = net payout / stake - 1, so a 1.95x
 * Rise/Fall and a 1.09x Differs contract need very different steps.
 */
export function nextStake(input: {
  mode: "off" | "1.5" | "2" | "payout" | "custom";
  baseStake: number;
  multiplier: number;
  lastStake: number;
  payout: number;
  cumulativeLoss: number;
}): number {
  const floor = (value: number) => Math.max(0.35, Math.round(value * 100) / 100);
  if (input.mode === "off") return floor(input.baseStake);
  if (input.mode === "payout") {
    const b = input.lastStake > 0 ? (input.payout - input.lastStake) / input.lastStake : 0;
    if (b <= 0.01) return floor(input.lastStake * 2);
    return floor((input.cumulativeLoss + input.baseStake * b) / b);
  }
  const factor = input.mode === "1.5" ? 1.5 : input.mode === "2" ? 2 : input.multiplier;
  return floor(input.lastStake * Math.max(1.01, factor));
}
