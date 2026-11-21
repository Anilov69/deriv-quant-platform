import { describe, expect, it } from "vitest";
import {
  binomialZ,
  chiSquarePValue,
  chiSquareUniform,
  decimalsFromPip,
  lastDigit,
  normCdf,
  shrunkProbability,
} from "@/engines/stats";
import { breakEvenProbability, evPerDollar, expectedValue, kellyFraction, suggestStake } from "@/utils/evCalculator";

describe("stats", () => {
  it("normal cdf", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it("chi-square p-values match tables", () => {
    expect(chiSquarePValue(16.919, 9)).toBeCloseTo(0.05, 3);
    expect(chiSquarePValue(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chiSquareUniform(Array(10).fill(10)).chi2).toBe(0);
  });
  it("binomial z", () => {
    expect(binomialZ(60, 100, 0.5)).toBeCloseTo(2, 6);
  });
  it("shrinkage stays near theory for small samples", () => {
    expect(shrunkProbability(5, 5, 0.5, 200)).toBeCloseTo(205 / 205 / 2 + 2.5 / 205, 6);
    expect(shrunkProbability(0, 0, 0.1, 200)).toBe(0.1);
  });
  it("last digit respects pip precision", () => {
    expect(lastDigit(4853.1, 3)).toBe(0);
    expect(lastDigit(81.1374, 4)).toBe(4);
    expect(decimalsFromPip(0.01)).toBe(2);
    expect(decimalsFromPip(3)).toBe(3);
  });
});

describe("ev calculator", () => {
  // Live Deriv quote: stake 10 → payout 19.53 on Even/Odd.
  it("break-even and EV", () => {
    expect(breakEvenProbability(10, 19.53)).toBeCloseTo(0.512, 3);
    expect(expectedValue(0.5, 10, 19.53)).toBeCloseTo(-0.235, 3);
    expect(evPerDollar(0.55, 10, 19.53)).toBeGreaterThan(0);
  });
  it("kelly", () => {
    // b = 1, p = 0.6 → f* = 0.2
    expect(kellyFraction(0.6, 10, 20)).toBeCloseTo(0.2, 6);
    expect(kellyFraction(0.5, 10, 19.53)).toBeLessThan(0);
    const s = suggestStake(0.6, 10, 20, 1000, 2);
    expect(s.fraction).toBeCloseTo(0.02, 6); // quarter-Kelly 5% capped at 2%
    expect(s.stake).toBe(20);
    expect(s.capped).toBe(true);
    expect(suggestStake(0.5, 10, 19.53, 1000, 2).stake).toBe(0);
  });
});
