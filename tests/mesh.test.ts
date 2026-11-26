import { describe, expect, it } from "vitest";
import {
  MIN_STAKE,
  buildMesh,
  bundleTotal,
  combinedProbability,
  consensusOf,
  decimalsFromPip,
  digitsFromQuotes,
  dominanceShare,
  evaluateMesh,
  formatQuote,
  lastDigit,
  nodeTone,
  scoreDigits,
  splitStakes,
  topDigits,
  transitionProbabilities,
} from "@/utils/transitionMeshMath";
import type { MeshWindow } from "@/utils/transitionMeshMath";

function windowOf(counts: number[]): MeshWindow {
  const total = counts.reduce((sum, count) => sum + count, 0);
  let hottest = 0;
  for (let digit = 1; digit < 10; digit += 1) if (counts[digit] > counts[hottest]) hottest = digit;
  let runnerUp = hottest === 0 ? 1 : 0;
  for (let digit = 0; digit < 10; digit += 1) {
    if (digit === hottest) continue;
    if (counts[digit] > counts[runnerUp]) runnerUp = digit;
  }
  const min = Math.min(...counts);
  const transitions = Array.from({ length: 10 }, () => new Array<number>(10).fill(0));
  return {
    lookback: total,
    total,
    counts,
    percentages: counts.map((count) => (count / total) * 100),
    transitions,
    hottest,
    hottestCount: counts[hottest],
    runnerUp,
    runnerUpCount: counts[runnerUp],
    coldest: counts.map((count, digit) => (count === min ? digit : -1)).filter((digit) => digit >= 0),
  };
}

describe("digit extraction keeps trailing zeros", () => {
  it("formats with the symbol precision before taking the last character", () => {
    expect(formatQuote(1234.5, 2)).toBe("1234.50");
    expect(lastDigit(1234.5, 2)).toBe(0);
    expect(String(1234.5).slice(-1)).toBe("5");
    expect(lastDigit(1234.55, 2)).toBe(5);
    expect(lastDigit(12.3, 1)).toBe(3);
  });

  it("derives precision from the pip size", () => {
    expect(decimalsFromPip(0.01)).toBe(2);
    expect(decimalsFromPip(0.001)).toBe(3);
    expect(decimalsFromPip(1)).toBe(0);
    expect(decimalsFromPip(0)).toBe(2);
    expect(decimalsFromPip(Number.NaN)).toBe(2);
  });

  it("maps a whole quote list", () => {
    expect(digitsFromQuotes([1.2, 1.25, 1.0, 1.09], 2)).toEqual([0, 5, 0, 9]);
  });
});

