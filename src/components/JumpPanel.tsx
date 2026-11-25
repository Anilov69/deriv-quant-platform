"use client";

import { Radio, Zap } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";

export function JumpPanel({ platform }: { platform: QuantPlatform }) {
  const analysis = platform.analysis;
  if (analysis.kind !== "jump") return <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4 text-xs text-slate-500"><Zap className="mb-3" size={17} />Select a Jump Index to monitor ATR events, Poisson hazard, elapsed time, and post-jump stabilization.</section>;
  const jump = analysis.jump;
  const hazardColor = jump.elevatedHazard ? "text-amber-300" : "text-emerald-300";
  return (
    <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4">
      <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Jump process</span><span className={`flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider ${hazardColor}`}><Radio size={11} />{jump.elevatedHazard ? "Hazard elevated" : "Nominal hazard"}</span></div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="ATR / event rate" value={`${jump.atr.toFixed(5)} / ${(jump.jumpIntensity * 100).toFixed(2)}%`} />
        <Metric label="Elapsed-time hazard" value={`${(jump.hazard * 100).toFixed(2)}%`} />
        <Metric label="Elapsed since jump" value={jump.ticksSinceJump === null ? "No event" : `${jump.ticksSinceJump} ticks`} />
        <Metric label="Stabilization window" value="5 quiet ticks" />
        <Metric label="Stabilized" value={jump.stabilized ? "Ready" : "Waiting"} />
        <Metric label="Jump events" value={String(jump.jumps.length)} />
      </div>
      <div className="mt-4">
        <div className="mb-2 flex justify-between text-[9px] text-slate-500"><span>Hazard intensity</span><span>{(jump.hazard * 100).toFixed(2)}%</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/5"><div className={`h-full rounded-full ${jump.elevatedHazard ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${Math.min(100, jump.hazard * 100)}%` }} /></div>
      </div>
      <div className="mt-4 rounded-lg border border-white/[0.07] bg-slate-950/40 p-3 text-[10px] leading-4 text-slate-500">{jump.elevatedHazard ? "Digit entries suppressed while elevated hazard persists. A micro-drift signal requires stabilization and positive payout-aware EV." : "ATR detects price discontinuities. Elapsed-time hazard and stabilization gates remain active after each event."}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[9px] uppercase tracking-wider text-slate-600">{label}</div><div className="mt-1 font-mono text-xs text-slate-200">{value}</div></div>;
}
