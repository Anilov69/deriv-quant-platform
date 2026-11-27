import { describe, expect, it } from "vitest";
import type { ContractOffer, Tick } from "@/deriv";
import {
  QUANT_AUTO_STOP_LOSS,
  QUANT_AUTO_TAKE_PROFIT,
  buildQuantTradePlan,
  classifyQuantRegime,
  computeQuantFeatures,
  edgeDriftBreaker,
  estimateQuantRealizedProbability,
  extractQuantCapabilities,
  formatQuantDuration,
  quantKellyFraction,
  quantQuoteMetrics,
  quantStakeCap,
  quantAutoStopLoss,
  quantAutoTakeProfit,
  shouldHarvest,
  sizeQuantStake,
  type QuantCapabilities,
  type QuantFeatures,
  type QuantRegimeSignal,
} from "@/utils/quantEngineMath";

function makeTicks(prices: readonly number[]): Tick[] {
  return prices.map((quote, index) => ({ epoch: 1_700_000_000 + index, quote }));
}

function offer(
  contractType: string,
  min: string,
  max: string,
  barrier: string | null = null,
  pip = 0.01,
): ContractOffer {
  return {
    contractType,
    contractCategory: contractType === "CALL" || contractType === "PUT" ? "callput" : "touch",
    minContractDuration: min,
    maxContractDuration: max,
    expiryType: "intraday",
    barrier,
    defaultStake: 0.35,
    pipSize: pip,
    underlyingSymbol: "1HZ100V",
  };
}

function features(overrides: Partial<QuantFeatures> = {}): QuantFeatures {
  return {
    samples: 150,
    ready: true,
    spot: 1000,
    atr15: 0.2,
    atr100: 0.25,
    atrRatio: 0.8,
    efficiency30: 0.4,
    hurst: 0.5,
    medianTickRange: 0.2,
    ticksSinceJump: null,
    jumpDirection: 0,
    price30Ago: 995,
    change30: 5,
    impulse: 0.1,
    atr15Prior: 0.2,
    impulseVsAtr: 0.5,
    priorAtrRatio: 0.9,
    ...overrides,
  };
}

function capabilities(): QuantCapabilities {
  return extractQuantCapabilities([
    offer("NOTOUCH", "1t", "10t", "+0.50"),
    offer("ONETOUCH", "1t", "5t", "+0.30"),
    offer("CALL", "1t", "10t"),
    offer("PUT", "1t", "10t"),
  ]);
}

describe("quant feature extractor", () => {
  it("computes all four features over a rolling 150-tick window", () => {
    const prices = Array.from({ length: 160 }, (_, index) => 1000 + (index % 2 === 0 ? 0.1 : -0.1));
    const value = computeQuantFeatures(makeTicks(prices));
    expect(value.samples).toBe(150);
    expect(value.ready).toBe(true);
    expect(value.atr15).toBeCloseTo(0.2, 6);
    expect(value.atr100).toBeCloseTo(0.2, 6);
    expect(value.atrRatio).toBeCloseTo(1, 6);
    expect(value.efficiency30).toBe(0);
    expect(value.hurst).not.toBeNull();
    expect(value.spot).toBeCloseTo(prices[prices.length - 1], 6);
  });

  it("scores a clean directional path with ER30 = 1", () => {
    const prices = Array.from({ length: 150 }, (_, index) => 1000 + index);
    const value = computeQuantFeatures(makeTicks(prices));
    expect(value.efficiency30).toBeCloseTo(1, 6);
    expect(value.atr15).toBeCloseTo(1, 6);
    expect(value.impulse).toBeCloseTo(1, 6);
    expect(value.impulseVsAtr).toBeCloseTo(1, 6);
  });

  it("counts ticks since an 18x median jump and records its direction", () => {
    const prices = Array.from({ length: 150 }, (_, index) => 1000 + (index % 2 === 0 ? 0.01 : -0.01));
    for (let index = 120; index < prices.length; index += 1) prices[index] += 5;
    const value = computeQuantFeatures(makeTicks(prices));
    expect(value.medianTickRange).toBeCloseTo(0.02, 6);
    expect(value.jumpDirection).toBe(1);
    expect(value.ticksSinceJump).not.toBeNull();
    expect(value.ticksSinceJump).toBeGreaterThan(20);
  });

  it("does not claim a jump on a flat series", () => {
    const value = computeQuantFeatures(makeTicks(Array.from({ length: 150 }, () => 1000)));
    expect(value.medianTickRange).toBe(0);
    expect(value.ticksSinceJump).toBeNull();
    expect(value.ready).toBe(true);
  });
});

