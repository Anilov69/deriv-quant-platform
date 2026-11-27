import { describe, expect, it } from "vitest";
import type { ContractOffer } from "@/deriv";
import {
  COLLAR_FALLBACK_MULTIPLE,
  buildCollarPayoffMatrix,
  clampCollarDuration,
  clampLockStart,
  classifyCollarOutcome,
  collarLockWindow,
  computeCollarImpulse,
  computeCollarRiskPlan,
  corridorWidth,
  leg2DurationFor,
  lockConditionMet,
  maxCollarDuration,
  nextCollarLevel,
  presetStakes,
  roundStake,
  selectCollarSpec,
  selectImpulseSide,
  stakesForLevel,
  targetSpotFor,
} from "@/utils/collarMath";

function offer(contractType: string, patch: Partial<ContractOffer> = {}): ContractOffer {
  return {
    contractType,
    contractCategory: "callput",
    minContractDuration: "1t",
    maxContractDuration: "10t",
    expiryType: "tick",
    barrier: null,
    defaultStake: 1,
    pipSize: 0.01,
    underlyingSymbol: "R_100",
    ...patch,
  };
}

function trendingPrices(count: number, start = 1000, step = 0.1): number[] {
  return Array.from({ length: count }, (_, index) => start + index * step);
}

describe("Collar impulse", () => {
  it("warms up on the rolling 60-tick window and computes signed impulse", () => {
    const prices = trendingPrices(60);
    const impulse = computeCollarImpulse(prices);
    expect(impulse.samples).toBe(60);
    expect(impulse.ready).toBe(true);
    expect(impulse.delta5).toBeCloseTo(0.5, 6);
    expect(impulse.atr20).toBeCloseTo(0.1, 6);
    expect(impulse.ratio).toBeCloseTo(5, 6);
    expect(impulse.direction).toBe("up");
  });

  it("does not signal before 60 samples or on a flat tape", () => {
    expect(computeCollarImpulse(trendingPrices(59)).ready).toBe(false);
    const flat = computeCollarImpulse(Array.from({ length: 60 }, () => 1000));
    expect(flat.ready).toBe(false);
    expect(flat.atr20).toBe(0);
    expect(flat.ratio).toBe(0);
  });
});

describe("Direction modes", () => {
  const impulse = computeCollarImpulse(trendingPrices(60));

  it("auto follows the sign at the threshold", () => {
    expect(selectImpulseSide(impulse, "auto", true, 1.2)).toBe("call");
    const down = computeCollarImpulse(trendingPrices(60, 1000, -0.1));
    expect(selectImpulseSide(down, "auto", true, 1.2)).toBe("put");
    expect(selectImpulseSide(down, "bullish", true, 1.2)).toBeNull();
    expect(selectImpulseSide(down, "bearish", true, 1.2)).toBe("put");
  });

  it("respects a disabled filter and never invents a flat direction", () => {
    const flat = computeCollarImpulse(Array.from({ length: 60 }, () => 1000));
    expect(selectImpulseSide(flat, "auto", false, 1.2)).toBeNull();
    expect(selectImpulseSide(flat, "bullish", false, 1.2)).toBeNull();
    expect(selectImpulseSide(impulse, "bullish", false, 1.2)).toBe("call");
    expect(selectImpulseSide(impulse, "bearish", false, 1.2)).toBe("put");
    expect(selectImpulseSide(impulse, "auto", false, 1.2)).toBe("call");
  });
});

describe("Time-axis lock window", () => {
  it("uses T+3 to T+(D-5) for the default 10-tick collar", () => {
    expect(collarLockWindow(10, 3)).toEqual({ start: 3, end: 5, valid: true });
    expect(collarLockWindow(10, 9)).toEqual({ start: 5, end: 5, valid: true });
    expect(collarLockWindow(8, 3)).toEqual({ start: 3, end: 3, valid: true });
    expect(clampLockStart(12, 10)).toBe(5);
    expect(clampLockStart(0, 10)).toBe(1);
  });

  it("prices Leg 2 to the exact terminal tick and refuses under five remaining", () => {
    expect(leg2DurationFor(10, 3)).toBe(7);
    expect(leg2DurationFor(10, 5)).toBe(5);
    expect(leg2DurationFor(10, 6)).toBeNull();
    expect(leg2DurationFor(8, 3)).toBe(5);
  });

  it("checks the corridor only in the favorable direction", () => {
    expect(targetSpotFor(1000, "call", 0.2, 0.8)).toBeCloseTo(1000.16, 8);
    expect(targetSpotFor(1000, "put", 0.2, 0.8)).toBeCloseTo(999.84, 8);
    expect(lockConditionMet("call", 1000.16, 1000, 0.2, 0.8)).toBe(true);
    expect(lockConditionMet("call", 1000.15, 1000, 0.2, 0.8)).toBe(false);
    expect(lockConditionMet("put", 999.8, 1000, 0.2, 0.8)).toBe(true);
    expect(corridorWidth(1000, 1000.16)).toBeCloseTo(0.16, 8);
  });
});

