import type { ReactElement } from "react";

interface Props {
  symbol: string;
  prices: readonly number[];
  upperBarrier: number;
  lowerBarrier: number;
  decimals: number;
  fastAtr: number;
  baselineAtr: number;
  squeezeRatio: number;
  threshold: number;
  squeezeReady: boolean;
  ready: boolean;
}

const WIDTH = 720;
const HEIGHT = 250;
const PAD = { left: 12, right: 92, top: 18, bottom: 28 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function BarrierChannelVisualizer(props: Props): ReactElement {
  const { symbol, upperBarrier, lowerBarrier, decimals, fastAtr, baselineAtr, squeezeRatio, threshold, ready } = props;
  const prices = props.prices.slice(-40).filter((price) => Number.isFinite(price) && price > 0);
  const spot = prices.length > 0 ? prices[prices.length - 1] : 0;
  const values = [...prices, upperBarrier, lowerBarrier].filter((price) => Number.isFinite(price) && price > 0);
  const rawMin = values.length > 0 ? Math.min(...values) : 0;
  const rawMax = values.length > 0 ? Math.max(...values) : 0;
  const padding = Math.max((rawMax - rawMin) * 0.18, spot * 0.0002, 0.01);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const span = Math.max(max - min, 0.000001);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const yFor = (price: number): number => PAD.top + ((max - price) / span) * plotHeight;
  const xFor = (index: number): number =>
    prices.length <= 1 ? PAD.left + plotWidth : PAD.left + (index / (prices.length - 1)) * plotWidth;
  const linePoints = prices.map((price, index) => xFor(index).toFixed(1) + "," + yFor(price).toFixed(1)).join(" ");
  const areaPoints =
    prices.length > 0
      ? PAD.left + "," + (PAD.top + plotHeight) + " " + linePoints + " " + (PAD.left + plotWidth) + "," + (PAD.top + plotHeight)
      : "";
  const upperY = yFor(upperBarrier);
  const lowerY = yFor(lowerBarrier);
  const spotY = yFor(spot);
  const grid = [0, 1, 2, 3].map((index) => PAD.top + (index / 3) * plotHeight);
  const ratioPercent = Math.max(0, Math.round(squeezeRatio * 100));
  const thresholdPercent = Math.round(clamp(threshold, 0.1, 2) * 100);
  const ratioWidth = clamp(ratioPercent, 0, 180);
  const state = !ready ? "WARMING UP" : squeezeRatio <= threshold ? "COILED / SQUEEZE READY" : "EXPANDING / NORMAL";
  const stateTone = !ready
    ? "border-line bg-ink text-muted"
    : squeezeRatio <= threshold
      ? "border-accent/50 bg-accent/10 text-accent"
      : "border-amber-400/40 bg-amber-400/10 text-amber-300";

  return (
    <div className="rounded border border-line bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted">Live barrier channel</p>
          <p className="mt-0.5 font-mono text-xs text-slate-300">
            {symbol || "no market"} <span className="text-muted">·</span> {prices.length} / 40 ticks
            <span className="mx-2 text-muted">·</span> spot <span className="text-slate-100">{spot > 0 ? spot.toFixed(decimals) : "-"}</span>
          </p>
        </div>
        <span className={"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide " + stateTone}>
          <span className={"h-1.5 w-1.5 rounded-full " + (!ready ? "bg-muted" : squeezeRatio <= threshold ? "animate-pulse bg-accent" : "bg-amber-400")} />
          {state}
        </span>
      </div>

      <div className="mt-3 overflow-hidden rounded border border-line bg-ink">
        <svg viewBox={"0 0 " + WIDTH + " " + HEIGHT} className="h-auto w-full" role="img" aria-label="Last 40 ticks with upper and lower one-touch barriers">
          <defs>
            <linearGradient id="touch-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          {grid.map((y, index) => (
            <g key={index}>
              <line x1={PAD.left} y1={y} x2={PAD.left + plotWidth} y2={y} stroke="currentColor" strokeOpacity="0.08" strokeDasharray="3 5" />
              <text x={PAD.left + plotWidth + 8} y={y + 3} fill="currentColor" opacity="0.55" fontSize="10" fontFamily="monospace">
                {(max - (index / 3) * span).toFixed(decimals)}
              </text>
            </g>
          ))}

          {upperBarrier > 0 && lowerBarrier > 0 ? (
            <rect
              x={PAD.left}
              y={Math.min(upperY, lowerY)}
              width={plotWidth}
              height={Math.max(1, Math.abs(lowerY - upperY))}
              fill="currentColor"
              opacity="0.045"
            />
          ) : null}

          {prices.length > 1 ? (
            <>
              <polygon points={areaPoints} fill="url(#touch-area)" className="text-accent" />
              <polyline points={linePoints} fill="none" stroke="currentColor" strokeWidth="2" className="text-accent" strokeLinejoin="round" strokeLinecap="round" />
            </>
          ) : (
            <text x={PAD.left + plotWidth / 2} y={PAD.top + plotHeight / 2} textAnchor="middle" fill="currentColor" opacity="0.5" fontSize="11">
              Waiting for live ticks…
            </text>
          )}

          {spot > 0 ? (
            <>
              <line x1={PAD.left} y1={spotY} x2={PAD.left + plotWidth} y2={spotY} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="2 4" />
              <circle cx={xFor(prices.length - 1)} cy={spotY} r="3.5" className="fill-accent" />
            </>
          ) : null}

          {upperBarrier > 0 ? (
            <>
              <line x1={PAD.left} y1={upperY} x2={PAD.left + plotWidth} y2={upperY} stroke="currentColor" strokeDasharray="7 5" strokeWidth="1.5" className="text-accent" />
              <text x={PAD.left + 6} y={upperY - 6} fill="currentColor" className="text-accent" fontSize="10" fontFamily="monospace">
                UPPER +{props.upperBarrier ? Math.abs(upperBarrier - spot).toFixed(decimals) : "0.00"} · {upperBarrier.toFixed(decimals)}
              </text>
            </>
          ) : null}
          {lowerBarrier > 0 ? (
            <>
              <line x1={PAD.left} y1={lowerY} x2={PAD.left + plotWidth} y2={lowerY} stroke="currentColor" strokeDasharray="7 5" strokeWidth="1.5" className="text-danger" />
              <text x={PAD.left + 6} y={lowerY + 14} fill="currentColor" className="text-danger" fontSize="10" fontFamily="monospace">
                LOWER -{props.lowerBarrier ? Math.abs(spot - lowerBarrier).toFixed(decimals) : "0.00"} · {lowerBarrier.toFixed(decimals)}
              </text>
            </>
          ) : null}
        </svg>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded border border-line bg-ink px-3 py-2">
          <p className="text-[9px] uppercase tracking-widest text-muted">Fast ATR (10t)</p>
          <p className="font-mono text-sm text-slate-100">{fastAtr > 0 ? fastAtr.toFixed(4) : "-"}</p>
        </div>
        <div className="rounded border border-line bg-ink px-3 py-2">
          <p className="text-[9px] uppercase tracking-widest text-muted">Baseline ATR (50t)</p>
          <p className="font-mono text-sm text-slate-100">{baselineAtr > 0 ? baselineAtr.toFixed(4) : "-"}</p>
        </div>
        <div className="rounded border border-line bg-ink px-3 py-2">
          <p className="text-[9px] uppercase tracking-widest text-muted">Squeeze ratio</p>
          <p className={"font-mono text-sm " + (ready && squeezeRatio <= threshold ? "text-accent" : "text-amber-300")}>
            {ready ? ratioPercent + "%" : "warming up"}
            <span className="ml-1 text-[9px] text-muted">≤ {thresholdPercent}% armed</span>
          </p>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-[9px] text-muted">
          <span>ATR compression gauge</span>
          <span>threshold {thresholdPercent}%</span>
        </div>
        <div className="relative mt-1 h-2 overflow-hidden rounded-full bg-ink">
          <div className={"h-full rounded-full transition-all " + (squeezeRatio <= threshold ? "bg-accent" : "bg-amber-400")} style={{ width: ratioWidth + "%" }} />
          <div className="absolute inset-y-0 w-px bg-slate-100/50" style={{ left: Math.min(100, thresholdPercent / 1.8) + "%" }} />
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-muted">
          <span>compressed</span>
          <span>fast / baseline = {squeezeRatio.toFixed(2)}x</span>
          <span>stretched</span>
        </div>
      </div>
    </div>
  );
}
