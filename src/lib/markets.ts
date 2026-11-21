/**
 * Strict market scope: only the three Deriv Synthetic Index families below are
 * supported. Anything else returned by `active_symbols` (Crash/Boom, Range
 * Break, baskets, forex…) is ignored by design.
 */
export type MarketFamily = "continuous" | "step" | "jump";

export interface MarketDef {
  symbol: string;
  name: string;
  family: MarketFamily;
  /** Annualised volatility (Volatility / Jump indices) or step size (Step indices). */
  param: number;
}

export const FAMILY_LABEL: Record<MarketFamily, string> = {
  continuous: "Continuous Indices",
  step: "Step Indices",
  jump: "Jump Indices",
};

export const FAMILY_ENGINE: Record<MarketFamily, string> = {
  continuous: "GBM & Digit Entropy Engine",
  step: "Discrete Random Walk & Run-Length Engine",
  jump: "Poisson Jump-Diffusion & Regime Engine",
};

/** Static fallback list; the live `active_symbols` response filters/extends it. */
export const MARKETS: MarketDef[] = [
  { symbol: "R_10", name: "Volatility 10 Index", family: "continuous", param: 0.1 },
  { symbol: "R_25", name: "Volatility 25 Index", family: "continuous", param: 0.25 },
  { symbol: "R_50", name: "Volatility 50 Index", family: "continuous", param: 0.5 },
  { symbol: "R_75", name: "Volatility 75 Index", family: "continuous", param: 0.75 },
  { symbol: "R_100", name: "Volatility 100 Index", family: "continuous", param: 1.0 },
  { symbol: "1HZ10V", name: "Volatility 10 (1s) Index", family: "continuous", param: 0.1 },
  { symbol: "1HZ25V", name: "Volatility 25 (1s) Index", family: "continuous", param: 0.25 },
  { symbol: "1HZ50V", name: "Volatility 50 (1s) Index", family: "continuous", param: 0.5 },
  { symbol: "1HZ75V", name: "Volatility 75 (1s) Index", family: "continuous", param: 0.75 },
  { symbol: "1HZ100V", name: "Volatility 100 (1s) Index", family: "continuous", param: 1.0 },
  { symbol: "stpRNG", name: "Step Index 100", family: "step", param: 0.1 },
  { symbol: "stpRNG2", name: "Step Index 200", family: "step", param: 0.2 },
  { symbol: "stpRNG3", name: "Step Index 300", family: "step", param: 0.3 },
  { symbol: "stpRNG4", name: "Step Index 400", family: "step", param: 0.4 },
  { symbol: "stpRNG5", name: "Step Index 500", family: "step", param: 0.5 },
  { symbol: "JD10", name: "Jump 10 Index", family: "jump", param: 0.1 },
  { symbol: "JD25", name: "Jump 25 Index", family: "jump", param: 0.25 },
  { symbol: "JD50", name: "Jump 50 Index", family: "jump", param: 0.5 },
  { symbol: "JD75", name: "Jump 75 Index", family: "jump", param: 0.75 },
  { symbol: "JD100", name: "Jump 100 Index", family: "jump", param: 1.0 },
];

/** Only the classic 1s variants listed in scope are accepted (not 1HZ15V/30V/90V). */
const ALLOWED = new Set(MARKETS.map((m) => m.symbol));

export function familyOf(symbol: string): MarketFamily | null {
  if (!ALLOWED.has(symbol)) return null;
  return MARKETS.find((m) => m.symbol === symbol)!.family;
}

export function marketsFor(family: MarketFamily, activeSymbols?: Set<string>): MarketDef[] {
  return MARKETS.filter((m) => m.family === family && (!activeSymbols || activeSymbols.has(m.symbol)));
}

/** Digital-option contract types in scope. */
export type ContractType =
  | "CALL"
  | "PUT"
  | "DIGITEVEN"
  | "DIGITODD"
  | "DIGITOVER"
  | "DIGITUNDER"
  | "DIGITMATCH"
  | "DIGITDIFF";

export const CONTRACT_LABEL: Record<ContractType, string> = {
  CALL: "Rise",
  PUT: "Fall",
  DIGITEVEN: "Even",
  DIGITODD: "Odd",
  DIGITOVER: "Over",
  DIGITUNDER: "Under",
  DIGITMATCH: "Matches",
  DIGITDIFF: "Differs",
};
