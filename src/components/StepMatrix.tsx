"use client";

import { Activity, Waves } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";

export function StepMatrix({ platform }: { platform: QuantPlatform }) {
  const analysis = platform.analysis;
  if (analysis.kind !== "step") return <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4 text-xs text-slate-500"><Activity className="mb-3" size={17} />Select a Step Index market to inspect the empirical 10×10 transition matrix.</section>;
  const { transitionMatrix: markovMatrix, streak: streakLength, streakDirection, lagAutocorrelation, meanReversionScore, maxObservedStep } = analysis.step;
  return (
    <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4">
      <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Markov transition matrix</span><span className="text-[9px] text-slate-600">ROW → NEXT COLUMN</span></div>
      <div className="mt-4 grid grid-cols-[18px_repeat(10,minmax(0,1fr))] gap-1">
        <span />
        {Array.from({ length: 10 }, (_, index) => <span key={index} className="text-center font-mono text-[9px] text-slate-600">{index}</span>)}
        {markovMatrix.map((row, from) => <div key={from} className="contents"><span className="flex items-center font-mono text-[9px] text-slate-500">{from}</span>{row.map((probability, to) => {
          const intensity = Math.max(0, Math.min(1, probability / 0.24));
          return <div key={to} title={`${from} → ${to}: ${(probability * 100).toFixed(2)}%`} className="flex aspect-square items-center justify-center rounded-sm font-mono text-[7px] text-slate-300" style={{ backgroundColor: `rgba(34,211,238,${0.03 + intensity * 0.55})` }}>{probability >= 0.1 ? Math.round(probability * 100) : ""}</div>;
        })}</div>)}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <Metric label="Current streak" value={`${streakDirection === "up" ? "↑" : streakDirection === "down" ? "↓" : "–"} ${streakLength}`} />
        <Metric label="Lag-1 autocorrelation" value={lagAutocorrelation.toFixed(3)} />
        <Metric label="Mean reversion" value={`${(meanReversionScore * 100).toFixed(1)}%`} />
        <Metric label="Observed step ceiling" value={String(maxObservedStep)} />
      </div>
      <div className="mt-3 flex gap-2 text-[10px] leading-4 text-slate-500"><Waves size={13} className="mt-0.5 shrink-0" />Observed constraints and smoothed transitions select barrier neighbors; no future-step knowledge is used.</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-white/[0.03] p-2.5"><div className="text-[9px] text-slate-500">{label}</div><div className="mt-1 font-mono text-slate-200">{value}</div></div>;
}
