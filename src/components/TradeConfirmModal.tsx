"use client";
import { useState } from "react";
import { CONTRACT_LABEL } from "@/lib/markets";
import type { SignalRow } from "@/lib/signals";
import { pct, signed } from "@/lib/format";
import { currentAccount, useStore } from "@/store/useStore";

/** Manual trade ticket: shows the math and warns loudly on negative EV or real money. */
export function TradeConfirmModal({ row, onConfirm, onCancel }: { row: SignalRow; onConfirm: (stake: number) => void; onCancel: () => void }) {
  const s = useStore();
  const acct = currentAccount(s);
  const real = acct?.account_type === "real";
  const [stake, setStake] = useState<number>(row.kellyStake > 0 ? row.kellyStake : s.guardrails.quoteStake);
  const negative = !(row.evPerStake > 0);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onCancel}>
      <div className={`w-full max-w-md rounded-xl border-2 bg-slate-950 p-6 ${real ? "border-red-500" : "border-slate-700"}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h2 className="text-lg font-bold">
          {CONTRACT_LABEL[row.contractType]} {row.barrier ?? ""} · {row.duration} ticks · {s.symbol}
        </h2>
        <p className={`mt-1 text-xs font-bold ${real ? "text-red-300" : "text-emerald-300"}`}>{real ? "REAL MONEY" : "DEMO"} account {acct?.account_id}</p>
        <div className="num mt-4 grid grid-cols-2 gap-2 text-sm">
          <div>P_model <b>{pct(row.pModel, 2)}</b></div>
          <div>P_be <b>{pct(row.pBe, 2)}</b></div>
          <div>Payout <b>{Number.isFinite(row.payoutPct) ? `${row.payoutPct.toFixed(1)}%` : "—"}</b></div>
          <div className={negative ? "text-red-400" : "text-emerald-400"}>EV <b>{Number.isFinite(row.evPerStake) ? `${signed(row.evPerStake * 100)}%` : "—"}</b></div>
        </div>
        {negative && (
          <p className="mt-3 rounded border border-amber-700 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            This contract has no modelled edge — expected loss ≈ {Number.isFinite(row.evPerStake) ? `${(-row.evPerStake * stake).toFixed(2)}` : "?"} {s.currency} per trade.
          </p>
        )}
        <label className="mt-4 block">
          <span className="label">Stake ({s.currency})</span>
          <input type="number" min={0.35} step={0.5} className="input num mt-1" value={stake} onChange={(e) => setStake(Number(e.target.value))} />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className={`btn text-white ${real ? "bg-red-600 hover:bg-red-500" : "bg-sky-600 hover:bg-sky-500"}`} disabled={!(stake >= 0.35)} onClick={() => onConfirm(stake)} data-testid="confirm-trade">
            Buy for {stake.toFixed(2)} {s.currency}
          </button>
        </div>
      </div>
    </div>
  );
}
