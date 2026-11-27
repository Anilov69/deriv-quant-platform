import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DerivSession } from "@/deriv";

const TOKEN = "test-token-1234";
const APP_ID = "12aBc34";
const OTP_URL = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc123";

const ACCOUNTS = {
  data: [
    { account_id: "VRTC900001", currency: "USD", account_type: "demo", name: "Demo USD" },
    { account_id: "CR900001", currency: "USD", account_type: "real", name: "Real USD" },
  ],
};

const SYMBOLS = [
  { underlying_symbol: "R_100", underlying_symbol_name: "Volatility 100 Index", pip_size: 0.01 },
  { underlying_symbol: "JD10", underlying_symbol_name: "Jump 10 Index", pip_size: 0.01 },
  { underlying_symbol: "stpRNG2", underlying_symbol_name: "Step Index 2", pip_size: 0.1 },
  { underlying_symbol: "EURUSD", underlying_symbol_name: "EUR/USD", pip_size: 0.00001 },
];

class MockSocket {
  static OPEN = 1;
  static instances: MockSocket[] = [];

  url: string;
  readyState = 1;
  sent: Record<string, any>[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(raw: string): void {
    const payload = JSON.parse(raw) as Record<string, any>;
    this.sent.push(payload);
    setTimeout(() => this.reply(payload), 0);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  private reply(payload: Record<string, any>): void {
    const req = { req_id: payload.req_id };
    if (payload.active_symbols !== undefined) {
      this.emit({ msg_type: "active_symbols", active_symbols: SYMBOLS, ...req });
    } else if (payload.balance !== undefined) {
      this.emit({ msg_type: "balance", balance: { balance: 1000, currency: "USD" }, ...req });
    } else if (payload.forget !== undefined) {
      this.emit({ forget: 1, ...req });
    } else if (payload.ticks !== undefined) {
      this.emit({ msg_type: "tick", tick: { epoch: 1, quote: 446.62 }, subscription: { id: "tick-1" }, ...req });
    } else if (payload.ticks_history !== undefined) {
      this.emit({ history: { prices: [446.6, 446.61, 446.62], times: [1, 2, 3] }, ...req });
    } else if (payload.contracts_for !== undefined) {
      this.emit({
        contracts_for: {
          available: [
            {
              contract_type: "ONETOUCH",
              contract_category: "touch",
              min_contract_duration: "15s",
              max_contract_duration: "60s",
              expiry_type: "intraday",
              barrier: "+0.14",
              default_stake: 0.35,
              pip_size: 0.01,
              underlying_symbol: payload.contracts_for,
            },
            {
              contract_type: "DIGITMATCH",
              contract_category: "digits",
              min_contract_duration: "1t",
              max_contract_duration: "10t",
              expiry_type: "tick",
              barrier: null,
              default_stake: 1,
              pip_size: 0.01,
              underlying_symbol: payload.contracts_for,
            },
          ],
        },
        ...req,
      });
    } else if (payload.proposal !== undefined) {
      this.emit({ proposal: { id: "quote-1", ask_price: 1, payout: 8.93, spot: 446.62 }, ...req });
    } else if (payload.buy !== undefined) {
      this.emit({ buy: { contract_id: 777, buy_price: payload.price }, ...req });
    } else if (payload.proposal_open_contract !== undefined) {
      this.emit({
        msg_type: "proposal_open_contract",
        proposal_open_contract: { contract_id: payload.contract_id, status: "open", profit: 0 },
        ...req,
      });
    } else {
      this.emit({ msg_type: "unknown", ...req });
    }
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let sessions: DerivSession[] = [];

beforeEach(() => {
  calls = [];
  sessions = [];
  MockSocket.instances = [];
  vi.stubGlobal("WebSocket", MockSocket);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.endsWith("/accounts")
      ? ACCOUNTS
      : url.endsWith("/otp")
        ? { data: { url: OTP_URL } }
        : { message: "unexpected" };
    return new Response(JSON.stringify(body), { status: 200 });
  });
});

afterEach(() => {
  for (const session of sessions) session.disconnect();
  vi.unstubAllGlobals();
});

async function connect(): Promise<{ session: DerivSession; socket: MockSocket }> {
  const session = new DerivSession();
  sessions.push(session);
  await session.connect(TOKEN, APP_ID);
  return { session, socket: MockSocket.instances[0] };
}

describe("authentication", () => {
  it("exchanges the token for a single-use socket without an authorize frame", async () => {
    const { socket } = await connect();
    expect(socket.url).toBe(OTP_URL);
    expect(socket.sent.some((frame) => "authorize" in frame)).toBe(false);
    expect(socket.sent.some((frame) => "loginid" in frame)).toBe(false);
  });

  it("sends the token as a bearer header and the App ID as its own header", async () => {
    await connect();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://api.derivws.com/trading/v1/options/accounts");
    expect(calls[0].init.method).toBe("GET");
    expect(headers.Authorization).toBe("Bearer " + TOKEN);
    expect(headers["Deriv-App-ID"]).toBe(APP_ID);
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("requests the OTP with no body and no content type", async () => {
    await connect();
    const otp = calls.find((call) => call.url.endsWith("/otp"));
    expect(otp).toBeDefined();
    expect(otp?.init.method).toBe("POST");
    expect(otp?.init.body).toBeUndefined();
    expect((otp?.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("prefers the demo account and reports both", async () => {
    const session = new DerivSession();
    sessions.push(session);
    const accounts = await session.connect(TOKEN, APP_ID);
    expect(accounts.map((account) => account.kind)).toEqual(["demo", "real"]);
    expect(session.accountId).toBe("VRTC900001");
  });
});

describe("requests", () => {
  it("asks for symbols without the removed product_type filter", async () => {
    const { session, socket } = await connect();
    await session.loadSymbols();
    const frame = socket.sent.find((item) => item.active_symbols !== undefined);
    expect(frame?.active_symbols).toBe("brief");
    expect(frame).not.toHaveProperty("product_type");
  });

  it("normalises the New API symbol fields and drops non-synthetic markets", async () => {
    const { session } = await connect();
    const symbols = await session.loadSymbols();
    expect(symbols.map((symbol) => symbol.symbol).sort()).toEqual(["JD10", "R_100", "stpRNG2"]);
    const step = symbols.find((symbol) => symbol.symbol === "stpRNG2");
    expect(step).toMatchObject({ name: "Step Index 2", family: "step", pip: 0.1 });
  });

  it("requests contracts_for with only the symbol and parses duration units", async () => {
    const { session, socket } = await connect();
    const offers = await session.contractsFor("R_100");
    const frame = socket.sent.find((item) => item.contracts_for !== undefined);
    expect(frame).toMatchObject({ contracts_for: "R_100" });
    expect(Object.keys(frame ?? {}).sort()).toEqual(["contracts_for", "req_id"]);
    expect(frame).not.toHaveProperty("currency");
    expect(frame).not.toHaveProperty("product_type");
    expect(offers.find((offer) => offer.contractType === "ONETOUCH")).toMatchObject({
      minContractDuration: "15s",
      maxContractDuration: "60s",
      expiryType: "intraday",
    });
  });

  it("sends the ONETOUCH duration unit and defaults other pages to ticks", async () => {
    const { session, socket } = await connect();
    await session.quote({ symbol: "R_100", contract: "ONETOUCH", barrier: "+0.14", duration: 30, durationUnit: "s", stake: 0.35, currency: "USD" });
    await session.quote({ symbol: "R_100", contract: "DIGITMATCH", barrier: "3", duration: 1, stake: 1, currency: "USD" });
    const frames = socket.sent.filter((item) => item.proposal !== undefined);
    expect(frames[0]).toMatchObject({ duration: 30, duration_unit: "s" });
    expect(frames[1]).toMatchObject({ duration: 1, duration_unit: "t" });
  });

  it("quotes with underlying_symbol and buys that exact quote at a numeric price", async () => {
    const { session, socket } = await connect();
    const quote = await session.quote({ symbol: "R_100", contract: "DIGITMATCH", barrier: "3", duration: 1, stake: 1, currency: "USD" });
    expect(quote).toEqual({ id: "quote-1", ask: 1, payout: 8.93 });
    const frame = socket.sent.find((item) => item.proposal !== undefined);
    expect(frame?.underlying_symbol).toBe("R_100");
    expect(frame?.contract_type).toBe("DIGITMATCH");
    expect(frame?.barrier).toBe("3");
    expect(frame).not.toHaveProperty("symbol");

    const contractId = await session.buy(quote.id, quote.ask);
    expect(contractId).toBe(777);
    const buyFrame = socket.sent.find((item) => item.buy !== undefined);
    expect(buyFrame?.price).toBe(1);
    expect(typeof buyFrame?.price).toBe("number");
  });

  it("paces proposals so a batch cannot trip Deriv's burst limit", async () => {
    const { session, socket } = await connect();
    const started = Date.now();
    await Promise.all([
      session.quote({ symbol: "R_100", contract: "DIGITMATCH", barrier: "3", duration: 1, stake: 1, currency: "USD" }),
      session.quote({ symbol: "R_100", contract: "DIGITDIFF", barrier: "3", duration: 1, stake: 1, currency: "USD" }),
      session.quote({ symbol: "R_100", contract: "DIGITODD", duration: 1, stake: 1, currency: "USD" }),
    ]);
    const proposals = socket.sent.filter((item) => item.proposal !== undefined);
    expect(proposals).toHaveLength(3);
    // Two forced gaps between three proposals, even though all were requested at once.
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });

  it("streams ticks and seeds history for the same symbol", async () => {
    const { session } = await connect();
    const ticks: number[] = [];
    session.onTick = (tick) => ticks.push(tick.quote);
    await session.subscribeTicks("R_100");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ticks).toEqual([446.62]);
    const history = await session.history("R_100", 3);
    expect(history.map((tick) => tick.quote)).toEqual([446.6, 446.61, 446.62]);
  });

  it("surfaces a Deriv error to the caller instead of hanging", async () => {
    vi.stubGlobal("fetch", async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: "Invalid token" }), { status: 401 });
    });
    const session = new DerivSession();
    sessions.push(session);
    await expect(session.connect("bad", APP_ID)).rejects.toThrow(/token or App ID/i);
  });
});