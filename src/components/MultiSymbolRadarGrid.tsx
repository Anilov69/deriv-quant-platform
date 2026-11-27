import type { ReactElement } from "react";
import type { ParoliTail, ProgressionMode } from "@/utils/paroliMath";
import { highTail, lowTail, tailShort } from "@/utils/paroliMath";

export interface RadarCardView {
  symbol: string;
  name: string;
  enabled: boolean;
  quote: number | null;
  digit: number | null;
  decimals: number;
  high: number;
  low: number;
  lowStreak: number;
  highStreak: number;
  centerDrought: number;
  ready: boolean;
  overAvailable: boolean;
  underAvailable: boolean;
  shared: boolean;
  error: string | null;
}

export interface BurstView {
  symbol: string;
  tail: ParoliTail;
  step: number;
  totalSteps: number;
  stepStake: number;
  stepPayout: number;
  stepStates: Array<"won" | "lost" | "active" | "pending">;
}

export interface Step2Watch {
  hopping: boolean;
  mode: ProgressionMode;
  clusterThreshold: number;
  centerThreshold: number;
  armed: boolean;
}

interface Props {
  cards: RadarCardView[];
  threshold: number;
  burst: BurstView | null;
  busy: boolean;
  snipeDisabled: boolean;
  step2?: Step2Watch;
  onToggle: (symbol: string) => void;
  onSnipe: (symbol: string) => void;
}

function progressTone(value: number, threshold: number, firing: boolean): string {
  if (firing) return "bg-emerald-400 animate-pulse";
  if (value >= threshold) return "bg-emerald-400";
  if (value >= Math.max(1, threshold - 2)) return "bg-amber-400";
  return "bg-slate-500";
}

function progressWidth(value: number, threshold: number): string {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, threshold)) * 100));
  return pct.toFixed(0) + "%";
}

function DroughtBar({
  label,
  value,
  threshold,
  firing,
  unavailable,
}: {
  label: string;
  value: number;
  threshold: number;
  firing: boolean;
  unavailable: boolean;
}): ReactElement {
  return (
    <div>
      <div className="flex items-center justify-between text-[9px]">
        <span className={unavailable ? "text-muted line-through" : "text-slate-400"}>{label}</span>
        <span className={"font-mono " + (firing ? "text-emerald-300" : value >= threshold ? "text-emerald-300" : "text-slate-300")}>
          {unavailable ? "n/a" : value + " / " + threshold}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
        <div className={"h-full rounded-full transition-all " + progressTone(value, threshold, firing)} style={{ width: unavailable ? "0%" : progressWidth(value, threshold) }} />
      </div>
    </div>
  );
}

function DigitBadge({ digit }: { digit: number | null }): ReactElement {  if (digit === null) return <span className="rounded border border-line px-2 py-0.5 font-mono text-sm text-muted">-</span>;
  const tone = highTail(digit)
    ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300"
    : lowTail(digit)
      ? "border-sky-400/50 bg-sky-400/10 text-sky-300"
      : "border-slate-500/50 bg-slate-500/10 text-slate-200";
  return <span className={"rounded border px-2 py-0.5 font-mono text-sm font-semibold " + tone}>{digit}</span>;
}

function MiniMeter({
  label,
  value,
  threshold,
  tone,
}: {
  label: string;
  value: number;
  threshold: number;
  tone: "sky" | "emerald";
}): ReactElement {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, threshold)) * 100));
  const bar = tone === "sky" ? "bg-sky-400" : "bg-emerald-400";
  const text = value >= threshold ? (tone === "sky" ? "text-sky-300" : "text-emerald-300") : "text-slate-400";
  return (
    <div>
      <div className="flex items-center justify-between gap-1 text-[8px]">
        <span className="truncate text-muted">{label}</span>
        <span className={"shrink-0 font-mono " + text}>{value}/{threshold}</span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-line">
        <div className={"h-full rounded-full " + bar} style={{ width: pct.toFixed(0) + "%" }} />
      </div>
    </div>
  );
}

