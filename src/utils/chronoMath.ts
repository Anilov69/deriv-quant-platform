export type ChronoWeaponMode = "asymmetric_corridor" | "virtual_probe";
export type ChronoDirection = "bullish" | "bearish" | "neutral";
export type ChronoTier = 1 | 2;
export type ChronoWeapon =
  | "STAGGERED ANCHOR"
  | "VIRTUAL PROBE"
  | "ACCU 5% CANNON";
export type ChronoOutcome =
  | "STAGGERED DOUBLE-WIN"
  | "TREND-LOCKED GREEN"
  | "REVERSAL SCRATCH"
  | "T2 EARLY CUT"
  | "SOLO ANCHOR WIN"
  | "SOLO ANCHOR MISS"
  | "VIRTUAL SNAP DOUBLE-WIN"
  | "CALM DRIFT SCRATCH"
  | "BREAKOUT MISS"
  | "ACCU CANNON HIT"
  | "ACCU KNOCKOUT (PROFIT LOCKED)";

export interface ChronoLegRequest {
  contractType: "CALL" | "PUT" | "NOTOUCH" | "ONETOUCH" | "ACCU";
  stake: number;
  duration?: number;
  durationUnit?: "t";
  barrier?: string;
  growthRate?: number;
  limitTakeProfit?: number;
  label: string;
}

export interface ChronoRoundLog {
  id: number;
  timestamp: number;
  symbol: string;
  tier: ChronoTier;
  weapon: ChronoWeapon;
  outcome: ChronoOutcome;
  leg1Pnl: number;
  leg2Pnl: number;
  netPnl: number;
}

export interface ChronoGeometry {
  spot: number;
  entryStrike: number;
  rollingAsianMean: number;
  resetTarget: number | null;
  corridorLow: number;
  corridorHigh: number;
  bankedProfit: number;
  vaultThreshold: number;
  protectedPrincipal: number;
}

export interface MicrostructureSignal {
  direction: ChronoDirection;
  snapMove: number;
  momentumMove: number;
  efficiencyRatio: number;
  momentumMove4: number;
  efficiencyRatio4: number;
  atr15: number;
  atr100: number;
}

export interface ChronoDecision {
  weapon: ChronoWeapon | null;
  direction: ChronoDirection;
  reason: string;
}

export const CHRONO_SYMBOLS = [
  "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V",
  "R_10", "R_25", "R_50", "R_75", "R_100",
] as const;

export const CHRONO_MIN_STAKE = 0.35;
export const CHRONO_MIN_ACCUMULATOR_STAKE = 0.35;
export const CHRONO_DEFAULT_VAULT_THRESHOLD = 0.36;
export const CHRONO_DEFAULT_ACCU_TICKS = 15;
export const CHRONO_DEFAULT_GROWTH_RATE = 0.05;

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function atrFrom(quotes: readonly number[]): number {
  if (quotes.length < 2) return 0;
  let sum = 0;
  for (let index = 1; index < quotes.length; index += 1) {
    sum += Math.abs(quotes[index] - quotes[index - 1]);
  }
  return sum / (quotes.length - 1);
}

export function efficiencyRatio(quotes: readonly number[]): number {
  if (quotes.length < 2) return 0;
  const net = Math.abs(quotes[quotes.length - 1] - quotes[0]);
  let path = 0;
  for (let index = 1; index < quotes.length; index += 1) {
    path += Math.abs(quotes[index] - quotes[index - 1]);
  }
  return path > 0 ? net / path : 0;
}

export function rollingAsianMean(quotes: readonly number[], count = 6): number {
  if (quotes.length === 0) return 0;
  const window = quotes.slice(-Math.max(1, count));
  return window.reduce((sum, quote) => sum + quote, 0) / window.length;
}

export function safeEvenResetDuration(minTicks: number): number {
  const minimum = Math.max(6, Math.ceil(minTicks));
  return minimum % 2 === 0 ? minimum : minimum + 1;
}

export function analyzeMicrostructure(quotes: readonly number[]): MicrostructureSignal {
  const atr15 = atrFrom(quotes.slice(-15));
  const atr100 = atrFrom(quotes.slice(-100));
  const recent3 = quotes.length >= 4 ? quotes.slice(-4) : [];
  const recent4 = quotes.length >= 5 ? quotes.slice(-5) : [];
  const recent6 = quotes.length >= 6 ? quotes.slice(-6) : [];
  const momentumMove = recent3.length > 0 ? quotes[quotes.length - 1] - recent3[0] : 0;
  const momentumMove4 = recent4.length > 0 ? quotes[quotes.length - 1] - recent4[0] : 0;
  const snapMove = recent6.length > 0 ? quotes[quotes.length - 1] - recent6[0] : 0;
  const er = efficiencyRatio(recent3);
  const er4 = efficiencyRatio(recent4);
  let direction: ChronoDirection = "neutral";
  if (momentumMove > 0) direction = "bullish";
  else if (momentumMove < 0) direction = "bearish";
  return { direction, snapMove, momentumMove, efficiencyRatio: er, momentumMove4, efficiencyRatio4: er4, atr15, atr100 };
}

