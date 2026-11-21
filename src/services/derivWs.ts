/**
 * Resilient Deriv WebSocket client.
 *
 * - `req_id` correlation with promise-based `request()`.
 * - Persistent subscriptions that are transparently re-sent after reconnect.
 * - Exponential back-off reconnect (1 s → 30 s, ±20 % jitter). For trading
 *   sockets the URL provider is called again so a fresh OTP URL is used.
 * - `ping` every 5 s; round-trip time is exposed as latency (pings are outside
 *   Deriv's rate budgets).
 * - Client-side sliding-window rate limiter mirroring Deriv's per-minute budgets,
 *   plus automatic back-off on `RateLimit` errors for idempotent requests.
 */

type Json = Record<string, unknown>;
export type DerivMessage = Json & { msg_type?: string; req_id?: number; error?: { code: string; message: string } };
export type ConnState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export class DerivApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Deriv WebSocket rate budgets (per minute). See developers.deriv.com/docs/limits. */
const BUDGETS: Record<string, number> = { pricing: 360, balance: 100, portfolio: 30, other: 220 };
function budgetOf(msg: Json): keyof typeof BUDGETS {
  if ("proposal" in msg || "proposal_open_contract" in msg || "buy" in msg || "sell" in msg) return "pricing";
  if ("balance" in msg || "statement" in msg) return "balance";
  if ("portfolio" in msg || "profit_table" in msg) return "portfolio";
  return "other";
}

class RateLimiter {
  private sent: Record<string, number[]> = {};
  /** Milliseconds to wait before a message in this budget may be sent (keeps 10 % headroom). */
  delay(budget: string): number {
    const now = Date.now();
    const list = (this.sent[budget] = (this.sent[budget] ?? []).filter((t) => now - t < 60_000));
    const cap = Math.floor(BUDGETS[budget] * 0.9);
    return list.length < cap ? 0 : 60_000 - (now - list[0]) + 10;
  }
  record(budget: string) {
    (this.sent[budget] ??= []).push(Date.now());
  }
}

