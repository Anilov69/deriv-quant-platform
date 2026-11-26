import { describe, expect, it } from "vitest";
import {
  AutoTrader,
  DEFAULT_AUTO,
  DEFAULT_MARTINGALE,
  EMPTY_BOOK,
  HaltSignal,
  MIN_STAKE,
  planStake,
  previewSteps,
  settleBook,
} from "@/autotrade";
import type { AutoConfig, MartingaleConfig, Ports, Snapshot } from "@/autotrade";

function config(overrides: Partial<AutoConfig> = {}): AutoConfig {
  return { ...DEFAULT_AUTO, filters: { ...DEFAULT_AUTO.filters }, ...overrides };
}

function martingale(overrides: Partial<MartingaleConfig> = {}): MartingaleConfig {
  return { ...DEFAULT_MARTINGALE, ...overrides };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const probabilities = new Array<number>(10).fill(0.05);
  probabilities[3] = 0.55;
  return { symbol: "R_100", family: "continuous", probabilities, currentDigit: 3, momentumZ: 0, ...overrides };
}

function makePorts(ratio = 1.95, snap: Snapshot = snapshot()) {
  const state = {
    quoteCalls: [] as Array<{ contract: string; stake: number }>,
    buyCalls: [] as Array<{ id: string; price: number }>,
    buys: 0,
    ratio,
    snapshot: snap,
  };
  const ports: Ports = {
    snapshot: () => state.snapshot,
    quote: async (input) => {
      state.quoteCalls.push({ contract: input.contract, stake: input.stake });
      return { id: "quote-" + state.quoteCalls.length, ask: input.stake, payout: input.stake * state.ratio };
    },
    buy: async (id, price) => {
      state.buyCalls.push({ id, price });
      state.buys += 1;
      return 100 + state.buys;
    },
    watch: async () => undefined,
    balance: () => 1000,
    currency: () => "USD",
  };
  return { ports, state };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2000) throw new Error("timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function engineFor(ports: Ports) {
  return new AutoTrader(ports, {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
    now: () => Date.now(),
  });
}

describe("stake planning", () => {
  it("uses the flat base stake when martingale is off or at step 0", () => {
    const book = { ...EMPTY_BOOK, step: 1, cumulativeLoss: 5 };
    expect(planStake({ martingale: martingale({ enabled: false }), book, payoutRatio: 1.95 }).stake).toBe(1);
    expect(planStake({ martingale: martingale({ enabled: true }), book: EMPTY_BOOK, payoutRatio: 1.95 }).stake).toBe(1);
  });

  it("recovers the ladder plus one base profit at the live payout ratio", () => {
    // b = 0.95; (1 lost + 1 * 0.95) / 0.95 = 2.05
    const stake = planStake({
      martingale: martingale({ enabled: true, mode: "payout", baseStake: 1 }),
      book: { step: 1, cumulativeLoss: 1, netProfit: -1 },
      payoutRatio: 1.95,
    }).stake;
    expect(stake).toBeCloseTo(2.05, 2);
  });

  it("scales the recovery stake with the contract's own payout", () => {
    // A 40% payout (Over/Under at 1.4x) needs a far bigger step than 1.95x.
    const thin = planStake({
      martingale: martingale({ enabled: true, mode: "payout", baseStake: 1 }),
      book: { step: 1, cumulativeLoss: 1, netProfit: -1 },
      payoutRatio: 1.4,
    }).stake;
    const rich = planStake({
      martingale: martingale({ enabled: true, mode: "payout", baseStake: 1 }),
      book: { step: 1, cumulativeLoss: 1, netProfit: -1 },
      payoutRatio: 8.93,
    }).stake;
    expect(thin).toBeGreaterThan(rich);
  });

  it("applies a fixed multiplier geometrically", () => {
    const stake = planStake({
      martingale: martingale({ enabled: true, mode: "multiplier", baseStake: 1, multiplier: 2.1 }),
      book: { step: 2, cumulativeLoss: 3, netProfit: -3 },
      payoutRatio: 1.95,
    }).stake;
    expect(stake).toBeCloseTo(4.41, 2);
  });

  it("refuses a payout that cannot recover the loss", () => {
    expect(() => planStake({
      martingale: martingale({ enabled: true, mode: "payout" }),
      book: { step: 1, cumulativeLoss: 1, netProfit: -1 },
      payoutRatio: 1.01,
    })).toThrow(HaltSignal);
  });

  it("never returns a stake below the Deriv minimum", () => {
    const stake = planStake({
      martingale: martingale({ enabled: true, baseStake: 0.1 }),
      book: EMPTY_BOOK,
      payoutRatio: 1.95,
    }).stake;
    expect(stake).toBe(MIN_STAKE);
  });
});