export function chooseChronoWeapon(
  mode: ChronoWeaponMode,
  signal: MicrostructureSignal,
): ChronoDecision {
  const impulseExpansion = signal.atr100 > 0 && signal.atr15 >= signal.atr100 * 0.90;
  if (mode === "asymmetric_corridor") {
    const eligible = impulseExpansion
      && signal.efficiencyRatio >= 0.62
      && Math.abs(signal.momentumMove) >= signal.atr15 * 1.35;
    if (!eligible) return { weapon: null, direction: "neutral", reason: "Waiting for 1.35x ATR asymmetric anchor" };
    const direction = signal.direction;
    return {
      weapon: "STAGGERED ANCHOR",
      direction,
      reason: direction === "bullish" ? "Bullish 3-tick impulse · CALL anchor" : direction === "bearish" ? "Bearish 3-tick impulse · PUT anchor" : "Neutral impulse",
    };
  }
  const eligible = impulseExpansion
    && signal.efficiencyRatio >= 0.65
    && Math.abs(signal.momentumMove) >= signal.atr15 * 1.5;
  if (!eligible) return { weapon: null, direction: "neutral", reason: "Waiting for 1.50x ATR virtual probe" };
  return {
    weapon: "VIRTUAL PROBE",
    direction: signal.direction,
    reason: "Virtual probe crossed · 2-leg snap-back corridor",
  };
}

export function staggeredAnchorRequest(direction: "bullish" | "bearish"): ChronoLegRequest {
  return {
    contractType: direction === "bullish" ? "CALL" : "PUT",
    stake: 0.45,
    duration: 5,
    durationUnit: "t",
    label: (direction === "bullish" ? "CALL" : "PUT") + " $0.45 T=0 anchor",
  };
}

export function staggeredTrapRequest(direction: "bullish" | "bearish"): ChronoLegRequest {
  return {
    contractType: direction === "bullish" ? "PUT" : "CALL",
    stake: 0.35,
    duration: 5,
    durationUnit: "t",
    label: (direction === "bullish" ? "PUT" : "CALL") + " $0.35 T=2 peak trap",
  };
}

export function virtualProbeRequests(direction: "bullish" | "bearish", notouchBarrier: string, onetouchBarrier: string): ChronoLegRequest[] {
  return [
    { contractType: "NOTOUCH", stake: 0.45, duration: 5, durationUnit: "t", barrier: notouchBarrier, label: "NOTOUCH $0.45 impulse-direction protection" },
    { contractType: "ONETOUCH", stake: 0.35, duration: 5, durationUnit: "t", barrier: onetouchBarrier, label: "ONETOUCH $0.35 snap-back probe" },
  ];
}

export function accumulatorRequest(
  cannonStake: number,
  growthRate: number,
  takeProfitMultiple = 0.38,
): ChronoLegRequest {
  const safeStake = round2(clamp(cannonStake || CHRONO_MIN_ACCUMULATOR_STAKE, CHRONO_MIN_ACCUMULATOR_STAKE, 100));
  const safeRate = round2(clamp(growthRate, 0.01, 0.05));
  return {
    contractType: "ACCU",
    stake: 0.35,
    growthRate: 0.05,
    limitTakeProfit: takeProfitMultiple,
    label: "ACCU 5% $0.35 house-profit cannon",
  };
}

export function chronoAutoStopLoss(): number {
  return 2.80;
}

export function chronoAutoTakeProfit(): number {
  return 3.50;
}

export function chronoCsvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function chronoCsv(rows: readonly ChronoRoundLog[]): string {
  const header = ["Timestamp", "Symbol", "Tier & Weapon", "Outcome Badge", "Leg 1 P&L", "Leg 2 P&L", "Net Round P&L"];
  const body = rows.map((row) => [
    new Date(row.timestamp).toISOString(),
    row.symbol,
    "T" + String(row.tier) + ": " + row.weapon,
    row.outcome,
    row.leg1Pnl.toFixed(2),
    row.leg2Pnl.toFixed(2),
    row.netPnl.toFixed(2),
  ]);
  return [header, ...body].map((row) => row.map(chronoCsvCell).join(",")).join("\n");
}
