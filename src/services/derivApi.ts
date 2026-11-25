import type {
  ConnectionStatus,
  ContractType,
  DerivAccount,
  MarketSymbol,
  Proposal,
  Tick,
  TradeRecord,
} from "@/types";
import { fetchDerivAccounts, isValidAppId, requestDerivOtp } from "@/services/derivRest";

export interface DerivClientEvents {
  status: ConnectionStatus;
  authorized: { loginId: string; name: string };
  accounts: DerivAccount[];
  balance: { currency: string; balance: number; loginId: string };
  symbols: MarketSymbol[];
  history: { symbol: string; ticks: Tick[] };
  tick: Tick & { symbol: string };
  proposal: Proposal;
  bought: { contractId: number; proposal: Proposal; buyPrice: number };
  contract: TradeRecord;
  error: DerivApiError;
  latency: number;
}

type EventName = keyof DerivClientEvents;
type Listener<K extends EventName> = (payload: DerivClientEvents[K]) => void;

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
  key: string;
  requestId: number;
  subscriptionId?: string;
  payload: Record<string, unknown>;
}

interface DerivErrorPayload {
  code?: string;
  message?: string;
}

interface ContractPayload {
  contract_id?: number;
  status?: string;
  profit?: number | string;
  is_sold?: number;
  entry_spot?: number | string;
  exit_spot?: number | string;
  current_spot?: number | string;
  underlying_symbol?: string;
  contract_type?: ContractType;
  barrier?: string | number;
  date_start?: number;
  date_end?: number;
  payout?: number | string;
  buy_price?: number | string;
}

const MAX_TICKS = 1_000;
const MAX_SUBSCRIPTIONS = 12;
const REQUEST_TIMEOUT_MS = 12_000;
const PING_INTERVAL_MS = 20_000;
const PROPOSAL_INTERVAL_MS = 1_100;

const CONTINUOUS_SYMBOLS = new Set(["R_10", "R_25", "R_50", "R_75", "R_100"]);
const ONE_SECOND_SYMBOLS = new Set(["1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"]);
const JUMP_SYMBOLS = new Set(["JD10", "JD25", "JD50", "JD75", "JD100"]);

export class DerivApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DerivApiError";
    this.code = code;
  }
}

