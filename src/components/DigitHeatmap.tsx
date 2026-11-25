"use client";

import type { QuantPlatform } from "@/hooks/useQuantPlatform";

export function DigitHeatmap({ platform }: { platform: QuantPlatform }) {
  const windows = [100, 300, 1000] as const;
  const countsFor = (window: number) => {
    if (platform.analysis.kind === "continuous") {
      const analysis = platform.analysis.continuous;
      return window === 100 ? analysis.digitCounts100 : window === 300 ? analysis.digitCounts300 : analysis.digitCounts1000;
    }
    const counts = Array<number>(10).fill(0);
    for (const tick of platform.ticks.slice(-window)) counts[tick.digit] += 1;
    return counts;
  };
  return (
    <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4">
      <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Digit distribution</span><span className="text-[9px] text-slate-600">NORMALIZED FREQUENCY</span></div>
      <div className="mt-4 space-y-3">
        {windows.map((window) => <div key={window}>
          <div className="mb-1.5 flex justify-between text-[9px] text-slate-500"><span>{window.toLocaleString()} ticks</span><span>{platform.ticks.length < window ? `collecting ${platform.ticks.length}/${window}` : "sample complete"}</span></div>
          <div className="grid grid-cols-10 gap-0.5 sm:gap-1.5">
            {Array.from({ length: 10 }, (_, digit) => {
              const counts = countsFor(window);
              const probability = counts[digit] / Math.max(1, counts.reduce((sum, count) => sum + count, 0));
              const intensity = Math.max(0, Math.min(1, (probability - 0.04) / 0.16));
              return <div key={digit} className={`relative flex h-14 flex-col items-center justify-center rounded-md border transition ${digit === platform.selectedBarrier ? "border-cyan-300 ring-1 ring-cyan-300/30" : "border-white/[0.07]"}`} style={{ backgroundColor: `rgba(34,211,238,${0.04 + intensity * 0.32})` }}>
                <span className="font-mono text-sm font-semibold text-slate-200">{digit}</span>
                <span className="mt-1 font-mono text-[9px] text-slate-400">{(probability * 100).toFixed(1)}%</span>
              </div>;
            })}
          </div>
        </div>)}
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500"><span>Frequency → color intensity</span><span>Uniform baseline: 10%</span></div>
    </section>
  );
}

export function EntropyGauge({ platform }: { platform: QuantPlatform }) {
  const entropy = platform.analysis.kind === "continuous" ? platform.analysis.continuous.entropy300 : (() => {
    const counts = Array<number>(10).fill(0);
    for (const tick of platform.ticks.slice(-300)) counts[tick.digit] += 1;
    const total = counts.reduce((sum, count) => sum + count, 0);
    return counts.reduce((sum, count) => count ? sum - (count / total) * Math.log2(count / total) : sum, 0);
  })();
  const zScores = platform.analysis.kind === "continuous" ? platform.analysis.continuous.zScores : null;
  const arc = 126;
  const angle = Math.PI * (1 - entropy / Math.log2(10));
  const x = 60 + 46 * Math.cos(angle);
  const y = 58 - 46 * Math.sin(angle);
  return (
    <section className="rounded-xl border border-white/10 bg-[#0d1522] p-4">
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Entropy & z-score</span>
      <div className="mt-2 flex items-center gap-2">
        <svg viewBox="0 0 120 68" className="h-24 w-36 shrink-0" role="img" aria-label={`Shannon entropy ${entropy.toFixed(3)} bits`}>
          <path d="M 14 58 A 46 46 0 1 1 106 58" fill="none" stroke="#1e293b" strokeWidth="8" strokeLinecap="round" pathLength={arc} strokeDasharray={`${arc * Math.min(1, entropy / Math.log2(10))} ${arc}`} />
          <path d="M 14 58 A 46 46 0 1 1 106 58" fill="none" stroke="#22d3ee" strokeWidth="8" strokeLinecap="round" pathLength={arc} strokeDasharray={`${arc * Math.min(1, entropy / Math.log2(10))} ${arc}`} />
          <line x1="60" y1="58" x2={x} y2={y} stroke="#e2e8f0" strokeWidth="1.5" />
          <circle cx="60" cy="58" r="3" fill="#e2e8f0" />
        </svg>
        <div><div className="font-mono text-2xl font-semibold text-cyan-300">{entropy.toFixed(3)}</div><div className="text-[10px] text-slate-500">bits · max {Math.log2(10).toFixed(3)}</div><div className={`mt-2 text-[9px] font-semibold uppercase tracking-wider ${entropy < 3.1 ? "text-amber-300" : "text-emerald-300"}`}>{entropy < 3.1 ? "Structured" : "Near-uniform"}</div></div>
      </div>
      {zScores && <div className="mt-2 grid grid-cols-10 gap-1">{zScores.map((z, digit) => <div key={digit} className="text-center"><div className={`font-mono text-[9px] ${z > 1.96 ? "text-amber-300" : z < -1.96 ? "text-cyan-300" : "text-slate-500"}`}>{z >= 0 ? "+" : ""}{z.toFixed(1)}</div><div className="mt-1 text-[9px] text-slate-600">{digit}</div></div>)}</div>}
    </section>
  );
}