describe("Contract capability", () => {
  it("selects matching CALL and PUT rise-fall tick offers", () => {
    const spec = selectCollarSpec(
      [offer("CALL"), offer("PUT", { pipSize: 0.001 }), offer("DIGITOVER", { contractCategory: "digits" })],
      "R_100",
      0.01,
    );
    expect(spec).not.toBeNull();
    expect(spec?.minTickDuration).toBe(5);
    expect(spec?.maxTickDuration).toBe(10);
    expect(spec?.pip).toBe(0.01);
    expect(spec?.category).toBe("callput");
    expect(maxCollarDuration(spec)).toBe(10);
  });

  it("rejects missing sides, non-tick durations and windows below eight ticks", () => {
    expect(selectCollarSpec([offer("CALL")], "R_100", 0.01)).toBeNull();
    expect(selectCollarSpec([offer("CALL", { minContractDuration: "5m" }), offer("PUT")], "R_100", 0.01)).toBeNull();
    expect(selectCollarSpec([offer("CALL", { maxContractDuration: "5t" }), offer("PUT", { maxContractDuration: "5t" })], "R_100", 0.01)).toBeNull();
  });

  it("rejects CALL/PUT offers that belong to a non-rise-fall category", () => {
    const higherLower = [offer("CALL", { contractCategory: "higher_lower" }), offer("PUT", { contractCategory: "higher_lower" })];
    expect(selectCollarSpec(higherLower, "R_100", 0.01)).toBeNull();
    const mixed = [offer("CALL", { contractCategory: "higher_lower" }), offer("PUT")];
    expect(selectCollarSpec(mixed, "R_100", 0.01)).toBeNull();
    const barrier = [offer("CALL", { barrier: "+0.10" }), offer("PUT", { barrier: "-0.10" })];
    expect(selectCollarSpec(barrier, "R_100", 0.01)).toBeNull();
  });

  it("accepts a legacy rise_fall category with no barrier", () => {
    const spec = selectCollarSpec([offer("CALL", { contractCategory: "rise_fall" }), offer("PUT", { contractCategory: "rise_fall" })], "R_100", 0.01);
    expect(spec).not.toBeNull();
    expect(spec?.category).toBe("rise_fall");
  });

  it("clamps a requested duration to the live offer and lock window", () => {
    const spec = selectCollarSpec([offer("CALL"), offer("PUT")], "R_100", 0.01);
    expect(clampCollarDuration(18, spec, 3)).toBe(10);
    expect(clampCollarDuration(4, spec, 3)).toBe(8);
    expect(maxCollarDuration(null)).toBe(20);
  });

  it("honors a market minimum above five ticks and keeps Leg 2 legal", () => {
    const spec = selectCollarSpec(
      [
        offer("CALL", { minContractDuration: "10t", maxContractDuration: "20t" }),
        offer("PUT", { minContractDuration: "10t", maxContractDuration: "20t" }),
      ],
      "R_100",
      0.01,
    );
    expect(spec?.minTickDuration).toBe(10);
    expect(clampCollarDuration(8, spec, 3)).toBe(13);
    expect(leg2DurationFor(13, 3)).toBe(10);
    expect(leg2DurationFor(13, 3)! >= (spec?.minTickDuration ?? 0)).toBe(true);
    expect(collarLockWindow(13, 3, 10)).toEqual({ start: 3, end: 3, valid: true });
    expect(clampLockStart(8, 13, 10)).toBe(3);
  });

  it("rejects a tick range that cannot fit any second leg", () => {
    const spec = selectCollarSpec(
      [
        offer("CALL", { minContractDuration: "10t", maxContractDuration: "10t" }),
        offer("PUT", { minContractDuration: "10t", maxContractDuration: "10t" }),
      ],
      "R_100",
      0.01,
    );
    expect(spec).toBeNull();
  });
});

