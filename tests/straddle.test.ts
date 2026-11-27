import { describe, expect, it } from "vitest";
import type { ContractOffer, Quote } from "@/deriv";
import {
  barrierOffsetFor,
  buildStraddlePayoutPreview,
  clampTouchDuration,
  classifyStraddleOutcome,
  computeAtrSqueeze,
  computeStraddleRiskPlan,
  formatSignedBarrier,
  isSqueezeReady,
  nextStraddleLevel,
  parseTickContractDuration,
  selectOnetouchTickSpec,
} from "@/utils/straddleMath";

function offer(patch: Partial<ContractOffer>): ContractOffer {
  return {
    contractType: "ONETOUCH",
    contractCategory: "touch",
    minContractDuration: "5t",
    maxContractDuration: "10t",
    expiryType: "tick",
    barrier: "+0.14",
    defaultStake: 0.35,
    pipSize: 0.01,
    underlyingSymbol: "R_100",
    ...patch,
  };
}

function quote(ask: number, payout: number): Quote {
  return { id: "q-" + ask + "-" + payout, ask, payout };
}

describe("ATR squeeze", () => {
  it("uses the last 10 and 50 absolute tick deltas", () => {
    const prices = [100];
    for (let index = 1; index <= 50; index += 1) {
      prices.push(prices[prices.length - 1] + (index <= 40 ? 1 : 0.2));
    }
    const atr = computeAtrSqueeze(prices);
    expect(atr.ready).toBe(true);
    expect(atr.fastSamples).toBe(10);
    expect(atr.baselineSamples).toBe(50);
    expect(atr.fastAtr).toBeCloseTo(0.2, 10);
    expect(atr.baselineAtr).toBeCloseTo(0.84, 10);
    expect(atr.squeezeRatio).toBeCloseTo(0.238095, 5);
  });

  it("never calls a cold buffer a squeeze", () => {
    const atr = computeAtrSqueeze([100, 100.1, 100.05]);
    expect(atr.ready).toBe(false);
    expect(isSqueezeReady(atr, 0.75, true)).toBe(false);
    expect(isSqueezeReady(atr, 0.75, false)).toBe(false);
  });

  it("allows the filter to be bypassed only after the baseline fills", () => {
    const prices = Array.from({ length: 51 }, (_, index) => 100 + index);
    const atr = computeAtrSqueeze(prices);
    expect(isSqueezeReady(atr, 0.1, true)).toBe(false);
    expect(isSqueezeReady(atr, 0.1, false)).toBe(true);
  });
});

describe("tick ONETOUCH capability", () => {
  it("parses tick durations and ignores minute durations", () => {
    expect(parseTickContractDuration("5t")).toBe(5);
    expect(parseTickContractDuration(" 10T ")).toBe(10);
    expect(parseTickContractDuration("1m")).toBeNull();
    expect(parseTickContractDuration("")).toBeNull();
  });

  it("selects a tick entry and exposes the default barrier", () => {
    const spec = selectOnetouchTickSpec([offer({}), offer({ expiryType: "daily", minContractDuration: "1d", maxContractDuration: "1d", barrier: null })]);
    expect(spec).not.toBeNull();
    expect(spec?.minTicks).toBe(5);
    expect(spec?.maxTicks).toBe(10);
    expect(spec?.defaultBarrier).toBeCloseTo(0.14);
    expect(spec?.pipSize).toBeCloseTo(0.01);
    expect(spec?.otherTenors).toEqual(["daily (1d-1d)"]);
  });

  it("rejects a symbol with no tick ONETOUCH and caps duration at 15", () => {
    expect(selectOnetouchTickSpec([offer({ expiryType: "daily" })])).toBeNull();
    const spec = selectOnetouchTickSpec([offer({ maxContractDuration: "20t" })]);
    expect(spec?.maxTicks).toBe(15);
    expect(clampTouchDuration(30, spec)).toBe(15);
    expect(clampTouchDuration(2, spec)).toBe(5);
  });

  it("rejects a tick tenor whose minimum is beyond the page cap", () => {
    expect(
      selectOnetouchTickSpec([offer({ minContractDuration: "20t", maxContractDuration: "25t" })]),
    ).toBeNull();
  });
});

