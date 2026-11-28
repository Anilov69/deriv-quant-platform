import type { ReactElement } from "react";
import type { ChronoGeometry } from "@/utils/chronoMath";

interface Props {
  geometry: ChronoGeometry;
  active: boolean;
  armed: boolean;
}

function signedMoney(value: number): string {
  return (value >= 0 ? "+$" : "-$") + Math.abs(value).toFixed(2);
}

export default function ChronoCorridorVisualizer({ geometry, active, armed }: Props): ReactElement {
  const values = [geometry.spot, geometry.entryStrike, geometry.rollingAsianMean, geometry.resetTarget ?? geometry.rollingAsianMean].filter((value) => Number.isFinite(value) && value > 0);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;
  const span = Math.max(max - min, 0.0001);
  const xFor = (value: number): number => 50 + ((value - min) / span) * 500;
  const entryX = geometry.entryStrike > 0 ? xFor(geometry.entryStrike) : 300;
  const meanX = geometry.rollingAsianMean > 0 ? xFor(geometry.rollingAsianMean) : 300;
  const resetX = geometry.resetTarget !== null && geometry.resetTarget > 0 ? xFor(geometry.resetTarget) : null;
  const spotX = geometry.spot > 0 ? xFor(geometry.spot) : 300;
  const lowX = Math.min(entryX, meanX, resetX ?? meanX);
  const highX = Math.max(entryX, meanX, resetX ?? meanX);
  const doubleWin = geometry.spot >= Math.min(geometry.entryStrike, geometry.rollingAsianMean) && geometry.spot <= Math.max(geometry.entryStrike, geometry.rollingAsianMean);
  const progress = geometry.vaultThreshold > 0 ? Math.min(100, Math.max(0, (geometry.bankedProfit / geometry.vaultThreshold) * 100)) : 0;

  return (
    <section className="rounded-lg border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Live Chrono Corridor</h2>
          <p className="text-[10px] text-muted">Asymmetric staggered corridor / virtual probe / 5% ACCU profit split.</p>
        </div>
        <span className={"rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest " + (active ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" : "border-line bg-ink/60 text-muted")}>{active ? "Round live" : "Standby"}</span>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_310px]">
        <div className="overflow-hidden rounded border border-line bg-ink/50">
          <svg viewBox="0 0 600 210" role="img" aria-label="Asymmetric Chrono corridor" className="h-auto w-full min-w-[280px]">
            <rect x="40" y="25" width="520" height="145" rx="8" fill="#0b1220" stroke="#1e293b" />
            {doubleWin ? <rect x={Math.max(40, lowX)} y="25" width={Math.max(12, Math.min(520, highX - lowX))} height="145" rx="6" fill="#10b981" fillOpacity="0.14" /> : null}
            <line x1={entryX} y1="25" x2={entryX} y2="170" stroke="#38bdf8" strokeWidth="2" />
            <line x1={meanX} y1="25" x2={meanX} y2="170" stroke="#a78bfa" strokeDasharray="6 5" strokeWidth="2" />
            {resetX !== null ? <line x1={resetX} y1="25" x2={resetX} y2="170" stroke="#f59e0b" strokeWidth="2" /> : null}
            <line x1={spotX} y1="18" x2={spotX} y2="176" stroke={doubleWin ? "#34d399" : "#e2e8f0"} strokeWidth="3" />
            <circle cx={spotX} cy="97" r="6" fill={doubleWin ? "#34d399" : "#e2e8f0"} />
            <text x={entryX} y="195" fill="#7dd3fc" fontSize="9" textAnchor="middle">S0 {geometry.entryStrike > 0 ? geometry.entryStrike.toFixed(3) : "—"}</text>
            <text x={meanX} y="42" fill="#c4b5fd" fontSize="9" textAnchor="middle">S-bar {geometry.rollingAsianMean > 0 ? geometry.rollingAsianMean.toFixed(3) : "—"}</text>
            {resetX !== null ? <text x={resetX} y="58" fill="#fbbf24" fontSize="9" textAnchor="middle">RESET TARGET</text> : null}
            <text x={spotX} y="16" fill={doubleWin ? "#6ee7b7" : "#e2e8f0"} fontSize="9" textAnchor="middle">SPOT {geometry.spot > 0 ? geometry.spot.toFixed(3) : "—"}</text>
          </svg>
        </div>

        <div className="space-y-2">
          <div className={"rounded border p-3 " + (doubleWin ? "border-emerald-400/50 bg-emerald-400/10" : "border-line bg-ink/50")}>
            <p className={"text-[8px] font-bold uppercase tracking-widest " + (doubleWin ? "text-emerald-300" : "text-muted")}>{doubleWin ? "Green double-win zone" : "Corridor not centered"}</p>
            <p className={"mt-1 font-mono text-lg " + (doubleWin ? "text-emerald-200" : "text-slate-300")}>{doubleWin ? "INSIDE CORRIDOR" : "SEARCHING"}</p>
          </div>

          <div className="rounded border border-line bg-ink/50 p-3">
            <div className="flex items-center justify-between gap-2"><p className="text-[9px] font-bold uppercase tracking-widest text-muted">House-money vault</p><span className={"rounded px-1.5 py-0.5 text-[8px] font-bold " + (armed ? "bg-emerald-400/15 text-emerald-300" : "bg-slate-500/10 text-slate-300")}>{armed ? "ARMED" : "LOCKED"}</span></div>
            <p className="mt-2 font-mono text-sm text-slate-100">{signedMoney(geometry.bankedProfit)} / ${geometry.vaultThreshold.toFixed(2)}</p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: progress.toFixed(0) + "%" }} /></div>
            <p className="mt-2 text-[9px] text-muted">Protected principal: <span className="font-mono text-slate-300">${geometry.protectedPrincipal.toFixed(2)}</span></p>
          </div>
        </div>
      </div>
    </section>
  );
}