describe("ladder settlement", () => {
  it("resets the ladder on a win", () => {
    const result = settleBook(
      { step: 2, cumulativeLoss: 6, netProfit: -6 },
      martingale({ enabled: true }),
      { stake: 4, profit: 3.8 },
    );
    expect(result.note).toBe("win");
    expect(result.book).toEqual({ step: 0, cumulativeLoss: 0, netProfit: -2.2 });
  });

  it("escalates and accumulates the loss", () => {
    const result = settleBook(EMPTY_BOOK, martingale({ enabled: true }), { stake: 1, profit: -1 });
    expect(result.note).toBe("loss");
    expect(result.book).toEqual({ step: 1, cumulativeLoss: 1, netProfit: -1 });
  });

  it("forces the stake back to base when the step cap is hit", () => {
    const result = settleBook(
      { step: 3, cumulativeLoss: 10, netProfit: -10 },
      martingale({ enabled: true, maxSteps: 3 }),
      { stake: 8, profit: -8 },
    );
    expect(result.note).toBe("cap");
    expect(result.book).toEqual({ step: 0, cumulativeLoss: 0, netProfit: -18 });
  });

  it("does not track a ladder when martingale is off", () => {
    const result = settleBook(EMPTY_BOOK, martingale({ enabled: false }), { stake: 1, profit: -1 });
    expect(result.book).toEqual({ step: 0, cumulativeLoss: 0, netProfit: -1 });
  });
});

describe("progression preview", () => {
  it("shows step 0 through the cap with rising risk", () => {
    const rows = previewSteps({ martingale: martingale({ enabled: true, maxSteps: 4, baseStake: 1 }), payoutRatio: 1.95, winProbability: 0.55 });
    expect(rows.map((row) => row.step)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[0].stake).toBe(1);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].stake).toBeGreaterThan(rows[index - 1].stake);
      expect(rows[index].cumulativeRisk).toBeGreaterThan(rows[index - 1].cumulativeRisk);
      expect(rows[index].streakProbability).toBeLessThan(rows[index - 1].streakProbability);
    }
  });

  it("grows faster at a thin payout because recovery costs more", () => {
    const thin = previewSteps({ martingale: martingale({ enabled: true, maxSteps: 2 }), payoutRatio: 1.4, winProbability: 0.5 });
    const rich = previewSteps({ martingale: martingale({ enabled: true, maxSteps: 2 }), payoutRatio: 8.93, winProbability: 0.5 });
    expect(thin[2].cumulativeRisk).toBeGreaterThan(rich[2].cumulativeRisk);
  });

  it("prices a streak at the assumed win rate", () => {
    const rows = previewSteps({ martingale: martingale({ enabled: true, maxSteps: 2 }), payoutRatio: 1.95, winProbability: 0.5 });
    expect(rows[0].streakProbability).toBeCloseTo(0.5, 10);
    expect(rows[1].streakProbability).toBeCloseTo(0.25, 10);
    expect(rows[2].streakProbability).toBeCloseTo(0.125, 10);
  });
});