describe("barrier presets", () => {
  it("scales and rounds to the symbol pip", () => {
    expect(barrierOffsetFor(0.14, "balanced", 0.2, 0.01)).toBeCloseTo(0.14);
    expect(barrierOffsetFor(0.14, "tight", 0.2, 0.01)).toBeCloseTo(0.11);
    expect(barrierOffsetFor(0.14, "wide", 0.2, 0.01)).toBeCloseTo(0.19);
    expect(barrierOffsetFor(0.14, "custom", 0.333, 0.01)).toBeCloseTo(0.33);
  });

  it("formats signed relative barriers", () => {
    expect(formatSignedBarrier(0.14, 2, "upper")).toBe("+0.14");
    expect(formatSignedBarrier(0.14, 2, "lower")).toBe("-0.14");
  });
});

describe("straddle risk plan", () => {
  it("uses 4x the flat cost and a 65%-of-SL take-profit floor", () => {
    const plan = computeStraddleRiskPlan({
      baseStake: 0.35,
      martingaleEnabled: false,
      multiplier: 1.65,
      maxLevels: 2,
      singleSidePayout: 1.16,
    });
    expect(plan.levels).toHaveLength(1);
    expect(plan.initialCost).toBeCloseTo(0.7);
    expect(plan.autoStopLoss).toBeCloseTo(2.8);
    expect(plan.singleSideNet).toBeCloseTo(0.46);
    expect(plan.autoTakeProfit).toBeCloseTo(1.75);
    expect(plan.recommendedBuffer).toBeCloseTo(9.8);
  });

  it("budgets one full martingale cycle", () => {
    const plan = computeStraddleRiskPlan({
      baseStake: 0.35,
      martingaleEnabled: true,
      multiplier: 1.65,
      maxLevels: 2,
      singleSidePayout: null,
    });
    expect(plan.levels.map((level) => level.legStake)).toEqual([0.35, 0.58, 0.95]);
    expect(plan.levels.map((level) => level.straddleCost)).toEqual([0.7, 1.16, 1.9]);
    expect(plan.rawCycleCost).toBeCloseTo(3.76);
    expect(plan.autoStopLoss).toBeCloseTo(3.8);
  });

  it("resets after a non-loss and steps up after a loss", () => {
    expect(nextStraddleLevel(0, false, true, 2)).toBe(1);
    expect(nextStraddleLevel(1, false, true, 2)).toBe(2);
    expect(nextStraddleLevel(2, false, true, 2)).toBe(2);
    expect(nextStraddleLevel(1, true, true, 2)).toBe(0);
    expect(nextStraddleLevel(1, false, false, 2)).toBe(0);
  });
});

describe("payout and outcome", () => {
  it("prices one-sided and whipsaw outcomes from the exact two asks", () => {
    const preview = buildStraddlePayoutPreview(quote(0.35, 0.82), quote(0.35, 1.09));
    expect(preview.cost).toBeCloseTo(0.7);
    expect(preview.upperNet).toBeCloseTo(0.12);
    expect(preview.lowerNet).toBeCloseTo(0.39);
    expect(preview.doublePayout).toBeCloseTo(1.91);
    expect(preview.doubleNet).toBeCloseTo(1.21);
    expect(preview.quietNet).toBeCloseTo(-0.7);
    expect(preview.doubleRoi).toBeCloseTo(172.9);
  });

  it("classifies zero, one, and two touched legs", () => {
    expect(classifyStraddleOutcome(0)).toBe("RANGE_LOSS");
    expect(classifyStraddleOutcome(1)).toBe("ONE_SIDE_WIN");
    expect(classifyStraddleOutcome(2)).toBe("WHIPSAW_2X");
  });
});
