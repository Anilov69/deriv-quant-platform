/**
 * Deriv transport, written for the New Options API.
 *
 * Handshake: GET accounts -> POST otp -> new WebSocket(url).
 * The OTP request must carry no body and no Content-Type; the socket is
 * already authenticated, so no "authorize" frame is ever sent.
 */

export type Family = "continuous" | "jump" | "step";
export type Status = "idle" | "connecting" | "live" | "error";

export const REST_BASE = "https://api.derivws.com";
const REQUEST_TIMEOUT_MS = 15000;
const WS_TIMEOUT_MS = 12000;

export interface Account {
  id: string;
  currency: string;
  kind: "demo" | "real";
  label: string;
}

export interface SymbolInfo {
  symbol: string;
  name: string;
  pip: number;
  family: Family;
}

export interface Tick {
  epoch: number;
  quote: number;
}

export interface Quote {
  id: string;
  ask: number;
  payout: number;
}

export interface Contract {
  id: number;
  symbol: string;
  contractType: string;
  stake: number;
  payout: number;
  status: string;
  profit: number;
}

export class DerivError extends Error {
  readonly code: string;
  readonly http: number;

  constructor(code: string, message: string, http = 0) {
    super(message);
    this.name = "DerivError";
    this.code = code;
    this.http = http;
  }
}

export function familyOf(symbol: string): Family | null {
  if (/^stpRNG[0-9]*$/i.test(symbol)) return "step";
  if (/^JD[0-9]+$/.test(symbol)) return "jump";
  if (/^(R_[0-9]+|1HZ[0-9]+V)$/.test(symbol)) return "continuous";
  return null;
}