describe("auto-trade engine", () => {
  it("never buys a second contract before the first settles", async () => {
    const { ports, state } = makePorts();
    const engine = engineFor(ports);
    engine.configure(config({ minEvPct: 2, cooldownSeconds: 0 }), martingale({ enabled: false }));
    engine.start();
    await waitFor(() => state.buys >= 1, "first buy");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(state.buys).toBe(1);
    expect(engine.state).toBe("OPEN");
    expect(engine.locked).toBe(true);

    engine.onContractUpdate({ contract_id: 101, is_sold: 1, profit: 0.95, status: "won" });
    await waitFor(() => state.buys >= 2, "second buy after settlement");
    expect(state.buys).toBe(2);
    engine.onContractUpdate({ contract_id: 102, is_sold: 1, profit: -1, status: "lost" });
    engine.stop("test done");
    expect(engine.state).toBe("OFF");
  });

  it("only quotes the trade types the user enabled", async () => {
    const { ports, state } = makePorts();
    const engine = engineFor(ports);
    engine.configure(
      config({ minEvPct: 0, filters: { riseFall: false, evenOdd: true, overUnder: false, matchDiff: false } }),
      martingale({ enabled: false }),
    );
    engine.start();
    await waitFor(() => state.buys >= 1, "an even/odd buy");
    const contract = state.quoteCalls[0].contract;
    expect(["DIGITODD", "DIGITEVEN"]).toContain(contract);
    engine.onContractUpdate({ contract_id: 101, is_sold: 1, profit: 0.9, status: "won" });
    engine.stop("test done");
  });

  it("halts and reports when the daily loss limit is hit", async () => {
    const { ports, state } = makePorts();
    const engine = engineFor(ports);
    const halts: string[] = [];
    engine.onHalt = (reason) => halts.push(reason);
    engine.configure(config({ minEvPct: 0, dailyLossLimit: 1, dailyProfitTarget: 0 }), martingale({ enabled: false }));
    engine.start();
    await waitFor(() => state.buys >= 1, "first buy");
    engine.onContractUpdate({ contract_id: 101, is_sold: 1, profit: -1, status: "lost" });
    await waitFor(() => halts.length >= 1, "halt");
    expect(halts[0]).toMatch(/loss limit/i);
    expect(engine.state).toBe("HALTED");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.buys).toBe(1);
  });

  it("raises the next stake with the payout-adjusted recovery after a loss", async () => {
    const { ports, state } = makePorts();
    const engine = engineFor(ports);
    engine.configure(
      config({ minEvPct: 0, cooldownSeconds: 0 }),
      martingale({ enabled: true, mode: "payout", baseStake: 1, maxSteps: 3 }),
    );
    engine.start();
    await waitFor(() => state.buys >= 1, "first buy");
    expect(state.buyCalls[0].price).toBeCloseTo(1, 2);
    engine.onContractUpdate({ contract_id: 101, is_sold: 1, profit: -1, status: "lost" });
    await waitFor(() => state.buys >= 2, "second buy");
    expect(state.buyCalls[1].price).toBeCloseTo(2.05, 2);
    engine.onContractUpdate({ contract_id: 102, is_sold: 1, profit: 1.95, status: "won" });
    await waitFor(() => engine.book.step === 0, "ladder reset");
    engine.stop("test done");
  });

  it("backs off instead of hammering when Deriv rate-limits proposals", async () => {
    const sleeps: number[] = [];
    const { ports } = makePorts();
    const limited: Ports = {
      ...ports,
      quote: async () => {
        throw new Error("You have reached the rate limit for proposal.");
      },
    };
    const engine = new AutoTrader(limited, {
      sleep: (ms) => {
        sleeps.push(ms);
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
      now: () => Date.now(),
    });
    const halts: string[] = [];
    engine.onHalt = (reason) => halts.push(reason);
    engine.configure(config({ minEvPct: 0 }), martingale({ enabled: false }));
    engine.start();
    await waitFor(() => sleeps.some((ms) => ms >= 4000), "rate-limit backoff");
    expect(sleeps).toContain(4000);
    expect(halts).toHaveLength(0);
    expect(engine.state).not.toBe("HALTED");
    engine.stop("test done");
  });

  it("does not trade a step index when only digit contracts are enabled", async () => {
    const step = snapshot({ symbol: "stpRNG2", family: "step", currentDigit: 0, momentumZ: 0 });
    const { ports, state } = makePorts(1.95, step);
    const engine = engineFor(ports);
    engine.configure(config({ minEvPct: 0, filters: { riseFall: false, evenOdd: true, overUnder: true, matchDiff: true } }), martingale({ enabled: false }));
    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(state.buys).toBe(0);
    engine.stop("no eligible contracts");
  });
});