describe("Bayesian regime router", () => {
  it("classifies a low-ATR mean-reverting 1HZ symbol as volatility vacuum / NOTOUCH", () => {
    const signal = classifyQuantRegime(features({ atrRatio: 0.5, hurst: 0.3, efficiency30: 0.2 }), "1HZ100V");
    expect(signal?.regime).toBe(1);
    expect(signal?.contract).toBe("NOTOUCH");
    expect(signal?.posterior).toBeGreaterThan(0.99);
  });

  it("routes persistent positive drift to CALL and negative drift to PUT", () => {
    const up = classifyQuantRegime(features({ efficiency30: 0.8, hurst: 0.7, change30: 4 }), "DSI20");
    const down = classifyQuantRegime(features({ efficiency30: 0.8, hurst: 0.7, change30: -4 }), "DSI30");
    expect(up?.regime).toBe(2);
    expect(up?.contract).toBe("CALL");
    expect(down?.contract).toBe("PUT");
  });

  it("fades a fresh jump in the opposite direction on JD symbols", () => {
    const signal = classifyQuantRegime(features({ ticksSinceJump: 1, jumpDirection: 1, atrRatio: 1, hurst: 0.5 }), "JD75");
    expect(signal?.regime).toBe(3);
    expect(signal?.contract).toBe("PUT");
    expect(signal?.preferredContracts).toEqual(["PUT", "NOTOUCH"]);
  });

  it("routes expansion after compression to ONETOUCH in the impulse direction", () => {
    const signal = classifyQuantRegime(features({ priorAtrRatio: 0.6, impulseVsAtr: 3.2, impulse: 0.8, atrRatio: 1, hurst: 0.5 }), "1HZ50V");
    expect(signal?.regime).toBe(4);
    expect(signal?.contract).toBe("ONETOUCH");
    expect(signal?.direction).toBe(1);
  });

  it("does not classify before a full 100-tick Hurst window", () => {
    expect(classifyQuantRegime(features({ ready: false }), "1HZ100V")).toBeNull();
  });
});

describe("contract capability router", () => {
  it("extracts the fastest valid duration and default barrier for each weapon", () => {
    const caps = extractQuantCapabilities([
      offer("CALL", "5t", "10t"),
      offer("CALL", "1t", "3t"),
      offer("NOTOUCH", "1m", "3m", "-0.40"),
      offer("NOTOUCH", "5s", "30s", "+0.20"),
    ]);
    expect(caps.CALL?.duration).toEqual({ value: 1, unit: "t" });
    expect(caps.CALL?.maxDuration.value).toBe(10);
    expect(caps.NOTOUCH?.duration).toEqual({ value: 5, unit: "s" });
    expect(caps.NOTOUCH?.barrierOffset).toBeCloseTo(0.2, 6);
    expect(caps.PUT).toBeUndefined();
  });

  it("ignores an absolute contracts_for barrier instead of asking for a huge move", () => {
    const absolute = extractQuantCapabilities([offer("NOTOUCH", "1t", "10t", "+1234.50")]);
    const signal = classifyQuantRegime(features({ atrRatio: 0.5, hurst: 0.3, atr15: 0.1 }), "1HZ100V");
    const plan = buildQuantTradePlan({ symbol: "1HZ100V", features: features({ atrRatio: 0.5, hurst: 0.3, atr15: 0.1 }), signal: signal!, capabilities: absolute, history: makeTicks([1000, 1000]) });
    expect(plan?.barrier).toBe("+0.10");
  });

  it("builds a tick-aligned vacuum plan with a signed no-touch barrier", () => {
    const sparks = Array.from({ length: 150 }, (_, index) => 1000 + (index % 2 === 0 ? 0.1 : -0.1));
    const history = makeTicks(sparks);
    const signal = classifyQuantRegime(features({ atrRatio: 0.5, hurst: 0.3, atr15: 0.1 }), "1HZ100V");
    expect(signal).not.toBeNull();
    const plan = buildQuantTradePlan({ symbol: "1HZ100V", features: features({ atrRatio: 0.5, hurst: 0.3, atr15: 0.1 }), signal: signal!, capabilities: capabilities(), history });
    expect(plan?.contract).toBe("NOTOUCH");
    expect(plan?.duration).toBe(1);
    expect(plan?.unit).toBe("t");
    expect(plan?.barrier).toBe("+0.50");
    expect(plan?.pRealized).toBeGreaterThanOrEqual(0.5);
    expect(plan?.pRealized).toBeLessThanOrEqual(0.92);
  });

  it("forces the locked-drift weapon onto the 5-tick horizon", () => {
    const history = makeTicks(Array.from({ length: 150 }, (_, index) => 1000 + index * 0.1));
    const signal = classifyQuantRegime(features({ efficiency30: 0.8, hurst: 0.7, change30: 4 }), "DSI20");
    const plan = buildQuantTradePlan({ symbol: "DSI20", features: features({ efficiency30: 0.8, hurst: 0.7, change30: 4 }), signal: signal!, capabilities: capabilities(), history });
    expect(plan?.duration).toBe(5);
    expect(plan?.unit).toBe("t");
    expect(plan?.barrier).toBeNull();
  });

  it("returns null when the routed weapon is not in contracts_for", () => {
    const noTouch = extractQuantCapabilities([offer("CALL", "1t", "5t")]);
    const signal: QuantRegimeSignal = {
      regime: 1, key: "vacuum", label: "VOLATILITY VACUUM", contract: "NOTOUCH",
      preferredContracts: ["NOTOUCH"], direction: 0, posterior: 0.9, condition: "test",
    };
    const plan = buildQuantTradePlan({ symbol: "1HZ100V", features: features(), signal, capabilities: noTouch, history: makeTicks([1000, 1001]) });
    expect(plan).toBeNull();
  });
});

