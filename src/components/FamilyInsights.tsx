"use client";
import type { EngineOutput } from "@/engines/types";
import type { ContinuousInsights } from "@/engines/continuousEngine";
import type { StepInsights } from "@/engines/stepEngine";
import type { JumpInsights } from "@/engines/jumpEngine";
import { pct } from "@/lib/format";
import { useStore } from "@/store/useStore";
import { Stat } from "./DigitPanel";

export function FamilyInsights({ output }: { output: EngineOutput }) {
  const st = useStore((s) => s.settings);
  const decimals = useStore((s) => s.decimals);
  return (
    <div className="panel">
      <div className="panel-title">
        <span>
          {output.family === "continuous" && "Module A · GBM tick-velocity & mean reversion"}
          {output.family === "step" && "Module B · Run-length & step parity"}
          {output.family === "jump" && "Module C · Jump hazard & regime"}
        </span>
        {output.warmingUp && <span className="text-xs font-normal text-amber-300">warming up…</span>}
      </div>
      <div className="p-4 text-xs">
        {output.family === "continuous" && <Continuous ins={output.insights as ContinuousInsights} z={st.bollingerZ} />}
        {output.family === "step" && <Step ins={output.insights as StepInsights} k={st.minStreak} decimals={decimals} />}
        {output.family === "jump" && <Jump ins={output.insights as JumpInsights} decimals={decimals} />}
      </div>
    </div>
  );
}

function Continuous({ ins, z }: { ins: ContinuousInsights; z: number }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Bollinger Zₜ" value={ins.zNow.toFixed(2)} warn={Math.abs(ins.zNow) > z} />
        <Stat label="rₜ = ln(Sₜ/Sₜ₋₁)" value={ins.rNow.toExponential(2)} />
        <Stat label="Δrₜ" value={ins.dRNow.toExponential(2)} />
        <Stat label="σ_N (per tick)" value={ins.sigmaN.toExponential(2)} />
      </div>
      <Trigger
        on={!!ins.trigger}
        text={ins.trigger ? `Exhaustion: Zₜ beyond ±${z} with momentum inflection → ${ins.trigger === "fall" ? "FALL" : "RISE"} candidate` : `No trigger: needs |Zₜ| > ${z} and Δr opposing the move`}
      />
    </div>
  );
}

function Step({ ins, k, decimals }: { ins: StepInsights; k: number; decimals: number }) {
  const totalRuns = ins.runs.reduce((a, b) => a + b, 0);
  const shown = ins.runs.slice(1, 11);
  const maxRun = Math.max(1, ...shown);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Current streak" value={`${ins.streak} ${ins.streakDir > 0 ? "▲" : ins.streakDir < 0 ? "▼" : ""}`} warn={ins.streak >= k} />
        <Stat label="P(streak ≥ k) = 0.5ᵏ" value={pct(ins.streakTailP, 2)} warn={ins.streakTailP <= 0.0157} />
        <Stat label="ρ(1) step direction" value={ins.rho1.toFixed(3)} />
        <Stat label="Regime" value={ins.mode} />
      </div>
      <div className="flex flex-wrap gap-2">
        {ins.stepSizes.map((s) => (
          <span key={s.size} className="num rounded border border-slate-700 px-2 py-0.5">±{s.size.toFixed(decimals)} × {s.count}</span>
        ))}
      </div>
      <div>
        <div className="label mb-1">Completed run lengths vs geometric expectation (bars = observed, ticks = expected)</div>
        <div className="flex h-20 items-end gap-1">
          {shown.map((c, i) => {
            const len = i + 1;
            const exp = totalRuns * Math.pow(0.5, len);
            return (
              <div key={len} className="relative flex flex-1 flex-col items-center">
                <div className="relative h-16 w-full">
                  <div className="absolute inset-x-0 bottom-0 rounded-t bg-pink-500/70" style={{ height: `${(c / maxRun) * 100}%` }} />
                  <div className="absolute inset-x-0 border-t-2 border-slate-200" style={{ bottom: `${Math.min(100, (exp / maxRun) * 100)}%` }} />
                </div>
                <span className="num text-[10px] text-slate-500">{len}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <div className="label mb-1">Next-digit distribution from current digit {ins.currentDigit} (empirical transition row)</div>
        <div className="grid grid-cols-10 gap-1 text-center text-[10px]">
          {ins.nextDigitDist.map((p, d) => (
            <div key={d} className="num rounded py-1" style={{ background: `rgba(56,189,248,${0.08 + 0.8 * p})` }}>
              <div className="font-semibold">{d}</div>
              {pct(p, 0)}
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-slate-500">Fixed ±step sizes make digit transitions deterministic — Deriv therefore does not offer digit contracts on Step indices.</p>
      </div>
      <Trigger on={ins.streak >= k} text={ins.streak >= k ? `Tail streak k=${ins.streak} (≥${k}) — Rise/Fall candidates active (${ins.mode})` : `Waiting for a streak ≥ ${k}`} />
    </div>
  );
}

function Jump({ ins, decimals }: { ins: JumpInsights; decimals: number }) {
  const mins = (s: number | null) => (s === null ? "none in buffer" : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Jumps in buffer" value={String(ins.jumps.length)} />
        <Stat label="Since last jump" value={mins(ins.secondsSinceJump)} />
        <Stat label="λ̂ (jumps / hour)" value={(ins.lambda * 3600).toFixed(2)} />
        <Stat label="ATR₂₀ / σ_tick" value={`${ins.atr20.toFixed(decimals)} / ${ins.sigmaTick.toFixed(decimals)}`} />
      </div>
      <table className="w-full text-left">
        <thead className="text-slate-500">
          <tr>
            <th className="py-1 font-medium">Duration</th>
            <th className="font-medium">P(jump in contract) = 1−e^(−λT)</th>
            <th className="font-medium">Min. safe cushion (3σ√d)</th>
          </tr>
        </thead>
        <tbody className="num">
          {ins.hazard.map((h, i) => (
            <tr key={h.duration} className="border-t border-slate-800">
              <td className="py-1">{h.duration}t</td>
              <td>{pct(h.p, 3)}</td>
              <td>
                {ins.cushion[i].price.toFixed(decimals)} ({ins.cushion[i].pips} pips)
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500">Poisson arrivals are memoryless — time since the last jump does not change the hazard; λ̂ blends the configured prior with jumps observed in the buffer.</p>
      <Trigger
        on={ins.postJump.active}
        text={ins.postJump.active ? `Post-jump window (10–30t): drift ${ins.postJump.direction > 0 ? "up" : "down"} ${ins.postJump.drift.toFixed(decimals)}` : `Outside post-jump window${ins.ticksSinceJump !== null ? ` (${ins.ticksSinceJump}t since jump)` : ""}`}
      />
    </div>
  );
}

function Trigger({ on, text }: { on: boolean; text: string }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${on ? "border-sky-600 bg-sky-950/40 text-sky-200" : "border-slate-800 text-slate-400"}`}>
      <span className="font-semibold">{on ? "● TRIGGER " : "○ "}</span>
      {text}
    </div>
  );
}
