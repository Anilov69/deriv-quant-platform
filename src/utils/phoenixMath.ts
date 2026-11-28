export type PhoenixGear = 1 | 2 | 3 | 4;
export type PhoenixDirection = "LONG" | "SHORT" | "LONG_SHORT";
export type PhoenixExitStatus =
  | "DOUBLE-DIP"
  | "CRASH RESCUED"
  | "CLEAN RUNNER"
  | "PEEL LOCKED"
  | "RANGE 65% LOCK"
  | "CHOP SALVAGE"
  | "STEP 1 MISS"
  | "ROUND ACTIVE";

export type PhoenixContractType =
  | "CALL"
  | "PUT"
  | "ONETOUCH"
  | "NOTOUCH"
  | "TURBOSLONG"
  | "TURBOSSHORT"
  | "VANILLALONGCALL"
  | "VANILLALONGPUT";

export interface PhoenixLegRequest {
  contractType: PhoenixContractType;
  barrier: string | undefined;
  duration: number;
  durationUnit: "t" | "s" | "m";
  stake: number;
  label: string;
}

export interface PhoenixQuoteSnapshot {
  spot: number;
  atr15: number;
  atr100: number;
  touchBarrierOffset: number;
  koBarrierOffset: number;
}

export interface PhoenixScenario {
  label: string;
  net: number;
  tone: "emerald" | "amber" | "sky" | "muted";
}

export interface PhoenixRoundLog {
  id: number;
  timestamp: number;
  symbol: string;
  gear: PhoenixGear;
  direction: PhoenixDirection;
  exitStatus: PhoenixExitStatus;
  leg1Pnl: number;
  leg2Pnl: number;
  netPnl: number;
}

export interface PhoenixRouteDecision {
  gear: PhoenixGear;
  reason: string;
  reachable: boolean;
}

export const PHOENIX_SYMBOLS = [
  "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V",
  "R_10", "R_25", "R_50", "R_75", "R_100",
] as const;

export const PHOENIX_MIN_STAKE = 0.35;
export const PHOENIX_DEFAULT_DANGER_TRIGGER = 50;
export const PHOENIX_DEFAULT_STAGNATION_TICKS = 15;

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function gearRoundRisk(gear: PhoenixGear, baseStake: number, turboStake: number): number {
  if (gear === 1) return round2(Math.max(PHOENIX_MIN_STAKE, baseStake) * 2);
  if (gear === 2) return round2(Math.max(PHOENIX_MIN_STAKE, turboStake) + PHOENIX_MIN_STAKE);
  if (gear === 3) return 2;
  return round2(Math.max(PHOENIX_MIN_STAKE, baseStake));
}

export function autoStopLoss(roundMaxRisk: number): number {
  return round2(roundMaxRisk * 4);
}

export function autoTakeProfit(expectedPhoenixWin: number): number {
  return round2(Math.max(0.25, expectedPhoenixWin * 3));
}

export function routePhoenixGear(
  primaryGear: 1 | 2 | 3,
  autoRouter: boolean,
  atr15: number,
  atr100: number,
  touchBarrierOffset: number,
): PhoenixRouteDecision {
  const compression = atr100 > 0 ? atr15 / atr100 : 1;
  const reachable = atr15 * 4 >= Math.abs(touchBarrierOffset);
  if (!autoRouter) {
    if ((primaryGear === 1 || primaryGear === 2) && !reachable) {
      return { gear: primaryGear, reason: "DEAD CHOP · STANDING BY", reachable: false };
    }
    return { gear: primaryGear, reason: reachable ? "PRIMARY GEAR ARMED" : "COMPRESSION GEAR ARMED", reachable };
  }
  if (compression <= 0.60) {
    return { gear: 4, reason: "AUTO ROUTER · RANGE BOX", reachable: true };
  }
  if (primaryGear === 3 && compression <= 0.65) {
    return { gear: 3, reason: "AUTO ROUTER · GAMMA COMPRESSION", reachable: true };
  }
  if (!reachable) {
    return { gear: 4, reason: "DEAD CHOP · ROUTED TO RANGE BOX", reachable: false };
  }
  return { gear: primaryGear, reason: "AUTO ROUTER · VOLATILITY EXPANSION", reachable: true };
}

export function chooseImpulseDirection(spotMove: number, previousSpot: number, spot: number): "LONG" | "SHORT" {
  if (spotMove !== 0) return spotMove > 0 ? "LONG" : "SHORT";
  if (previousSpot === spot) return "LONG";
  return spot > previousSpot ? "LONG" : "SHORT";
}

export function decimalsFromLatestQuote(latestQuote: number): number {
  if (!Number.isFinite(latestQuote) || latestQuote <= 0) return 2;
  const fraction = String(latestQuote).split(".")[1];
  const decimals = fraction ? fraction.length : 2;
  return Math.max(2, Math.min(4, decimals));
}

export function pipSizeFromDecimals(decimals: number): number {
  const safeDecimals = Math.max(2, Math.min(4, Math.round(decimals)));
  return Number((10 ** -safeDecimals).toFixed(safeDecimals));
}

export function syntheticTouchOffset(atr15: number, pipSize: number, decimals: number, validatedOffset?: number): number {
  const safeAtr = Number.isFinite(atr15) && atr15 > 0 ? atr15 : pipSize * 20;
  const base = validatedOffset && validatedOffset > 0
    ? validatedOffset
    : Math.max(pipSize * 20, safeAtr * 1.8);
  return Number(base.toFixed(Math.max(2, Math.min(4, decimals))));
}