describe("buildMesh", () => {
  const digits = [0, 1, 1, 2, 2, 2, 3, 3, 3, 3];

  it("counts appearances and percentage inside the window", () => {
    const mesh = buildMesh(digits, 10);
    expect(mesh.total).toBe(10);
    expect(mesh.counts.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(mesh.percentages[3]).toBe(40);
    expect(mesh.hottest).toBe(3);
    expect(mesh.runnerUp).toBe(2);
    expect(mesh.coldest).toEqual([4, 5, 6, 7, 8, 9]);
    expect(nodeTone(mesh, 3)).toBe("hot");
    expect(nodeTone(mesh, 2)).toBe("runner");
    expect(nodeTone(mesh, 5)).toBe("cold");
    expect(nodeTone(mesh, 1)).toBe("mid");
  });

  it("counts consecutive transitions inside the window only", () => {
    const mesh = buildMesh(digits, 10);
    expect(mesh.transitions[0][1]).toBe(1);
    expect(mesh.transitions[1][1]).toBe(1);
    expect(mesh.transitions[1][2]).toBe(1);
    expect(mesh.transitions[2][2]).toBe(2);
    expect(mesh.transitions[2][3]).toBe(1);
    expect(mesh.transitions[3][3]).toBe(3);
  });

  it("has no ranking colours before any tick arrives", () => {
    const mesh = buildMesh([], 100);
    expect(mesh.total).toBe(0);
    expect(mesh.coldest).toEqual([]);
    expect(nodeTone(mesh, 0)).toBe("mid");
    expect(consensusOf([mesh, mesh, mesh]).kind).toBe("weak");
  });

  it("slices to the requested lookback", () => {
    const mesh = buildMesh([9, 9, 9, 1, 2, 3], 4);
    expect(mesh.total).toBe(4);
    expect(mesh.counts[9]).toBe(1);
    expect(mesh.counts[3]).toBe(1);
    expect(mesh.transitions[9][9]).toBe(0);
  });

  it("normalises transition rows to probabilities", () => {
    const mesh = windowOf([0, 10, 0, 0, 0, 0, 0, 0, 0, 0]);
    mesh.transitions[1][4] = 6;
    mesh.transitions[1][5] = 2;
    expect(transitionProbabilities(mesh, 1)[4]).toBe(0.75);
    expect(transitionProbabilities(mesh, 1)[5]).toBe(0.25);
    expect(transitionProbabilities(mesh, 9)).toEqual(new Array(10).fill(0));
  });
});

describe("cross-window consensus", () => {
  it("detects three matching hottest digits", () => {
    const counts = [1, 1, 1, 1, 1, 1, 1, 20, 1, 1];
    const result = consensusOf([windowOf(counts), windowOf(counts), windowOf(counts)]);
    expect(result.kind).toBe("triple");
    expect(result.digit).toBe(7);
  });

  it("accepts two greens plus a runner-up in the third window", () => {
    const green = [1, 1, 1, 1, 1, 1, 1, 20, 1, 1];
    const second = [1, 1, 1, 20, 1, 1, 1, 19, 1, 1];
    const result = consensusOf([windowOf(green), windowOf(green), windowOf(second)]);
    expect(result.kind).toBe("strong");
    expect(result.digit).toBe(7);
  });

  it("reports divergence when the leaders do not line up", () => {
    const a = [20, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const b = [1, 20, 1, 1, 1, 1, 1, 1, 1, 1];
    const c = [1, 1, 20, 1, 1, 1, 1, 1, 1, 1];
    const result = consensusOf([windowOf(a), windowOf(b), windowOf(c)]);
    expect(result.kind).toBe("weak");
    expect(result.digit).toBeNull();
  });
});

describe("hybrid scoring", () => {
  it("blends window frequency with the transition probability", () => {
    const flatCounts = [1, 1, 1, 1, 10, 1, 1, 1, 1, 1];
    const meshes = [windowOf(flatCounts), windowOf(flatCounts), windowOf(flatCounts)];
    meshes[0].transitions[3][4] = 9;
    meshes[0].transitions[3][6] = 1;
    const ranked = scoreDigits(meshes, 3, false);
    const four = ranked.find((entry) => entry.digit === 4)!;
    expect(four.transition).toBe(0.9);
    expect(four.score).toBeCloseTo(0.6 * four.frequency + 0.4 * 0.9, 10);
    expect(ranked[0].digit).toBe(4);
  });

  it("orders deterministically on ties", () => {
    const counts = new Array<number>(10).fill(1);
    const meshes = [windowOf(counts), windowOf(counts), windowOf(counts)];
    const ranked = scoreDigits(meshes, 0, false);
    expect(ranked.map((entry) => entry.digit)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("zeros unreachable digits on step indices", () => {
    const counts = [1, 1, 1, 1, 1, 1, 1, 10, 1, 1];
    const meshes = [windowOf(counts), windowOf(counts), windowOf(counts)];
    meshes[0].transitions[1][3] = 5;
    meshes[0].transitions[1][4] = 5;
    const filtered = scoreDigits(meshes, 1, true);
    expect(filtered.find((entry) => entry.digit === 7)!.score).toBe(0);
    expect(filtered[0].digit === 3 || filtered[0].digit === 4).toBe(true);
    const unfiltered = scoreDigits(meshes, 1, false);
    expect(unfiltered.find((entry) => entry.digit === 7)!.score).toBeGreaterThan(0);
  });

  it("returns at most three positive-score digits", () => {
    const counts = [1, 1, 1, 1, 1, 1, 1, 10, 1, 1];
    const meshes = [windowOf(counts), windowOf(counts), windowOf(counts)];
    meshes[0].transitions[2][3] = 1;
    const filtered = scoreDigits(meshes, 2, true);
    const top = topDigits(filtered, 3);
    expect(top).toHaveLength(1);
    expect(top[0].digit).toBe(3);
  });

  it("combines the individual probabilities and compares to a uniform pick", () => {
    const a = windowOf([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    a.transitions[0][1] = 0.12 * 100;
    a.transitions[0][2] = 0.1 * 100;
    a.transitions[0][3] = 0.08 * 100;
    a.transitions[0][4] = 0.7 * 100;
    const top = topDigits(scoreDigits([a, a, a], 0, false), 3).slice(0, 3);
    expect(top.map((entry) => entry.digit)).toEqual([4, 1, 2]);
    const combined = combinedProbability(top);
    expect(combined).toBeCloseTo(0.92, 10);
    expect(dominanceShare(combined)).toBeCloseTo(0.92 / 0.3, 10);
  });
});

describe("stake planning", () => {
  it("keeps a flat bundle at the per-digit minimum", () => {
    expect(splitStakes(0.35, false)).toEqual([0.35, 0.35, 0.35]);
    expect(bundleTotal(splitStakes(0.35, false))).toBe(1.05);
  });

  it("scales only leg one in weighted mode", () => {
    const stakes = splitStakes(0.6, true);
    expect(stakes).toEqual([0.6, MIN_STAKE, MIN_STAKE]);
    expect(bundleTotal(stakes)).toBe(1.3);
  });

  it("clamps tiny or invalid stakes up to the minimum", () => {
    expect(splitStakes(0.2, true)).toEqual([0.35, 0.35, 0.35]);
    expect(splitStakes(Number.NaN, false)).toEqual([0.35, 0.35, 0.35]);
    expect(splitStakes(0.444, false)[0]).toBe(0.44);
  });
});

describe("evaluateMesh", () => {
  it("formats quotes, builds the three windows and ranks the live centre", () => {
    const quotes = [1.0, 1.01, 1.02, 1.03, 1.04];
    const evaluation = evaluateMesh(quotes, 2, [3, 4, 5], false);
    expect(evaluation.digits).toEqual([0, 1, 2, 3, 4]);
    expect(evaluation.center).toBe(4);
    expect(evaluation.meshes).toHaveLength(3);
    expect(evaluation.meshes[0].total).toBe(3);
    expect(evaluation.meshes[2].total).toBe(5);
    expect(evaluation.ranked).toHaveLength(10);
  });
});
