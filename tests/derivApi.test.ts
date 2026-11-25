import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DerivClient, familyForSymbol, redactSecret, type DerivClientEvents } from "../src/services/derivApi";
import type { Proposal } from "../src/types";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static failHandshake = false;
  static currentLoginId = "VRTC100";

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    MockWebSocket.currentLoginId = new URL(url).pathname.endsWith("/real") ? "CR100" : "VRTC100";
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (MockWebSocket.failHandshake) {
        this.readyState = MockWebSocket.CLOSED;
        this.onerror?.(new Event("error"));
        this.onclose?.({ type: "close" } as CloseEvent);
        return;
      }
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(raw: string): void {
    const request = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(request);
    const reqId = request.req_id;
    let response: Record<string, unknown>;

    if (request.active_symbols) {
      response = {
        msg_type: "active_symbols",
        active_symbols: [
          { symbol: "R_100", display_name: "Volatility 100 Index", pip: 0.001, exchange_is_open: 1 },
          { symbol: "1HZ10V", display_name: "Volatility 10 (1s) Index", pip: 0.001, exchange_is_open: 1 },
          { symbol: "stpRNG2", display_name: "Step Index 2", pip: 0.001, exchange_is_open: 1 },
          { symbol: "JD10", display_name: "Jump 10 Index", pip: 0.01, exchange_is_open: 1 },
          { symbol: "EURUSD", display_name: "EUR/USD", pip: 0.00001, exchange_is_open: 1 },
        ],
      };
    } else if (request.balance) {
      response = { msg_type: "balance", balance: { balance: 1000, currency: "USD", loginid: MockWebSocket.currentLoginId } };
    } else if (request.proposal) {
      response = {
        msg_type: "proposal",
        subscription: { id: `proposal-sub-${String(reqId)}` },
        proposal: { id: `proposal-${String(reqId)}`, ask_price: request.amount, payout: Number(request.amount) * 1.95, spot: 100.123 },
      };
    } else if (request.buy) {
      response = { msg_type: "buy", buy: { contract_id: 12345, buy_price: 1 } };
    } else if (request.proposal_open_contract) {
      response = { msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: request.contract_id, status: "open", entry_spot: 100.123 } };
    } else if (request.ticks_history) {
      response = { msg_type: "history", history: { symbol: request.ticks_history, prices: [100.121, 100.122], times: [1_700_000_000, 1_700_000_001] } };
    } else if (request.ticks) {
      response = { msg_type: "tick", subscription: { id: `tick-sub-${String(reqId)}` }, tick: { symbol: request.ticks, quote: 100.123, epoch: 1_700_000_002 } };
    } else {
      response = { msg_type: "forget", forget: 1 };
    }

    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ ...response, req_id: reqId }) } as MessageEvent));
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ type: "close" } as CloseEvent);
  }

  serverClose(): void {
    this.close();
  }
}

const clients: DerivClient[] = [];
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let failAccounts = false;
let invalidOtpUrl = false;
let failOtpAccount = "";
let otpSequence = 0;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function eventOnce<K extends keyof DerivClientEvents>(client: DerivClient, event: K): Promise<DerivClientEvents[K]> {
  return new Promise((resolve) => {
    const off = client.on(event, (payload) => {
      off();
      resolve(payload);
    });
  });
}

