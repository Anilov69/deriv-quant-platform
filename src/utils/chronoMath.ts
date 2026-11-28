export type ChronoWeaponMode = "auto_both" | "asian_impulse_only" | "reset_warp_only";
export type ChronoDirection = "bullish" | "bearish" | "neutral";
export type ChronoTier = 1 | 2;
export type ChronoWeapon = "RESETCALL+PUT" | "RESETPUT+CALL" | "CALL+ASIAND" | "PUT+ASIANU" | "ACCU 5% CANNON" | "ASIANU/ASIAND PAROLI";
export type ChronoOutcome =
  | "DOUBLE-WIN CORRIDOR"
  | "MICRO-SCRATCH"
  | "VAULT CANNON HIT"
  | "CORRIDOR MISS";

export interface ChronoLegRequest {
  contractType: "RESETCALL" | "RESETPUT" | "CALL" | "PUT" | "ASIAND" | "ASIANU" | "ACCU";
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
export const CHRONO_MIN_ACCUMULATOR_STAKE = 1;
export const CHRONO_DEFAULT_VAULT_THRESHOLD = 1.05;
export const CHRONO_DEFAULT_ACCU_TICKS = 12;
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
  if (momentumMove4 > 0) direction = "bullish";
  else if (momentumMove4 < 0) direction = "bearish";
  return { direction, snapMove, momentumMove, efficiencyRatio: er, momentumMove4, efficiencyRatio4: er4, atr15, atr100 };
}

export function chooseChronoWeapon(
  mode: ChronoWeaponMode,
  signal: MicrostructureSignal,
  resetTickSupported: boolean,
): ChronoDecision {
  const absoluteSnap = Math.abs(signal.snapMove);
  const absoluteMomentum = Math.abs(signal.momentumMove4);
  const impulseExpansion = signal.atr100 > 0 && signal.atr15 >= signal.atr100 * 1.10;
  const impulseEligible = impulseExpansion && signal.efficiencyRatio4 >= 0.78 && absoluteMomentum >= signal.atr15 * 2.4;
  if (mode === "asian_impulse_only") {
    const eligible = impulseEligible;
    if (!eligible) return { weapon: null, direction: "neutral", reason: "Impulse filter not met" };
    return signal.direction === "bullish"
      ? { weapon: "CALL+ASIAND", direction: "bullish", reason: "Bullish clean momentum burst" }
      : signal.direction === "bearish"
        ? { weapon: "PUT+ASIANU", direction: "bearish", reason: "Bearish clean momentum burst" }
        : { weapon: null, direction: "neutral", reason: "Neutral impulse" };
  }
  if (mode === "reset_warp_only") {
    if (!resetTickSupported) return { weapon: null, direction: "neutral", reason: "Reset ticks unavailable" };
    const eligible = absoluteSnap >= 1.6 * signal.atr15;
    if (!eligible) return { weapon: null, direction: "neutral", reason: "Exhaustion snap not met" };
    return signal.direction === "bearish"
      ? { weapon: "RESETCALL+PUT", direction: "bullish", reason: "Sharp drop exhaustion snap" }
      : signal.direction === "bullish"
        ? { weapon: "RESETPUT+CALL", direction: "bearish", reason: "Sharp spike exhaustion snap" }
        : { weapon: null, direction: "neutral", reason: "Neutral snap" };
  }
  if (resetTickSupported && absoluteSnap >= 1.6 * signal.atr15) {
    return signal.direction === "bearish"
      ? { weapon: "RESETCALL+PUT", direction: "bullish", reason: "Weapon A · bullish reset exhaustion" }
      : signal.direction === "bullish"
        ? { weapon: "RESETPUT+CALL", direction: "bearish", reason: "Weapon A · bearish reset exhaustion" }
        : { weapon: null, direction: "neutral", reason: "Neutral reset snap" };
  }
  if (impulseEligible) {
    return signal.direction === "bullish"
      ? { weapon: "CALL+ASIAND", direction: "bullish", reason: "Weapon B · bullish momentum burst" }
      : signal.direction === "bearish"
        ? { weapon: "PUT+ASIANU", direction: "bearish", reason: "Weapon B · bearish momentum burst" }
        : { weapon: null, direction: "neutral", reason: "Neutral momentum" };
  }
  return { weapon: null, direction: "neutral", reason: "Standing by · no corridor trigger" };
}

export function tier1PairRequests(
  weapon: "RESETCALL+PUT" | "RESETPUT+CALL" | "CALL+ASIAND" | "PUT+ASIANU",
  stake: number,
  resetDuration: number,
): ChronoLegRequest[] {
  const safeStake = round2(clamp(stake, CHRONO_MIN_STAKE, 100));
  if (weapon === "RESETCALL+PUT") {
    return [
      { contractType: "RESETCALL", stake: safeStake, duration: resetDuration, durationUnit: "t", label: "RESETCALL midpoint warp" },
      { contractType: "PUT", stake: safeStake, duration: resetDuration, durationUnit: "t", label: "PUT continued-crash guard" },
    ];
  }
  if (weapon === "RESETPUT+CALL") {
    return [
      { contractType: "RESETPUT", stake: safeStake, duration: resetDuration, durationUnit: "t", label: "RESETPUT midpoint warp" },
      { contractType: "CALL", stake: safeStake, duration: resetDuration, durationUnit: "t", label: "CALL rebound guard" },
    ];
  }
  if (weapon === "CALL+ASIAND") {
    return [
      { contractType: "CALL", stake: safeStake, duration: 5, durationUnit: "t", label: "CALL 5 ticks" },
      { contractType: "ASIAND", stake: safeStake, duration: 5, durationUnit: "t", label: "ASIAND 5 ticks" },
    ];
  }
  return [
    { contractType: "PUT", stake: safeStake, duration: 5, durationUnit: "t", label: "PUT 5 ticks" },
    { contractType: "ASIANU", stake: safeStake, duration: 5, durationUnit: "t", label: "ASIANU 5 ticks" },
  ];
}

export function accumulatorRequest(
  cannonStake: number,
  growthRate: number,
  takeProfitMultiple = 0.85,
): ChronoLegRequest {
  const safeStake = round2(clamp(cannonStake, CHRONO_MIN_ACCUMULATOR_STAKE, 100));
  const safeRate = round2(clamp(growthRate, 0.01, 0.05));
  return {
    contractType: "ACCU",
    stake: safeStake,
    growthRate: safeRate,
    limitTakeProfit: round2(safeStake * takeProfitMultiple),
    label: "ACCU " + String(Math.round(safeRate * 100)) + "% growth cannon",
  };
}

export function paroliHouseMoneyRequest(direction: "bullish" | "bearish", reinvestStake: number): ChronoLegRequest[] {
  const stake = round2(clamp(reinvestStake, CHRONO_MIN_STAKE, 100));
  if (direction === "bullish") {
    return [
      { contractType: "ASIANU", stake, duration: 5, durationUnit: "t", label: "ASIANU house-money Step 1" },
      { contractType: "ASIAND", stake, duration: 5, durationUnit: "t", label: "ASIAND reinvested Step 2" },
    ];
  }
  return [
    { contractType: "ASIAND", stake, duration: 5, durationUnit: "t", label: "ASIAND house-money Step 1" },
    { contractType: "ASIANU", stake, duration: 5, durationUnit: "t", label: "ASIANU reinvested Step 2" },
  ];
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
