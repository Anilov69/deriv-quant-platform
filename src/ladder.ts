/**
 * The ladder.
 *
 * A prediction is only worth something relative to its price. Rather than
 * choosing one contract and hoping, this builds every plausible contract on the
 * selected symbol, prices each one against the model, and keeps the ones whose
 * payout beats the model's break-even probability.
 *
 * Deriv's payout already contains a house margin (~8.9x on a 1-tick digit), so
 * the break-even for DIGITMATCH is about 11.2%. The ladder therefore only lists
 * a contract as positive when the model clears that bar, which for a fair random
 * digit almost never happens. That is the point: it refuses to fabricate edges.
 */

import type { Family } from "@/deriv";

export interface Candidate {
  key: string;
  contract: string;
  barrier?: string;
  duration: number;
  probability: number;
  label: string;
  note: string;
}

export interface LadderInput {
  family: Family;
  probabilities: number[];
  currentDigit: number;
  momentumZ: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sumRange(probabilities: number[], from: number, to: number): number {
  let total = 0;
  for (let digit = from; digit <= to; digit += 1) total += probabilities[digit] ?? 0;
  return total;
}

export function buildCandidates(input: LadderInput): Candidate[] {
  const probabilities = input.probabilities.length === 10
    ? input.probabilities
    : new Array<number>(10).fill(0.1);

  // Step indices quote no digit contracts at all, so only CALL/PUT is offered.
  const upward = clamp(0.5 - 0.04 * Math.tanh(input.momentumZ), 0.35, 0.65);
  const riseFall: Candidate[] = [
    {
      key: "CALL:5",
      contract: "CALL",
      duration: 5,
      probability: upward,
      label: "Rise",
      note: "EWMA pullback model, 5 ticks",
    },
    {
      key: "PUT:5",
      contract: "PUT",
      duration: 5,
      probability: 1 - upward,
      label: "Fall",
      note: "EWMA pullback model, 5 ticks",
    },
  ];

  if (input.family === "step") return riseFall;

  const ranked = probabilities
    .map((probability, digit) => ({ digit, probability }))
    .sort((a, b) => b.probability - a.probability);

  const candidates: Candidate[] = [];

  for (const entry of ranked.slice(0, 2)) {
    candidates.push({
      key: "DIGITMATCH:" + entry.digit,
      contract: "DIGITMATCH",
      barrier: String(entry.digit),
      duration: 1,
      probability: entry.probability,
      label: "Digit is " + entry.digit,
      note: "recency-weighted posterior",
    });
  }

  for (const entry of ranked.slice(-2)) {
    candidates.push({
      key: "DIGITDIFF:" + entry.digit,
      contract: "DIGITDIFF",
      barrier: String(entry.digit),
      duration: 1,
      probability: 1 - entry.probability,
      label: "Digit is not " + entry.digit,
      note: "recency-weighted posterior",
    });
  }

  const oddProbability = probabilities[1] + probabilities[3] + probabilities[5] + probabilities[7] + probabilities[9];
  if (Math.abs(oddProbability - 0.5) >= 0.015) {
    candidates.push({
      key: "DIGITODD",
      contract: "DIGITODD",
      duration: 1,
      probability: oddProbability,
      label: "Digit is odd",
      note: "posterior parity",
    });
    candidates.push({
      key: "DIGITEVEN",
      contract: "DIGITEVEN",
      duration: 1,
      probability: 1 - oddProbability,
      label: "Digit is even",
      note: "posterior parity",
    });
  }

  for (const barrier of [2, 7]) {
    const over = sumRange(probabilities, barrier + 1, 9);
    const under = sumRange(probabilities, 0, barrier - 1);
    candidates.push({
      key: "DIGITOVER:" + barrier,
      contract: "DIGITOVER",
      barrier: String(barrier),
      duration: 1,
      probability: over,
      label: "Digit over " + barrier,
      note: "tail mass",
    });
    candidates.push({
      key: "DIGITUNDER:" + barrier,
      contract: "DIGITUNDER",
      barrier: String(barrier),
      duration: 1,
      probability: under,
      label: "Digit under " + barrier,
      note: "tail mass",
    });
  }

  return candidates.concat(riseFall);
}

export interface RankedQuote {
  key: string;
  contract: string;
  barrier?: string;
  duration: number;
  label: string;
  note: string;
  probability: number;
  ask: number;
  payout: number;
  breakEven: number;
  edge: number;
  value: boolean;
}

export function rank(candidates: Candidate[], quotes: Map<string, { ask: number; payout: number }>): RankedQuote[] {
  const rows: RankedQuote[] = [];
  for (const candidate of candidates) {
    const quote = quotes.get(candidate.key);
    if (!quote) continue;
    const breakEven = quote.ask / quote.payout;
    const edge = candidate.probability * quote.payout - quote.ask;
    rows.push({
      ...candidate,
      ask: quote.ask,
      payout: quote.payout,
      breakEven,
      edge,
      value: edge > 0,
    });
  }
  rows.sort((a, b) => b.edge - a.edge);
  return rows;
}