export function cleanBarrierOffset(rawBarrier: string | number | null | undefined, decimals: number): number {
  const parsed = typeof rawBarrier === "number" ? rawBarrier : parseFloat(String(rawBarrier ?? "").replace(/[^0-9.+-]/g, ""));
  if (!Number.isFinite(parsed)) return 0;
  const places = Math.max(0, Math.min(8, Math.round(decimals)));
  return Number(Math.abs(parsed).toFixed(places));
}

export function formatBarrierOffset(rawBarrier: string | number | null | undefined, decimals: number, upper: boolean): string {
  const clean = cleanBarrierOffset(rawBarrier, decimals);
  const places = Math.max(0, Math.min(8, Math.round(decimals)));
  return (upper ? "+" : "-") + clean.toFixed(places);
}

export function microPhoenixRequests(
  direction: "LONG" | "SHORT",
  spot: number,
  baseStake: number,
  interiorOffset: number,
): PhoenixLegRequest[] {
  const stake = round2(clamp(baseStake, PHOENIX_MIN_STAKE, 100));
  const isLong = direction === "LONG";
  const shieldOffset = -interiorOffset * (isLong ? 1 : -1);
  return [
    {
      contractType: isLong ? "CALL" : "PUT",
      barrier: undefined,
      duration: 5,
      durationUnit: "t",
      stake,
      label: isLong ? "CALL 5 ticks" : "PUT 5 ticks",
    },
    {
      contractType: isLong ? "ONETOUCH" : "ONETOUCH",
      barrier: cleanBarrierOffset(shieldOffset, 2) === 0
        ? undefined
        : formatBarrierOffset(shieldOffset, 2, shieldOffset >= 0),
      duration: 5,
      durationUnit: "t",
      stake,
      label: isLong ? "Opposite interior ONETOUCH" : "Opposite interior ONETOUCH",
    },
  ];
}

export function turbinePhoenixRequests(
  direction: "LONG" | "SHORT",
  koBarrier: string,
  touchBarrier: string,
  turboStake: number,
  shieldStake = PHOENIX_MIN_STAKE,
): PhoenixLegRequest[] {
  return [
    {
      contractType: direction === "LONG" ? "TURBOSLONG" : "TURBOSSHORT",
      barrier: koBarrier,
      duration: 0,
      durationUnit: "t",
      stake: round2(clamp(turboStake, PHOENIX_MIN_STAKE, 100)),
      label: direction === "LONG" ? "TURBOSLONG" : "TURBOSSHORT",
    },
    {
      contractType: "ONETOUCH",
      barrier: touchBarrier,
      duration: 5,
      durationUnit: "t",
      stake: round2(clamp(shieldStake, PHOENIX_MIN_STAKE, 100)),
      label: "Interior ONETOUCH shield",
    },
  ];
}

export function vanillaRequests(stake = 1, atmBarrier = "+0.0"): PhoenixLegRequest[] {
  const safeStake = round2(clamp(stake, 0.35, 100));
  return [
    { contractType: "VANILLALONGCALL", barrier: atmBarrier, duration: 5, durationUnit: "t", stake: safeStake, label: "ATM VANILLALONGCALL" },
    { contractType: "VANILLALONGPUT", barrier: atmBarrier, duration: 5, durationUnit: "t", stake: safeStake, label: "ATM VANILLALONGPUT" },
  ];
}

export function rangeBoxRequest(stake: number, barrier = "+0.0"): PhoenixLegRequest {
  return {
    contractType: "NOTOUCH",
    barrier,
    duration: 1,
    durationUnit: "t",
    stake: round2(clamp(stake, PHOENIX_MIN_STAKE, 100)),
    label: "NOTOUCH range box",
  };
}

export function expectedPhoenixScenarios(gear: PhoenixGear, maxRisk: number): PhoenixScenario[] {
  if (gear === 1) return [
    { label: "Phoenix Double-Dip Jackpot", net: round2(maxRisk + 0.40), tone: "emerald" },
    { label: "Clean Breakout Runner", net: round2(maxRisk * 0.65), tone: "sky" },
    { label: "Crash Rescue Shield", net: round2(0.40), tone: "amber" },
    { label: "Range-Box / Chop Lock", net: -round2(maxRisk), tone: "muted" },
  ];
  if (gear === 2) return [
    { label: "Clean Breakout Runner", net: 4.25, tone: "emerald" },
    { label: "Phoenix Double-Dip Jackpot", net: 2.60, tone: "sky" },
    { label: "Crash Rescue Shield", net: 0.40, tone: "amber" },
    { label: "Range-Box / Chop Lock", net: -round2(maxRisk), tone: "muted" },
  ];
  if (gear === 3) return [
    { label: "PEEL LOCKED", net: 0.50, tone: "emerald" },
    { label: "Clean Breakout Runner", net: 1.25, tone: "sky" },
    { label: "Crash Rescue Shield", net: 0, tone: "amber" },
    { label: "Range-Box / Chop Lock", net: -2, tone: "muted" },
  ];
  return [
    { label: "RANGE 65% LOCK", net: 1.10, tone: "emerald" },
    { label: "Clean Breakout Runner", net: 0.35, tone: "sky" },
    { label: "Crash Rescue Shield", net: -0.35, tone: "amber" },
    { label: "Range-Box / Chop Lock", net: -0.35, tone: "muted" },
  ];
}

export function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function phoenixCsv(rows: readonly PhoenixRoundLog[]): string {
  const header = ["Timestamp", "Symbol", "Gear", "Direction", "Shield / Exit Status", "Leg 1 P&L", "Leg 2 P&L", "Net Round P&L"];
  const body = rows.map((row) => [
    new Date(row.timestamp).toISOString(), row.symbol, String(row.gear), row.direction, row.exitStatus,
    row.leg1Pnl.toFixed(2), row.leg2Pnl.toFixed(2), row.netPnl.toFixed(2),
  ]);
  return [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}
