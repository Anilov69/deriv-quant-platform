"use client";

import { RotateCcw, TrendingDown, Trophy } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";

export function SessionAnalytics({ platform }: { platform: QuantPlatform }) {
  const { analytics } = platform;
  const values = analytics.curve;
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => `${values.length === 1 ? 0 : index / (values.length - 1) * 300},${88 - (value - min) / (max - min) * 76}`).join(" ");
  const sessionChange = platform.balance - platform.startBalance;
  const stopRemaining = Math.max(0, platform.risk.dailyStopLoss + Math.min(0, sessionChange));
  const targetRemaining = Math.max(0, platform.risk.dailyTakeProfit - Math.max(0, sessionChange));
  return (
    <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4">
      <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Session analytics</span><button onClick={platform.resetDailyBaseline} className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1.5 text-[9px] text-slate-400 hover:bg-white/5 hover:text-slate-200"><RotateCcw size={11} /> New baseline</button></div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Session P&L" value={`${sessionChange >= 0 ? "+" : ""}${sessionChange.toFixed(2)}`} tone={sessionChange >= 0 ? "text-emerald-300" : "text-rose-300"} />
        <Metric label="Trade P&L" value={`${analytics.pnl >= 0 ? "+" : ""}${analytics.pnl.toFixed(2)}`} tone={analytics.pnl >= 0 ? "text-emerald-300" : "text-rose-300"} />
        <Metric label="Win rate" value={`${analytics.winRate.toFixed(1)}%`} />
        <Metric label="Max drawdown" value={`-${analytics.maxDrawdown.toFixed(2)}`} tone="text-rose-300" />
      </div>
      <div className="mt-4 rounded-lg border border-white/[0.07] bg-slate-950/40 p-3">
        <div className="flex items-center justify-between text-[9px] text-slate-500"><span>TRADE EQUITY CURVE</span><span>{analytics.trades} settled</span></div>
        <svg viewBox="0 0 300 96" preserveAspectRatio="none" className="mt-2 h-24 w-full" role="img" aria-label={`Session trade profit curve, current ${analytics.pnl.toFixed(2)}`}>
          <defs><linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity=".22" /><stop offset="100%" stopColor="#22d3ee" stopOpacity="0" /></linearGradient></defs>
          <line x1="0" x2="300" y1={88 - (0 - min) / (max - min) * 76} y2={88 - (0 - min) / (max - min) * 76} stroke="#334155" strokeDasharray="3 4" />
          <polygon points={`0,88 ${points} 300,88`} fill="url(#equity-fill)" />
          <polyline points={points} fill="none" stroke="#22d3ee" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2 rounded-lg bg-rose-400/[0.05] p-2.5"><TrendingDown size={15} className="text-rose-300" /><div><div className="text-[9px] text-slate-500">Loss limit remaining</div><div className="mt-0.5 font-mono text-xs text-rose-200">{stopRemaining.toFixed(2)}</div></div></div>
        <div className="flex items-center gap-2 rounded-lg bg-emerald-400/[0.05] p-2.5"><Trophy size={15} className="text-emerald-300" /><div><div className="text-[9px] text-slate-500">Profit target remaining</div><div className="mt-0.5 font-mono text-xs text-emerald-200">{targetRemaining.toFixed(2)}</div></div></div>
      </div>
      <div className="mt-3 flex justify-between text-[10px] text-slate-500"><span>Avg. result / trade</span><span className={`font-mono ${analytics.averageProfit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{analytics.averageProfit >= 0 ? "+" : ""}{analytics.averageProfit.toFixed(3)} {platform.account.currency}</span></div>
    </section>
  );
}

function Metric({ label, value, tone = "text-slate-100" }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3"><div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div><div className={`mt-1.5 font-mono text-sm font-semibold ${tone}`}>{value}</div></div>;
}