describe("implied vs realized edge", () => {
  it("uses ask / payout for implied probability and the exact positive-EV formula", () => {
    const metrics = quantQuoteMetrics({ ask: 0.35, payout: 0.7 }, 0.6);
    expect(metrics.pImplied).toBeCloseTo(0.5, 8);
    expect(metrics.evPct).toBeCloseTo(20, 8);
  });

  it("reports a negative edge when realized probability is below implied", () => {
    const metrics = quantQuoteMetrics({ ask: 0.35, payout: 0.7 }, 0.4);
    expect(metrics.evPct).toBeCloseTo(-20, 8);
  });
});

describe("fractional Kelly sizing", () => {
  it("computes the full Kelly fraction and applies one quarter", () => {
    expect(quantKellyFraction(0.6, 0.7, 0.35)).toBeCloseTo(0.2, 8);
    expect(sizeQuantStake({ mode: "kelly", balance: 100, quote: { ask: 0.35, payout: 0.7 }, pRealized: 0.6, fixedStake: 0.35 })).toBe(1.5);
  });

  it("clamps a negative Kelly edge to the minimum stake", () => {
    expect(sizeQuantStake({ mode: "kelly", balance: 100, quote: { ask: 0.35, payout: 0.7 }, pRealized: 0.4, fixedStake: 0.35 })).toBe(0.35);
  });

  it("caps quarter-Kelly at 2.5% of balance or $1.50", () => {
    expect(quantStakeCap(20)).toBeCloseTo(0.5, 8);
    expect(quantStakeCap(0)).toBe(0.35);
    expect(quantStakeCap(1000)).toBe(1.5);
    expect(sizeQuantStake({ mode: "fixed", balance: 15, quote: { ask: 0.35, payout: 0.7 }, pRealized: 0.6, fixedStake: 1 })).toBeLessThanOrEqual(quantStakeCap(15));
    expect(sizeQuantStake({ mode: "kelly", balance: 20, quote: { ask: 0.35, payout: 0.7 }, pRealized: 0.6, fixedStake: 0.35 })).toBe(0.5);
    expect(sizeQuantStake({ mode: "fixed", balance: 1000, quote: { ask: 0.35, payout: 0.7 }, pRealized: 0.6, fixedStake: 1 })).toBe(1);
  });
});

describe("early-exit and session guards", () => {
  it("harvests only after the capture target and four-cent floor", () => {
    const base = { enabled: true, targetCapturePct: 65, buyPrice: 0.35, payout: 1, isValidToSell: true, isSold: false };
    expect(shouldHarvest({ ...base, bidPrice: 0.8 })).toBe(true);
    expect(shouldHarvest({ ...base, bidPrice: 0.7 })).toBe(false);
    expect(shouldHarvest({ ...base, enabled: false, bidPrice: 0.9 })).toBe(false);
    expect(shouldHarvest({ ...base, isValidToSell: false, bidPrice: 0.9 })).toBe(false);
    expect(shouldHarvest({ ...base, buyPrice: 0.35, payout: 0.39, bidPrice: 0.38, targetCapturePct: 10 })).toBe(false);
  });

  it("keeps the spec's $2.10 auto stop and $3.00 auto target", () => {
    expect(QUANT_AUTO_STOP_LOSS).toBe(2.1);
    expect(QUANT_AUTO_TAKE_PROFIT).toBe(3);
    expect(quantAutoStopLoss()).toBe(2.1);
    expect(quantAutoTakeProfit()).toBe(3);
  });

  it("trips the edge breaker only after 15 settled trades and a 15-point shortfall", () => {
    const losing = Array.from({ length: 15 }, () => ({ won: false, pImplied: 0.6 }));
    expect(edgeDriftBreaker(losing).triggered).toBe(true);
    expect(edgeDriftBreaker(losing.slice(0, 14)).triggered).toBe(false);
    expect(edgeDriftBreaker(Array.from({ length: 15 }, () => ({ won: true, pImplied: 0.6 }))).triggered).toBe(false);
  });

  it("formats the routed duration and clamps realized probabilities", () => {
    expect(formatQuantDuration(5, "t")).toBe("5t");
    const value = estimateQuantRealizedProbability({
      kind: "NOTOUCH", regime: 1, direction: 0, history: makeTicks([1000]), duration: 1, unit: "t", barrierOffset: 0.5,
      features: features(),
    });
    expect(value).toBe(0.6);
  });
});
