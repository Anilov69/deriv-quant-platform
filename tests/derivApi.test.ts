import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DerivClient, familyForSymbol, redactSecret, type DerivClientEvents } from "../src/services/derivApi";
import { isValidAppId } from "../src/services/derivRest";
import type { Proposal } from "../src/types";

const ACCOUNTS = [
  { account_id: "VRTC900001", currency: "USD", account_type: "demo", account_name: "Demo account" },
  { account_id: "CR900001", currency: "USD", account_type: "real", account_name: "Real account" },
];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static currentLoginId = "VRTC900001";

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  /** Each OTP URL targets one account, so the mock derives the login from the socket path. */
  get loginId(): string {
    return this.url.includes("/ws/real") ? "CR900001" : "VRTC900001";
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
      response = { msg_type: "balance", balance: { balance: 1000, currency: "USD", loginid: this.loginId } };
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

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ type: "close" } as CloseEvent);
  }
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const clients: DerivClient[] = [];
const otpAccounts: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

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
  MockWebSocket.currentLoginId = "VRTC900001";
  otpAccounts.length = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.derivws.com/trading/v1/options/accounts") return response({ data: ACCOUNTS });
    const otp = /\/accounts\/([^/]+)\/otp$/.exec(url);
    if (otp) {
      expect(init?.method).toBe("POST");
      const accountId = decodeURIComponent(otp[1]);
      otpAccounts.push(accountId);
      const mode = accountId === "CR900001" ? "real" : "demo";
      return response({ data: { url: `wss://api.derivws.com/trading/v1/options/ws/${mode}?otp=${otpAccounts.length}` } });
    }
    return response({ message: "unexpected request" }, 404);
  });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clearCredentials();
  vi.unstubAllGlobals();
});

describe("Deriv API boundaries", () => {
  it("accepts alphanumeric App IDs and rejects malformed ones", () => {
    expect(isValidAppId("12aBc34")).toBe(true);
    expect(isValidAppId("1234")).toBe(true);
    expect(isValidAppId("my-app_01")).toBe(true);
    expect(isValidAppId("bad id!")).toBe(false);
    expect(isValidAppId("")).toBe(false);

    for (const symbol of ["R_10", "R_100", "1HZ50V", "stpRNG", "stpRNG2", "stpRNG12", "JD100"]) {
      expect(familyForSymbol(symbol)).not.toBeNull();
    }
    for (const symbol of ["", "R_20", "JD1", "stpRNGX", "EURUSD", "cryptoBTC"]) {
      expect(familyForSymbol(symbol)).toBeNull();
    }
    expect(redactSecret("token abc123 failed", "abc123")).toBe("token [redacted] failed");
  });

  it("fetches accounts over REST, opens the OTP socket, and never sends an authorize frame", async () => {
    const client = new DerivClient();
    clients.push(client);
    const authorized = eventOnce(client, "authorized");
    const accounts = eventOnce(client, "accounts");
    const symbols = eventOnce(client, "symbols");
    const balance = eventOnce(client, "balance");

    await client.connect("test-token", "12aBc34");

    await expect(authorized).resolves.toEqual({ loginId: "VRTC900001", name: "Demo account" });
    await expect(accounts).resolves.toHaveLength(2);
    await expect(symbols).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "R_100", family: "continuous" }),
      expect.objectContaining({ symbol: "stpRNG2", family: "step" }),
      expect.objectContaining({ symbol: "JD10", family: "jump" }),
    ]));
    expect((await symbols).some((item) => item.symbol === "EURUSD")).toBe(false);
    await expect(balance).resolves.toEqual({ currency: "USD", balance: 1000, loginId: "VRTC900001" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.derivws.com/trading/v1/options/accounts");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Deriv-App-ID"]).toBe("12aBc34");
    expect(MockWebSocket.instances[0].url).toContain("wss://api.derivws.com/trading/v1/options/ws/demo?otp=");
    expect(MockWebSocket.instances[0].sent.some((request) => "authorize" in request)).toBe(false);
  });

  it("rejects a malformed App ID before touching the network", async () => {
    const client = new DerivClient();
    clients.push(client);
    await expect(client.connect("test-token", "bad id!")).rejects.toThrow(/App ID/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("surfaces a 401 from Deriv and clears credentials", async () => {
    fetchMock.mockImplementationOnce(async () => response({ message: "Missing authorization header" }, 401));
    const client = new DerivClient();
    clients.push(client);
    await expect(client.connect("bad-token", "12aBc34")).rejects.toThrow(/401/);
    expect((client as unknown as { token: string }).token).toBe("");
    expect(client.connected).toBe(false);
  });

  it("parses a live proposal, buys that exact quote, and tracks its contract", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token", "12aBc34");
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
    await client.connect("test-token", "12aBc34");
    const stale: Proposal = {
      id: "stale", contractType: "CALL", symbol: "R_100", duration: 3, durationUnit: "t",
      askPrice: 1, payout: 1.95, spot: 100, currency: "USD", receivedAt: Date.now() - 5_000,
    };
    await expect(client.buyProposal(stale)).rejects.toThrow(/expired/i);
    expect(MockWebSocket.instances[0].sent.some((request) => request.buy)).toBe(false);
  });

  it("switches accounts by requesting a fresh OTP socket", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token", "12aBc34");
    const balance = eventOnce(client, "balance");
    await client.switchAccount("CR900001");

    expect(otpAccounts).toEqual(["VRTC900001", "CR900001"]);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain("/ws/real?otp=");
    expect(MockWebSocket.instances[1].sent.some((request) => "authorize" in request)).toBe(false);
    expect((await balance).loginId).toBe("CR900001");
  });
});
