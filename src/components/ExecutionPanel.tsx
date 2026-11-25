"use client";

import { Bot, CircleDollarSign, Play, Settings2, ShieldAlert, Square, TrendingUp } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";
import type { RiskSettings } from "@/types";

export function ExecutionPanel({ platform, onExecute }: { platform: QuantPlatform; onExecute: () => void }) {
  const real = platform.account.kind === "real";
  const patchRisk = (patch: Partial<RiskSettings>) => platform.updateRisk(patch);
  const progressionMultiplier = platform.ev ? 1 + 1 / platform.ev.payoutPercentage : platform.risk.multiplier;
  return (
    <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400"><Settings2 size={14} /> Execution & risk</div>
        <div className="font-mono text-xs text-cyan-200">{platform.account.currency} {platform.stake.toFixed(2)} <span className="text-[9px] text-slate-500">NEXT STAKE</span></div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <NumberField label="Base stake" value={platform.risk.baseStake} min={0.35} step={0.01} onChange={(value) => patchRisk({ baseStake: value })} />
        <NumberField label="Kelly fraction" value={platform.risk.kellyFraction} min={0.01} max={0.25} step={0.01} onChange={(value) => patchRisk({ kellyFraction: value })} />
        <NumberField label="Daily stop-loss" value={platform.risk.dailyStopLoss} min={1} step={1} onChange={(value) => patchRisk({ dailyStopLoss: value })} />
        <NumberField label="Daily take-profit" value={platform.risk.dailyTakeProfit} min={1} step={1} onChange={(value) => patchRisk({ dailyTakeProfit: value })} />
      </div>

      <div className="mt-4 rounded-lg border border-white/10 bg-slate-950/40 p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-slate-200">Martingale progression</div>
            <div className="mt-1 text-[10px] text-slate-500">OFF uses flat / fractional-Kelly sizing</div>
          </div>
          <button aria-label="Toggle Martingale" aria-pressed={platform.risk.martingale} onClick={() => patchRisk({ martingale: !platform.risk.martingale })} className={`relative h-6 w-11 rounded-full transition ${platform.risk.martingale ? "bg-amber-400" : "bg-slate-700"}`}>
            <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${platform.risk.martingale ? "left-6" : "left-1"}`} />
          </button>
        </div>
        <div className={`mt-3 grid grid-cols-3 gap-2 transition ${platform.risk.martingale ? "opacity-100" : "pointer-events-none opacity-35"}`}>
          <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Payout multiplier</div><div className="mt-1.5 rounded-md border border-white/10 bg-slate-950/60 px-2.5 py-2 font-mono text-xs text-amber-200">{progressionMultiplier.toFixed(3)}×</div></div>
          <NumberField label="Max step" value={platform.risk.maxStep} min={1} max={12} step={1} onChange={(value) => patchRisk({ maxStep: value })} />
          <NumberField label="Loss limit" value={platform.risk.maxConsecutiveLosses} min={1} max={20} step={1} onChange={(value) => patchRisk({ maxConsecutiveLosses: value })} />
        </div>
        <label className="mt-3 block text-[10px] uppercase tracking-wider text-slate-500">
          Progression mode
          <select value={platform.risk.mode} onChange={(event) => patchRisk({ mode: event.target.value as RiskSettings["mode"] })} className="mt-1.5 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-2 text-xs normal-case tracking-normal text-slate-200 outline-none">
            <option value="next-signal">Immediate next signal</option>
            <option value="classic-immediate">Classic immediate</option>
          </select>
        </label>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500"><span>Progression preview</span><span>P(loss) = pₗₒₛₛⁿ</span></div>
        <div className="max-h-36 overflow-auto rounded-lg border border-white/[0.07]">
          <table className="w-full text-right font-mono text-[10px]">
            <thead className="sticky top-0 bg-slate-950 text-[9px] text-slate-500"><tr><th className="px-2 py-2 text-left">STEP</th><th className="px-2 py-2">STAKE</th><th className="px-2 py-2">CUM. CAP</th><th className="px-2 py-2">MAX LOSS</th></tr></thead>
            <tbody className="divide-y divide-white/[0.05] text-slate-300">
              {platform.progression.slice(0, 7).map((row) => <tr key={row.step}><td className="px-2 py-1.5 text-left text-slate-500">{row.step}</td><td className="px-2 py-1.5">{row.stake.toFixed(2)}</td><td className="px-2 py-1.5">{row.cumulativeCapital.toFixed(2)}</td><td className="px-2 py-1.5 text-rose-300">{(row.probabilityOfLoss * 100).toFixed(2)}%</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`mt-4 flex items-center justify-between rounded-lg border p-3 ${real ? "border-amber-400/30 bg-amber-400/[0.06]" : "border-white/10 bg-white/[0.02]"}`}>
        <div className="flex items-center gap-2"><Bot size={17} className={platform.autoTrade ? "text-emerald-400" : "text-slate-500"} /><div><div className="text-xs font-medium text-slate-200">Auto-trade</div><div className="text-[10px] text-slate-500">{real ? "Manual confirmation only" : "Positive-EV signals · 1.5s interval"}</div></div></div>
        <button aria-label="Toggle auto trade" aria-pressed={platform.autoTrade} disabled={real || platform.emergencyStop} onClick={() => platform.setAutoTrade(!platform.autoTrade)} className={`relative h-6 w-11 rounded-full transition disabled:opacity-30 ${platform.autoTrade ? "bg-emerald-400" : "bg-slate-700"}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${platform.autoTrade ? "left-6" : "left-1"}`} /></button>
      </div>

      {real && <div className="mt-3 flex gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-[10px] leading-4 text-amber-200"><ShieldAlert size={15} className="shrink-0" />REAL ACCOUNT: every purchase opens a confirmation showing symbol, contract, stake, payout, and EV.</div>}

      <button onClick={onExecute} disabled={!platform.canTrade || platform.openPositions >= 3} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500">
        {platform.autoTrade ? <Square size={15} /> : platform.openPositions >= 3 ? <CircleDollarSign size={16} /> : <Play size={15} fill="currentColor" />}
        {platform.autoTrade ? "AUTO-TRADE RUNNING" : platform.openPositions >= 3 ? "POSITION LIMIT REACHED" : real ? "REVIEW REAL TRADE" : "EXECUTE SELECTED SIGNAL"}
      </button>
      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500"><span className="flex items-center gap-1"><TrendingUp size={11} /> {platform.consecutiveLosses} consecutive losses</span><span>{platform.openPositions} open / 3 max</span></div>
    </section>
  );
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return (
    <label className="block text-[10px] uppercase tracking-wider text-slate-500">
      {label}
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }} className="mt-1.5 w-full rounded-md border border-white/10 bg-slate-950/60 px-2.5 py-2 font-mono text-xs normal-case tracking-normal text-slate-200 outline-none focus:border-cyan-400/50" />
    </label>
  );
}
