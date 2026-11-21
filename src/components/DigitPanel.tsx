"use client";
import { useState } from "react";
import { DIGIT_WINDOWS, digitWindowStats } from "@/engines/continuousEngine";
import { binomialZ } from "@/engines/stats";
import { pct } from "@/lib/format";

/** Diverging colour for a z-score: blue (under) ↔ red (over), saturating at |Z| = 3. */
function zColor(z: number) {
  const a = Math.min(1, Math.abs(z) / 3);
  return z >= 0 ? `rgba(239,68,68,${0.12 + 0.6 * a})` : `rgba(59,130,246,${0.12 + 0.6 * a})`;
}

export function DigitPanel({ digits }: { digits: number[] }) {
  const [win, setWin] = useState<number>(100);
  const st = digitWindowStats(digits, win);
  const max = Math.max(...st.freq, 0.15);
  const recent = digits.slice(-win);
  const over = Array.from({ length: 9 }, (_, b) => {
    const k = recent.filter((d) => d > b).length;
    return { b, rate: st.n ? k / st.n : 0, p0: (9 - b) / 10, z: binomialZ(k, st.n, (9 - b) / 10) };
  });
  const under = Array.from({ length: 9 }, (_, i) => {
    const b = i + 1;
    const k = recent.filter((d) => d < b).length;
    return { b, rate: st.n ? k / st.n : 0, p0: b / 10, z: binomialZ(k, st.n, b / 10) };
  });

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Last-digit distribution</span>
        <div className="flex gap-1">
          {DIGIT_WINDOWS.map((w) => (
            <button key={w} onClick={() => setWin(w)} className={`rounded px-2 py-0.5 text-xs ${win === w ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800"}`}>
              {w}
            </button>
          ))}
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-end gap-1.5" data-testid="digit-histogram">
          {st.freq.map((f, d) => (
            <div key={d} className="flex flex-1 flex-col items-center gap-1">
              <span className={`num rounded px-1 text-[10px] ${Math.abs(st.z[d]) > 2 ? "bg-amber-500/20 font-bold text-amber-300" : "text-slate-500"}`} title="Z-score vs p = 0.10">
                {st.z[d] >= 0 ? "+" : ""}{st.z[d].toFixed(1)}
              </span>
              <div className="relative h-28 w-full">
                <div className="absolute inset-x-0 border-t border-dashed border-slate-500/60" style={{ bottom: `${(0.1 / max) * 100}%` }} />
                <div className={`absolute inset-x-0 bottom-0 rounded-t ${d % 2 ? "bg-violet-500/80" : "bg-sky-500/80"}`} style={{ height: `${(f / max) * 100}%` }} />
              </div>
              <span className="num text-xs font-semibold">{d}</span>
              <span className="num text-[10px] text-slate-500">{pct(f, 0)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <Stat label={`χ² (df 9), n=${st.n}`} value={st.chi2.toFixed(2)} />
          <Stat label="χ² p-value" value={st.pValue.toFixed(3)} warn={st.pValue < 0.05} />
          <Stat label="Even rate (Z)" value={`${pct(st.evenRate)} (${st.evenZ.toFixed(2)})`} warn={Math.abs(st.evenZ) > 2} />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Dashed line = theoretical 10 %. With 10 digits × 4 windows, a |Z| &gt; 2 flag appears by chance ~4.6 % of the time per digit.
        </p>

        <div className="mt-4 space-y-2">
          <div className="label">Parity heatmap (theory 50 %)</div>
          <div className="grid grid-cols-2 gap-1 text-center text-xs">
            {[
              { l: "Even", r: st.evenRate, z: st.evenZ },
              { l: "Odd", r: 1 - st.evenRate, z: -st.evenZ },
            ].map((c) => (
              <div key={c.l} className="num rounded py-1.5" style={{ background: zColor(c.z) }}>
                {c.l} {pct(c.r)} <span className="text-slate-300/70">Z {c.z.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="label pt-1">Over / Under heatmap (empirical vs theory)</div>
          {[{ name: "Over", data: over }, { name: "Under", data: under }].map((row) => (
            <div key={row.name} className="grid grid-cols-[48px_repeat(9,1fr)] gap-1 text-center text-[10px]">
              <div className="self-center text-left text-slate-400">{row.name}</div>
              {row.data.map((c) => (
                <div key={c.b} className="num rounded py-1" style={{ background: zColor(c.z) }} title={`${row.name} ${c.b}: ${pct(c.rate)} vs ${pct(c.p0)} theory, Z=${c.z.toFixed(2)}`}>
                  <div className="font-semibold">{c.b}</div>
                  <div>{pct(c.rate, 0)}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-1.5">
      <div className="label !normal-case !tracking-normal">{label}</div>
      <div className={`num text-sm font-semibold ${warn ? "text-amber-300" : ""}`}>{value}</div>
    </div>
  );
}
