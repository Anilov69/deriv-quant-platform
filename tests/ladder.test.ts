import { describe, expect, it } from "vitest";
import { buildCandidates, rank } from "@/ladder";
import { posterior, weightedDigitCounts } from "@/stats";

const probabilities = posterior(weightedDigitCounts([1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9], 40), 0.5);

describe("candidate construction", () => {
  it("offers only Rise/Fall on step indices, which quote no digit contracts", () => {
    const candidates = buildCandidates({ family: "step", probabilities, currentDigit: 3, momentumZ: 0.4 });
    expect(candidates.map((candidate) => candidate.contract)).toEqual(["CALL", "PUT"]);
    expect(candidates.some((candidate) => candidate.contract.startsWith("DIGIT"))).toBe(false);
  });

  it("prices digit contracts on continuous and jump indices", () => {
    for (const family of ["continuous", "jump"] as const) {
      const candidates = buildCandidates({ family, probabilities, currentDigit: 3, momentumZ: 0 });
      expect(candidates.some((candidate) => candidate.contract === "DIGITMATCH")).toBe(true);
      expect(candidates.some((candidate) => candidate.contract === "DIGITDIFF")).toBe(true);
      expect(candidates.some((candidate) => candidate.contract === "CALL")).toBe(true);
    }
  });

  it("keeps every probability strictly inside zero and one", () => {
    const candidates = buildCandidates({ family: "continuous", probabilities, currentDigit: 0, momentumZ: 0 });
    for (const candidate of candidates) {
      expect(candidate.probability).toBeGreaterThan(0);
      expect(candidate.probability).toBeLessThan(1);
      expect(candidate.duration).toBeGreaterThan(0);
    }
  });

  it("matches DIGITMATCH probability to the digit's posterior mass", () => {
    const candidates = buildCandidates({ family: "continuous", probabilities, currentDigit: 0, momentumZ: 0 });
    const best = probabilities.indexOf(Math.max(...probabilities));
    const match = candidates.find((candidate) => candidate.contract === "DIGITMATCH" && candidate.barrier === String(best));
    expect(match?.probability).toBeCloseTo(probabilities[best], 10);
  });
});

describe("ranking", () => {
  it("flags only quotes that clear the payout's break-even", () => {
    const candidates = buildCandidates({ family: "step", probabilities, currentDigit: 0, momentumZ: 0 });
    const quotes = new Map<string, { ask: number; payout: number }>();
    // A digit-match payout near the real 8.93x can beat the model; a thin one cannot.
    quotes.set(candidates[0].key, { ask: 1, payout: 8.93 });
    quotes.set(candidates[1].key, { ask: 1, payout: 2.4 });
    const rows = rank(candidates, quotes);
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBe(true);
    expect(rows[0].breakEven).toBeCloseTo(1 / 8.93, 10);
    expect(rows[1].value).toBe(false);
    expect(rows[0].edge).toBeGreaterThan(rows[1].edge);
  });

  it("drops candidates Deriv did not quote", () => {
    const candidates = buildCandidates({ family: "step", probabilities, currentDigit: 0, momentumZ: 0 });
    const rows = rank(candidates, new Map([[candidates[0].key, { ask: 1, payout: 2 }]]));
    expect(rows).toHaveLength(1);
  });
});