interface Pending {
  resolve: (m: DerivMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface Subscription {
  key: string;
  unsubscribe: () => void;
}

interface SubEntry {
  request: Json;
  onMessage: (m: DerivMessage) => void;
  onError?: (e: DerivApiError) => void;
  /** Server-side subscription id of the current connection (for `forget`). */
  serverId?: string;
  reqId?: number;
}

export interface DerivSocketOptions {
  /** Returns the URL to (re)connect to. Called on every (re)connect. */
  url: () => Promise<string> | string;
  name: string;
  onState?: (s: ConnState) => void;
  onLatency?: (ms: number) => void;
  /** Fatal auth failure (OTP rejected repeatedly): caller should re-authenticate. */
  onFatal?: (e: Error) => void;
}

export class DerivSocket {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, Pending>();
  private subs = new Map<string, SubEntry>();
  private limiter = new RateLimiter();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByUser = false;
  private openWaiters: (() => void)[] = [];
  state: ConnState = "idle";

  constructor(private opts: DerivSocketOptions) {}

  private setState(s: ConnState) {
    this.state = s;
    this.opts.onState?.(s);
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return this.waitOpen();
    this.setState(this.attempts ? "reconnecting" : "connecting");
    let url: string;
    try {
      url = await this.opts.url();
    } catch (e) {
      this.scheduleReconnect(e as Error);
      return this.waitOpen();
    }
    if (this.closedByUser) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setState("open");
      this.startPing();
      this.resubscribeAll();
      this.openWaiters.splice(0).forEach((f) => f());
    };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopPing();
      this.ws = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new DerivApiError("Disconnected", "Connection lost before a reply was received."));
      }
      this.pending.clear();
      for (const s of this.subs.values()) s.serverId = undefined;
      if (this.closedByUser) this.setState("closed");
      else this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows and drives reconnection */
    };
    return this.waitOpen();
  }

  private waitOpen(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((r) => this.openWaiters.push(r));
  }

  private scheduleReconnect(err?: Error) {
    if (this.closedByUser) return;
    this.attempts++;
    if (this.attempts > 8 && err) this.opts.onFatal?.(err);
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
    const delay = base * (0.8 + Math.random() * 0.4);
    this.setState("reconnecting");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPing();
    this.subs.clear();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState("closed");
  }

  private startPing() {
    this.stopPing();
    const ping = () => {
      const t0 = performance.now();
      this.request({ ping: 1 }, 10_000)
        .then(() => this.opts.onLatency?.(Math.round(performance.now() - t0)))
        .catch(() => {});
    };
    ping();
    this.pingTimer = setInterval(ping, 5000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private async rawSend(msg: Json) {
    const budget = msg.ping ? null : budgetOf(msg);
    if (budget) {
      let d = this.limiter.delay(budget);
      while (d > 0) {
        await new Promise((r) => setTimeout(r, d));
        d = this.limiter.delay(budget);
      }
      this.limiter.record(budget);
    }
    if (this.ws?.readyState !== WebSocket.OPEN) throw new DerivApiError("Disconnected", "Not connected.");
    this.ws.send(JSON.stringify(msg));
  }

  /** One-shot request/response. Rejects with DerivApiError on API error. */
  async request(msg: Json, timeoutMs = 15_000, retries = 2): Promise<DerivMessage> {
    await this.waitOpen();
    const id = this.reqId++;
    const p = new Promise<DerivMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DerivApiError("Timeout", "Deriv did not reply in time."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.rawSend({ ...msg, req_id: id });
    } catch (e) {
      const pend = this.pending.get(id);
      if (pend) clearTimeout(pend.timer);
      this.pending.delete(id);
      throw e;
    }
    try {
      return await p;
    } catch (e) {
      // `buy` is never retried automatically (would risk a duplicate contract).
      const idempotent = !("buy" in msg) && !("sell" in msg);
      if (idempotent && retries > 0 && e instanceof DerivApiError && e.code === "RateLimit") {
        await new Promise((r) => setTimeout(r, 2000 * (3 - retries)));
        return this.request(msg, timeoutMs, retries - 1);
      }
      throw e;
    }
  }

  /**
   * Persistent subscription identified by `key`. Re-sent automatically after
   * every reconnect. Calling again with the same key replaces the old one.
   */
  subscribe(key: string, request: Json, onMessage: (m: DerivMessage) => void, onError?: (e: DerivApiError) => void): Subscription {
    if (this.subs.has(key)) this.forgetKey(key);
    const entry: SubEntry = { request: { ...request, subscribe: 1 }, onMessage, onError };
    this.subs.set(key, entry);
    if (this.ws?.readyState === WebSocket.OPEN) void this.sendSub(entry);
    return { key, unsubscribe: () => this.forgetKey(key) };
  }

  private async sendSub(entry: SubEntry) {
    const id = this.reqId++;
    entry.reqId = id;
    try {
      await this.rawSend({ ...entry.request, req_id: id });
    } catch {
      /* will be re-sent on reconnect */
    }
  }

  private resubscribeAll() {
    for (const e of this.subs.values()) void this.sendSub(e);
  }

  forgetKey(key: string) {
    const e = this.subs.get(key);
    if (!e) return;
    this.subs.delete(key);
    if (e.serverId && this.ws?.readyState === WebSocket.OPEN) void this.request({ forget: e.serverId }).catch(() => {});
  }

  private handle(data: unknown) {
    let msg: DerivMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const id = msg.req_id;
    if (id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (msg.error) p.reject(new DerivApiError(msg.error.code, msg.error.message));
      else p.resolve(msg);
      return;
    }
    for (const e of this.subs.values()) {
      if (e.reqId !== id) continue;
      if (msg.error) {
        e.onError?.(new DerivApiError(msg.error.code, msg.error.message));
        if (msg.error.code === "RateLimit") setTimeout(() => this.subs.has(this.keyOf(e)) && void this.sendSub(e), 5000);
        return;
      }
      const sid = (msg.subscription as { id?: string } | undefined)?.id;
      if (sid) e.serverId = sid;
      e.onMessage(msg);
      return;
    }
  }

  private keyOf(entry: SubEntry): string {
    for (const [k, v] of this.subs) if (v === entry) return k;
    return "";
  }
}

export const PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
