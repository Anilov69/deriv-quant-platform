"use client";
import { useState } from "react";
import { signIn, signOut } from "@/services/session";
import { useStore } from "@/store/useStore";

export function LoginDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useStore((s) => s.authStatus);
  const error = useStore((s) => s.authError);
  const storedAppId = useStore((s) => s.appId);
  const accounts = useStore((s) => s.accounts);
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState(storedAppId);
  const [show, setShow] = useState(false);

  if (!open) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await signIn(token.trim(), appId.trim());
    setToken("");
    if (useStore.getState().authStatus === "signed-in") onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside className="h-full w-full max-w-md overflow-y-auto border-l border-slate-800 bg-slate-950 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-bold">Deriv connection</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close">✕</button>
        </div>

        {status === "signed-in" ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">Connected. {accounts.length} account(s) available:</p>
            <ul className="space-y-1 text-sm">
              {accounts.map((a) => (
                <li key={a.account_id} className="num flex justify-between rounded border border-slate-800 px-3 py-1.5">
                  <span>{a.account_id}</span>
                  <span className={a.account_type === "real" ? "text-red-300" : "text-emerald-300"}>{a.account_type.toUpperCase()} · {a.currency}</span>
                </li>
              ))}
            </ul>
            <button className="btn-ghost w-full" onClick={() => { signOut(); onClose(); }}>Sign out & forget token</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" autoComplete="off">
            <div>
              <label className="label" htmlFor="pat">Personal Access Token</label>
              <div className="mt-1 flex gap-2">
                <input
                  id="pat"
                  className="input num"
                  type={show ? "text" : "password"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="pat_…"
                  required
                />
                <button type="button" className="btn-ghost !px-2 text-xs" onClick={() => setShow((v) => !v)}>{show ? "Hide" : "Show"}</button>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="appid">App ID</label>
              <input id="appid" className="input num mt-1" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="Your Deriv App ID" required />
              <p className="mt-1 text-xs text-slate-500">Required with PAT authentication (sent as the <code>Deriv-App-ID</code> header).</p>
            </div>
            {status === "error" && <p className="rounded border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300" role="alert">{error}</p>}
            <button className="btn-primary w-full" disabled={status === "validating" || !token || !appId}>
              {status === "validating" ? "Validating…" : "Connect"}
            </button>
            <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs leading-relaxed text-slate-400">
              <p><b className="text-slate-200">Where to get these:</b> create an app and a Personal Access Token with the <b>trade</b> scope in the Deriv developer dashboard (developers.deriv.com).</p>
              <p><b className="text-slate-200">Security:</b> the token is kept only in this tab&apos;s memory, sent only to api.derivws.com, never stored or logged. Reloading the page signs you out.</p>
              <p>You start on your <b className="text-emerald-300">Demo</b> account. Switching to Real requires an explicit confirmation.</p>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
