"use client";
import { currentAccount, useStore } from "@/store/useStore";
import { resume, stopAll } from "@/services/session";
import { money } from "@/lib/format";

function Dot({ state }: { state: string }) {
  const c = state === "open" ? "bg-emerald-400" : state === "connecting" || state === "reconnecting" ? "bg-amber-400 animate-pulse" : "bg-slate-600";
  return <span className={`inline-block h-2 w-2 rounded-full ${c}`} />;
}

export function TopBar({ onOpenLogin, onRequestSwitch }: { onOpenLogin: () => void; onRequestSwitch: (id: string) => void }) {
  const s = useStore();
  const acct = currentAccount(s);
  const isReal = acct?.account_type === "real";
  const demos = s.accounts.filter((a) => a.account_type === "demo");
  const reals = s.accounts.filter((a) => a.account_type === "real");
  const lat = s.latency;

  return (
    <header className={`sticky top-0 z-30 border-b backdrop-blur ${isReal ? "border-red-500/60 bg-red-950/40" : "border-slate-800 bg-slate-950/80"}`}>
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2 pr-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-500 to-emerald-500 text-sm font-black text-slate-950">Δ</div>
          <div className="leading-tight">
            <div className="text-sm font-bold">Deriv Quant</div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Synthetic indices lab</div>
          </div>
        </div>

        <button onClick={onOpenLogin} className="btn-ghost !py-1 text-xs" data-testid="auth-button">
          <span className={`h-2 w-2 rounded-full ${s.authStatus === "signed-in" ? "bg-emerald-400" : s.authStatus === "validating" ? "bg-amber-400 animate-pulse" : "bg-slate-500"}`} />
          {s.authStatus === "signed-in" ? "PAT connected" : s.authStatus === "validating" ? "Validating…" : "Connect PAT"}
        </button>

        {s.authStatus === "signed-in" && (
          <div className="flex items-center gap-1 rounded-lg border border-slate-700 p-0.5" data-testid="account-switcher">
            <button
              disabled={!demos.length}
              onClick={() => demos[0] && onRequestSwitch(demos[0].account_id)}
              className={`rounded-md px-3 py-1 text-xs font-bold ${!isReal ? "bg-emerald-500 text-emerald-950" : "text-slate-400 hover:text-slate-200"}`}
            >
              DEMO
            </button>
            <button
              disabled={!reals.length}
              title={reals.length ? "" : "No real account on this token"}
              onClick={() => reals[0] && onRequestSwitch(reals[0].account_id)}
              className={`rounded-md px-3 py-1 text-xs font-bold disabled:opacity-30 ${isReal ? "bg-red-500 text-white" : "text-slate-400 hover:text-amber-300"}`}
            >
              REAL
            </button>
            {s.accounts.length > 2 && (
              <select className="ml-1 bg-transparent text-xs text-slate-300 outline-none" value={s.accountId ?? ""} onChange={(e) => onRequestSwitch(e.target.value)}>
                {s.accounts.map((a) => (
                  <option key={a.account_id} value={a.account_id} className="bg-slate-900">
                    {a.account_type.toUpperCase()} · {a.account_id} · {a.currency}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {acct && (
          <div className="flex items-center gap-3 text-xs">
            <span className={`rounded px-2 py-0.5 font-bold ${isReal ? "bg-red-500/20 text-red-300 ring-1 ring-red-500/50" : "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40"}`}>
              {isReal ? "REAL MONEY" : "DEMO"}
            </span>
            <div>
              <div className="label">Balance</div>
              <div className="num text-sm font-semibold" data-testid="balance">{s.balance !== null ? money(s.balance, s.currency) : "—"}</div>
            </div>
            <div>
              <div className="label">Login ID</div>
              <div className="num">{s.loginId ?? acct.account_id}</div>
            </div>
          </div>
        )}

        <div className="ml-auto flex items-center gap-4 text-xs">
          <div className="flex items-center gap-3 text-slate-400">
            <span className="flex items-center gap-1.5" title="Market data socket"><Dot state={s.publicConn} /> Data</span>
            {s.authStatus === "signed-in" && <span className="flex items-center gap-1.5" title="Trading socket"><Dot state={s.tradeConn} /> Trade</span>}
            <span className={`num ${lat === null ? "" : lat < 150 ? "text-emerald-400" : lat < 400 ? "text-amber-400" : "text-red-400"}`} data-testid="latency">
              {lat === null ? "— ms" : `${lat} ms`}
            </span>
          </div>
          {s.halted ? (
            <button onClick={resume} className="btn bg-slate-700 text-white hover:bg-slate-600">Resume trading</button>
          ) : (
            <button onClick={() => void stopAll()} className="btn bg-red-600 text-white shadow-lg shadow-red-900/40 hover:bg-red-500" data-testid="stop-all">
              ■ STOP ALL
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
