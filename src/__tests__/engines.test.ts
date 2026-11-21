import { describe, expect, it } from "vitest";
import { runContinuousEngine } from "@/engines/continuousEngine";
import { runStepEngine } from "@/engines/stepEngine";
import { detectJumps, runJumpEngine } from "@/engines/jumpEngine";
import { DEFAULT_ENGINE_SETTINGS } from "@/engines/types";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const rand = rng(42);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const times = (n: number) => Array.from({ length: n }, (_, i) => 1_700_000_000 + i);

describe("engines on simulated RNG data", () => {
  it("continuous: digits ~uniform, P_model near theory", () => {
    const prices = [1000];
    for (let i = 1; i < 1000; i++) prices.push(prices[i - 1] * Math.exp(0.0005 * gauss()));
    const out = runContinuousEngine({ prices, times: times(1000), decimals: 2, settings: DEFAULT_ENGINE_SETTINGS });
    expect(out.insights.windows[1000].n).toBe(1000);
    const even = out.candidates.find((c) => c.contractType === "DIGITEVEN")!;
    expect(Math.abs(even.pModel - 0.5)).toBeLessThan(0.05);
    expect(out.candidates.filter((c) => c.contractType === "CALL")).toHaveLength(DEFAULT_ENGINE_SETTINGS.riseFallDurations.length);
  });

  it("step: detects fixed step size and deterministic parity flips", () => {
    const prices = [7000];
    for (let i = 1; i < 1000; i++) prices.push(Math.round((prices[i - 1] + (rand() < 0.5 ? 0.1 : -0.1)) * 10) / 10);
    const out = runStepEngine({ prices, times: times(1000), decimals: 1, settings: { ...DEFAULT_ENGINE_SETTINGS, digitDuration: 1 } });
    expect(out.insights.stepSizes).toEqual([{ size: 0.1, count: 999 }]);
    expect(Math.abs(out.insights.rho1)).toBeLessThan(0.1);
    // Horizon 2 steps of ±1 digit → parity always preserved: Even/Odd is deterministic.
    const even = out.candidates.find((c) => c.contractType === "DIGITEVEN")!;
    const odd = out.candidates.find((c) => c.contractType === "DIGITODD")!;
    expect(even.k === even.n || odd.k === odd.n).toBe(true);
  });

  it("jump: finds injected jumps and blocks on hazard", () => {
    const prices = [100];
    for (let i = 1; i < 600; i++) prices.push(prices[i - 1] + 0.01 * gauss() + (i === 300 ? 0.5 : 0));
    const { jumps } = detectJumps(prices, times(600), 5);
    expect(jumps.map((j) => j.index)).toContain(300);
    const out = runJumpEngine({
      prices,
      times: times(600),
      decimals: 4,
      settings: { ...DEFAULT_ENGINE_SETTINGS, jumpHazardBlock: 0.0001 },
    });
    expect(out.insights.lambda).toBeGreaterThan(0);
    expect(out.candidates.filter((c) => c.contractType === "CALL").every((c) => c.blocked)).toBe(true);
  });

  it("handles empty / tiny inputs without crashing", () => {
    for (const run of [runContinuousEngine, runStepEngine, runJumpEngine]) {
      const out = run({ prices: [], times: [], decimals: 2, settings: DEFAULT_ENGINE_SETTINGS });
      expect(out.warmingUp).toBe(true);
      run({ prices: [1], times: [1], decimals: 2, settings: DEFAULT_ENGINE_SETTINGS });
    }
  });
});
