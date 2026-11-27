import type { ReactElement } from "react";
import type { PhoenixGear, PhoenixScenario } from "@/utils/phoenixMath";

export interface PhoenixGeometry {
  spot: number;
  koBarrierOffset: number;
  touchBarrierOffset: number;
  dangerTriggerPct: number;
  trailingFloor: number | null;
  peakBid: number | null;
  buyPrice: number;
  peakBidPrice: number | null;
}

interface Props {
  gear: PhoenixGear;
  geometry: PhoenixGeometry;
  scenarios: PhoenixScenario[];
  active: boolean;
}

function signed(value: number): string {
  return (value >= 0 ? "+" : "") + "$" + value.toFixed(2);
}

export default function PhoenixPayoffVisualizer({ gear, geometry, scenarios, active }: Props): ReactElement {
  const center = 300;
  const halfWidth = 260;
  const spotX = center;
  const koAbs = Math.abs(geometry.koBarrierOffset);
  const touchAbs = Math.abs(geometry.touchBarrierOffset);
  const koX = Math.max(100, Math.min(500, center + (geometry.koBarrierOffset >= 0 ? koAbs : -koAbs) * 14));
  const touchX = Math.max(120, Math.min(480, center + geometry.touchBarrierOffset * 14));
  const dangerDistance = koAbs * geometry.dangerTriggerPct / 100;
  const dangerOffset = geometry.koBarrierOffset >= 0 ? dangerDistance : -dangerDistance;
  const dangerX = Math.max(130, Math.min(470, center + dangerOffset * 14));
  const trailingX = geometry.trailingFloor === null
    ? null
    : Math.max(90, Math.min(510, center + (geometry.trailingFloor - geometry.spot) * 14));

  return (
    <section className="rounded-lg border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Live Phoenix Geometry</h2>
          <p className="text-[10px] text-muted">Spot, barriers, danger trigger and trailing peak lock.</p>
        </div>
        <span className={"rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest " + (active ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300" : "border-line bg-ink/60 text-muted")}>
          Gear {gear} · {active ? "round live" : "standby"}
        </span>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="overflow-hidden rounded border border-line bg-ink/50">
          <svg viewBox="0 0 600 210" role="img" aria-label="Phoenix spot and barrier payoff geometry" className="h-auto w-full min-w-[280px]">
            <defs>
              <linearGradient id="phoenix-fill" x1="0" x2="1">
                <stop offset="0" stopColor="#38bdf8" stopOpacity="0.12" />
                <stop offset="0.5" stopColor="#10b981" stopOpacity="0.04" />
                <stop offset="1" stopColor="#f43f5e" stopOpacity="0.12" />
              </linearGradient>
            </defs>
            <rect x="40" y="20" width="520" height="155" rx="8" fill="url(#phoenix-fill)" stroke="#1e293b" />
            <line x1="40" y1="97" x2="560" y2="97" stroke="#334155" strokeWidth="1" />
            <line x1={spotX} y1="20" x2={spotX} y2="175" stroke="#38bdf8" strokeWidth="2" />
            {gear === 2 ? <line x1={koX} y1="20" x2={koX} y2="175" stroke="#f43f5e" strokeWidth="2" /> : null}
            {touchAbs > 0 ? <line x1={touchX} y1="20" x2={touchX} y2="175" stroke="#f59e0b" strokeWidth="2" /> : null}
            {gear === 2 ? <line x1={dangerX} y1="20" x2={dangerX} y2="175" stroke="#a78bfa" strokeDasharray="7 5" strokeWidth="1.5" /> : null}
            {trailingX !== null ? <line x1={trailingX} y1="20" x2={trailingX} y2="175" stroke="#34d399" strokeDasharray="3 4" strokeWidth="2" /> : null}
            <circle cx={spotX} cy="97" r="5" fill="#38bdf8" />
            <text x={spotX} y="190" fill="#7dd3fc" fontSize="10" textAnchor="middle">SPOT {geometry.spot > 0 ? geometry.spot.toFixed(3) : "—"}</text>
            {gear === 2 ? <text x={koX} y="32" fill="#fb7185" fontSize="9" textAnchor="middle">TURBO KO</text> : null}
            {touchAbs > 0 ? <text x={touchX} y="48" fill="#fbbf24" fontSize="9" textAnchor="middle">INTERIOR BARRIER</text> : null}
            {gear === 2 ? <text x={dangerX} y="64" fill="#c4b5fd" fontSize="9" textAnchor="middle">DANGER {geometry.dangerTriggerPct}%</text> : null}
            {trailingX !== null ? <text x={trailingX} y="80" fill="#6ee7b7" fontSize="9" textAnchor="middle">PEAK FLOOR</text> : null}
          </svg>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {scenarios.map((scenario) => {
            const tone = scenario.tone === "emerald"
              ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
              : scenario.tone === "amber"
                ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
                : scenario.tone === "sky"
                  ? "border-sky-400/40 bg-sky-400/10 text-sky-200"
                  : "border-line bg-ink/50 text-slate-300";
            return (
              <div key={scenario.label} className={"rounded border p-2 " + tone}>
                <p className="min-h-[28px] text-[8px] uppercase leading-tight tracking-widest">{scenario.label}</p>
                <p className="mt-1 font-mono text-sm">{signed(scenario.net)}</p>
              </div>
            );
          })}
          <div className="col-span-2 rounded border border-line bg-ink/50 px-2 py-1.5">
            <div className="flex justify-between text-[9px] text-muted">
              <span>Buy price</span><span className="font-mono text-slate-200">${geometry.buyPrice.toFixed(2)}</span>
            </div>
            <div className="mt-1 flex justify-between text-[9px] text-muted">
              <span>Peak bid</span><span className="font-mono text-emerald-300">${geometry.peakBid === null ? "—" : geometry.peakBid.toFixed(2)}</span>
            </div>
            <div className="mt-1 flex justify-between text-[9px] text-muted">
              <span>Trailing floor</span><span className="font-mono text-emerald-300">${geometry.trailingFloor === null ? "—" : geometry.trailingFloor.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
