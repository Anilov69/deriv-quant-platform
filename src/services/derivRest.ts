import type { AccountKind, DerivAccount } from "@/types";

/**
 * Deriv's current REST + OTP transport.
 *
 * The legacy flow (wss://ws.derivws.com/websockets/v3 + {"authorize": token}) rejects
 * personal access tokens and non-numeric App IDs. The supported path is:
 *   1. GET  /trading/v1/options/accounts            -> account list
 *   2. POST /trading/v1/options/accounts/{id}/otp   -> single-use WebSocket URL
 *   3. new WebSocket(data.url)                      -> already authenticated, no authorize frame
 *
 * Both endpoints allow browser CORS for this app's origin, so everything stays client-side.
 */

const REST_BASE = "https://api.derivws.com";
const REQUEST_TIMEOUT_MS = 15_000;

export interface DerivCredentials {
  token: string;
  appId: string;
}

export class DerivRestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "DerivRestError";
    this.code = code;
    this.status = status;
  }
}

/** App IDs are alphanumeric; numeric-only validation is what broke earlier builds. */
export function isValidAppId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.trim());
}

function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

async function call(
  credentials: DerivCredentials,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${REST_BASE}${path}`, {
      method: init.method,
      body: init.body,
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Deriv-App-ID": credentials.appId,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = { message: text.slice(0, 200) };
      }
    }
    if (!response.ok) {
      const error = payload.error as { code?: string; message?: string } | undefined;
      const message = typeof payload.message === "string" ? payload.message : error?.message;
      throw new DerivRestError(
        error?.code ?? `Http${response.status}`,
        response.status === 401
          ? "Deriv rejected the token or App ID (401). Verify both and try again."
          : message ?? `Deriv rejected the request (HTTP ${response.status}).`,
        response.status,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof DerivRestError) throw error;
    if ((error as Error)?.name === "AbortError") {
      throw new DerivRestError("Timeout", "Deriv did not answer in time. Try again.");
    }
    throw new DerivRestError("NetworkError", "Could not reach Deriv. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}

function unwrap(payload: Record<string, unknown>): unknown {
  return payload.data ?? payload;
}

function normalizeAccount(raw: unknown): DerivAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const loginid = String(pick(item, ["account_id", "accountId", "loginid", "login_id", "id"]) ?? "").trim();
  if (!loginid) return null;
  const rawType = String(pick(item, ["account_type", "accountType", "type", "account_kind"]) ?? "").toLowerCase();
  const kind: AccountKind =
    loginid.toUpperCase().startsWith("VRTC") || rawType.includes("demo") || rawType.includes("virtual") ? "demo" : "real";
  const currency = String(pick(item, ["currency", "currency_code"]) ?? "USD").toUpperCase();
  const name = String(
    pick(item, ["account_name", "accountName", "name", "landing_company", "landing_company_name"]) ?? loginid,
  );
  return { loginid, currency, kind, name };
}

export async function fetchDerivAccounts(credentials: DerivCredentials): Promise<DerivAccount[]> {
  const payload = await call(credentials, "/trading/v1/options/accounts", { method: "GET" });
  const container = unwrap(payload) as Record<string, unknown> | unknown[];
  const list = Array.isArray(container)
    ? container
    : Array.isArray(container?.accounts)
      ? container.accounts
      : [];
  return list.map(normalizeAccount).filter((account): account is DerivAccount => account !== null);
}

export async function requestDerivOtp(credentials: DerivCredentials, accountId: string): Promise<string> {
  const payload = await call(credentials, `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const data = unwrap(payload) as Record<string, unknown>;
  const url = String(
    (typeof data === "object" ? pick(data, ["url", "otp_url", "websocket_url", "ws_url"]) : undefined) ??
      pick(payload, ["url", "otp_url"]) ??
      "",
  ).trim();
  if (!/^wss:\/\//i.test(url)) {
    throw new DerivRestError("OtpMissing", "Deriv did not return a WebSocket URL for this account.");
  }
  return url;
}
