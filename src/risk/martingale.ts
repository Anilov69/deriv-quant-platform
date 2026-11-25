import type { EvEstimate, RiskSettings } from "../types";

const MAX_PROGRESSION_STEPS = 1000;
const DEFAULT_MAX_KELLY_FRACTION = 0.25;

export interface ProgressionRow {
  step: number;
  stake: number;
  payout: number;
  cumulativeCapital: number;
  cumulativeLoss: number;
  probabilityOfLoss: number;
}

export interface KillSwitchResult {
  stopped: boolean;
  reason?: string;
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function requireNonnegative(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) throw new Error(`${name} must be nonnegative`);
}

function requireProbability(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0 || value > 1) throw new Error(`${name} must be in [0, 1]`);
}

function requireFraction(name: string, value: number): void {
  requireProbability(name, value);
}

function requirePositivePayout(payout: number, stake: number): void {
  requireFinite("payout", payout);
  requireNonnegative("stake", stake);
  if (payout <= stake) throw new Error("payout must be greater than stake");
}

function requireSettings(settings: RiskSettings): void {
  requireNonnegative("baseStake", settings.baseStake);
  if (typeof settings.martingale !== "boolean") throw new Error("martingale must be a boolean");
  requireFinite("multiplier", settings.multiplier);
  if (settings.multiplier <= 0) throw new Error("multiplier must be greater than zero");
  requireNonnegative("maxStep", settings.maxStep);
  if (!Number.isSafeInteger(settings.maxStep)) throw new Error("maxStep must be a nonnegative safe integer");
  if (settings.mode !== "next-signal" && settings.mode !== "classic-immediate") {
    throw new Error("mode must be next-signal or classic-immediate");
  }
  requireFraction("kellyFraction", settings.kellyFraction);
  requireNonnegative("dailyStopLoss", settings.dailyStopLoss);
  requireNonnegative("dailyTakeProfit", settings.dailyTakeProfit);
  requireNonnegative("maxConsecutiveLosses", settings.maxConsecutiveLosses);
  if (!Number.isSafeInteger(settings.maxConsecutiveLosses)) {
    throw new Error("maxConsecutiveLosses must be a nonnegative safe integer");
  }
}

export function calculateEv(probability: number, payout: number, stake: number): EvEstimate {
  requireProbability("probability", probability);
  requirePositivePayout(payout, stake);
  if (stake === 0) throw new Error("stake must be greater than zero to calculate payout percentage");

  const netPayout = payout - stake;
  const payoutPercentage = netPayout / stake;
  const breakEvenProbability = stake / payout;
  const expectedValue = probability * netPayout - (1 - probability) * stake;
  const edge = probability - breakEvenProbability;
  if (!Number.isFinite(payoutPercentage) || !Number.isFinite(expectedValue)) {
    throw new Error("payout and stake produce values outside the supported numeric range");
  }

  return {
    stake,
    payout,
    breakEvenProbability,
    modelProbability: probability,
    payoutPercentage,
    expectedValue,
    edge,
    actionable: expectedValue > 0 && edge > 0,
  };
}

export function kellyStake(
  bankroll: number,
  probability: number,
  payout: number,
  fraction: number,
  maxFraction: number = DEFAULT_MAX_KELLY_FRACTION,
): number {
  requireNonnegative("bankroll", bankroll);
  requireProbability("probability", probability);
  requireFinite("payout", payout);
  requireFraction("fraction", fraction);
  requireFraction("maxFraction", maxFraction);
  if (payout <= 1) throw new Error("payout must be a total-return multiple greater than one");
  if (bankroll === 0 || fraction === 0 || maxFraction === 0) return 0;
  if (probability <= 1 / payout) return 0;

  const fullKellyFraction = (probability * payout - 1) / (payout - 1);
  const fractionalKelly = Math.min(maxFraction, Math.max(0, fullKellyFraction * fraction));
  const stake = bankroll * fractionalKelly;
  if (!Number.isFinite(stake)) throw new Error("Kelly inputs produce a stake outside the supported numeric range");
  return Math.min(bankroll, stake);
}

export function payoutAwareMultiplier(payoutPercentage: number): number {
  requireFinite("payoutPercentage", payoutPercentage);
  if (payoutPercentage <= 0) throw new Error("payoutPercentage must be greater than zero");
  const multiplier = 1 + 1 / payoutPercentage;
  if (!Number.isFinite(multiplier)) {
    throw new Error("payoutPercentage produces a multiplier outside the supported numeric range");
  }
  return multiplier;
}

function cappedProgressionStake(
  baseStake: number,
  multiplier: number,
  consecutiveLosses: number,
  capitalLimit: number,
): number {
  if (baseStake === 0 || capitalLimit === 0) return 0;
  const cap = capitalLimit;
  if (baseStake >= cap) return cap;

  const stake = baseStake * multiplier ** consecutiveLosses;
  return Number.isFinite(stake) ? Math.min(cap, stake) : cap;
}

