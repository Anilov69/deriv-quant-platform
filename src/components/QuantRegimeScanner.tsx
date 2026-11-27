import type { ReactElement } from "react";
import type {
  QuantContractKind,
  QuantDurationUnit,
  QuantFamily,
  QuantRegimeId,
} from "@/utils/quantEngineMath";

export interface QuantScannerRow {
  symbol: string;
  family: QuantFamily;
  watched: boolean;
  samples: number;
  ready: boolean;
  spot: number | null;
  atrRatio: number | null;
  efficiency30: number | null;
  hurst: number | null;
  ticksSinceJump: number | null;
  regime: QuantRegimeId | null;
  regimeLabel: string;
  posterior: number | null;
  contract: QuantContractKind | null;
  direction: -1 | 0 | 1;
  duration: number | null;
  unit: QuantDurationUnit | null;
  barrier: string | null;
  pRealized: number | null;
  pImplied: number | null;
  evPct: number | null;
  quoteAgeMs: number | null;
  historyError: string | null;
  contractError: string | null;
  quoteError: string | null;
}

interface Props {
  rows: QuantScannerRow[];
  minEv: number;
  busy: boolean;
  armed: boolean;
  paused: boolean;
  connected: boolean;
  executingSymbol: string | null;
  onExecute: (symbol: string) => void;
  onToggle: (symbol: string) => void;
}

function regimeTone(regime: QuantRegimeId | null): string {
  if (regime === 1) return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
  if (regime === 2) return "border-sky-400/40 bg-sky-400/10 text-sky-200";
  if (regime === 3) return "border-amber-400/40 bg-amber-400/10 text-amber-200";
  if (regime === 4) return "border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200";
  return "border-line bg-ink/60 text-muted";
}

function fmt(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function pct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : (value >= 0 ? "+" : "") + value.toFixed(1) + "%";
}

function directionGlyph(direction: -1 | 0 | 1): string {
  return direction > 0 ? "↑" : direction < 0 ? "↓" : "↔";
}

function contractTone(contract: QuantContractKind | null): string {
  if (contract === "NOTOUCH") return "text-emerald-200";
  if (contract === "ONETOUCH") return "text-fuchsia-200";
  if (contract === "CALL") return "text-sky-200";
  if (contract === "PUT") return "text-amber-200";
  return "text-muted";
}

