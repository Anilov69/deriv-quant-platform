import { describe, expect, it } from "vitest";
import { buildSignals, recommended } from "@/lib/signals";
import type { Candidate } from "@/engines/types";
import { useStore } from "@/store/useStore";

const g = useStore.getState().guardrails;
const cand = (p: Partial<Candidate>): Candidate => ({
  key: "DIGITEVEN||1", contractType: "DIGITEVEN", duration: 1, pModel: 0.5, pTheory: 0.5, k: 50, n: 100, active: true, rationale: "", ...p,
});
const quotes = { "DIGITEVEN||1": { stake: 10, payout: 19.53, at: 0 } };

describe("signal filter", () => {
  it("fair-odds model is never actionable", () => {
    const [r] = buildSignals([cand({})], quotes, undefined, g, 1000);
    expect(r.status).toBe("no-edge");
    expect(r.evPerStake).toBeLessThan(0);
  });
  it("+EV but statistically weak is not actionable", () => {
    const [r] = buildSignals([cand({ pModel: 0.53, k: 56, n: 100 })], quotes, undefined, g, 1000);
    expect(r.status).toBe("weak");
    expect(recommended([r])).toBeNull();
  });
  it("+EV, significant and triggered is actionable with a Kelly stake", () => {
    const [r] = buildSignals([cand({ pModel: 0.6, k: 650, n: 1000 })], quotes, undefined, g, 1000);
    expect(r.status).toBe("actionable");
    expect(r.kellyStake).toBeGreaterThan(0);
    expect(recommended([r])?.key).toBe(r.key);
  });
  it("respects contract availability and blocks", () => {
    expect(buildSignals([cand({})], quotes, { CALL: [1, 10] }, g, 1000)[0].status).toBe("not-offered");
    expect(buildSignals([cand({ pModel: 0.6, k: 650, n: 1000, blocked: "jump" })], quotes, undefined, g, 1000)[0].status).toBe("blocked");
  });
});