function BurstBanner({ burst }: { burst: BurstView }): ReactElement {
  const stepLabel = "STEP " + burst.step + " OF " + burst.totalSteps;
  const moneyLabel = burst.step > 1 ? "HOUSE MONEY" : "BASE RISK";
  return (
    <div className="rounded-lg border border-emerald-400/50 bg-emerald-400/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-300">BURST LOCKED ON {burst.symbol} · {stepLabel} ({moneyLabel} ${burst.stepStake.toFixed(2)})</p>
        <span className="rounded-full border border-emerald-400/40 px-2 py-0.5 font-mono text-[10px] text-emerald-200">{tailShort(burst.tail)} · est. ${burst.stepPayout.toFixed(2)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {burst.stepStates.map((state, index) => {
          const tone =
            state === "won"
              ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-200"
              : state === "lost"
                ? "border-danger/60 bg-danger/15 text-danger"
                : state === "active"
                  ? "border-amber-400/60 bg-amber-400/15 text-amber-200 animate-pulse"
                  : "border-line bg-ink/60 text-muted";
          return (
            <span key={index} className="flex items-center gap-1.5">
              <span className={"rounded-full border px-2 py-0.5 text-[9px] font-semibold " + tone}>
                Step {index + 1} · {state === "won" ? "WIN" : state === "lost" ? "LOSS" : state === "active" ? "LIVE" : "PENDING"}
              </span>
              {index < burst.stepStates.length - 1 ? <span className="text-muted">→</span> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function MultiSymbolRadarGrid({ cards, threshold, burst, busy, snipeDisabled, step2, onToggle, onSnipe }: Props): ReactElement {
  return (
    <section className="rounded-lg border border-line bg-panel p-3" aria-label="Multi-symbol sniper radar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Multi-Symbol Sniper Radar</h2>
          <p className="text-[10px] text-muted">Five 1HZ feeds plus optional Jump indices. Droughts reset whenever the tail lands.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {step2?.hopping ? (
            <span className={"rounded-full border px-2 py-0.5 font-mono text-[10px] " + (step2.armed ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-200 animate-pulse" : "border-line text-muted")}>
              {step2.armed ? "step 2 armed · hopping" : "step 2 hopping"}
            </span>
          ) : null}
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-muted">trigger {threshold} ticks</span>
        </div>
      </div>
      {burst ? <div className="mt-3"><BurstBanner burst={burst} /></div> : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => {
          const firing = burst?.symbol === card.symbol;
          const overFiring = firing && burst?.tail === "over";
          const underFiring = firing && burst?.tail === "under";
          return (
            <article
              key={card.symbol}
              className={"rounded-lg border p-2.5 transition-colors " + (firing ? "border-emerald-400/60 bg-emerald-400/5" : card.enabled ? "border-line bg-ink/50" : "border-line/60 bg-ink/20 opacity-60")}
            >
              <div className="flex items-start justify-between gap-2">
                <label className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-slate-200">
                  <input
                    type="checkbox"
                    checked={card.enabled}
                    disabled={busy || firing}
                    onChange={() => onToggle(card.symbol)}
                    aria-label={"Enable " + card.symbol + " in radar"}
                  />
                  <span className="font-mono">{card.symbol}</span>
                </label>
                <DigitBadge digit={card.quote === null ? null : card.digit} />
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <p className="truncate text-[9px] text-muted">{card.name}</p>
                <p className="font-mono text-sm text-slate-100">{card.quote === null ? "-" : card.quote.toFixed(card.decimals)}</p>
              </div>
              <div className="mt-2 space-y-2">
                <DroughtBar label="Over 6 (7,8,9)" value={card.high} threshold={threshold} firing={overFiring} unavailable={!card.overAvailable} />
                <DroughtBar label="Under 3 (0,1,2)" value={card.low} threshold={threshold} firing={underFiring} unavailable={!card.underAvailable} />
              </div>
              {step2?.hopping ? (
                <div className="mt-2 rounded border border-line/70 bg-ink/40 p-1.5">
                  <p className="text-[8px] font-bold uppercase tracking-widest text-muted">
                    Step-2 watch{step2.armed ? " · live" : ""}
                  </p>
                  <div className="mt-1">
                    {step2.mode === "paroli_cushion" ? (
                      <MiniMeter label="Center drought (no 4/5)" value={card.centerDrought} threshold={step2.centerThreshold} tone="emerald" />
                    ) : step2.mode === "classic_tail" ? (
                      <MiniMeter label="Tail drought" value={Math.max(card.high, card.low)} threshold={threshold} tone="emerald" />
                    ) : (
                      <div className="space-y-1">
                        <MiniMeter label="Low 0-4 -> Over 4" value={card.lowStreak} threshold={step2.clusterThreshold} tone="sky" />
                        <MiniMeter label="High 5-9 -> Under 5" value={card.highStreak} threshold={step2.clusterThreshold} tone="emerald" />
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="truncate text-[9px] text-muted">
                  {card.error ? card.error : !card.ready ? "seeding 50 ticks..." : card.shared ? "listening to shared stream" : !card.overAvailable && !card.underAvailable ? "no digit tails offered" : "live stream"}
                </span>
                <button
                  type="button"
                  onClick={() => onSnipe(card.symbol)}
                  disabled={snipeDisabled || !card.enabled || !card.ready || !card.quote || (!card.overAvailable && !card.underAvailable)}
                  className="rounded border border-accent/40 px-2 py-1 text-[9px] font-semibold text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Snipe
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {cards.length === 0 ? <p className="mt-3 text-xs text-muted">Connect to Deriv to open the radar pool.</p> : null}
    </section>
  );
}
