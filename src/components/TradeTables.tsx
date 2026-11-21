"use client";
import { CONTRACT_LABEL } from "@/lib/markets";
import { clock, pct, signed } from "@/lib/format";
import { useStore, type TradeRecord } from "@/store/useStore";

const STATUS_CLS: Record<TradeRecord["status"], string> = {
  pending: "text-amber-300",
  open: "text-sky-300",
  won: "text-emerald-400",
  lost: "text-red-400",
  sold: "text-slate-300",
  unknown: "text-amber-300",
  failed: "text-slate-500",
};

const COLS: (keyof TradeRecord)[] = [
  "boughtAt", "accountType", "accountId", "symbol", "contractType", "barrier", "duration", "stake", "payout",
  "pModel", "ev", "status", "profit", "entrySpot", "exitSpot", "contractId", "transactionId", "auto", "note",
];

function toCsv(trades: TradeRecord[]) {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const settled = trades.filter((t) => t.status === "won" || t.status === "lost" || t.status === "sold");
  const wins = settled.filter((t) => t.status === "won").length;
  const pnl = settled.reduce((a, t) => a + (t.profit ?? 0), 0);
  const expEv = settled.reduce((a, t) => a + t.ev, 0);
  const lines = [
    `# session_trades,${settled.length},wins,${wins},win_rate,${settled.length ? (wins / settled.length).toFixed(4) : ""},pnl,${pnl.toFixed(2)},model_expected_pnl,${expEv.toFixed(2)}`,
    COLS.join(","),
    ...trades.map((t) => COLS.map((c) => esc(c === "boughtAt" ? new Date(t.boughtAt * 1000).toISOString() : t[c])).join(",")),
  ];
  return lines.join("\n");
}

export function TradeTables() {
  const trades = useStore((s) => s.trades);
  const open = trades.filter((t) => t.status === "open" || t.status === "pending" || t.status === "unknown");
  const settled = trades.filter((t) => t.status === "won" || t.status === "lost" || t.status === "sold");
  const wins = settled.filter((t) => t.status === "won").length;
  const pnl = settled.reduce((a, t) => a + (t.profit ?? 0), 0);

  const exportCsv = () => {
    const blob = new Blob([toCsv(trades)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `deriv-quant-trades-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_2fr]">
      <div className="panel">
        <div className="panel-title"><span>Open contracts</span><span className="text-xs font-normal text-slate-500">{open.length}</span></div>
        <div className="max-h-72 overflow-auto p-2 text-xs">
          {open.length === 0 && <p className="p-3 text-slate-500">No open contracts.</p>}
          {open.map((t) => (
            <div key={t.id} className="num mb-1.5 rounded-lg border border-slate-800 px-3 py-2">
              <div className="flex justify-between font-sans font-semibold">
                <span>{t.symbol} · {CONTRACT_LABEL[t.contractType]} {t.barrier ?? ""} · {t.duration}t</span>
                <span className={STATUS_CLS[t.status]}>{t.status.toUpperCase()}</span>
              </div>
              <div className="mt-0.5 text-slate-400">
                Stake {t.stake.toFixed(2)} → {t.payout.toFixed(2)} · entry {t.entrySpot ?? "…"} {t.profit !== undefined && <>· P&L {signed(t.profit)}</>}
              </div>
              {t.note && <div className="mt-0.5 text-amber-300">{t.note}</div>}
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">
          <span>Trade history</span>
          <div className="flex items-center gap-3 text-xs font-normal text-slate-400">
            <span>{settled.length} settled · win {settled.length ? pct(wins / settled.length) : "—"} · P&L <b className={pnl >= 0 ? "text-emerald-400" : "text-red-400"}>{signed(pnl)}</b></span>
            <button className="btn-ghost !py-0.5 text-xs" onClick={exportCsv} disabled={!trades.length} data-testid="export-csv">Export CSV</button>
          </div>
        </div>
        <div className="max-h-72 overflow-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="sticky top-0 bg-slate-900 text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="font-medium">Acct</th>
                <th className="font-medium">Market</th>
                <th className="font-medium">Contract</th>
                <th className="font-medium">Stake</th>
                <th className="font-medium">P_model</th>
                <th className="font-medium">Model EV</th>
                <th className="font-medium">Result</th>
                <th className="font-medium">P&L</th>
              </tr>
            </thead>
            <tbody className="num">
              {trades.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-4 font-sans text-slate-500">No trades yet this session.</td></tr>
              )}
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-slate-800/80" title={t.note}>
                  <td className="px-3 py-1.5">{clock(t.boughtAt)}</td>
                  <td className={t.accountType === "real" ? "text-red-300" : "text-emerald-300"}>{t.accountType === "real" ? "REAL" : "DEMO"}</td>
                  <td>{t.symbol}</td>
                  <td className="font-sans">{CONTRACT_LABEL[t.contractType]} {t.barrier ?? ""} · {t.duration}t{t.auto ? " · auto" : ""}</td>
                  <td>{t.stake.toFixed(2)}</td>
                  <td>{pct(t.pModel, 1)}</td>
                  <td className={t.ev >= 0 ? "text-emerald-400" : "text-red-400/80"}>{signed(t.ev)}</td>
                  <td className={STATUS_CLS[t.status]}>{t.status}</td>
                  <td className={(t.profit ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}>{t.profit !== undefined ? signed(t.profit) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
