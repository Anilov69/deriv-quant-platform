"use client";

import { FormEvent, useState } from "react";
import { KeyRound, LockKeyhole, X } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";

export function AuthDrawer({ platform }: { platform: QuantPlatform }) {
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("");
  if (!platform.authOpen) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim() || !appId.trim()) return;
    try {
      await platform.connect(token, appId);
      setToken("");
      setAppId("");
    } catch {
      setToken("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/75 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !platform.authBusy) platform.setAuthOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="auth-title" className="h-full w-full max-w-md overflow-y-auto border-l border-white/10 bg-[#0c1320] p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300"><KeyRound size={20} /></div>
          <button aria-label="Close authentication" onClick={() => platform.setAuthOpen(false)} className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white"><X size={18} /></button>
        </div>
        <h2 id="auth-title" className="mt-6 text-xl font-semibold text-white">Connect your Deriv account</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">The token is sent directly to Deriv for account discovery and a one-time WebSocket session. It stays in memory for this tab only.</p>

        <div className="mt-6 space-y-3 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4 text-xs leading-5 text-slate-300">
          <div className="flex items-center gap-2 font-semibold text-emerald-300"><LockKeyhole size={14} /> Session-only credential handling</div>
          <p>No app server, localStorage, cookies, analytics, or console logging contain your PAT. Closing or refreshing the tab clears access.</p>
          <p>Create a new PAT application with <span className="font-mono text-slate-200">read</span> and <span className="font-mono text-slate-200">trade</span> scopes at <a className="text-cyan-300 underline" href="https://developers.deriv.com" target="_blank" rel="noreferrer">developers.deriv.com</a>. Legacy registry App IDs, including 1089, do not work with the Options API.</p>
        </div>

        <form onSubmit={submit} className="mt-7 space-y-5">
          <label className="block text-xs font-medium text-slate-300">
            Personal Access Token
            <input
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste your Deriv PAT"
              className="mt-2 w-full rounded-lg border border-white/15 bg-slate-950/70 px-3 py-3 font-mono text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/10"
            />
          </label>
          <label className="block text-xs font-medium text-slate-300">
            Options API App ID
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]+"
              required
              value={appId}
              onChange={(event) => setAppId(event.target.value.replace(/\D/g, ""))}
              placeholder="New PAT application ID"
              className="mt-2 w-full rounded-lg border border-white/15 bg-slate-950/70 px-3 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/10"
            />
          </label>
          <button disabled={platform.authBusy || !token.trim() || !appId.trim()} type="submit" className="w-full rounded-lg bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">
            {platform.authBusy ? "Authorizing with Deriv…" : "Authorize & connect"}
          </button>
        </form>

        <div className="mt-6 border-t border-white/10 pt-5 text-xs leading-5 text-slate-500">
          The dashboard starts in a clearly marked simulation. Live proposals and purchases use the account selected in the header. Real trades always require a separate confirmation.
        </div>
        {platform.mode === "live" && (
          <button onClick={() => { platform.startSimulation(); platform.setAuthOpen(false); }} className="mt-5 w-full rounded-lg border border-white/10 px-4 py-2.5 text-xs text-slate-300 hover:bg-white/5">Disconnect & return to simulation</button>
        )}
      </section>
    </div>
  );
}
