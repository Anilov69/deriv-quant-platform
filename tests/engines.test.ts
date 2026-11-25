import { describe, expect, it } from "vitest";
import { analyzeContinuous } from "../src/engines/continuous";
import { analyzeJump, DEFAULT_JUMP_MULTIPLIER } from "../src/engines/jump";
import { analyzeStep } from "../src/engines/step";
import {
  calculateEv,
  evaluateKillSwitches,
  kellyStake,
  nextStake,
  payoutAwareMultiplier,
  probabilityOfRuinForProgression,
  progressionPreview,
} from "../src/risk/martingale";
import type { RiskSettings, Tick } from "../src/types";

function ticksFromDigits(digits: number[], quoteStart = 100): Tick[] {
  return digits.map((digit, index) => ({
    epoch: 1_700_000_000_000 + index * 1000,
    quote: quoteStart + index * 0.01,
    digit,
  }));
}

function riskSettings(overrides: Partial<RiskSettings> = {}): RiskSettings {
  return {
    baseStake: 10,
    martingale: false,
    multiplier: 2,
    maxStep: 100,
    mode: "next-signal",
    kellyFraction: 0.5,
    dailyStopLoss: 100,
    dailyTakeProfit: 200,
    maxConsecutiveLosses: 4,
    ...overrides,
  };
}

describe("martingale risk calculations", () => {
  it("calculates known EV, break-even, payout percentage, and edge values", () => {
    const estimate = calculateEv(0.6, 20, 10);
    expect(estimate.expectedValue).toBeCloseTo(2, 10);
    expect(estimate.breakEvenProbability).toBeCloseTo(0.5, 10);
    expect(estimate.payoutPercentage).toBeCloseTo(1, 10);
    expect(estimate.edge).toBeCloseTo(0.1, 10);
    expect(estimate.actionable).toBe(true);

    const losingEstimate = calculateEv(0.4, 20, 10);
    expect(losingEstimate.expectedValue).toBeCloseTo(-2, 10);
    expect(losingEstimate.actionable).toBe(false);
  });

  it("uses fractional Kelly with martingale off and flat stakes without an edge", () => {
    const settings = riskSettings();
    expect(nextStake(settings, 1000, 3, 0.6, 20)).toBeCloseTo(100, 10);
    expect(nextStake(settings, 1000, 3, 0.5, 20)).toBeCloseTo(10, 10);
    expect(nextStake(settings, 1000, 3, 0.4, 20)).toBeCloseTo(10, 10);
  });

  it("uses payout-aware progression with martingale on and respects step and bankroll caps", () => {
    const settings = riskSettings({ martingale: true, maxStep: 3 });
    expect(payoutAwareMultiplier(1)).toBeCloseTo(2, 10);
    expect(payoutAwareMultiplier(0.5)).toBeCloseTo(3, 10);
    expect(nextStake(settings, 1000, 2, 0.6, 20)).toBeCloseTo(40, 10);
    expect(nextStake(settings, 1000, 5, 0.6, 20)).toBeCloseTo(80, 10);
    expect(nextStake(settings, 50, 5, 0.6, 20)).toBeCloseTo(50, 10);
  });

  it("caps Kelly exposure and returns zero without a positive edge", () => {
    expect(kellyStake(1000, 0.75, 2, 1, 0.25)).toBeCloseTo(250, 10);
    expect(kellyStake(1000, 0.5, 2, 0.5)).toBe(0);
    expect(kellyStake(1000, 0.9, 2, 0)).toBe(0);
  });

  it("models cumulative capital and full losing-streak probability", () => {
    const settings = riskSettings({ martingale: true, maxStep: 4 });
    const rows = progressionPreview(settings, 1000, 0.6, 20, 4);
    expect(rows.map((row) => row.stake)).toEqual([10, 20, 40, 80]);
    expect(rows[3].cumulativeCapital).toBeCloseTo(150, 10);
    expect(rows[3].cumulativeLoss).toBeCloseTo(150, 10);
    expect(rows[3].probabilityOfLoss).toBeCloseTo(0.4 ** 4, 10);
    expect(probabilityOfRuinForProgression(0.6, rows)).toBeCloseTo(0.4 ** 4, 10);
  });

  it("evaluates daily stop-loss and take-profit kill switches", () => {
    const settings = riskSettings();
    expect(evaluateKillSwitches(1000, 900, settings)).toEqual({
      stopped: true,
      reason: "daily-stop-loss",
    });
    expect(evaluateKillSwitches(1000, 1201, settings)).toEqual({
      stopped: true,
      reason: "daily-take-profit",
    });
    expect(evaluateKillSwitches(1000, 1050, settings)).toEqual({ stopped: false });
  });

  it("rejects invalid public inputs instead of emitting non-finite outputs", () => {
    expect(() => calculateEv(Number.NaN, 20, 10)).toThrow(/probability/);
    expect(() => calculateEv(0.6, 10, 10)).toThrow(/payout/);
    expect(() => nextStake(riskSettings(), -1, 0, 0.6, 20)).toThrow(/bankroll/);
    expect(() => payoutAwareMultiplier(0)).toThrow(/payoutPercentage/);
  });
});

