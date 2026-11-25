import { FormEvent, useState } from "react";
import { KeyRound, LockKeyhole, ShieldCheck, X } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";
import { loadStoredCredentials } from "@/services/credentialStore";
import { isValidAppId } from "@/services/derivRest";

export function AuthDrawer({ platform }: { platform: QuantPlatform }) {
  const [stored] = useState(() => loadStoredCredentials());
  const [token, setToken] = useState(stored?.token ?? "");
  const [appId, setAppId] = useState(stored?.appId ?? "");
  const [remember, setRemember] = useState(stored?.remember ?? false);
  const [error, setError] = useState<string | null>(null);

  if (!platform.authOpen) return null;

  const appIdValid = isValidAppId(appId);
  const canSubmit = token.trim().length > 0 && appIdValid && !platform.authBusy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      await platform.connect(token, appId.trim(), remember);
      setToken("");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Deriv authorization failed.");
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
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Your token and App ID go straight to Deriv over HTTPS, which returns a single-use WebSocket URL for the selected account.
          No <span className="font-mono text-slate-300">authorize</span> frame and no legacy endpoint.
        </p>

        <div className="mt-6 space-y-3 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4 text-xs leading-5 text-slate-300">
          <div className="flex items-center gap-2 font-semibold text-emerald-300"><LockKeyhole size={14} /> Browser-only credential handling</div>
          <p>Nothing is bundled, committed, or sent to any server we own. By default the token lives in <span className="font-mono text-slate-200">sessionStorage</span> and disappears when this tab closes.</p>
          <p>Create the token in your Deriv API dashboard with <span className="font-mono text-slate-200">read</span> and <span className="font-mono text-slate-200">trade</span> permissions.</p>
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
            App ID
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              required
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="e.g. 12aBc34 (letters or digits)"
              aria-invalid={appId.length > 0 && !appIdValid}
              className={`mt-2 w-full rounded-lg border bg-slate-950/70 px-3 py-3 font-mono text-sm text-white outline-none transition placeholder:text-slate-600 focus:ring-2 focus:ring-cyan-400/10 ${appId.length > 0 && !appIdValid ? "border-rose-400/60 focus:border-rose-400/60" : "border-white/15 focus:border-cyan-400/60"}`}
            />
            <span className="mt-1.5 block font-normal text-[11px] text-slate-500">
              Alphanumeric values are valid — this field no longer strips letters.
            </span>
          </label>

          <label className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-white/20 bg-slate-950 accent-cyan-400"
            />
            <span>
              <span className="font-semibold text-slate-200">Remember on this device</span>
              <span className="mt-0.5 block text-slate-500">Uses localStorage instead of sessionStorage. Only tick this on a machine you trust.</span>
            </span>
          </label>

          {error && (
            <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2.5 text-xs leading-5 text-rose-200">{error}</p>
          )}

          <button disabled={!canSubmit} type="submit" className="w-full rounded-lg bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">
            {platform.authBusy ? "Requesting account + OTP…" : "Authorize & connect"}
          </button>
        </form>

        <div className="mt-6 flex items-start gap-2 border-t border-white/10 pt-5 text-xs leading-5 text-slate-500">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-slate-500" />
          <p>The dashboard starts in a clearly marked simulation. Live prices need a connected account; real-money orders always require separate confirmation.</p>
        </div>
        {platform.mode === "live" && (
          <button onClick={() => { platform.startSimulation(); platform.setAuthOpen(false); }} className="mt-5 w-full rounded-lg border border-white/10 px-4 py-2.5 text-xs text-slate-300 hover:bg-white/5">Disconnect & return to simulation</button>
        )}
      </section>
    </div>
  );
}
