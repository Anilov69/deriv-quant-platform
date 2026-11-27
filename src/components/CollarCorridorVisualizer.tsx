import type { ReactElement } from "react";
import type { CollarImpulse, CollarSide } from "@/utils/collarMath";
import { clamp, corridorWidth, formatPrice } from "@/utils/collarMath";

export interface CollarVisualizerState {
  direction: CollarSide;
  entrySpot: number;
  targetSpot: number;
  lockSpot: number | null;
  locked: boolean;
  duration: number;
  ticksElapsed: number;
  lockStart: number;
  lockEnd: number;
  leg2Duration: number | null;
}

interface Props {
  prices: readonly number[];
  decimals: number;
  impulse: CollarImpulse;
  active: CollarVisualizerState | null;
}

const W = 640;
const H = 232;
const LEFT = 12;
const RIGHT = 82;
const TOP = 14;
const BOTTOM = 24;

export default function CollarCorridorVisualizer({ prices, decimals, impulse, active }: Props): ReactElement {
  const series = prices.filter((price) => Number.isFinite(price) && price > 0).slice(-40);
  const values = [...series];
  if (active) {
    values.push(active.entrySpot, active.targetSpot);
    if (active.lockSpot !== null) values.push(active.lockSpot);
  }
  const rawMin = values.length > 0 ? Math.min(...values) : 0;
  const rawMax = values.length > 0 ? Math.max(...values) : 1;
  const span = Math.max(rawMax - rawMin, 0.0000001);
  const pad = span * 0.12;
  const min = rawMin - pad;
  const max = rawMax + pad;
  const y = (value: number): number => TOP + ((max - value) / (max - min)) * (H - TOP - BOTTOM);
  const x = (index: number): number => {
    if (series.length <= 1) return LEFT;
    return LEFT + (index / (series.length - 1)) * (W - LEFT - RIGHT);
  };
  const path = series.map((price, index) => (index === 0 ? "M" : "L") + x(index).toFixed(2) + " " + y(price).toFixed(2)).join(" ");
  const last = series.length > 0 ? series[series.length - 1] : null;
  const gauge = clamp(impulse.ratio, -3, 3);
  const gaugePct = ((gauge + 3) / 6) * 100;
  const lockedWidth = active?.locked && active.lockSpot !== null ? corridorWidth(active.entrySpot, active.lockSpot) : null;
  const windowClosed = active !== null && !active.locked && active.ticksElapsed > active.lockEnd;
  const progress = active ? clamp((active.ticksElapsed / Math.max(1, active.duration)) * 100, 0, 100) : 0;

  return (
    <section className="rounded-lg border border-line bg-panel p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Live Collar Corridor</h2>
          <p className="mt-0.5 text-[10px] text-muted">Last 40 ticks · entry, lock trigger and profit corridor geometry</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <span className="rounded border border-line bg-ink/60 px-2 py-1 text-muted">
            Spot <span className="font-mono text-slate-100">{formatPrice(last ?? 0, decimals)}</span>
          </span>
          <span className="rounded border border-line bg-ink/60 px-2 py-1 text-muted">
            ATR20 <span className="font-mono text-slate-100">{formatPrice(impulse.atr20, decimals)}</span>
          </span>
          <span className={"rounded border px-2 py-1 " + (impulse.ready ? "border-accent/40 bg-accent/10 text-accent" : "border-amber-400/40 bg-amber-400/10 text-amber-200")}>
            {impulse.ready ? "IMPULSE READY" : "WARMING " + impulse.samples + "/60"}
          </span>
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded border border-line bg-ink">
        {series.length < 2 ? (
          <div className="flex h-[232px] items-center justify-center text-[11px] text-muted">
            Waiting for the 60-tick seed before drawing the corridor.
          </div>
        ) : (
          <svg viewBox={"0 0 " + W + " " + H} className="h-[232px] w-full" role="img" aria-label="Last 40 ticks with collar geometry">
            <defs>
              <linearGradient id="collar-price-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4ade80" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#4ade80" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((fraction) => (
              <line
                key={fraction}
                x1={LEFT}
                x2={W - RIGHT}
                y1={TOP + fraction * (H - TOP - BOTTOM)}
                y2={TOP + fraction * (H - TOP - BOTTOM)}
                stroke="#1f2d3a"
                strokeDasharray="3 4"
              />
            ))}
            {active && lockedWidth !== null && active.lockSpot !== null ? (
              <rect
                x={LEFT}
                y={Math.min(y(active.entrySpot), y(active.lockSpot))}
                width={W - LEFT - RIGHT}
                height={Math.abs(y(active.entrySpot) - y(active.lockSpot))}
                fill="#4ade80"
                fillOpacity="0.16"
              />
            ) : null}
            <path d={path + " L" + x(series.length - 1).toFixed(2) + " " + (H - BOTTOM) + " L" + x(0).toFixed(2) + " " + (H - BOTTOM) + " Z"} fill="url(#collar-price-fill)" />
            <path d={path} fill="none" stroke="#4ade80" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
            {active ? (
              <>
                <line x1={LEFT} x2={W - RIGHT} y1={y(active.entrySpot)} y2={y(active.entrySpot)} stroke="#60a5fa" strokeWidth="1.2" strokeDasharray="6 4" />
                <text x={W - RIGHT + 5} y={y(active.entrySpot) + 3} fill="#93c5fd" fontSize="9" fontFamily="monospace">S0 {formatPrice(active.entrySpot, decimals)}</text>
                <line x1={LEFT} x2={W - RIGHT} y1={y(active.targetSpot)} y2={y(active.targetSpot)} stroke="#fbbf24" strokeWidth="1.2" strokeDasharray="2 4" />
                <text x={W - RIGHT + 5} y={y(active.targetSpot) + 3} fill="#fcd34d" fontSize="9" fontFamily="monospace">LOCK {formatPrice(active.targetSpot, decimals)}</text>
                {active.locked && active.lockSpot !== null ? (
                  <>
                    <line x1={LEFT} x2={W - RIGHT} y1={y(active.lockSpot)} y2={y(active.lockSpot)} stroke="#fbbf24" strokeWidth="1.4" />
                    <circle cx={W - RIGHT} cy={y(active.lockSpot)} r="3" fill="#fbbf24" />
                  </>
                ) : null}
              </>
            ) : null}
            {last !== null ? (
              <circle cx={x(series.length - 1)} cy={y(last)} r="3.5" fill="#4ade80" stroke="#080d12" strokeWidth="1.5" />
            ) : null}
          </svg>
        )}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px]">
        <div>
          <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-muted">
            <span>Impulse ratio</span>
            <span className={"font-mono " + (impulse.ratio > 0 ? "text-emerald-300" : impulse.ratio < 0 ? "text-danger" : "text-slate-300")}>
              {impulse.ratio >= 0 ? "+" : ""}{impulse.ratio.toFixed(2)}×
            </span>
          </div>
          <div className="relative mt-1 h-2 rounded-full bg-ink">
            <div className="absolute left-1/2 top-0 h-2 w-px bg-line" />
            <div
              className={"absolute top-0 h-2 w-2 -translate-x-1/2 rounded-full " + (impulse.ratio >= 0 ? "bg-emerald-400" : "bg-danger")}
              style={{ left: gaugePct + "%" }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[8px] text-muted">
            <span>-3.0×</span><span>0</span><span>+3.0×</span>
          </div>
        </div>
        <div className="rounded border border-line bg-ink/60 px-2 py-1.5">
          <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-muted">
            <span>Δ5 / ATR20</span>
            <span className="font-mono text-slate-200">{formatPrice(impulse.delta5, decimals)} / {formatPrice(impulse.atr20, decimals)}</span>
          </div>
          <p className="mt-1 text-[9px] leading-relaxed text-muted">
            {active ? (active.direction === "call" ? "CALL leg first; PUT collar locks above S0." : "PUT leg first; CALL collar locks below S0.") : "Auto impulse follows the sign; directional modes only trade with their bias."}
          </p>
        </div>
      </div>

      {active ? (
        <div className="mt-3 rounded border border-line bg-ink/60 px-2.5 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={"rounded border px-2 py-0.5 text-[9px] font-semibold " + (active.locked ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : windowClosed ? "border-line text-muted" : "border-amber-400/50 bg-amber-400/10 text-amber-200")}>
              {active.locked && lockedWidth !== null
                ? "COLLAR LOCKED · CORRIDOR WIDTH: " + lockedWidth.toFixed(decimals) + " pts"
                : windowClosed
                  ? "PEAK-LOCK WINDOW CLOSED · UNLOCKED SOLO"
                  : "PEAK-LOCK WINDOW T+" + active.lockStart + " TO T+" + active.lockEnd}
            </span>
            <span className="font-mono text-[10px] text-slate-300">Tick {Math.min(active.ticksElapsed, active.duration)} / {active.duration}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
            <div className={"h-full rounded-full " + (active.locked ? "bg-emerald-400" : "bg-amber-400")} style={{ width: progress + "%" }} />
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-2 text-[8px] uppercase tracking-widest text-muted">
            <span>{active.locked ? "Both legs expire on the same terminal tick" : "Leg 2 only while remaining ticks ≥ 5 and meet the market minimum"}</span>
            <span>{active.locked ? "Leg 2 duration: " + (active.leg2Duration ?? "-") + " ticks" : "No second stake spent"}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
