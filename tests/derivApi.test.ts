import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DerivClient, familyForSymbol, redactSecret, type DerivClientEvents } from "../src/services/derivApi";
import type { Proposal } from "../src/types";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static failAuthorization = false;
  static currentLoginId = "VRTC100";

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

  send(raw: string): void {
    const request = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(request);
    const reqId = request.req_id;
    let response: Record<string, unknown>;

    if (request.authorize) {
      if (!MockWebSocket.failAuthorization) MockWebSocket.currentLoginId = String(request.account ?? "VRTC100");
      response = MockWebSocket.failAuthorization
        ? { error: { code: "InvalidToken", message: `Rejected ${String(request.authorize)}` } }
        : {
          msg_type: "authorize",
          authorize: {
            loginid: String(request.account ?? "VRTC100"),
            fullname: "Test account",
            account_list: [
              { loginid: "VRTC100", currency: "USD", account_name: "Demo" },
              { loginid: "CR100", currency: "USD", account_name: "Real" },
            ],
          },
        };
    } else if (request.account_list) {
      response = {
        msg_type: "account_list",
        account_list: [
          { loginid: "VRTC100", currency: "USD", account_name: "Demo" },
          { loginid: "CR100", currency: "USD", account_name: "Real" },
        ],
      };
    } else if (request.active_symbols) {
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
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ type: "close" } as CloseEvent);
  }
}

const clients: DerivClient[] = [];

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
  MockWebSocket.failAuthorization = false;
  MockWebSocket.currentLoginId = "VRTC100";
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clearCredentials();
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

  it("authorizes, loads accounts and supported symbols, and resolves the balance stream", async () => {
    const client = new DerivClient();
    clients.push(client);
    const authorized = eventOnce(client, "authorized");
    const accounts = eventOnce(client, "accounts");
    const symbols = eventOnce(client, "symbols");
    const balance = eventOnce(client, "balance");

    await client.connect("test-token", "1234");

    await expect(authorized).resolves.toEqual({ loginId: "VRTC100", name: "Test account" });
    await expect(accounts).resolves.toHaveLength(2);
    await expect(symbols).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "R_100", family: "continuous" }),
      expect.objectContaining({ symbol: "stpRNG2", family: "step" }),
      expect.objectContaining({ symbol: "JD10", family: "jump" }),
    ]));
    expect((await symbols).some((item) => item.symbol === "EURUSD")).toBe(false);
    await expect(balance).resolves.toEqual({ currency: "USD", balance: 1000, loginId: "VRTC100" });
    expect(MockWebSocket.instances[0].url).toContain("app_id=1234");
  });

  it("clears credentials and redacts the token when authorization fails", async () => {
    MockWebSocket.failAuthorization = true;
    const client = new DerivClient();
    clients.push(client);
    await expect(client.connect("secret-token")).rejects.toThrow("Rejected [redacted]");
    expect((client as unknown as { token: string }).token).toBe("");
    expect(client.connected).toBe(false);
  });

  it("parses a live proposal, buys that exact quote, and tracks its contract", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token");
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
    await client.connect("test-token");
    const stale: Proposal = {
      id: "stale", contractType: "CALL", symbol: "R_100", duration: 3, durationUnit: "t",
      askPrice: 1, payout: 1.95, spot: 100, currency: "USD", receivedAt: Date.now() - 5_000,
    };
    await expect(client.buyProposal(stale)).rejects.toThrow(/expired/i);
    expect(MockWebSocket.instances[0].sent.some((request) => request.buy)).toBe(false);
  });

  it("selects and verifies the requested account before resubscribing balance", async () => {
    const client = new DerivClient();
    clients.push(client);
    await client.connect("test-token");
    const balance = eventOnce(client, "balance");
    await client.switchAccount("CR100");
    expect(MockWebSocket.instances[0].sent.some((request) => request.authorize && request.account === "CR100")).toBe(true);
    expect((await balance).loginId).toBe("CR100");
  });
});
