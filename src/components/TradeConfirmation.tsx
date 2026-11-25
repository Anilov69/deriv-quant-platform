"use client";

import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import type { TradeReview } from "@/hooks/useQuantPlatform";

export function TradeConfirmation({ review, busy, onCancel, onConfirm }: { review: TradeReview; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="trade-review-title" className="w-full max-w-md rounded-2xl border border-amber-400/45 bg-[#10131d] p-5 shadow-2xl shadow-amber-950/20">
        <div className="flex items-start justify-between"><div className="grid h-11 w-11 place-items-center rounded-xl border border-amber-400/30 bg-amber-400/10 text-amber-300"><ShieldAlert size={21} /></div><button aria-label="Cancel real trade" disabled={busy} onClick={onCancel} className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-30"><X size={18} /></button></div>
        <h2 id="trade-review-title" className="mt-4 text-lg font-semibold text-white">Confirm REAL-account purchase</h2>
        <p className="mt-1 text-xs leading-5 text-slate-400">This order uses real funds. Auto-trade is disabled on Real accounts.</p>
        <div className="mt-4 flex gap-2 rounded-lg border border-rose-400/30 bg-rose-400/[0.07] p-3 text-[11px] leading-4 text-rose-200"><AlertTriangle size={15} className="shrink-0" />A positive empirical EV does not guarantee a winning contract. Synthetic indices carry loss risk.</div>
        <dl className="mt-4 divide-y divide-white/[0.07] rounded-xl border border-white/10 bg-slate-950/40 px-4">
          <ReviewRow label="Market" value={review.signal.symbol} />
          <ReviewRow label="Contract" value={`${review.signal.contractType}${review.signal.barrier !== undefined ? ` · digit ${review.signal.barrier}` : ""} · ${review.signal.durationTicks} tick${review.signal.durationTicks === 1 ? "" : "s"}`} />
          <ReviewRow label="Stake" value={`${review.currency} ${review.stake.toFixed(2)}`} />
          <ReviewRow label="Total payout if won" value={`${review.currency} ${review.proposal.payout.toFixed(3)}`} />
          <ReviewRow label="Model probability" value={`${(review.signal.probability * 100).toFixed(2)}%`} />
          <ReviewRow label="Expected value" value={`${review.currency} ${review.ev.expectedValue >= 0 ? "+" : ""}${review.ev.expectedValue.toFixed(4)}`} tone={review.ev.expectedValue > 0 ? "text-emerald-300" : "text-rose-300"} />
          <ReviewRow label="Quote age" value={`${Math.max(0, Date.now() - review.proposal.receivedAt) / 1000 < 0.05 ? "fresh" : `${((Date.now() - review.proposal.receivedAt) / 1000).toFixed(1)}s`}`} />
        </dl>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button disabled={busy} onClick={onCancel} className="rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/5 disabled:opacity-40">Cancel</button>
          <button disabled={busy} onClick={onConfirm} className="rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50">{busy ? "Purchasing…" : "CONFIRM PURCHASE"}</button>
        </div>
        <p className="mt-3 text-center text-[9px] leading-4 text-slate-500">Purchase is rejected if the quote changes or expires before confirmation.</p>
      </section>
    </div>
  );
}

function ReviewRow({ label, value, tone = "text-slate-200" }: { label: string; value: string; tone?: string }) {
  return <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-[11px] text-slate-500">{label}</dt><dd className={`text-right font-mono text-[11px] ${tone}`}>{value}</dd></div>;
}
