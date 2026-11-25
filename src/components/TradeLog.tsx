"use client";

import { Download, ListFilter } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";
import type { TradeRecord } from "@/types";

function csvCell(value: string | number | undefined): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function TradeLog({ platform }: { platform: QuantPlatform }) {
  const exportCsv = () => {
    const columns = ["Opened at", "Closed at", "Mode", "Account", "Symbol", "Contract", "Barrier", "Duration ticks", "Stake", "Payout", "Profit", "Status", "Entry spot", "Exit spot", "Contract ID"];
    const rows = platform.trades.map((trade) => [new Date(trade.openedAt).toISOString(), trade.closedAt ? new Date(trade.closedAt).toISOString() : "", trade.mode, trade.accountKind, trade.symbol, trade.contractType, trade.barrier, trade.durationTicks, trade.stake, trade.payout, trade.profit, trade.status, trade.entrySpot, trade.exitSpot, trade.contractId]);
    const blob = new Blob(["\ufeff", [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `deriv-quant-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="overflow-hidden rounded-xl border border-white/10 bg-[#0d1522]">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400"><ListFilter size={14} /> Trade journal <span className="font-mono text-[10px] text-slate-600">{platform.trades.length}</span></div>
        <button onClick={exportCsv} disabled={platform.trades.length === 0} className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-[10px] text-slate-300 transition hover:bg-white/5 disabled:opacity-30"><Download size={12} /> Export CSV</button>
      </div>
      <div className="max-h-[360px] overflow-auto">
        <table className="w-full min-w-[760px] text-left text-[11px]">
          <thead className="sticky top-0 z-10 bg-slate-950 text-[9px] uppercase tracking-wider text-slate-500"><tr>{["Time / market", "Contract", "Stake", "Payout", "P&L", "Status"].map((heading) => <th key={heading} className="px-4 py-2.5 font-medium">{heading}</th>)}</tr></thead>
          <tbody className="divide-y divide-white/[0.05]">
            {platform.trades.length === 0 ? <tr><td colSpan={6} className="px-4 py-12 text-center text-xs text-slate-500">No trades recorded this session.</td></tr> : platform.trades.map((trade) => <TradeRow key={trade.id} trade={trade} currency={platform.account.currency} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TradeRow({ trade, currency }: { trade: TradeRecord; currency: string }) {
  const settled = ["won", "lost", "sold"].includes(trade.status);
  return <tr className="hover:bg-white/[0.025]">
    <td className="px-4 py-3"><div className="font-medium text-slate-200">{trade.symbol}</div><div className="mt-0.5 font-mono text-[9px] text-slate-500">{new Date(trade.openedAt).toLocaleTimeString()} · {trade.mode}{trade.accountKind === "real" ? " · REAL" : ""}</div></td>
    <td className="px-4 py-3"><div className="text-slate-300">{trade.contractType}{trade.barrier !== undefined && <span className="ml-1.5 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">D{trade.barrier}</span>}</div><div className="mt-0.5 text-[9px] text-slate-500">{trade.durationTicks} tick{trade.durationTicks === 1 ? "" : "s"}</div></td>
    <td className="px-4 py-3 font-mono text-slate-400">{trade.stake.toFixed(2)}</td>
    <td className="px-4 py-3 font-mono text-slate-400">{trade.payout.toFixed(2)}</td>
    <td className={`px-4 py-3 font-mono font-medium ${settled ? trade.profit >= 0 ? "text-emerald-300" : "text-rose-300" : "text-slate-500"}`}>{settled ? `${trade.profit >= 0 ? "+" : ""}${trade.profit.toFixed(2)} ${currency}` : "—"}</td>
    <td className="px-4 py-3"><span className={`rounded px-2 py-1 text-[9px] font-bold uppercase ${trade.status === "won" ? "bg-emerald-400/10 text-emerald-300" : trade.status === "lost" || trade.status === "error" ? "bg-rose-400/10 text-rose-300" : "bg-cyan-400/10 text-cyan-300"}`}>{trade.status}</span>{trade.error && <div className="mt-1 max-w-32 truncate text-[9px] text-rose-300" title={trade.error}>{trade.error}</div>}</td>
  </tr>;
}
