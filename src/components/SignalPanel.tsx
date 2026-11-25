"use client";

import { ArrowDownRight, ArrowUpRight, Crosshair, Sparkles } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";
import type { ContractType, Signal } from "@/types";

function contractLabel(type: ContractType): string {
  if (type === "DIGITMATCH") return "Matches";
  if (type === "DIGITDIFF") return "Differs";
  return type === "CALL" ? "Rise" : "Fall";
}

function SignalIcon({ signal }: { signal: Signal }) {
  if (signal.direction === "up") return <ArrowUpRight size={15} className="text-emerald-400" />;
  if (signal.direction === "down") return <ArrowDownRight size={15} className="text-rose-400" />;
  return <Crosshair size={15} className="text-cyan-300" />;
}

export function SignalPanel({ platform }: { platform: QuantPlatform }) {
  const candidates = platform.analysis.kind === "continuous" ? platform.analysis.continuous.signals
    : platform.analysis.kind === "step" ? platform.analysis.step.signals
      : platform.analysis.jump.signals;
  const visible = candidates.filter((signal) => {
    if (platform.contractFilter === "ALL") return true;
    if (platform.contractFilter === "MATCH") return signal.contractType === "DIGITMATCH";
    if (platform.contractFilter === "DIFFERS") return signal.contractType === "DIGITDIFF";
    return signal.contractType === "CALL" || signal.contractType === "PUT";
  }).sort((a, b) => b.score - a.score).slice(0, 5);
  const ev = platform.ev;

  return (
    <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400"><Sparkles size={14} /> Signal queue</div>
        <span className="rounded bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-400">{visible.length} candidates</span>
      </div>

      {platform.analysis.kind === "jump" && platform.analysis.jump.elevatedHazard && (
        <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">Elevated jump hazard · digit signals paused</div>
      )}

      <div className="mt-3 space-y-2">
        {visible.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 px-3 py-8 text-center text-xs leading-5 text-slate-500">No signal meets the engine threshold.<br />The tick buffer continues collecting.</div>
        ) : visible.map((signal) => {
          const selected = platform.activeSignal?.id === signal.id;
          return (
            <button key={signal.id} onClick={() => {
              platform.setPreferredContract(signal.contractType);
              if (signal.barrier !== undefined) platform.setSelectedBarrier(Number(signal.barrier));
              if (signal.contractType === "CALL" || signal.contractType === "PUT") platform.setRiseFallDuration(signal.durationTicks);
            }} className={`w-full rounded-lg border p-3 text-left transition ${selected ? "border-cyan-400/40 bg-cyan-400/[0.07]" : "border-white/[0.08] bg-white/[0.02] hover:border-white/20"}`}>
              <div className="flex items-center gap-2">
                <SignalIcon signal={signal} />
                <span className="text-xs font-semibold text-slate-100">{contractLabel(signal.contractType)}</span>
                {signal.barrier !== undefined && <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">digit {signal.barrier}</span>}
                {(signal.contractType === "CALL" || signal.contractType === "PUT") && <span className="text-[10px] text-slate-500">{signal.durationTicks} ticks</span>}
                <span className="ml-auto font-mono text-xs font-semibold text-cyan-200">{(signal.probability * 100).toFixed(1)}%</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400" style={{ width: `${Math.min(100, signal.score)}%` }} /></div>
              <div className="mt-2 truncate text-[10px] text-slate-500" title={signal.reasons.join(" · ")}>{signal.reasons.slice(0, 2).join(" · ")}</div>
            </button>
          );
        })}
      </div>

      <div className={`mt-4 rounded-xl border p-4 ${ev?.actionable ? "border-emerald-400/30 bg-emerald-400/[0.06]" : "border-white/10 bg-slate-950/50"}`}>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Live expected value</span>
          <span className={`rounded px-2 py-1 text-[9px] font-bold tracking-wider ${ev?.actionable ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/10 text-rose-300"}`}>{ev?.actionable ? "ACTIONABLE" : "NO EDGE"}</span>
        </div>
        {ev && platform.activeSignal ? (
          <>
            <div className={`mt-3 font-mono text-2xl font-semibold ${ev.expectedValue > 0 ? "text-emerald-300" : "text-rose-300"}`}>{ev.expectedValue >= 0 ? "+" : ""}{ev.expectedValue.toFixed(3)} <span className="text-xs text-slate-500">{platform.account.currency} / trade</span></div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
              <Metric label="Model probability" value={`${(ev.modelProbability * 100).toFixed(2)}%`} />
              <Metric label="Break-even" value={`${(ev.breakEvenProbability * 100).toFixed(2)}%`} />
              <Metric label="Payout" value={`${ev.payout.toFixed(3)}`} />
              <Metric label="Payout percentage" value={`${ev.payoutPercentage.toFixed(2)}%`} />
            </div>
            <div className="mt-3 text-[10px] leading-4 text-slate-500">EV = p × (payout − stake) − (1 − p) × stake. Empirical estimates are not guaranteed RNG predictions.</div>
          </>
        ) : <div className="mt-4 text-xs text-slate-500">Waiting for a matching live proposal.</div>}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[9px] uppercase tracking-wider text-slate-600">{label}</div><div className="mt-1 font-mono text-slate-200">{value}</div></div>;
}
