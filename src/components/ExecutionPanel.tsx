"use client";
import { CONTRACT_LABEL } from "@/lib/markets";
import type { SignalRow } from "@/lib/signals";
import { pct, signed } from "@/lib/format";
import { guardrailBlock, requoteNow } from "@/services/session";
import { currentAccount, useStore, type Guardrails } from "@/store/useStore";
import type { EngineSettings } from "@/engines/types";

function Num({ label, value, onChange, step = 1, min = 0, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; suffix?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-0.5 flex items-center gap-1">
        <input
          type="number"
          className="input num !py-1"
          value={value}
          step={step}
          min={min}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= min) onChange(v);
          }}
        />
        {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
      </div>
    </label>
  );
}

export function ExecutionPanel({ best, onExecute }: { best: SignalRow | null; onExecute: (r: SignalRow, auto: boolean) => void }) {
  const s = useStore();
  const g = s.guardrails;
  const st = s.settings;
  const acct = currentAccount(s);
  const block = guardrailBlock();
  const setG = (p: Partial<Guardrails>) => s.set({ guardrails: { ...g, ...p } });
  const setS = (p: Partial<EngineSettings>, requote = false) => {
    s.set({ settings: { ...st, ...p } });
    if (requote) requoteNow();
  };
  const mine = s.trades.filter((t) => t.accountId === s.accountId && t.profit !== undefined && t.status !== "open");
  const pnl = mine.reduce((a, t) => a + (t.profit ?? 0), 0);

  return (
    <div className={`panel ${acct?.account_type === "real" ? "!border-red-500/60" : ""}`}>
      <div className="panel-title">
        <span>Execution & risk guardrails</span>
        <span className={`text-xs font-normal ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>Session P&L {signed(pnl)} {s.currency}</span>
      </div>
      <div className="space-y-4 p-4">
        <div className={`rounded-lg border p-3 ${best ? "border-emerald-500/60 bg-emerald-950/30" : "border-slate-800 bg-slate-950/40"}`} data-testid="recommendation">
          <div className="label">Recommended trade</div>
          {best ? (
            <div className="mt-1 text-sm">
              <div className="font-semibold text-emerald-300">
                {CONTRACT_LABEL[best.contractType]} {best.barrier ?? ""} · {best.duration} ticks
              </div>
              <div className="num mt-0.5 text-xs text-slate-300">
                P_model {pct(best.pModel, 2)} vs P_be {pct(best.pBe, 2)} · EV {signed(best.evPerStake * 100)}% · stake {best.kellyStake.toFixed(2)} {s.currency}
              </div>
            </div>
          ) : (
            <p className="mt-1 text-xs text-slate-400">No contract currently passes the EV filter. This is the normal state: Deriv&apos;s payouts are priced below fair odds.</p>
          )}
          <button className="btn-primary mt-3 w-full" disabled={!best || !!block || s.busy} onClick={() => best && onExecute(best, false)} data-testid="execute-recommended">
            {s.busy ? "Placing order…" : "Execute recommended trade"}
          </button>
          {block && <p className="mt-1.5 text-[11px] text-amber-300">⛔ {block}</p>}
        </div>

        <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 px-3 py-2">
          <div>
            <div className="text-sm font-semibold">Semi-auto mode</div>
            <div className="text-[11px] text-slate-500">Auto-executes actionable signals, one at a time, within the guardrails below.</div>
          </div>
          <input
            type="checkbox"
            className="h-5 w-5 accent-sky-500"
            checked={s.autoMode}
            disabled={!!block && !s.autoMode}
            onChange={(e) => s.set({ autoMode: e.target.checked })}
            data-testid="auto-mode"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <Num label="Max daily loss" value={g.maxDailyLoss} onChange={(v) => setG({ maxDailyLoss: v })} suffix={s.currency} />
          <Num label="Max consecutive losses" value={g.maxConsecutiveLosses} onChange={(v) => setG({ maxConsecutiveLosses: Math.max(1, Math.round(v)) })} min={1} />
          <Num label="Minimum EV" value={+(g.minEv * 100).toFixed(2)} step={0.5} onChange={(v) => setG({ minEv: v / 100 })} suffix="%" />
          <Num label="Max risk / trade" value={g.maxRiskPct} step={0.5} onChange={(v) => setG({ maxRiskPct: v })} suffix="%" />
          <Num label="Kelly multiplier" value={g.kellyMultiplier} step={0.05} onChange={(v) => setG({ kellyMultiplier: Math.min(1, v) })} />
          <Num label="Min sample (n)" value={g.minSample} onChange={(v) => setG({ minSample: Math.round(v) })} />
          <Num label="Min edge Z" value={g.minEdgeZ} step={0.1} onChange={(v) => setG({ minEdgeZ: v })} />
          <Num label="Quote / manual stake" value={g.quoteStake} step={1} min={0.35} onChange={(v) => setG({ quoteStake: v })} suffix={s.currency} />
        </div>

        <details className="rounded-lg border border-slate-800 px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold">Engine parameters</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Num label="Digit window" value={st.digitWindow} onChange={(v) => setS({ digitWindow: Math.min(1000, Math.max(20, Math.round(v))) })} />
            <Num label="Prior strength α" value={st.priorStrength} onChange={(v) => setS({ priorStrength: Math.round(v) })} />
            <Num label="Digit duration (t)" value={st.digitDuration} min={1} onChange={(v) => setS({ digitDuration: Math.min(10, Math.max(1, Math.round(v))) }, true)} />
            <label className="block">
              <span className="label">Rise/Fall durations</span>
              <input
                className="input num mt-0.5 !py-1"
                defaultValue={st.riseFallDurations.join(",")}
                onBlur={(e) => {
                  const d = [...new Set(e.target.value.split(",").map((x) => Math.round(Number(x))).filter((x) => x >= 1 && x <= 10))].sort((a, b) => a - b);
                  if (d.length) setS({ riseFallDurations: d }, true);
                }}
              />
            </label>
            <Num label="Bollinger N" value={st.bollingerN} min={5} onChange={(v) => setS({ bollingerN: Math.round(v) })} />
            <Num label="Exhaustion |Z|" value={st.bollingerZ} step={0.1} onChange={(v) => setS({ bollingerZ: v })} />
            <Num label="Min streak k" value={st.minStreak} min={2} onChange={(v) => setS({ minStreak: Math.round(v) })} />
            <Num label="Jump k × ATR₂₀" value={st.jumpAtrMultiple} step={0.5} onChange={(v) => setS({ jumpAtrMultiple: v })} />
            <Num label="Prior λ (jumps/h)" value={+(st.jumpLambda * 3600).toFixed(2)} step={0.5} onChange={(v) => setS({ jumpLambda: Math.max(0.01, v) / 3600 })} />
            <Num label="Jump hazard block" value={+(st.jumpHazardBlock * 100).toFixed(3)} step={0.1} onChange={(v) => setS({ jumpHazardBlock: v / 100 })} suffix="%" />
          </div>
        </details>
      </div>
    </div>
  );
}