describe("Collar stakes and risk plan", () => {
  it("ships the $0.35 symmetric and $0.70 + $0.35 weighted presets", () => {
    expect(presetStakes("symmetric", 0.35, 0.5, 0.5)).toEqual({ leg1: 0.35, leg2: 0.35 });
    expect(presetStakes("weighted", 0.35, 0.35, 0.35)).toEqual({ leg1: 0.7, leg2: 0.35 });
    expect(roundStake(0.37)).toBe(0.35);
    expect(roundStake(0.38)).toBe(0.4);
    expect(roundStake(0.01)).toBe(0.35);
  });

  it("derives the symmetric auto stop and quarter-rounded auto target", () => {
    const plan = computeCollarRiskPlan({
      leg1Stake: 0.35,
      leg2Stake: 0.35,
      martingaleEnabled: false,
      multiplier: 1.6,
      maxLevels: 2,
      leg1Multiple: COLLAR_FALLBACK_MULTIPLE,
      leg2Multiple: COLLAR_FALLBACK_MULTIPLE,
    });
    expect(plan.autoStopLoss).toBe(2.1);
    expect(plan.corridorNet).toBe(0.66);
    expect(plan.autoTakeProfit).toBe(2.75);
    expect(plan.effectiveMaxLevels).toBe(0);
  });

  it("derives the weighted continuation payoff and 6x leg-1 stop", () => {
    const plan = computeCollarRiskPlan({
      leg1Stake: 0.7,
      leg2Stake: 0.35,
      martingaleEnabled: false,
      multiplier: 1.6,
      maxLevels: 2,
      leg1Multiple: COLLAR_FALLBACK_MULTIPLE,
      leg2Multiple: COLLAR_FALLBACK_MULTIPLE,
    });
    expect(plan.corridorNet).toBe(0.99);
    expect(plan.autoStopLoss).toBe(4.2);
    expect(plan.autoTakeProfit).toBe(4);
  });

  it("builds the full martingale cycle cost as the auto stop", () => {
    const plan = computeCollarRiskPlan({
      leg1Stake: 0.35,
      leg2Stake: 0.35,
      martingaleEnabled: true,
      multiplier: 1.6,
      maxLevels: 2,
      leg1Multiple: COLLAR_FALLBACK_MULTIPLE,
      leg2Multiple: COLLAR_FALLBACK_MULTIPLE,
    });
    expect(plan.effectiveMaxLevels).toBe(2);
    expect(plan.levels.map((level) => level.roundCost)).toEqual([0.7, 1.1, 1.8]);
    expect(plan.rawCycleCost).toBe(3.6);
    expect(plan.autoStopLoss).toBe(3.6);
    expect(stakesForLevel(plan, 1)).toEqual({ level: 1, multiplier: 1.6, leg1Stake: 0.55, leg2Stake: 0.55, roundCost: 1.1, cumulativeCost: 1.8 });
  });

  it("escalates only on net losses below minus five cents", () => {
    expect(nextCollarLevel(0, -0.02, true, 2)).toBe(0);
    expect(nextCollarLevel(0, -0.37, true, 2)).toBe(1);
    expect(nextCollarLevel(1, -0.37, true, 2)).toBe(2);
    expect(nextCollarLevel(2, -0.37, true, 2)).toBe(2);
    expect(nextCollarLevel(1, 0.31, true, 2)).toBe(0);
    expect(nextCollarLevel(1, -0.37, false, 2)).toBe(0);
  });
});

describe("Four-scenario payoff matrix", () => {
  it("matches the symmetric expected numbers", () => {
    const matrix = buildCollarPayoffMatrix({ leg1Stake: 0.35, leg2Stake: 0.35, leg1Multiple: 1.94, leg2Multiple: 1.94 });
    expect(matrix.totalCost).toBe(0.7);
    expect(matrix.corridorProfit).toBe(0.66);
    expect(matrix.soloWinProfit).toBe(0.33);
    expect(matrix.savedMissLoss).toBe(-0.35);
    expect(matrix.lockedWorst).toBe(-0.02);
    expect(matrix.lockedBest).toBe(-0.02);
  });

  it("matches the weighted corridor, continuation and reversal numbers", () => {
    const matrix = buildCollarPayoffMatrix({ leg1Stake: 0.7, leg2Stake: 0.35, leg1Multiple: 1.94, leg2Multiple: 1.94 });
    expect(matrix.corridorProfit).toBe(0.99);
    expect(matrix.breakoutProfit).toBe(0.31);
    expect(matrix.reversalProfit).toBe(-0.37);
    expect(matrix.soloWinProfit).toBe(0.66);
    expect(matrix.savedMissLoss).toBe(-0.7);
  });

  it("classifies every grouped history outcome", () => {
    expect(classifyCollarOutcome(false, 0.33, 0)).toBe("SOLO_WIN");
    expect(classifyCollarOutcome(false, -0.35, 0)).toBe("SAVED_MISS");
    expect(classifyCollarOutcome(true, 0.33, 0.33)).toBe("CORRIDOR_2X");
    expect(classifyCollarOutcome(true, 0.33, -0.35)).toBe("COLLAR_SCRATCH");
    expect(classifyCollarOutcome(true, -0.35, -0.35)).toBe("COLLAR_LOSS");
  });
});
