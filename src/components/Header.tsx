"use client";

import { Activity, CircleStop, KeyRound, Radio, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";

const statusLabel = {
  disconnected: "Offline",
  connecting: "Connecting",
  connected: "Live",
  reconnecting: "Reconnecting",
  error: "Connection error",
};

export function Header({ platform }: { platform: QuantPlatform }) {
  const real = platform.account.kind === "real";
  const live = platform.mode === "live";
  return (
    <header className={`border-b ${real ? "border-amber-500/50 bg-amber-500/[0.04]" : "border-white/10 bg-[#0b111b]/90"}`}>
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-4 px-4 py-3 lg:px-6">
        <div className="flex min-w-[210px] items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
            <Activity size={21} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-[0.18em] text-white">DERIV QUANT</span>
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${live ? "bg-cyan-400/15 text-cyan-300" : "bg-violet-400/15 text-violet-300"}`}>
                {live ? "LIVE" : "SIMULATION"}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
              {live && platform.status === "connected" ? <Wifi size={11} className="text-emerald-400" /> : <WifiOff size={11} />}
              {live ? statusLabel[platform.status] : "Local market simulator"}
              {live && platform.latency > 0 && <span className="text-slate-500">· {platform.latency} ms</span>}
            </div>
          </div>
        </div>

        <div className={`flex min-w-[250px] flex-1 items-center gap-3 rounded-xl border px-3 py-2 ${real ? "border-amber-400/40 bg-amber-400/[0.06]" : "border-white/10 bg-white/[0.025]"}`}>
          <ShieldCheck size={18} className={real ? "text-amber-400" : "text-emerald-400"} />
          <div className="min-w-0 flex-1">
            <div className={`text-[10px] font-bold uppercase tracking-[0.16em] ${real ? "text-amber-400" : "text-emerald-400"}`}>
              {real ? "Real account · confirmation required" : "Demo account · no real funds"}
            </div>
            {live ? (
              <select
                aria-label="Switch Deriv account"
                value={platform.account.loginid}
                onChange={(event) => void platform.switchAccount(event.target.value)}
                className="mt-1 w-full cursor-pointer bg-transparent text-xs text-slate-200 outline-none"
              >
                {platform.accounts.map((item) => <option key={item.loginid} value={item.loginid} className="bg-slate-900">{item.kind.toUpperCase()} · {item.loginid} · {item.currency}</option>)}
              </select>
            ) : (
              <div className="mt-1 truncate text-xs text-slate-300">{platform.account.loginid} · {platform.account.currency}</div>
            )}
          </div>
        </div>

        <div className="ml-auto flex max-w-full flex-wrap items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Balance</div>
            <div className="font-mono text-lg font-semibold text-white">{platform.account.currency} {platform.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
          {!live && (
            <button onClick={() => platform.setAuthOpen(true)} className="flex items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2.5 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/20">
              <KeyRound size={15} /> Connect PAT
            </button>
          )}
          <button
            onClick={() => platform.emergencyStop ? platform.resetEmergency() : platform.stopTrading()}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-bold transition ${platform.emergencyStop ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"}`}
          >
            {platform.emergencyStop ? <ShieldCheck size={15} /> : <CircleStop size={15} />}
            {platform.emergencyStop ? "RESET STOP" : "EMERGENCY STOP"}
          </button>
        </div>
      </div>
      {platform.killReason && (
        <div className="border-t border-rose-500/20 bg-rose-500/10 px-4 py-2 text-center text-xs font-medium text-rose-200">
          <Radio size={12} className="mr-2 inline" />{platform.killReason} New trades are blocked.
        </div>
      )}
    </header>
  );
}