export function validAppId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.trim());
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function rest(path: string, token: string, appId: string, method: "GET" | "POST"): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(REST_BASE + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Deriv-App-ID": appId,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: any = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 160) };
      }
    }
    if (!response.ok) {
      const message = typeof body?.message === "string" ? body.message : "HTTP " + response.status;
      throw new DerivError(
        response.status === 401 ? "Unauthorized" : "Http" + response.status,
        response.status === 401 ? "Deriv rejected the token or App ID (401)." : message,
        response.status,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof DerivError) throw error;
    if ((error as Error)?.name === "AbortError") throw new DerivError("Timeout", "Deriv did not answer in time.");
    throw new DerivError("Network", "Could not reach Deriv. Check your connection.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deriv's documented WebSocket budget is 360 proposal-class calls a minute,
 * shared with proposal_open_contract and buy. That is an average of 6/s, but a
 * burst of proposals is rejected long before the average is reached, which is
 * exactly what an unpaced ladder refresh does. Every proposal therefore goes
 * through one serialised queue with a floor interval, and a RateLimit answer
 * parks the queue instead of retrying.
 */
export const PROPOSAL_SPACING_MS = 320;
const RATE_LIMIT_PAUSE_MS = 5000;

export function isRateLimit(error: unknown): boolean {
  return error instanceof Error && /rate[\s-]?limit/i.test(error.message);
}

export class DerivSession {
  status: Status = "idle";
  accountId = "";
  onStatus: ((status: Status, detail: string) => void) | null = null;
  onTick: ((tick: Tick) => void) | null = null;
  onTickFor: ((symbol: string, tick: Tick) => void) | null = null;
  onSymbols: ((symbols: SymbolInfo[]) => void) | null = null;
  onBalance: ((balance: number, currency: string) => void) | null = null;
  onContract: ((contract: any) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private socket: WebSocket | null = null;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private sequence = 1;
  private tickSubscription: string | null = null;
  private tickSymbols = new Map<string, string>();
  private ping: ReturnType<typeof setInterval> | undefined;
  private token = "";
  private appId = "";
  private closing = false;
  private proposalChain: Promise<unknown> = Promise.resolve();
  private lastProposalAt = 0;
  private proposalPausedUntil = 0;

  get live(): boolean {
    return this.status === "live";
  }

  private setStatus(status: Status, detail: string): void {
    this.status = status;
    this.onStatus?.(status, detail);
  }

  async connect(token: string, appId: string): Promise<Account[]> {
    this.token = token.trim();
    this.appId = appId.trim();
    this.setStatus("connecting", "Requesting accounts from Deriv...");
    const body = await rest("/trading/v1/options/accounts", this.token, this.appId, "GET");
    const rows: any[] = Array.isArray(body?.data) ? body.data : [];
    const accounts: Account[] = rows
      .map((row) => ({
        id: String(row?.account_id ?? ""),
        currency: String(row?.currency ?? "USD"),
        kind: String(row?.account_type ?? "").toLowerCase().includes("demo") ? ("demo" as const) : ("real" as const),
        label: String(row?.name ?? row?.account_type ?? "Account"),
      }))
      .filter((account) => account.id.length > 0);
    if (accounts.length === 0) throw new DerivError("NoAccount", "This token has no Options accounts.");
    const chosen = accounts.find((account) => account.kind === "demo") ?? accounts[0];
    await this.openFor(chosen.id);
    return accounts;
  }

  async switchTo(accountId: string): Promise<void> {
    this.closeSocket();
    await this.openFor(accountId);
  }

  private async openFor(accountId: string): Promise<void> {
    this.accountId = accountId;
    const path = "/trading/v1/options/accounts/" + encodeURIComponent(accountId) + "/otp";
    const body = await rest(path, this.token, this.appId, "POST");
    const url = String(body?.data?.url ?? "");
    if (!/^wss:\/\//i.test(url)) throw new DerivError("NoOtp", "Deriv did not return a socket URL for this account.");
    await this.openSocket(url);
  }

  private openSocket(url: string): Promise<void> {
    this.setStatus("connecting", "Opening the single-use OTP socket...");
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      this.closing = false;
      let settled = false;
      socket.onopen = () => {
        settled = true;
        this.setStatus("live", "Live via OTP socket");
        this.startPing();
        resolve();
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          this.setStatus("error", "The Deriv socket failed to open.");
          reject(new DerivError("Socket", "The Deriv socket failed to open."));
        }
      };
      socket.onclose = () => {
        if (!settled) {
          settled = true;
          this.setStatus("error", "The Deriv socket closed during setup.");
          reject(new DerivError("Socket", "The Deriv socket closed during setup."));
          return;
        }
        if (!this.closing) this.setStatus("idle", "Socket closed");
      };
      socket.onmessage = (event) => this.handleMessage(String((event as MessageEvent).data));
    });
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const reqId = typeof message?.req_id === "number" ? (message.req_id as number) : undefined;

    if (message.error) {
      const text = String(message.error.message ?? "Deriv rejected the request.");
      if (reqId !== undefined && this.pending.has(reqId)) {
        const entry = this.pending.get(reqId)!;
        this.pending.delete(reqId);
        entry.reject(new DerivError(String(message.error.code ?? "ApiError"), text));
        return;
      }
      if (message.msg_type !== "tick") this.onError?.(text);
      return;
    }

    if (message.msg_type === "tick" && message.tick) {
      // The first frame of a ticks subscription carries the req_id too, so the
      // awaiting caller still needs resolving below.
      const tick = { epoch: num(message.tick.epoch), quote: num(message.tick.quote) };
      const owner = message.subscription?.id ? this.tickSymbols.get(String(message.subscription.id)) : undefined;
      if (owner) this.onTickFor?.(owner, tick);
      else this.onTick?.(tick);
    }

    if (message.msg_type === "balance" && message.balance) {
      this.onBalance?.(num(message.balance.balance), String(message.balance.currency ?? "USD"));
    }

    if (message.msg_type === "proposal_open_contract" && message.proposal_open_contract) {
      this.onContract?.(message.proposal_open_contract);
    }

    if (reqId !== undefined && this.pending.has(reqId)) {
      const entry = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      entry.resolve(message);
    }
  }

  private send(payload: Record<string, unknown>): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new DerivError("NotConnected", "Connect to Deriv first."));
    }
    const reqId = this.sequence++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      socket.send(JSON.stringify({ ...payload, req_id: reqId }));
      setTimeout(() => {
        if (this.pending.has(reqId)) {
          this.pending.delete(reqId);
          reject(new DerivError("Timeout", "Deriv did not answer in time."));
        }
      }, WS_TIMEOUT_MS);
    });
  }

  async loadSymbols(): Promise<SymbolInfo[]> {
    const message = await this.send({ active_symbols: "brief" });
    const rows: any[] = Array.isArray(message?.active_symbols) ? message.active_symbols : [];
    const symbols: SymbolInfo[] = [];
    for (const row of rows) {
      const symbol = String(row?.underlying_symbol ?? "");
      const family = familyOf(symbol);
      const pip = num(row?.pip_size, 0);
      if (!family || pip <= 0) continue;
      symbols.push({ symbol, name: String(row?.underlying_symbol_name ?? symbol), pip, family });
    }
    symbols.sort((a, b) => a.family.localeCompare(b.family) || a.symbol.localeCompare(b.symbol));
    this.onSymbols?.(symbols);
    return symbols;
  }

  async history(symbol: string, count: number): Promise<Tick[]> {
    const message = await this.send({ ticks_history: symbol, count, end: "latest" });
    const prices: any[] = Array.isArray(message?.history?.prices) ? message.history.prices : [];
    const times: any[] = Array.isArray(message?.history?.times) ? message.history.times : [];
    return prices.map((price, index) => ({ quote: num(price), epoch: num(times[index]) }));
  }

  async subscribeTicks(symbol: string): Promise<void> {
    if (this.tickSubscription) {
      try {
        await this.send({ forget: this.tickSubscription });
      } catch {
        /* the old subscription may already be gone */
      }
      this.tickSubscription = null;
    }
    const message = await this.send({ ticks: symbol, subscribe: 1 });
    this.tickSubscription = String(message?.subscription?.id ?? "");
  }

  /**
   * A second, independent tick stream for a named page (the gap engine), so the
   * terminal's own subscription keeps its symbol. Returns the subscription id.
   */
  async subscribeTicksFor(symbol: string): Promise<string> {
    const message = await this.send({ ticks: symbol, subscribe: 1 });
    const id = String(message?.subscription?.id ?? "");
    if (id) this.tickSymbols.set(id, symbol);
    return id;
  }

  async forget(subscriptionId: string): Promise<void> {
    if (!subscriptionId) return;
    this.tickSymbols.delete(subscriptionId);
    try {
      await this.send({ forget: subscriptionId });
    } catch {
      /* the subscription may already be gone */
    }
  }

  async subscribeBalance(): Promise<void> {
    await this.send({ balance: 1, subscribe: 1 });
  }

  async quote(input: {
    symbol: string;
    contract: string;
    barrier?: string;
    duration: number;
    stake: number;
    currency: string;
  }): Promise<Quote> {
    const payload: Record<string, unknown> = {
      proposal: 1,
      amount: input.stake,
      basis: "stake",
      contract_type: input.contract,
      currency: input.currency,
      duration: input.duration,
      duration_unit: "t",
      underlying_symbol: input.symbol,
    };
    if (input.barrier !== undefined) payload.barrier = input.barrier;
    const message = await this.sendProposal(payload);
    const proposal = message?.proposal;
    const ask = num(proposal?.ask_price);
    const payout = num(proposal?.payout);
    if (!proposal?.id || ask <= 0 || payout <= 0) throw new DerivError("NoQuote", "Deriv returned no usable quote.");
    return { id: String(proposal.id), ask, payout };
  }

  private sendProposal(payload: Record<string, unknown>): Promise<any> {
    const run = this.proposalChain.then(async () => {
      const now = Date.now();
      const wait = Math.max(this.proposalPausedUntil - now, this.lastProposalAt + PROPOSAL_SPACING_MS - now, 0);
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      this.lastProposalAt = Date.now();
      try {
        return await this.send(payload);
      } catch (error) {
        if (isRateLimit(error)) {
          this.proposalPausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
          throw new DerivError("RateLimit", "Deriv rate-limited proposals; pausing for a few seconds.", 0);
        }
        throw error;
      }
    });
    this.proposalChain = run.catch(() => undefined);
    return run;
  }

  async buy(id: string, price: number): Promise<number> {
    const message = await this.send({ buy: id, price });
    const contractId = num(message?.buy?.contract_id);
    if (!contractId) throw new DerivError("NoContract", "Deriv did not confirm the purchase.");
    return contractId;
  }

  async watch(contractId: number): Promise<string> {
    const message = await this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    return String(message?.subscription?.id ?? "");
  }

  disconnect(): void {
    this.closing = true;
    this.closeSocket();
    this.tickSubscription = null;
    this.setStatus("idle", "Disconnected");
  }

  private closeSocket(): void {
    if (this.ping !== undefined) {
      clearInterval(this.ping);
      this.ping = undefined;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onclose = null;
      try {
        socket.close(1000, "client");
      } catch {
        /* already closing */
      }
    }
    for (const entry of this.pending.values()) entry.reject(new DerivError("Closed", "The socket closed."));
    this.pending.clear();
  }

  private startPing(): void {
    if (this.ping !== undefined) clearInterval(this.ping);
    this.ping = setInterval(() => {
      try {
        this.send({ ping: 1 }).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }, 25000);
  }
}