export default function QuantRegimeScanner({
  rows,
  minEv,
  busy,
  armed,
  paused,
  connected,
  executingSymbol,
  onExecute,
  onToggle,
}: Props): ReactElement {
  const liveRows = rows.filter((row) => row.watched && row.ready);
  const qualified = liveRows.filter((row) => row.evPct !== null && row.evPct >= minEv);
  const warming = rows.filter((row) => row.watched && !row.ready).length;
  const best = liveRows.reduce<QuantScannerRow | null>((winner, row) => {
    if (row.evPct === null) return winner;
    if (!winner || winner.evPct === null || row.evPct > winner.evPct) return row;
    return winner;
  }, null);

  return (
    <section className="rounded-lg border border-line bg-panel/60">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-3 py-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-slate-100">Live Quant Matrix</h2>
            <span className="rounded-full border border-line px-2 py-0.5 text-[8px] uppercase tracking-widest text-muted">
              {rows.filter((row) => row.watched).length}/{rows.length} watched
            </span>
          </div>
          <p className="mt-1 max-w-xl text-[10px] leading-relaxed text-muted">
            Derived-imprint scanner: ATR compression, Kaufman efficiency, Hurst R/S and jump exhaustion. A row only becomes executable when a live proposal clears the EV gate.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={"rounded-full border px-2.5 py-1 text-[9px] font-semibold tracking-wide " + (qualified.length > 0 ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : "border-amber-400/40 bg-amber-400/10 text-amber-200")}>
            {qualified.length > 0 ? qualified.length + " +EV SETUP" + (qualified.length === 1 ? "" : "S") : "SCANNING FOR +EV MISPRICING"}
          </span>
          <span className={"rounded-full border px-2.5 py-1 text-[9px] font-semibold tracking-wide " + (armed ? "border-accent/50 bg-accent/10 text-accent" : paused ? "border-danger/40 bg-danger/10 text-danger" : "border-line bg-ink/60 text-muted")}>
            {paused ? "BREAKER PAUSED" : armed ? "HARVESTER ARMED" : "MANUAL / DISARMED"}
          </span>
        </div>
      </div>

      {!connected ? (
        <p className="mx-3 mt-3 rounded border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[10px] text-amber-200">
          Connect Deriv to begin the 10-symbol 150-tick scan. No proposal or buy request will be sent while unauthenticated.
        </p>
      ) : null}
      {warming > 0 ? (
        <p className="mx-3 mt-3 text-[9px] text-muted">
          {warming} watched market{warming === 1 ? " is" : "s are"} still warming to the full 101-sample Hurst window.
        </p>
      ) : null}

      <div className="overflow-x-auto p-2">
        <table className="w-full min-w-[960px] border-separate border-spacing-y-1 text-left text-[10px]">
          <thead className="text-[8px] uppercase tracking-widest text-muted">
            <tr>
              <th className="px-2 py-1">On</th>
              <th className="px-2 py-1">Symbol / Spot</th>
              <th className="px-2 py-1">ATR Ratio</th>
              <th className="px-2 py-1">ER30 / H</th>
              <th className="px-2 py-1">Regime</th>
              <th className="px-2 py-1">Route</th>
              <th className="px-2 py-1">P<sub>realized</sub> / P<sub>implied</sub></th>
              <th className="px-2 py-1">Live EV</th>
              <th className="px-2 py-1 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const readyForAction = row.watched && row.ready && row.evPct !== null && row.evPct >= minEv && row.pRealized !== null;
              const canExecute = connected && readyForAction && !busy && !paused;
              const error = row.quoteError ?? row.contractError ?? row.historyError;
              return (
                <tr key={row.symbol} className={"align-top " + (row.watched ? "bg-ink/40" : "bg-ink/10 opacity-60")}>
                  <td className="rounded-l border-y border-l border-line px-2 py-2">
                    <input
                      type="checkbox"
                      checked={row.watched}
                      onChange={() => onToggle(row.symbol)}
                      disabled={busy}
                      aria-label={"Watch " + row.symbol}
                      className="h-3.5 w-3.5 accent-emerald-400 disabled:opacity-40"
                    />
                  </td>
                  <td className="border-y border-line px-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[11px] font-semibold text-slate-100">{row.symbol}</span>
                      <span className="rounded border border-line px-1 py-0.5 text-[7px] uppercase tracking-wide text-muted">{row.family}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-muted">{row.spot === null ? "—" : row.spot.toFixed(3)}</p>
                    {error ? <p className="mt-0.5 max-w-[150px] truncate text-[8px] text-danger" title={error}>{error}</p> : null}
                  </td>
                  <td className="border-y border-line px-2 py-2 font-mono text-slate-200">
                    <p>{fmt(row.atrRatio)}</p>
                    <p className="text-[8px] text-muted">{row.samples}/150 ticks</p>
                  </td>
                  <td className="border-y border-line px-2 py-2 font-mono text-slate-200">
                    <p>{fmt(row.efficiency30)} / {fmt(row.hurst)}</p>
                    {row.family === "jump" ? <p className="text-[8px] text-amber-200/80">jump +{row.ticksSinceJump === null ? "—" : row.ticksSinceJump}t</p> : null}
                  </td>
                  <td className="border-y border-line px-2 py-2">
                    {row.regime ? (
                      <span className={"inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[8px] font-semibold tracking-wide " + regimeTone(row.regime)}>
                        {row.regimeLabel}
                        <span className="opacity-70">{row.posterior === null ? "" : Math.round(row.posterior * 100) + "%"}</span>
                      </span>
                    ) : (
                      <span className="text-[9px] text-muted">{row.ready ? "NO ACTIVE REGIME" : "WARMING " + row.samples + "/150"}</span>
                    )}
                  </td>
                  <td className="border-y border-line px-2 py-2">
                    {row.contract && row.duration !== null && row.unit !== null ? (
                      <div className="space-y-0.5">
                        <p className={"font-mono text-[10px] font-semibold " + contractTone(row.contract)}>
                          {row.contract} <span className="text-muted">· {directionGlyph(row.direction)} {row.duration}{row.unit}</span>
                        </p>
                        {row.barrier ? <p className="font-mono text-[8px] text-muted">barrier {row.barrier}</p> : <p className="text-[8px] text-muted">no barrier</p>}
                      </div>
                    ) : <span className="text-[9px] text-muted">—</span>}
                  </td>
                  <td className="border-y border-line px-2 py-2 font-mono text-slate-200">
                    <p>{row.pRealized === null ? "—" : row.pRealized.toFixed(3)} / {row.pImplied === null ? "—" : row.pImplied.toFixed(3)}</p>
                    <p className="text-[8px] text-muted">{row.quoteAgeMs === null ? "live proposal pending" : "proposal " + Math.max(0, Math.round(row.quoteAgeMs / 1000)) + "s old"}</p>
                  </td>
                  <td className="border-y border-line px-2 py-2">
                    <span className={"inline-flex min-w-[58px] justify-center rounded border px-2 py-1 font-mono text-[10px] font-semibold " + (row.evPct === null ? "border-line bg-ink/60 text-muted" : row.evPct >= minEv ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : row.evPct >= 0 ? "border-amber-400/40 bg-amber-400/10 text-amber-200" : "border-danger/50 bg-danger/10 text-danger")}>
                      {pct(row.evPct)}
                    </span>
                  </td>
                  <td className="rounded-r border-y border-r border-line px-2 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onExecute(row.symbol)}
                      disabled={!canExecute || executingSymbol === row.symbol}
                      className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-[9px] font-semibold text-emerald-200 transition hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      {executingSymbol === row.symbol ? "Executing…" : "Execute Setup"}
                    </button>
                    {row.evPct !== null && row.evPct < minEv ? <p className="mt-1 text-[8px] text-muted">below +{minEv.toFixed(1)}% gate</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-[9px] text-muted">
        <p>
          EV % = ((P<sub>realized</sub> × payout − ask) / ask) × 100. A green row has cleared the +{minEv.toFixed(1)}% gate; nothing fires unless it still clears on the pre-buy quote.
        </p>
        <p className="font-mono">
          {best && best.evPct !== null ? "Best scan: " + best.symbol + " " + pct(best.evPct) : "No usable proposal yet"}
        </p>
      </div>
    </section>
  );
}
