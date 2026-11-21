"use client";
import { useState } from "react";

export function RealConfirmModal({ accountId, onConfirm, onCancel }: { accountId: string; onConfirm: () => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border-2 border-red-500 bg-slate-950 p-6 shadow-2xl shadow-red-900/40" role="dialog" aria-modal>
        <h2 className="text-lg font-bold text-red-300">⚠ Switch to REAL money account?</h2>
        <p className="mt-3 text-sm text-slate-300">
          Account <span className="num font-semibold">{accountId}</span> uses real funds. Trades placed from this dashboard will be executed immediately and can lose the full stake.
        </p>
        <p className="mt-2 text-sm text-slate-400">Synthetic indices are RNG-driven and Deriv&apos;s payouts are below fair odds; most signals have negative expected value.</p>
        <label className="mt-4 block text-xs text-slate-400" htmlFor="confirm-real">Type <b className="text-red-300">REAL</b> to confirm</label>
        <input id="confirm-real" className="input mt-1" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onCancel}>Stay on Demo</button>
          <button className="btn bg-red-600 text-white hover:bg-red-500" disabled={text !== "REAL"} onClick={onConfirm}>Enable real trading</button>
        </div>
      </div>
    </div>
  );
}