beforeEach(() => {
  MockWebSocket.instances = [];
  MockWebSocket.failHandshake = false;
  MockWebSocket.currentLoginId = "VRTC100";
  failAccounts = false;
  invalidOtpUrl = false;
  failOtpAccount = "";
  otpSequence = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(headers.get("Deriv-App-ID")).toBe("1234");
    if (url.pathname === "/trading/v1/options/accounts") {
      if (failAccounts) return jsonResponse({ errors: [{ status: 401, code: "Unauthorized", message: "Rejected test-token" }], meta: {} }, 401);
      return jsonResponse({
        data: [
          { account_id: "VRTC100", account_type: "demo", balance: 1000, currency: "USD", group: "row", status: "active" },
          { account_id: "CR100", account_type: "real", balance: 250, currency: "USD", group: "row", status: "active" },
        ],
        meta: {},
      });
    }
    const accountId = decodeURIComponent(url.pathname.split("/")[5] ?? "");
    if (accountId === failOtpAccount) return jsonResponse({ errors: [{ status: 400, code: "AccountNotFound", message: "Account unavailable" }], meta: {} }, 400);
    const kind = accountId === "CR100" ? "real" : "demo";
    otpSequence += 1;
    return jsonResponse({ data: { url: invalidOtpUrl ? "https://example.com/socket" : `wss://api.derivws.com/trading/v1/options/ws/${kind}?otp=otp-${otpSequence}` }, meta: {} });
  });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clearCredentials();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Deriv API boundaries", () => {
  it("allows only the requested synthetic-index families", () => {
    for (const symbol of ["R_10", "R_100", "1HZ50V", "stpRNG", "stpRNG2", "stpRNG12", "JD100"]) {
      expect(familyForSymbol(symbol)).not.toBeNull();
    }
    for (const symbol of ["", "R_20", "JD1", "stpRNGX", "EURUSD", "cryptoBTC"]) {
      expect(familyForSymbol(symbol)).toBeNull();
    }
    expect(redactSecret("token abc123 failed", "abc123")).toBe("token [redacted] failed");
  });

  it("requires a new numeric Options API App ID", async () => {
    const client = new DerivClient();
    clients.push(client);
    await expect(client.connect("test-token", "")).rejects.toThrow(/App ID/i);
    await expect(client.connect("test-token", "1089")).rejects.toThrow(/legacy registry ID/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discovers accounts, opens an OTP session, and loads symbols and balance", async () => {
    const client = new DerivClient();
    clients.push(client);
    const authorized = eventOnce(client, "authorized");
    const accounts = eventOnce(client, "accounts");
    const symbols = eventOnce(client, "symbols");
    const balance = eventOnce(client, "balance");

    await client.connect("test-token", "1234");

    await expect(authorized).resolves.toEqual({ loginId: "VRTC100", name: "Demo VRTC100" });
    await expect(accounts).resolves.toEqual([
      expect.objectContaining({ loginid: "VRTC100", kind: "demo" }),
      expect.objectContaining({ loginid: "CR100", kind: "real" }),
    ]);
    await expect(symbols).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "R_100", family: "continuous" }),
      expect.objectContaining({ symbol: "stpRNG2", family: "step" }),
      expect.objectContaining({ symbol: "JD10", family: "jump" }),
    ]));
    expect((await symbols).some((item) => item.symbol === "EURUSD")).toBe(false);
    await expect(balance).resolves.toEqual({ currency: "USD", balance: 1000, loginId: "VRTC100", kind: "demo" });
    expect(MockWebSocket.instances[0].url).toBe("wss://api.derivws.com/trading/v1/options/ws/demo?otp=otp-1");
    expect(MockWebSocket.instances[0].sent.some((request) => request.authorize)).toBe(false);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/trading/v1/options/accounts",
      "/trading/v1/options/accounts/VRTC100/otp",
    ]);
  });

  it("clears credentials and redacts the token when REST authorization fails", async () => {
    failAccounts = true;
    const client = new DerivClient();
    clients.push(client);
    await expect(client.connect("test-token", "1234")).rejects.toThrow("Rejected [redacted]");
    expect((client as unknown as { token: string }).token).toBe("");
    expect(client.connected).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("rejects an untrusted OTP URL without opening a socket", async () => {
    invalidOtpUrl = true;
    const client = new DerivClient();
    clients.push(client);
    await expect(client.connect("test-token", "1234")).rejects.toThrow(/invalid WebSocket URL/i);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect((client as unknown as { token: string }).token).toBe("");
  });

  it("clears credentials when the WebSocket handshake fails", async () => {
    MockWebSocket.failHandshake = true;
    const client = new DerivClient();
    clients.push(client);
    await expect(client.connect("test-token", "1234")).rejects.toThrow(/Could not reach Deriv/i);
    expect((client as unknown as { token: string }).token).toBe("");
    expect(client.connected).toBe(false);
  });

  it("parses a live proposal, buys that exact quote, and tracks its contract", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token", "1234");
    const proposalEvent = eventOnce(client, "proposal");
    await client.subscribeProposal({ symbol: "R_100", contractType: "DIGITMATCH", barrier: "5", duration: 1, amount: 1, currency: "USD" });
    const proposal = await proposalEvent;
    expect(proposal).toMatchObject({ symbol: "R_100", contractType: "DIGITMATCH", barrier: "5", duration: 1, askPrice: 1, payout: 1.95 });

    const bought = eventOnce(client, "bought");
    await expect(client.buyProposal(proposal)).resolves.toBe(12345);
    await expect(bought).resolves.toEqual({ contractId: 12345, proposal, buyPrice: 1 });
    const buyRequest = MockWebSocket.instances[0].sent.find((request) => request.buy);
    expect(buyRequest).toMatchObject({ buy: proposal.id, price: proposal.askPrice });
  });

  it("rejects stale proposals before sending a purchase", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token", "1234");
    const stale: Proposal = {
      id: "stale", contractType: "CALL", symbol: "R_100", duration: 3, durationUnit: "t",
      askPrice: 1, payout: 1.95, spot: 100, currency: "USD", receivedAt: Date.now() - 5_000,
    };
    await expect(client.buyProposal(stale)).rejects.toThrow(/expired/i);
    expect(MockWebSocket.instances[0].sent.some((request) => request.buy)).toBe(false);
  });

  it("opens a fresh real-account OTP session when switching accounts", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token", "1234");
    const balance = eventOnce(client, "balance");
    await client.switchAccount("CR100");
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toBe("wss://api.derivws.com/trading/v1/options/ws/real?otp=otp-2");
    expect(MockWebSocket.instances[1].sent.some((request) => request.authorize)).toBe(false);
    await expect(balance).resolves.toEqual({ currency: "USD", balance: 1000, loginId: "CR100", kind: "real" });
  });

  it("restores the previous account when an account switch fails", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token", "1234");
    failOtpAccount = "CR100";
    await expect(client.switchAccount("CR100")).rejects.toThrow(/Account unavailable/i);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain("/ws/demo?otp=otp-2");
    expect(client.connectionStatus).toBe("connected");
  });

  it("requests a fresh OTP and resubscribes after a server disconnect", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token", "1234");
    vi.useFakeTimers();
    MockWebSocket.instances[0].serverClose();
    expect(client.connectionStatus).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain("/ws/demo?otp=otp-2");
    expect(MockWebSocket.instances[1].sent.some((request) => request.balance && request.subscribe === 1)).toBe(true);
    expect(client.connectionStatus).toBe("connected");
  });
});
