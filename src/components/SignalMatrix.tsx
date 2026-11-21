"use client";
import { useState } from "react";
import { CONTRACT_LABEL } from "@/lib/markets";
import type { SignalRow, SignalStatus } from "@/lib/signals";
import { pct, signed } from "@/lib/format";
import { useStore } from "@/store/useStore";

const STATUS: Record<SignalStatus, { label: string; cls: string }> = {
  actionable: { label: "HIGH EDGE / ACTIONABLE", cls: "bg-emerald-500 text-emerald-950" },
  waiting: { label: "+EV · waiting trigger", cls: "bg-sky-500/20 text-sky-300" },
  "low-sample": { label: "+EV · low sample", cls: "bg-amber-500/15 text-amber-300" },
  weak: { label: "+EV · not significant", cls: "bg-amber-500/10 text-amber-200/80" },
  "no-edge": { label: "No edge", cls: "bg-slate-700/60 text-slate-400" },
  blocked: { label: "Blocked", cls: "bg-red-500/20 text-red-300" },
  "not-offered": { label: "Not offered", cls: "bg-slate-800 text-slate-500" },
  "no-quote": { label: "No quote", cls: "bg-slate-800 text-slate-500" },
};

type Filter = "all" | "risefall" | "digits" | "positive";

export function SignalMatrix({ rows, onTrade }: { rows: SignalRow[]; onTrade: (r: SignalRow) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const currency = useStore((s) => s.currency);
  const signedIn = useStore((s) => s.authStatus === "signed-in");
  const hideNotOffered = rows.filter((r) => r.status !== "not-offered");
  const shown = (hideNotOffered.length ? hideNotOffered : rows)
    .filter((r) =>
      filter === "risefall" ? r.contractType === "CALL" || r.contractType === "PUT"
      : filter === "digits" ? r.contractType.startsWith("DIGIT")
      : filter === "positive" ? r.evPerStake > 0
      : true,
    )
    .sort((a, b) => (b.evPerStake || -9) - (a.evPerStake || -9));
  const positives = rows.filter((r) => r.evPerStake > 0).length;
  const notOffered = rows.length - hideNotOffered.length;

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Signal & EV matrix</span>
        <div className="flex gap-1 text-xs font-normal">
          {(["all", "risefall", "digits", "positive"] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded px-2 py-0.5 ${filter === f ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-800"}`}>
              {f === "all" ? "All" : f === "risefall" ? "Rise/Fall" : f === "digits" ? "Digits" : `EV > 0 (${positives})`}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[460px] overflow-auto">
        <table className="w-full min-w-[860px] text-left text-xs" data-testid="signal-matrix">
          <thead className="sticky top-0 bg-slate-900 text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Contract</th>
              <th className="font-medium">Dur.</th>
              <th className="font-medium" title="Shrunk empirical win probability">P_model</th>
              <th className="font-medium" title="Theoretical fair probability">P_theory</th>
              <th className="font-medium" title="Stake / Payout">P_be</th>
              <th className="font-medium">Payout %</th>
              <th className="font-medium">EV / stake</th>
              <th className="font-medium">Kelly stake</th>
              <th className="font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <tbody className="num">
            {shown.map((r) => (
              <tr key={r.key} className={`border-t border-slate-800/80 ${r.status === "actionable" ? "bg-emerald-950/40" : "hover:bg-slate-800/30"}`} title={`${r.rationale}\n${r.reason}`}>
                <td className="px-3 py-1.5 font-sans font-semibold">
                  {CONTRACT_LABEL[r.contractType]}
                  {r.barrier !== undefined && <span className="ml-1 text-slate-400">{r.barrier}</span>}
                  {r.active && r.status !== "not-offered" && (r.contractType === "CALL" || r.contractType === "PUT") && <span className="ml-1 text-sky-400">●</span>}
                </td>
                <td>{r.duration}t</td>
                <td>{pct(r.pModel, 2)} <span className="text-slate-600">({r.k}/{r.n})</span></td>
                <td className="text-slate-500">{pct(r.pTheory, 1)}</td>
                <td>{pct(r.pBe, 2)}{Number.isFinite(r.edgeZ) && <span className={`ml-1 ${r.edgeZ >= 2 ? "text-emerald-400" : "text-slate-600"}`}>Z{r.edgeZ.toFixed(1)}</span>}</td>
                <td>{Number.isFinite(r.payoutPct) ? `${r.payoutPct.toFixed(1)}%` : "—"}</td>
                <td className={r.evPerStake > 0 ? "text-emerald-400" : r.evPerStake < 0 ? "text-red-400/80" : ""}>{Number.isFinite(r.evPerStake) ? `${signed(r.evPerStake * 100)}%` : "—"}</td>
                <td>{r.kellyStake > 0 ? `${r.kellyStake.toFixed(2)} ${currency}` : "0"}</td>
                <td>
                  <span className={`whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[10px] font-bold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                </td>
                <td className="pr-3 text-right">
                  <button className="btn-ghost !px-2 !py-0.5 text-[11px]" disabled={!signedIn || r.status === "not-offered"} onClick={() => onTrade(r)}>Trade</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">
        P_be = S/W · EV = P·(W−S) − (1−P)·S · Kelly f* = (bp−q)/b, b = (W−S)/S. P_model is a walk-forward back-test shrunk toward theory; actionable also needs Z(edge) ≥ the configured bar.
        {notOffered > 0 && ` ${notOffered} contract(s) hidden: not offered on this market.`}
      </div>
    </div>
  );
}
