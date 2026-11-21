/**
 * Deriv REST helpers (https://api.derivws.com). Used only for the PAT flow:
 *   GET  /trading/v1/options/accounts          → list demo/real accounts
 *   POST /trading/v1/options/accounts/{id}/otp → one-time WebSocket URL for that account
 * PAT auth requires both `Authorization: Bearer <PAT>` and `Deriv-App-ID`.
 * The token is passed in per call and never logged or persisted here.
 */
export const REST_BASE = "https://api.derivws.com";

export interface DerivAccount {
  account_id: string;
  balance: number;
  currency: string;
  group: string;
  status: "active" | "inactive";
  account_type: "demo" | "real";
}

export class DerivRestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, token: string, appId: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(REST_BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": appId,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new DerivRestError("Network error — could not reach Deriv.", 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body?.errors?.[0];
    const msg =
      res.status === 401
        ? "Token rejected. Check your Personal Access Token and App ID."
        : res.status === 403
          ? "Token is valid but lacks the 'trade' scope."
          : res.status === 429
            ? "Rate limited by Deriv — wait a moment and retry."
            : e?.message || `Deriv API error (${res.status})`;
    throw new DerivRestError(msg, res.status, e?.code);
  }
  return body as T;
}

export async function getAccounts(token: string, appId: string): Promise<DerivAccount[]> {
  const r = await call<{ data?: DerivAccount[] }>("/trading/v1/options/accounts", token, appId);
  return r.data ?? [];
}

export async function getOtpUrl(token: string, appId: string, accountId: string): Promise<string> {
  const r = await call<{ data?: { url?: string } }>(
    `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    token,
    appId,
    { method: "POST", body: "{}" },
  );
  if (!r.data?.url) throw new DerivRestError("Deriv did not return a WebSocket URL.", 500);
  return r.data.url;
}
