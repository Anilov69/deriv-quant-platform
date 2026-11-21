"use client";
import { FAMILY_ENGINE, FAMILY_LABEL, marketsFor, type MarketFamily } from "@/lib/markets";
import { selectSymbol } from "@/services/session";
import { useStore } from "@/store/useStore";

const FAMILIES: MarketFamily[] = ["continuous", "step", "jump"];

export function MarketTabs() {
  const family = useStore((s) => s.family);
  const symbol = useStore((s) => s.symbol);
  const active = useStore((s) => s.activeSymbols);
  const prices = useStore((s) => s.prices);
  const decimals = useStore((s) => s.decimals);
  const error = useStore((s) => s.marketError);
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2];

  return (
    <div className="panel">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 px-2 pt-2" role="tablist">
        {FAMILIES.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={family === f}
            onClick={() => selectSymbol(marketsFor(f, active ?? undefined)[0]?.symbol ?? marketsFor(f)[0].symbol)}
            className={`rounded-t-lg px-4 py-2 text-sm font-semibold transition ${family === f ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
          >
            {FAMILY_LABEL[f]}
          </button>
        ))}
        <span className="ml-auto hidden pr-3 text-xs text-slate-500 md:block">Engine: <b className="text-sky-300">{FAMILY_ENGINE[family]}</b></span>
      </div>
      <div className="flex flex-wrap items-center gap-2 p-3">
        {marketsFor(family).map((m) => {
          const off = active && !active.has(m.symbol);
          return (
            <button
              key={m.symbol}
              disabled={!!off}
              onClick={() => selectSymbol(m.symbol)}
              title={off ? "Not currently offered by Deriv" : m.name}
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${symbol === m.symbol ? "border-sky-500 bg-sky-500/15 text-sky-200" : "border-slate-700 text-slate-300 hover:border-slate-500"} disabled:opacity-30`}
            >
              {m.symbol}
            </button>
          );
        })}
        <div className="ml-auto flex items-baseline gap-2">
          <span className="text-xs text-slate-500">{symbol}</span>
          <span className={`num text-xl font-bold ${last > prev ? "text-emerald-400" : last < prev ? "text-red-400" : "text-slate-100"}`} data-testid="spot">
            {last !== undefined ? last.toFixed(decimals) : "…"}
          </span>
        </div>
      </div>
      {error && <div className="mx-3 mb-3 rounded border border-amber-700 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-300">Market data: {error} — will resume automatically.</div>}
    </div>
  );
}
