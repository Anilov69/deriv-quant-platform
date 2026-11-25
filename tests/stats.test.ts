import { describe, expect, it } from "vitest";
import {
  digitsFrom,
  entropyBits,
  evPerStake,
  jumpProfile,
  momentumZ,
  posterior,
  quietProbability,
  repeatProbability,
  weightedDigitCounts,
} from "@/stats";

describe("digit extraction", () => {
  it("reads digits at the quote's own precision", () => {
    expect(digitsFrom([446.62, 446.63, 446.6], 2)).toEqual([2, 3, 0]);
    expect(digitsFrom([1234.567, 1234.568], 3)).toEqual([7, 8]);
  });

  it("never produces a digit outside 0..9", () => {
    for (const digit of digitsFrom([0.0001, 9.9999, 12.345, 0], 4)) {
      expect(digit).toBeGreaterThanOrEqual(0);
      expect(digit).toBeLessThan(10);
    }
  });
});

describe("recency-weighted posterior", () => {
  it("gives the newest tick full weight and older ticks less", () => {
    const counts = weightedDigitCounts([9, 0], 10);
    expect(counts[0]).toBeCloseTo(1, 10);
    expect(counts[9]).toBeLessThan(1);
    expect(counts[9]).toBeGreaterThan(0);
  });

  it("always normalises to one", () => {
    const probabilities = posterior(weightedDigitCounts([1, 2, 3, 4, 5, 6, 7, 8, 9, 0], 40));
    const total = probabilities.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(probabilities).toHaveLength(10);
  });

  it("pulls toward uniform when there is no data", () => {
    for (const probability of posterior(weightedDigitCounts([], 40))) {
      expect(probability).toBeCloseTo(0.1, 10);
    }
  });

  it("reports maximum entropy for a uniform posterior", () => {
    expect(entropyBits(new Array<number>(10).fill(0.1))).toBeCloseTo(Math.log2(10), 10);
  });
});

describe("repeat probability", () => {
  it("approaches one when the digit never changes", () => {
    expect(repeatProbability([4, 4, 4, 4, 4, 4])).toBeGreaterThan(0.9);
  });

  it("stays near a tenth for a well mixed stream", () => {
    const digits = [1, 2, 1, 3, 2, 4, 1, 5, 3, 6, 2, 7, 1, 8, 3, 9, 4, 0, 5, 1];
    expect(repeatProbability(digits)).toBeLessThan(0.2);
  });

  it("is defined for a single tick", () => {
    expect(repeatProbability([7])).toBe(0.1);
  });
});

describe("momentum", () => {
  it("is positive for a rising series and negative for a falling one", () => {
    const rising = Array.from({ length: 80 }, (_, index) => 100 + index);
    const falling = Array.from({ length: 80 }, (_, index) => 200 - index);
    expect(momentumZ(rising)).toBeGreaterThan(1);
    expect(momentumZ(falling)).toBeLessThan(-1);
  });

  it("stays near zero for a flat series", () => {
    expect(Math.abs(momentumZ(new Array<number>(80).fill(50)))).toBe(0);
  });

  it("returns zero until there is enough history", () => {
    expect(momentumZ([1, 2, 3])).toBe(0);
  });
});

describe("jump profile", () => {
  it("finds a step in an otherwise quiet series", () => {
    const quotes = [...Array.from({ length: 60 }, () => 100), 108, 108, 108];
    const profile = jumpProfile(quotes);
    expect(profile.intensity).toBeGreaterThan(0);
    expect(profile.sinceLast).toBeLessThan(quotes.length);
  });

  it("reports no jumps for a perfectly quiet series", () => {
    expect(jumpProfile(new Array<number>(80).fill(100)).intensity).toBe(0);
  });

  it("decays the quiet probability with the horizon", () => {
    const five = quietProbability(0.2, 5);
    const fifty = quietProbability(0.2, 50);
    expect(five).toBeGreaterThan(fifty);
    expect(five).toBeCloseTo(Math.exp(-1), 10);
  });
});

describe("expected value", () => {
  it("matches the ladder's arithmetic", () => {
    // 12% chance paying 8.93x against a 1.00 stake.
    expect(evPerStake(0.12, 1, 8.93)).toBeCloseTo(0.0716, 6);
    expect(evPerStake(0.1, 1, 8.93)).toBeLessThan(0);
  });
});