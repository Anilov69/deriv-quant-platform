import type { ContractType, MarketFamily } from "@/lib/markets";

export interface EngineSettings {
  /** Rolling window (ticks) used to estimate empirical digit probabilities. */
  digitWindow: number;
  /** Prior strength α (pseudo-trials) for Bayesian shrinkage toward theory. */
  priorStrength: number;
  /** Tick duration for digit contracts. */
  digitDuration: number;
  /** Tick durations evaluated for Rise/Fall. */
  riseFallDurations: number[];
  /** Bollinger look-back N and exhaustion threshold for Module A. */
  bollingerN: number;
  bollingerZ: number;
  /** Minimum streak length k for Module B. */
  minStreak: number;
  /** Jump detector multiple of ATR₂₀ and prior λ (jumps / second) for Module C. */
  jumpAtrMultiple: number;
  jumpLambda: number;
  /** Block Rise/Fall when P(jump during contract) exceeds this. */
  jumpHazardBlock: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  digitWindow: 100,
  priorStrength: 200,
  digitDuration: 1,
  riseFallDurations: [1, 2, 3, 5],
  bollingerN: 20,
  bollingerZ: 2.2,
  minStreak: 6,
  jumpAtrMultiple: 5,
  jumpLambda: 1 / 1200,
  jumpHazardBlock: 0.005,
};

export interface EngineInput {
  prices: number[];
  times: number[];
  decimals: number;
  settings: EngineSettings;
}

/** A contract the engine has an opinion on, before live payout is attached. */
export interface Candidate {
  key: string;
  contractType: ContractType;
  /** Digit prediction / barrier, as sent to Deriv (`barrier`). */
  barrier?: string;
  duration: number;
  /** Model win probability P_model (shrunk empirical estimate). */
  pModel: number;
  /** Theoretical (fair, no-edge) win probability for comparison. */
  pTheory: number;
  /** Raw sample behind P_model: k wins out of n. */
  k: number;
  n: number;
  /** Whether the strategy trigger condition is currently met. */
  active: boolean;
  /** If set, the trade is vetoed by a risk filter (e.g. jump hazard). */
  blocked?: string;
  rationale: string;
}

export interface EngineOutput<I = unknown> {
  family: MarketFamily;
  candidates: Candidate[];
  insights: I;
  /** Sample too small for meaningful output. */
  warmingUp: boolean;
}
