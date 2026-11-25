/**
 * Credential persistence.
 *
 * Default is sessionStorage: the token survives reloads in this tab only.
 * "Remember on this device" opts into localStorage.
 * Nothing is ever bundled, committed, logged, or sent anywhere except Deriv.
 */

export interface StoredCredentials {
  token: string;
  appId: string;
  remember: boolean;
}

const KEY = "deriv.quant.credentials";

function storageFor(remember: boolean): Storage | null {
  try {
    return remember ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: StoredCredentials): void {
  clearStoredCredentials();
  try {
    storageFor(credentials.remember)?.setItem(
      KEY,
      JSON.stringify({ token: credentials.token, appId: credentials.appId }),
    );
  } catch {
    /* storage can be unavailable (private mode, quota) — the session still works */
  }
}

export function loadStoredCredentials(): StoredCredentials | null {
  for (const remember of [true, false]) {
    try {
      const raw = storageFor(remember)?.getItem(KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { token?: unknown; appId?: unknown };
      const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
      const appId = typeof parsed.appId === "string" ? parsed.appId.trim() : "";
      if (token && appId) return { token, appId, remember };
    } catch {
      /* ignore malformed entries */
    }
  }
  return null;
}

export function clearStoredCredentials(): void {
  for (const remember of [true, false]) {
    try {
      storageFor(remember)?.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}
