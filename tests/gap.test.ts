import { describe, expect, it } from "vitest";
import { classifyGap, gapSignal, nextStake } from "@/gap";

const tape = (values: number[]) => values;

describe("micro-tick gap model", () => {
  it("counts up, flat and down over exactly N-1 intervals", () => {
    const stats = classifyGap(tape([1, 2, 2, 1, 3, 3]), 6);
    expect(stats).toMatchObject({ up: 2, flat: 2, down: 1, total: 5 });
    expect(stats.upPct).toBe(40);
    expect(stats.flatPct).toBe(40);
    expect(stats.downPct).toBe(20);
    expect(stats.gapPp).toBe(20);
    expect(stats.leader).toBe("up");
    expect(stats.ready).toBe(true);
  });

  it("treats a flat tape as balanced and never ready to signal", () => {
    const stats = classifyGap(tape([5, 5, 5, 5]), 4);
    expect(stats).toMatchObject({ up: 0, flat: 3, down: 0, gapPp: 0 });
    expect(stats.leader).toBe("balanced");
    expect(gapSignal(stats, "momentum", 10).side).toBeNull();
  });

  it("requires the full lookback before it can fire", () => {
    const stats = classifyGap(tape([1, 2, 3]), 5);
    expect(stats.ready).toBe(false);
    expect(gapSignal(stats, "momentum", 0).side).toBeNull();
  });

  it("mirrors momentum and mean-reversion on the same tape", () => {
    const stats = classifyGap(tape([1, 2, 3, 4, 5]), 5);
    expect(stats.gapPp).toBe(100);
    expect(gapSignal(stats, "momentum", 10).side).toBe("CALL");
    expect(gapSignal(stats, "meanrev", 10).side).toBe("PUT");
    const falling = classifyGap(tape([5, 4, 3, 2, 1]), 5);
    expect(gapSignal(falling, "momentum", 10).side).toBe("PUT");
    expect(gapSignal(falling, "meanrev", 10).side).toBe("CALL");
  });

  it("holds when the gap is under the threshold", () => {
    const stats = classifyGap(tape([1, 2, 2, 1, 2]), 5);
    expect(stats.leader).toBe("up");
    expect(stats.gapPp).toBe(25);
    expect(gapSignal(stats, "momentum", 30).side).toBeNull();
    expect(gapSignal(stats, "momentum", 20).side).toBe("CALL");
  });
});

describe("gap martingale", () => {
  it("uses fixed multiples and keeps the 0.35 floor", () => {
    expect(nextStake({ mode: "off", baseStake: 1, multiplier: 2, lastStake: 4, payout: 1.95, cumulativeLoss: 4 })).toBe(1);
    expect(nextStake({ mode: "2", baseStake: 1, multiplier: 2, lastStake: 1, payout: 1.95, cumulativeLoss: 1 })).toBe(2);
    expect(nextStake({ mode: "1.5", baseStake: 1, multiplier: 2, lastStake: 2, payout: 1.95, cumulativeLoss: 3 })).toBe(3);
    expect(nextStake({ mode: "custom", baseStake: 1, multiplier: 3, lastStake: 1, payout: 1.95, cumulativeLoss: 1 })).toBe(3);
    expect(nextStake({ mode: "2", baseStake: 1, multiplier: 2, lastStake: 0.35, payout: 1.95, cumulativeLoss: 0.35 })).toBe(0.7);
  });

  it("solves the payout-adjusted recovery", () => {
    const stake = nextStake({ mode: 'payout', baseStake: 1, multiplier: 2, lastStake: 1, payout: 1.95, cumulativeLoss: 1 });
    expect(stake).toBe(2.05);
    const rich = nextStake({ mode: 'payout', baseStake: 1, multiplier: 2, lastStake: 1, payout: 8.93, cumulativeLoss: 1 });
    expect(rich).toBe(1.13);
    const thin = nextStake({ mode: 'payout', baseStake: 1, multiplier: 2, lastStake: 1, payout: 1.09, cumulativeLoss: 1 });
    expect(thin).toBe(12.11);
  });

  it("falls back to doubling when the quote has no net payout", () => {
    expect(nextStake({ mode: "payout", baseStake: 1, multiplier: 2, lastStake: 1, payout: 1, cumulativeLoss: 1 })).toBe(2);
  });
});
