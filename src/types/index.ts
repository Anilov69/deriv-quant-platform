export type MarketFamily = "continuous" | "step" | "jump";
export type ContractType = "DIGITMATCH" | "DIGITDIFF" | "CALL" | "PUT";
export type AccountKind = "demo" | "real";
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type DataMode = "live" | "simulation";

export interface MarketSymbol {
  symbol: string;
  displayName: string;
  family: MarketFamily;
  decimals: number;
  pip: number;
  available: boolean;
}

export interface DerivAccount {
  loginid: string;
  currency: string;
  kind: AccountKind;
  name: string;
}

export interface Tick {
  epoch: number;
  quote: number;
  digit: number;
}

export interface Proposal {
  id: string;
  contractType: ContractType;
  symbol: string;
  barrier?: string;
  duration: number;
  durationUnit: "t";
  askPrice: number;
  payout: number;
  spot: number;
  currency: string;
  receivedAt: number;
}

export interface Signal {
  id: string;
  symbol: string;
  family: MarketFamily;
  contractType: ContractType;
  barrier?: string;
  direction: "up" | "down" | "match" | "differ";
  durationTicks: number;
  probability: number;
  confidence: number;
  score: number;
  reasons: string[];
  createdAt: number;
}

export interface EvEstimate {
  stake: number;
  payout: number;
  breakEvenProbability: number;
  modelProbability: number;
  payoutPercentage: number;
  expectedValue: number;
  edge: number;
  actionable: boolean;
}

export interface TradeRecord {
  id: string;
  contractId?: number;
  symbol: string;
  contractType: ContractType;
  barrier?: string;
  direction: Signal["direction"];
  durationTicks: number;
  stake: number;
  payout: number;
  profit: number;
  status: "pending" | "open" | "won" | "lost" | "sold" | "error";
  mode: DataMode;
  accountKind: AccountKind;
  openedAt: number;
  closedAt?: number;
  entrySpot: number;
  exitSpot?: number;
  proposalId: string;
  error?: string;
}

export interface RiskSettings {
  baseStake: number;
  martingale: boolean;
  multiplier: number;
  maxStep: number;
  mode: "next-signal" | "classic-immediate";
  kellyFraction: number;
  dailyStopLoss: number;
  dailyTakeProfit: number;
  maxConsecutiveLosses: number;
}

export interface ContinuousAnalysis {
  digitCounts100: number[];
  digitCounts300: number[];
  digitCounts1000: number[];
  zScores: number[];
  entropy100: number;
  entropy300: number;
  entropy1000: number;
  hotDigit: number;
  coldDigit: number;
  repeatRate: number;
  lagAutocorrelation: number;
  logReturn: number;
  volatility: number;
  bollingerZ: number;
  velocityDeceleration: number;
  signals: Signal[];
}

export interface StepAnalysis {
  transitionMatrix: number[][];
  transitionCounts: number[][];
  observedSteps: number[];
  maxObservedStep: number;
  currentDigit: number;
  lowProbabilityBarrier: number;
  highProbabilityNeighbor: number;
  neighborProbability: number;
  streak: number;
  streakDirection: "up" | "down" | "none";
  lagAutocorrelation: number;
  meanReversionScore: number;
  signals: Signal[];
}

export interface JumpAnalysis {
  atr: number;
  jumps: number[];
  jumpIntensity: number;
  hazard: number;
  elevatedHazard: boolean;
  ticksSinceJump: number | null;
  stabilized: boolean;
  microDrift: number;
  signals: Signal[];
}

export interface TickBufferSnapshot {
  ticks: Tick[];
  currentDigit: number;
  lastQuote: number;
  decimals: number;
}