describe("continuous engine", () => {
  it("measures maximum Shannon entropy for uniform digits", () => {
    const digits = Array.from({ length: 100 }, (_, index) => index % 10);
    const analysis = analyzeContinuous("uniform", ticksFromDigits(digits));
    expect(analysis.entropy100).toBeCloseTo(Math.log2(10), 10);
    expect(analysis.entropy300).toBeCloseTo(Math.log2(10), 10);
    expect(analysis.entropy1000).toBeCloseTo(Math.log2(10), 10);
    for (const count of analysis.digitCounts100) expect(count).toBe(10);
    for (const score of analysis.zScores) expect(score).toBeCloseTo(0, 10);
  });

  it("emits deterministic bounded signal shapes from the final tick epoch", () => {
    const digits = Array.from({ length: 300 }, (_, index) => index % 5 === 0 ? (index / 5) % 10 : 7);
    const ticks = ticksFromDigits(digits);
    const first = analyzeContinuous("biased", ticks);
    const second = analyzeContinuous("biased", ticks);
    expect(first.signals).toEqual(second.signals);
    expect(first.signals.length).toBeGreaterThan(0);
    for (const signal of first.signals) {
      expect(signal.id).toContain("biased");
      expect(signal.id).toContain(String(signal.contractType));
      expect(signal.createdAt).toBe(ticks[ticks.length - 1].epoch);
      expect(signal.probability).toBeGreaterThanOrEqual(0);
      expect(signal.probability).toBeLessThanOrEqual(1);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
      expect(signal.score).toBeGreaterThanOrEqual(0);
      expect(signal.score).toBeLessThanOrEqual(1);
      expect(signal.reasons.length).toBeGreaterThan(0);
      if (signal.contractType === "CALL" || signal.contractType === "PUT") {
        expect(signal.durationTicks).toBeGreaterThanOrEqual(3);
        expect(signal.durationTicks).toBeLessThanOrEqual(5);
      }
    }
  });

  it("filters persistent repeat bias using lag autocorrelation", () => {
    const analysis = analyzeContinuous("persistent", ticksFromDigits(Array.from({ length: 300 }, () => 7)));
    expect(analysis.lagAutocorrelation).toBe(0);
    expect(analysis.repeatRate).toBe(1);
    expect(analysis.signals.filter((signal) =>
      signal.contractType === "DIGITMATCH" || signal.contractType === "DIGITDIFF",
    )).toEqual([]);
  });
});

describe("step engine", () => {
  it("builds empirical counts and row-normalized Bayesian transitions", () => {
    const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3];
    const analysis = analyzeStep("step", ticksFromDigits(digits));
    expect(analysis.transitionCounts[0][1]).toBe(2);
    expect(analysis.transitionCounts[3][4]).toBe(1);
    for (const row of analysis.transitionMatrix) {
      expect(row.reduce((total, probability) => total + probability, 0)).toBeCloseTo(1, 10);
      for (const probability of row) expect(probability).toBeGreaterThan(0);
    }
    expect(analysis.observedSteps).toHaveLength(13);
    expect(analysis.observedSteps).toContain(1);
    expect(analysis.observedSteps).toContain(9);
    expect(analysis.maxObservedStep).toBe(9);
    expect(analysis.streakDirection).toBe("up");
    expect(analysis.streak).toBe(3);
  });
});

describe("jump engine", () => {
  it("detects configured jumps and suppresses signals under elevated hazard", () => {
    const ticks: Tick[] = [];
    let quote = 100;
    for (let index = 0; index < 30; index += 1) {
      if (index > 0) quote += index % 5 === 0 ? 5 : 0.001;
      ticks.push({ epoch: 1_700_000_000_000 + index * 1000, quote, digit: 7 });
    }
    const analysis = analyzeJump("jump", ticks, {
      atrMultiplier: DEFAULT_JUMP_MULTIPLIER,
      elevatedHazardThreshold: 0.01,
    });
    expect(analysis.jumps.length).toBeGreaterThan(0);
    expect(analysis.jumpIntensity).toBeCloseTo(analysis.jumps.length / (ticks.length - 1), 10);
    expect(analysis.elevatedHazard).toBe(true);
    expect(analysis.signals).toEqual([]);
    expect(analysis.ticksSinceJump).toBe(ticks.length - 1 - analysis.jumps[analysis.jumps.length - 1]);
  });

  it("allows digit signals after sufficient quiet ticks when hazard is low", () => {
    const digits = Array.from({ length: 300 }, (_, index) => (index < 20 ? index % 10 : 7));
    const analysis = analyzeJump("calm", ticksFromDigits(digits));
    expect(analysis.jumps).toEqual([]);
    expect(analysis.hazard).toBe(0);
    expect(analysis.stabilized).toBe(true);
    expect(analysis.signals.some((signal) => signal.contractType === "DIGITMATCH")).toBe(true);
  });

  it("emits bounded Rise/Fall micro-drift signals after stabilization", () => {
    const ticks: Tick[] = Array.from({ length: 300 }, (_, index) => {
      const quote = 100 + index * 0.002 + Math.sin(index * 1.7) * 0.0001;
      return { epoch: 1_700_000_000_000 + index * 1000, quote, digit: index % 10 };
    });
    const analysis = analyzeJump("drift", ticks);
    expect(analysis.jumps).toEqual([]);
    expect(analysis.microDrift).toBeGreaterThan(0);
    const drift = analysis.signals.find((signal) => signal.contractType === "CALL");
    expect(drift).toBeDefined();
    expect(drift?.durationTicks).toBeGreaterThanOrEqual(3);
    expect(drift?.durationTicks).toBeLessThanOrEqual(5);
  });
});
