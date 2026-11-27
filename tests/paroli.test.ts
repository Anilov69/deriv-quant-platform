import { describe, expect, it } from "vitest";
import {
  advanceDrought,
  autoStopLoss,
  autoTakeProfit,
  buildParoliPlan,
  clampThreshold,
  decimalsFromPip,
  digitFromQuote,
  emptyDrought,
  findTrigger,
  manualTail,
  seedDroughts,
  stepStakeFor,
} from "@/utils/paroliMath";
import type { RadarDrought } from "@/utils/paroliMath";

function card(patch: Partial<RadarDrought>): RadarDrought {
  return {
    symbol: "1HZ100V",
    high: 0,
    low: 0,
    enabled: true,
    ready: true,
    overAvailable: true,
    underAvailable: true,
    order: 0,
    ...patch,
  };
}

describe("digit extraction", () => {
  it("keeps trailing zeros from a fixed-width quote", () => {
    expect(digitFromQuote(1794.2, 2)).toBe(0);
    expect(digitFromQuote(1794.29, 2)).toBe(9);
    expect(digitFromQuote(1794.2, 1)).toBe(2);
    expect(decimalsFromPip(0.01)).toBe(2);
    expect(decimalsFromPip(0.001)).toBe(3);
  });

  it("counts tail droughts independently", () => {
    let state = emptyDrought();
    for (const digit of [7, 8, 0, 1, 3, 4]) state = advanceDrought(state, digit);
    expect(state).toEqual({ high: 4, low: 2, lastDigit: 4, ticks: 6 });
  });

  it("seeds both counters from the 50-tick history", () => {
    const state = seedDroughts([7, 8, 0, 1, 3, 4], 0);
    expect(state.high).toBe(4);
    expect(state.low).toBe(2);
    expect(state.ticks).toBe(6);
  });
});

describe("radar trigger priority", () => {
  it("picks the longest eligible drought across the pool", () => {
    const trigger = findTrigger(
      [
        card({ symbol: "1HZ10V", high: 9, low: 2, order: 0 }),
        card({ symbol: "1HZ25V", high: 8, low: 11, order: 1 }),
      ],
      8,
      "both",
    );
    expect(trigger).toEqual({ symbol: "1HZ25V", tail: "under", drought: 11 });
  });

  it("respects direction and unsupported-tail flags", () => {
    const onlyOver = findTrigger(
      [card({ symbol: "JD10", high: 12, low: 0, overAvailable: false, underAvailable: true })],
      8,
      "both",
    );
    expect(onlyOver).toBeNull();
    expect(findTrigger([card({ high: 9, low: 12 })], 8, "over")).toEqual({
      symbol: "1HZ100V",
      tail: "over",
      drought: 9,
    });
  });

  it("does not arm warming or disabled cards", () => {
    expect(findTrigger([card({ high: 20, ready: false })], 8, "both")).toBeNull();
    expect(findTrigger([card({ high: 20, enabled: false })], 8, "both")).toBeNull();
  });

  it("clamps the threshold to the supported 4-20 range", () => {
    expect(clampThreshold(2)).toBe(4);
    expect(clampThreshold(25)).toBe(20);
    expect(clampThreshold(8.4)).toBe(8);
  });

  it("chooses the deeper manual tail and honors a locked direction", () => {
    expect(manualTail("both", 4, 9)).toBe("under");
    expect(manualTail("both", 9, 4)).toBe("over");
    expect(manualTail("under", 20, 0)).toBe("under");
  });
});

describe("Paroli plan", () => {
  it("matches the 2-step house-money example at a 2.92x multiple", () => {
    const plan = buildParoliPlan(0.35, 2, 100, 2.92);
    expect(plan.steps.map((step) => step.stake)).toEqual([0.35, 1.02]);
    expect(plan.steps.map((step) => step.payout)).toEqual([1.02, 2.98]);
    expect(plan.netProfit).toBe(2.63);
    expect(plan.roiPct).toBe(751.43);
    expect(plan.breakevenMisses).toBeCloseTo(7.514, 3);
    expect(plan.maxRisk).toBe(0.35);
  });

  it("calculates the 8x auto stop and quarter-rounded auto target", () => {
    expect(autoStopLoss(0.35)).toBe(2.8);
    expect(autoTakeProfit(2.63)).toBe(5.25);
  });

  it("rolls a third step at full reinvestment", () => {
    const plan = buildParoliPlan(0.35, 3, 100, 2.92);
    expect(plan.steps.map((step) => step.stake)).toEqual([0.35, 1.02, 2.98]);
    expect(plan.finalPayout).toBe(8.7);
    expect(plan.netProfit).toBe(8.35);
  });

  it("uses a reduced roll at 75 percent and still never risks more than the base", () => {
    const plan = buildParoliPlan(0.35, 2, 75, 2.92);
    expect(stepStakeFor(1.02, 75)).toBe(0.77);
    expect(plan.steps[1].stake).toBe(0.77);
    expect(plan.maxRisk).toBe(0.35);
    expect(plan.netProfit).toBe(2.15);
  });
});
