/**
 * Global app state (Zustand). The PAT lives only in this in-memory store: it is
 * never written to localStorage/sessionStorage/cookies and never logged, so a
 * page reload signs the user out.
 */
import { create } from "zustand";
import type { ContractType, MarketFamily } from "@/lib/markets";
import type { DerivAccount } from "@/services/derivRest";
import type { ConnState } from "@/services/derivWs";
import { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from "@/engines/types";

export const DEFAULT_APP_ID = process.env.NEXT_PUBLIC_DERIV_APP_ID ?? "";

export interface Quote {
  stake: number;
  payout: number;
  /** Server time of the quote (s) */
  at: number;
  error?: string;
}

export interface Availability {
  /** contract type → [min, max] tick duration */
  [type: string]: [number, number];
}

export interface TradeRecord {
  id: string;
  contractId?: number;
  transactionId?: number;
  symbol: string;
  contractType: ContractType;
  barrier?: string;
  duration: number;
  stake: number;
  payout: number;
  pModel: number;
  ev: number;
  accountId: string;
  accountType: "demo" | "real";
  currency: string;
  boughtAt: number;
  status: "pending" | "open" | "won" | "lost" | "sold" | "unknown" | "failed";
  profit?: number;
  entrySpot?: string;
  exitSpot?: string;
  note?: string;
  auto: boolean;
}

export interface Guardrails {
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  /** Minimum EV per unit stake (e.g. 0.01 = +1 %). */
  minEv: number;
  /** Max risk % of balance per trade (Kelly cap). */
  maxRiskPct: number;
  /** Kelly multiplier (0.25 = quarter-Kelly). */
  kellyMultiplier: number;
  /** Reference stake used to request quotes and for manual trades. */
  quoteStake: number;
  /** Minimum back-test sample n before a signal can be actionable. */
  minSample: number;
  /** Min. Z of back-tested hits vs break-even before a +EV row is actionable. */
  minEdgeZ: number;
}

interface State {
  appId: string;
  token: string | null;
  authStatus: "signed-out" | "validating" | "signed-in" | "error";
  authError?: string;
  accounts: DerivAccount[];
  accountId: string | null;
  balance: number | null;
  currency: string;
  loginId: string | null;
  tradeConn: ConnState;
  publicConn: ConnState;
  latency: number | null;

  family: MarketFamily;
  symbol: string;
  prices: number[];
  times: number[];
  decimals: number;
  activeSymbols: Set<string> | null;
  availability: Record<string, Availability>;
  quotes: Record<string, Quote>;
  marketError?: string;

  settings: EngineSettings;
  guardrails: Guardrails;
  autoMode: boolean;
  halted: boolean;
  realConfirmed: string | null;
  trades: TradeRecord[];
  busy: boolean;
  toast?: { kind: "info" | "error" | "success"; text: string; at: number };

  set: (p: Partial<State>) => void;
  upsertTrade: (t: Partial<TradeRecord> & { id: string }) => void;
  notify: (kind: "info" | "error" | "success", text: string) => void;
}

export const useStore = create<State>((set) => ({
  appId: DEFAULT_APP_ID,
  token: null,
  authStatus: "signed-out",
  accounts: [],
  accountId: null,
  balance: null,
  currency: "USD",
  loginId: null,
  tradeConn: "idle",
  publicConn: "idle",
  latency: null,

  family: "continuous",
  symbol: "R_100",
  prices: [],
  times: [],
  decimals: 2,
  activeSymbols: null,
  availability: {},
  quotes: {},

  settings: DEFAULT_ENGINE_SETTINGS,
  guardrails: {
    maxDailyLoss: 50,
    maxConsecutiveLosses: 3,
    minEv: 0.01,
    maxRiskPct: 2,
    kellyMultiplier: 0.25,
    quoteStake: 10,
    minSample: 30,
    minEdgeZ: 2.5,
  },
  autoMode: false,
  halted: false,
  realConfirmed: null,
  trades: [],
  busy: false,

  set: (p) => set(p),
  upsertTrade: (t) =>
    set((s) => {
      const i = s.trades.findIndex((x) => x.id === t.id);
      if (i < 0) return { trades: [t as TradeRecord, ...s.trades] };
      const trades = s.trades.slice();
      trades[i] = { ...trades[i], ...t };
      return { trades };
    }),
  notify: (kind, text) => set({ toast: { kind, text, at: Date.now() } }),
}));

export const currentAccount = (s: Pick<State, "accounts" | "accountId">) => s.accounts.find((a) => a.account_id === s.accountId) ?? null;
