"use client";

import { useState } from "react";
import { Activity, Braces, Database, ShieldCheck } from "lucide-react";
import { useQuantPlatform, type TradeReview } from "@/hooks/useQuantPlatform";
import { AuthDrawer } from "./AuthDrawer";
import { DigitHeatmap, EntropyGauge } from "./DigitHeatmap";
import { ExecutionPanel } from "./ExecutionPanel";
import { Header } from "./Header";
import { JumpPanel } from "./JumpPanel";
import { MarketControls } from "./MarketControls";
import { SessionAnalytics } from "./SessionAnalytics";
import { SignalPanel } from "./SignalPanel";
import { StepMatrix } from "./StepMatrix";
import { TickChart } from "./TickChart";
import { ToastStack } from "./ToastStack";
import { TradeConfirmation } from "./TradeConfirmation";
import { TradeLog } from "./TradeLog";

export function Dashboard() {
  const platform = useQuantPlatform();
  const [review, setReview] = useState<TradeReview | null>(null);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const jumps = platform.analysis.kind === "jump" ? platform.analysis.jump.jumps : [];

  const execute = () => {
    if (platform.account.kind === "real") {
      if (platform.activeSignal && platform.activeProposal && platform.ev) {
        setReview({ signal: platform.activeSignal, proposal: platform.activeProposal, ev: platform.ev, stake: platform.stake, currency: platform.account.currency });
      }
      return;
    }
    void platform.executeSignal();
  };

  const confirmPurchase = async () => {
    if (!review) return;
    setPurchaseBusy(true);
    await platform.executeSignal(true, review);
    setPurchaseBusy(false);
    setReview(null);
  };

  return (
    <div className={`min-h-screen bg-[#080e17] text-slate-200 ${platform.account.kind === "real" ? "real-account-frame" : ""}`}>
      <Header platform={platform} />
      <main className="mx-auto max-w-[1800px] space-y-4 px-4 py-4 lg:px-6 lg:py-5">
        <MarketControls platform={platform} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatusCard icon={<Database size={16} />} label="Tick buffer" value={`${platform.ticks.length.toLocaleString()} / 1,000`} detail="Rolling analysis window" />
          <StatusCard icon={<Braces size={16} />} label="Engine" value={platform.family.toUpperCase()} detail={platform.family === "continuous" ? "Digits · entropy · momentum" : platform.family === "step" ? "Markov · streaks · reversion" : "ATR · hazard · drift"} />
          <StatusCard icon={<Activity size={16} />} label="Open contracts" value={`${platform.openPositions} / 3`} detail={platform.openPositions ? "Settlement tracked live" : "No exposure"} />
          <StatusCard icon={<ShieldCheck size={16} />} label="Risk state" value={platform.emergencyStop ? "STOPPED" : platform.autoTrade ? "AUTO" : "ARMED"} detail={platform.emergencyStop ? platform.killReason ?? "Emergency stop" : `Loss streak ${platform.consecutiveLosses} / ${platform.risk.maxConsecutiveLosses}`} tone={platform.emergencyStop ? "text-rose-300" : "text-emerald-300"} />
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-[250px_minmax(0,1fr)_340px]">
          <aside className="min-w-0 space-y-4">
            <SessionAnalytics platform={platform} />
            {platform.family === "step" ? <StepMatrix platform={platform} /> : platform.family === "jump" ? <JumpPanel platform={platform} /> : <EntropyGauge platform={platform} />}
          </aside>

          <div className="min-w-0 space-y-4">
            <TickChart ticks={platform.ticks} jumps={jumps} />
            <DigitHeatmap platform={platform} />
            <TradeLog platform={platform} />
          </div>

          <aside className="min-w-0 space-y-4">
            <SignalPanel platform={platform} />
            <ExecutionPanel platform={platform} onExecute={execute} />
          </aside>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2 text-[9px] leading-4 text-slate-600">
          <span>Empirical probability models · live payout-aware EV · session-only credentials</span>
          <span>{platform.mode === "live" ? "DERIV WEBSOCKET" : "DETERMINISTIC LOCAL SIMULATION"} · {platform.symbol}</span>
        </footer>
      </main>
      <AuthDrawer platform={platform} />
      <ToastStack platform={platform} />
      {review && <TradeConfirmation review={review} busy={purchaseBusy} onCancel={() => setReview(null)} onConfirm={() => void confirmPurchase()} />}
    </div>
  );
}

function StatusCard({ icon, label, value, detail, tone = "text-slate-100" }: { icon: React.ReactNode; label: string; value: string; detail: string; tone?: string }) {
  return <div className="rounded-xl border border-white/[0.08] bg-[#0d1522] px-4 py-3">
    <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">{icon}{label}</div>
    <div className="mt-2 flex items-baseline justify-between gap-2"><span className={`font-mono text-lg font-semibold ${tone}`}>{value}</span><span className="truncate text-right text-[9px] text-slate-600">{detail}</span></div>
  </div>;
}