export function nextStake(
  settings: RiskSettings,
  bankroll: number,
  consecutiveLosses: number,
  probability: number,
  payout: number,
): number {
  requireSettings(settings);
  requireNonnegative("bankroll", bankroll);
  requireFinite("consecutiveLosses", consecutiveLosses);
  if (!Number.isSafeInteger(consecutiveLosses) || consecutiveLosses < 0) {
    throw new Error("consecutiveLosses must be a nonnegative safe integer");
  }
  requireProbability("probability", probability);
  requirePositivePayout(payout, settings.baseStake);
  if (bankroll === 0 || settings.baseStake === 0) return 0;

  if (!settings.martingale) {
    const breakEvenProbability = settings.baseStake / payout;
    if (probability <= breakEvenProbability) return Math.min(settings.baseStake, bankroll);
    const totalReturnMultiple = payout / settings.baseStake;
    return kellyStake(bankroll, probability, totalReturnMultiple, settings.kellyFraction);
  }

  const payoutPercentage = (payout - settings.baseStake) / settings.baseStake;
  const multiplier = payoutAwareMultiplier(payoutPercentage);
  const progressionStep = Math.min(consecutiveLosses, settings.maxStep);
  return cappedProgressionStake(settings.baseStake, multiplier, progressionStep, bankroll);
}

export function progressionPreview(
  settings: RiskSettings,
  bankroll: number,
  probability: number,
  payout: number,
  steps: number = 8,
): ProgressionRow[] {
  requireSettings(settings);
  requireNonnegative("bankroll", bankroll);
  requireProbability("probability", probability);
  requirePositivePayout(payout, settings.baseStake);
  requireFinite("steps", steps);
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_PROGRESSION_STEPS) {
    throw new Error(`steps must be an integer from 1 through ${MAX_PROGRESSION_STEPS}`);
  }

  const rows: ProgressionRow[] = [];
  const totalReturnMultiple = settings.baseStake > 0 ? payout / settings.baseStake : 0;
  const probabilityOfLoss = 1 - probability;
  let cumulativeCapital = 0;

  for (let step = 1; step <= steps; step += 1) {
    const remainingBankroll = Math.max(0, bankroll - cumulativeCapital);
    const stake = nextStake(settings, remainingBankroll, step - 1, probability, payout);
    const rowPayout = settings.baseStake > 0 ? stake * totalReturnMultiple : 0;
    if (!Number.isFinite(rowPayout)) throw new Error("progression payout is outside the supported numeric range");
    cumulativeCapital += stake;
    rows.push({
      step,
      stake,
      payout: rowPayout,
      cumulativeCapital,
      cumulativeLoss: cumulativeCapital,
      probabilityOfLoss: probabilityOfLoss ** step,
    });
  }

  return rows;
}

export function evaluateKillSwitches(
  startBalance: number,
  currentBalance: number,
  settings: RiskSettings,
): KillSwitchResult {
  requireNonnegative("startBalance", startBalance);
  requireFinite("currentBalance", currentBalance);
  requireSettings(settings);
  const netChange = currentBalance - startBalance;

  if (settings.dailyStopLoss > 0 && netChange <= -settings.dailyStopLoss) {
    return { stopped: true, reason: "daily-stop-loss" };
  }
  if (settings.dailyTakeProfit > 0 && netChange >= settings.dailyTakeProfit) {
    return { stopped: true, reason: "daily-take-profit" };
  }
  return { stopped: false };
}

export function probabilityOfRuinForProgression(winProbability: number, rows: ProgressionRow[]): number {
  requireProbability("winProbability", winProbability);
  if (!Array.isArray(rows)) throw new Error("rows must be an array");
  if (rows.length > MAX_PROGRESSION_STEPS) {
    throw new Error(`rows cannot contain more than ${MAX_PROGRESSION_STEPS} steps`);
  }
  if (rows.length === 0) return 0;

  let expectedStep = 1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    requireFinite(`rows[${index}].step`, row.step);
    if (!Number.isSafeInteger(row.step) || row.step !== index + 1) {
      throw new Error("rows must have sequential positive integer steps starting at one");
    }
    requireNonnegative(`rows[${index}].stake`, row.stake);
    requireNonnegative(`rows[${index}].payout`, row.payout);
    requireNonnegative(`rows[${index}].cumulativeCapital`, row.cumulativeCapital);
    requireNonnegative(`rows[${index}].cumulativeLoss`, row.cumulativeLoss);
    requireProbability(`rows[${index}].probabilityOfLoss`, row.probabilityOfLoss);
    expectedStep = row.step;
  }

  return (1 - winProbability) ** expectedStep;
}