export function redactSecret(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

export function familyForSymbol(symbol: string): MarketSymbol["family"] | null {
  if (CONTINUOUS_SYMBOLS.has(symbol) || ONE_SECOND_SYMBOLS.has(symbol)) return "continuous";
  if (symbol === "stpRNG" || /^stpRNG\d+$/.test(symbol)) return "step";
  if (JUMP_SYMBOLS.has(symbol)) return "jump";
  return null;
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uniqueTicks(ticks: Tick[]): Tick[] {
  const byEpoch = new Map<number, Tick>();
  for (const tick of ticks) {
    if (Number.isFinite(tick.quote) && Number.isFinite(tick.epoch)) byEpoch.set(tick.epoch, tick);
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch).slice(-MAX_TICKS);
}

export class DerivClient {
  private socket: WebSocket | null = null;
  private token = "";
  private appId = "";
  private socketUrl = "";
  private status: ConnectionStatus = "disconnected";
  private pending = new Map<number, PendingRequest>();
  private pendingBuys = new Map<number, Proposal>();
  private subscriptions = new Map<string, Subscription>();
  private listeners = new Map<EventName, Set<(payload: never) => void>>();
  private requestSequence = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = true;
  private lastProposalRequestAt = 0;
  private activeLoginId = "";
  private accountsCache: DerivAccount[] = [];
  private selectedTickSymbol = "";
  private tickCache = new Map<string, Tick[]>();
  private symbolMetadataCache = new Map<string, { decimals: number; pip: number }>();
  private contractMeta = new Map<number, { proposal: Proposal; mode: TradeRecord["mode"]; accountKind: TradeRecord["accountKind"] }>();

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  on<K extends EventName>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (payload: never) => void);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off<K extends EventName>(event: K, listener: Listener<K>): void {
    this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  private emit<K extends EventName>(event: K, payload: DerivClientEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<K>)(payload);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  async connect(token: string, appId: string): Promise<void> {
    const cleanToken = token.trim();
    const cleanAppId = appId.trim();
    if (!cleanToken) throw new DerivApiError("InvalidToken", "Enter a Deriv Personal Access Token.");
    if (!isValidAppId(cleanAppId)) {
      throw new DerivApiError("InvalidAppId", "Enter your Deriv App ID. Letters and numbers are both accepted.");
    }
    this.disconnect();
    this.token = cleanToken;
    this.appId = cleanAppId;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    try {
      const accounts = await fetchDerivAccounts({ token: this.token, appId: this.appId });
      if (!accounts.length) throw new DerivApiError("NoAccounts", "This token has no Options accounts available.");
      this.accountsCache = accounts;
      this.emit("accounts", accounts);
      const preferred = accounts.find((item) => item.kind === "demo") ?? accounts[0];
      await this.openAccount(preferred);
    } catch (error) {
      this.clearCredentials();
      throw error;
    }
  }

  private async openAccount(account: DerivAccount): Promise<void> {
    this.socketUrl = await requestDerivOtp({ token: this.token, appId: this.appId }, account.loginid);
    this.activeLoginId = account.loginid;
    await this.openAndAuthorize();
    this.emit("authorized", { loginId: account.loginid, name: account.name });
  }

  private async openAndAuthorize(): Promise<void> {
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const socket = new WebSocket(this.socketUrl);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const openedAt = performance.now();
      const openTimer = setTimeout(() => {
        socket.close();
        reject(new DerivApiError("ConnectionTimeout", "Deriv did not accept the WebSocket connection."));
      }, REQUEST_TIMEOUT_MS);

      socket.onopen = () => {
        clearTimeout(openTimer);
        this.startPing();
        this.setStatus("connected");
        this.emit("latency", Math.max(1, Math.round(performance.now() - openedAt)));
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(openTimer);
        reject(new DerivApiError("ConnectionFailed", "Could not reach Deriv. Check the network and try again."));
      };
      socket.onclose = () => this.handleClose(socket);
      socket.onmessage = (event) => this.handleMessage(event.data);
    });

    await this.loadActiveSymbols();
    await this.subscribeBalance();
    if (this.selectedTickSymbol) await this.subscribeTicks(this.selectedTickSymbol);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      const sentAt = performance.now();
      const reqId = ++this.requestSequence;
      this.sendRaw({ ping: 1, req_id: reqId });
      const off = this.on("latency", () => off());
      const timeout = setTimeout(() => {
        off();
        this.emit("latency", Math.max(1, Math.round(performance.now() - sentAt)));
      }, 5_000);
      const stop = this.on("latency", () => clearTimeout(timeout));
      void stop;
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopPing();
    this.rejectAllPending(new DerivApiError("Disconnected", "The Deriv connection closed."));
    this.subscriptions.clear();
    if (this.intentionalClose) {
      this.setStatus("disconnected");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const account = this.accountsCache.find((item) => item.loginid === this.activeLoginId);
      if (!account) {
        this.intentionalClose = true;
        this.setStatus("error");
        return;
      }
      void this.openAccount(account)
        .then(() => { this.reconnectAttempt = 0; })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    this.rejectAllPending(new DerivApiError("Disconnected", "The Deriv connection was closed."));
    this.subscriptions.clear();
    this.selectedTickSymbol = "";
    this.activeLoginId = "";
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Client disconnect");
    this.setStatus("disconnected");
  }

  clearCredentials(): void {
    this.disconnect();
    this.token = "";
    this.socketUrl = "";
    this.accountsCache = [];
    this.contractMeta.clear();
    this.pendingBuys.clear();
    this.tickCache.clear();
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.connected) throw new DerivApiError("NotConnected", "Connect to Deriv first.");
    this.socket?.send(JSON.stringify(payload));
  }

  private send(payload: Record<string, unknown>, requestId?: number): Promise<Record<string, unknown>> {
    if (!this.connected) return Promise.reject(new DerivApiError("NotConnected", "Connect to Deriv first."));
    if (this.pending.size >= 64) return Promise.reject(new DerivApiError("RequestQueueFull", "Too many Deriv requests are pending."));
    const reqId = requestId ?? ++this.requestSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new DerivApiError("RequestTimeout", "Deriv did not respond before the request timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.sendRaw({ ...payload, req_id: reqId });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(error);
      }
    });
  }

  private handleMessage(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      this.emit("error", new DerivApiError("InvalidResponse", "Deriv sent an unreadable response."));
      return;
    }

    const reqId = safeNumber(message.req_id, -1);
    if (message.error) {
      const apiError = message.error as DerivErrorPayload;
      const error = new DerivApiError(apiError.code ?? "ApiError", redactSecret(apiError.message ?? "Deriv rejected the request.", this.token));
      const pending = this.pending.get(reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(reqId);
        pending.reject(error);
      }
      this.emit("error", error);
      return;
    }

    if (message.msg_type === "ping" || message.msg_type === "pong") {
      this.emit("latency", 1);
      return;
    }

    const subscription = message.subscription as { id?: string } | undefined;
    const matching = [...this.subscriptions.values()].find((item) =>
      (subscription?.id && item.subscriptionId === subscription.id) || item.requestId === reqId,
    );
    if (matching && subscription?.id) matching.subscriptionId = subscription.id;

    if (message.msg_type === "account_list") {
      const list = (message.account_list as Record<string, unknown>[] | undefined) ?? [];
      const accounts = list.map((account): DerivAccount => ({
        loginid: String(account.loginid ?? ""),
        currency: String(account.currency ?? "USD"),
        kind: String(account.loginid ?? "").startsWith("VRTC") ? "demo" : "real",
        name: String(account.account_name ?? account.loginid ?? "Deriv account"),
      })).filter((account) => account.loginid);
      this.emit("accounts", accounts);
    } else if (message.msg_type === "balance") {
      const balance = message.balance as Record<string, unknown> | undefined;
      if (balance) {
        this.emit("balance", {
          currency: String(balance.currency ?? "USD"),
          balance: safeNumber(balance.balance),
          loginId: String(balance.loginid ?? this.activeLoginId),
        });
      }
    } else if (message.msg_type === "active_symbols") {
      const active = (message.active_symbols as Record<string, unknown>[] | undefined) ?? [];
      const symbols = this.filterSymbols(active);
      this.emit("symbols", symbols);
    } else if (message.msg_type === "history") {
      const history = message.history as { symbol?: string; prices?: number[]; times?: number[] } | undefined;
      if (history?.symbol && history.prices && history.times) {
        const metadata = this.symbolMetadata(history.symbol);
        const ticks = uniqueTicks(history.prices.map((quote, index) => this.toTick(quote, history.times?.[index] ?? 0, metadata.decimals)));
        this.tickCache.set(history.symbol, ticks);
        this.emit("history", { symbol: history.symbol, ticks });
      }
    } else if (message.msg_type === "tick") {
      const tick = message.tick as { symbol?: string; quote?: number; epoch?: number } | undefined;
      if (tick?.symbol && tick.quote !== undefined && tick.epoch !== undefined) {
        const metadata = this.symbolMetadata(tick.symbol);
        const normalized = this.toTick(tick.quote, tick.epoch, metadata.decimals);
        const cache = uniqueTicks([...(this.tickCache.get(tick.symbol) ?? []), normalized]);
        this.tickCache.set(tick.symbol, cache);
        this.emit("tick", { ...normalized, symbol: tick.symbol });
      }
    } else if (message.msg_type === "proposal") {
      const proposal = this.parseProposal(message.proposal as Record<string, unknown> | undefined, matching?.payload);
      if (proposal) this.emit("proposal", proposal);
    } else if (message.msg_type === "buy") {
      const buy = message.buy as Record<string, unknown> | undefined;
      if (buy?.contract_id !== undefined) {
        const proposal = this.findProposalForRequest(reqId);
        if (proposal) {
          const contractId = safeNumber(buy.contract_id);
          this.contractMeta.set(contractId, {
            proposal,
            mode: "live",
            accountKind: proposal.symbol ? (this.activeLoginId.startsWith("VRTC") ? "demo" : "real") : "demo",
          });
          this.emit("bought", { contractId, proposal, buyPrice: safeNumber(buy.buy_price, proposal.askPrice) });
          void this.subscribeContract(contractId).catch(() => undefined);
        }
      }
    } else if (message.msg_type === "proposal_open_contract") {
      const contract = message.proposal_open_contract as ContractPayload | undefined;
      if (contract?.contract_id !== undefined) this.handleContract(contract);
    }

    const pending = this.pending.get(reqId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      pending.resolve(message);
    }
  }

  private symbolMetadata(symbol: string): { decimals: number; pip: number } {
    const cached = this.symbolMetadataCache.get(symbol);
    if (cached) return cached;
    const match = /^(?:R|JD)(10|25|50|75|100)$/.exec(symbol);
    const metadata = { decimals: 2, pip: match ? 10 ** -Number(match[1]) : 0.01 };
    this.symbolMetadataCache.set(symbol, metadata);
    return metadata;
  }

  private toTick(quote: number, epoch: number, decimals: number): Tick {
    const scale = 10 ** decimals;
    const scaled = Math.round(Math.abs(quote) * scale);
    return { epoch, quote, digit: Math.floor((scaled % 10) + Number.EPSILON) };
  }

  private filterSymbols(active: Record<string, unknown>[]): MarketSymbol[] {
    const result: MarketSymbol[] = [];
    for (const item of active) {
      // New Options API names: underlying_symbol / underlying_symbol_name / pip_size.
      const symbol = String(item.underlying_symbol ?? item.symbol ?? "");
      const family = familyForSymbol(symbol);
      if (!family) continue;
      const pip = safeNumber(item.pip_size ?? item.pip, 0.01);
      const decimals = pip > 0 ? Math.min(8, Math.max(0, Math.round(-Math.log10(pip)))) : 2;
      this.symbolMetadataCache.set(symbol, { decimals, pip });
      result.push({
        symbol,
        displayName: String(item.underlying_symbol_name ?? item.display_name ?? symbol),
        family,
        decimals,
        pip,
        available: item.exchange_is_open !== 0 && item.is_trading_suspended !== 1,
      });
    }
    return result.sort((a, b) => a.family.localeCompare(b.family) || a.symbol.localeCompare(b.symbol));
  }

  private parseProposal(value: Record<string, unknown> | undefined, request?: Record<string, unknown>): Proposal | null {
    if (!value?.id || !request) return null;
    const payout = safeNumber(value.payout);
    const askPrice = safeNumber(value.ask_price);
    if (payout <= 0 || askPrice <= 0) return null;
    const contractType = String(request.contract_type ?? value.contract_type ?? "") as ContractType;
    if (!["DIGITMATCH", "DIGITDIFF", "CALL", "PUT"].includes(contractType)) return null;
    return {
      id: String(value.id),
      contractType,
      // We send "underlying_symbol"; accept the legacy key for older responses.
      symbol: String(request.underlying_symbol ?? request.symbol ?? value.symbol ?? ""),
      barrier: request.barrier === undefined ? undefined : String(request.barrier),
      duration: safeNumber(request.duration, 1),
      durationUnit: "t",
      askPrice,
      payout,
      spot: safeNumber(value.spot),
      currency: String(request.currency ?? "USD"),
      receivedAt: Date.now(),
    };
  }

  private findProposalForRequest(reqId: number): Proposal | null {
    return this.pendingBuys.get(reqId) ?? null;
  }

  private registerSubscription(key: string, payload: Record<string, unknown>): Subscription {
    const existing = this.subscriptions.get(key);
    if (existing) return existing;
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new DerivApiError("SubscriptionLimit", "Too many Deriv subscriptions are active.");
    const subscription: Subscription = { key, requestId: 0, payload };
    this.subscriptions.set(key, subscription);
    return subscription;
  }

  private async sendSubscription(key: string, payload: Record<string, unknown>, streaming: boolean): Promise<Record<string, unknown>> {
    const subscription = this.registerSubscription(key, payload);
    const reqId = ++this.requestSequence;
    subscription.requestId = reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.subscriptions.delete(key);
        reject(new DerivApiError("SubscriptionTimeout", "Deriv did not open the requested subscription."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, {
        resolve: (message) => {
          clearTimeout(timer);
          this.pending.delete(reqId);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(reqId);
          reject(error);
        },
        timer,
      });
      try {
        this.sendRaw({ ...payload, req_id: reqId, ...(streaming ? { subscribe: 1 } : {}) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        this.subscriptions.delete(key);
        reject(error);
      }
    });
  }

  async loadActiveSymbols(): Promise<MarketSymbol[]> {
    // product_type is a removed Legacy filter and now fails validation.
    const response = await this.send({ active_symbols: "brief" });
    const symbols = this.filterSymbols((response.active_symbols as Record<string, unknown>[] | undefined) ?? []);
    this.emit("symbols", symbols);
    return symbols;
  }

  async subscribeBalance(): Promise<void> {
    await this.sendSubscription("balance", { balance: 1 }, true);
  }

  async switchAccount(loginId: string): Promise<void> {
    const account = this.accountsCache.find((item) => item.loginid === loginId);
    if (!account) throw new DerivApiError("InvalidAccount", "The selected Deriv account is not available for this token.");
    await this.clearProposals();
    // An OTP authorises exactly one socket, so switching accounts means a fresh OTP + socket.
    this.intentionalClose = true;
    this.stopPing();
    this.subscriptions.clear();
    this.rejectAllPending(new DerivApiError("Switching", "Switching Deriv account."));
    const previous = this.socket;
    this.socket = null;
    previous?.close(1000, "Account switch");
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    await this.openAccount(account);
  }

  async subscribeTicks(symbol: string): Promise<void> {
    if (!familyForSymbol(symbol)) throw new DerivApiError("UnsupportedSymbol", "This market is outside the supported synthetic indices.");
    if (this.selectedTickSymbol && this.selectedTickSymbol !== symbol) await this.unsubscribe(this.selectedTickSymbol);
    this.selectedTickSymbol = symbol;
    if (!this.subscriptions.has(symbol)) await this.sendSubscription(symbol, { ticks: symbol }, true);
    const metadata = this.symbolMetadata(symbol);
    const response = await this.send({ ticks_history: symbol, adjust_start_time: 1, count: MAX_TICKS, end: "latest", start: 1, style: "ticks" });
    const history = response.history as { prices?: number[]; times?: number[] } | undefined;
    if (history?.prices && history.times) {
      const ticks = uniqueTicks(history.prices.map((quote, index) => this.toTick(quote, history.times?.[index] ?? 0, metadata.decimals)));
      this.tickCache.set(symbol, ticks);
      this.emit("history", { symbol, ticks });
    }
  }

  async subscribeProposal(input: {
    symbol: string;
    contractType: ContractType;
    barrier?: string;
    duration: number;
    amount: number;
    currency: string;
  }): Promise<void> {
    if (!this.connected) throw new DerivApiError("NotConnected", "Connect to Deriv first.");
    if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 10) throw new DerivApiError("InvalidDuration", "Duration must be between 1 and 10 ticks.");
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new DerivApiError("InvalidStake", "Stake must be greater than zero.");
    // Deriv offers no digit contracts on step indices; only CALL/PUT are tradable there.
    if (familyForSymbol(input.symbol) === "step" && input.contractType.startsWith("DIGIT")) {
      throw new DerivApiError("UnsupportedContract", `${input.contractType} is not offered on step indices. Use CALL or PUT.`);
    }
    const key = `proposal:${input.symbol}:${input.contractType}:${input.barrier ?? ""}:${input.duration}:${input.amount}`;
    if (this.subscriptions.has(key)) return;
    const wait = Math.max(0, PROPOSAL_INTERVAL_MS - (Date.now() - this.lastProposalRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastProposalRequestAt = Date.now();
    const payload: Record<string, unknown> = {
      proposal: 1,
      amount: input.amount,
      basis: "stake",
      contract_type: input.contractType,
      currency: input.currency,
      duration: input.duration,
      duration_unit: "t",
      // New API rejects the Legacy "symbol" field here.
      underlying_symbol: input.symbol,
    };
    if (input.contractType === "DIGITMATCH" || input.contractType === "DIGITDIFF") payload.barrier = input.barrier ?? "0";
    await this.sendSubscription(key, payload, true);
  }

  async buyProposal(proposal: Proposal): Promise<number> {
    if (!this.connected) throw new DerivApiError("NotConnected", "Connect to Deriv before buying.");
    if (Date.now() - proposal.receivedAt > 4_000) throw new DerivApiError("StaleProposal", "The live proposal expired. Refresh it before trading.");
    const reqId = ++this.requestSequence;
    this.pendingBuys.set(reqId, proposal);
    try {
      const response = await this.send({ buy: proposal.id, price: proposal.askPrice }, reqId);
      const buy = response.buy as { contract_id?: number } | undefined;
      const contractId = safeNumber(buy?.contract_id);
      if (!contractId) throw new DerivApiError("InvalidBuyResponse", "Deriv did not return a contract ID.");
      return contractId;
    } finally {
      this.pendingBuys.delete(reqId);
    }
  }

  async subscribeContract(contractId: number): Promise<void> {
    if (!this.contractMeta.has(contractId)) throw new DerivApiError("UnknownContract", "No trade metadata exists for this contract.");
    const key = `contract:${contractId}`;
    if (!this.subscriptions.has(key)) await this.sendSubscription(key, { proposal_open_contract: 1, contract_id: contractId }, true);
  }

  private handleContract(contract: ContractPayload): void {
    const contractId = safeNumber(contract.contract_id);
    const meta = this.contractMeta.get(contractId);
    if (!meta) return;
    const rawStatus = contract.status ?? "open";
    const settled = contract.is_sold === 1 || ["won", "lost"].includes(rawStatus);
    const status: TradeRecord["status"] = settled
      ? rawStatus === "lost" ? "lost" : rawStatus === "won" ? "won" : "sold"
      : "open";
    const record: TradeRecord = {
      id: `deriv-${contractId}`,
      contractId,
      symbol: String(contract.underlying_symbol ?? meta.proposal.symbol),
      contractType: contract.contract_type ?? meta.proposal.contractType,
      barrier: contract.barrier === undefined ? meta.proposal.barrier : String(contract.barrier),
      direction: meta.proposal.contractType === "CALL" ? "up" : meta.proposal.contractType === "PUT" ? "down" : meta.proposal.contractType === "DIGITMATCH" ? "match" : "differ",
      durationTicks: meta.proposal.duration,
      stake: meta.proposal.askPrice,
      payout: safeNumber(contract.payout, meta.proposal.payout),
      profit: settled ? safeNumber(contract.profit) : 0,
      status,
      mode: meta.mode,
      accountKind: meta.accountKind,
      openedAt: safeNumber(contract.date_start, Date.now() / 1_000),
      closedAt: settled ? safeNumber(contract.date_end, Date.now() / 1_000) : undefined,
      entrySpot: safeNumber(contract.entry_spot),
      exitSpot: settled ? safeNumber(contract.exit_spot, safeNumber(contract.current_spot)) : undefined,
      proposalId: meta.proposal.id,
    };
    if (settled) void this.unsubscribe(`contract:${contractId}`);
    this.emit("contract", record);
  }

  async unsubscribe(key: string): Promise<void> {
    const subscription = this.subscriptions.get(key);
    if (!subscription) return;
    this.subscriptions.delete(key);
    if (!subscription.subscriptionId || !this.connected) return;
    await this.send({ forget: subscription.subscriptionId }).catch(() => undefined);
  }

  async clearProposals(): Promise<void> {
    const keys = [...this.subscriptions.keys()].filter((key) => key.startsWith("proposal:"));
    for (const key of keys) await this.unsubscribe(key);
  }

  async forgetAll(): Promise<void> {
    if (!this.connected) return;
    await this.send({ forget_all: 1 }).catch(() => undefined);
    this.subscriptions.clear();
  }

  getCachedTicks(symbol: string): Tick[] {
    return [...(this.tickCache.get(symbol) ?? [])];
  }
}
