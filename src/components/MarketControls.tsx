"use client";

import { BarChart3, ChevronDown } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";
import type { ContractFilter } from "@/hooks/useQuantPlatform";
import type { ContractType, MarketFamily } from "@/types";

const families: Array<{ id: MarketFamily; label: string; caption: string }> = [
  { id: "continuous", label: "Continuous", caption: "Volatility & 1s" },
  { id: "step", label: "Step", caption: "Markov transitions" },
  { id: "jump", label: "Jump", caption: "Hazard & stabilization" },
];

const filters: Array<{ id: ContractFilter; label: string }> = [
  { id: "ALL", label: "All contracts" },
  { id: "MATCH", label: "Matches" },
  { id: "DIFFERS", label: "Differs" },
  { id: "RISE_FALL", label: "Rise / Fall" },
];

export function MarketControls({ platform }: { platform: QuantPlatform }) {
  const marketSymbols = platform.symbols.filter((item) => item.family === platform.family);
  const digitMode = platform.contractFilter === "ALL" || platform.contractFilter === "MATCH" || platform.contractFilter === "DIFFERS";
  return (
    <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400"><BarChart3 size={14} /> Market workspace</div>
        <div className="flex items-center gap-2 text-[10px] text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {platform.ticks.length.toLocaleString()} / 1,000 ticks
          <span className="mx-1 text-slate-700">|</span>
          {platform.symbolMeta?.decimals ?? 3} decimals
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {families.map((item) => (
          <button key={item.id} onClick={() => platform.selectFamily(item.id)} className={`rounded-lg border px-3 py-2.5 text-left transition ${platform.family === item.id ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 bg-white/[0.02] hover:border-white/20"}`}>
            <div className={`text-xs font-semibold ${platform.family === item.id ? "text-cyan-200" : "text-slate-200"}`}>{item.label}</div>
            <div className="mt-0.5 text-[10px] text-slate-500">{item.caption}</div>
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_auto]">
        <label className="relative block">
          <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-slate-500">Synthetic index</span>
          <select value={platform.symbol} onChange={(event) => platform.selectSymbol(event.target.value)} className="w-full appearance-none rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2.5 pr-8 text-xs font-medium text-slate-100 outline-none focus:border-cyan-400/50">
            {marketSymbols.map((item) => <option key={item.symbol} value={item.symbol} className="bg-slate-900">{item.symbol} · {item.displayName}{!item.available ? " (closed)" : ""}</option>)}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute bottom-3 right-3 text-slate-500" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-slate-500">Contract filter</span>
          <select value={platform.contractFilter} onChange={(event) => platform.setContractFilter(event.target.value as ContractFilter)} className="w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2.5 text-xs text-slate-100 outline-none focus:border-cyan-400/50">
            {filters.map((item) => <option key={item.id} value={item.id} className="bg-slate-900">{item.label}</option>)}
          </select>
        </label>
        <div>
          <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-slate-500">Last quote</span>
          <div className="rounded-lg border border-white/10 bg-slate-950/60 px-4 py-2 font-mono text-sm text-cyan-200">{platform.ticks.at(-1)?.quote.toFixed(platform.symbolMeta?.decimals ?? 3) ?? "—"}</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-5 border-t border-white/[0.07] pt-4">
        {digitMode && (
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Digit barrier</div>
            <div className="grid grid-cols-10 gap-1">
              {Array.from({ length: 10 }, (_, digit) => (
                <button key={digit} onClick={() => { platform.setSelectedBarrier(digit); platform.setPreferredContract(platform.contractFilter === "DIFFERS" ? "DIGITDIFF" : "DIGITMATCH"); }} className={`h-8 min-w-0 rounded-md border font-mono text-xs font-bold transition ${platform.selectedBarrier === digit ? "border-cyan-400/60 bg-cyan-400 text-slate-950" : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-cyan-400/30 hover:text-cyan-200"}`}>{digit}</button>
              ))}
            </div>
          </div>
        )}
        {(platform.contractFilter === "ALL" || platform.contractFilter === "RISE_FALL") && (
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Rise / Fall duration</div>
            <div className="flex gap-1">
              {[3, 4, 5].map((duration) => <button key={duration} onClick={() => { platform.setRiseFallDuration(duration); const type: ContractType = platform.preferredContract === "PUT" ? "PUT" : "CALL"; platform.setPreferredContract(type); }} className={`h-8 rounded-md border px-3 font-mono text-xs transition ${platform.riseFallDuration === duration ? "border-violet-400/50 bg-violet-400/15 text-violet-200" : "border-white/10 text-slate-400"}`}>{duration} ticks</button>)}
            </div>
          </div>
        )}
        <div className="ml-auto text-right text-[10px] leading-5 text-slate-500">
          <div>{platform.symbolMeta?.family.toUpperCase()} ENGINE</div>
          <div>{platform.mode === "live" ? "Deriv live proposals" : "Simulated proposals"}</div>
        </div>
      </div>
    </section>
  );
}
