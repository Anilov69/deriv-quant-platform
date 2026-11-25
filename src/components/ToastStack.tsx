"use client";

import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import type { QuantPlatform } from "@/hooks/useQuantPlatform";

export function ToastStack({ platform }: { platform: QuantPlatform }) {
  return <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
    {platform.toasts.map((toast) => {
      const Icon = toast.tone === "success" ? CheckCircle2 : toast.tone === "error" ? CircleAlert : Info;
      return <div key={toast.id} className={`pointer-events-auto flex items-start gap-3 rounded-xl border p-3 shadow-2xl backdrop-blur-xl ${toast.tone === "success" ? "border-emerald-400/25 bg-emerald-950/90 text-emerald-200" : toast.tone === "error" ? "border-rose-400/25 bg-rose-950/90 text-rose-200" : "border-cyan-400/25 bg-slate-900/95 text-cyan-100"}`}>
        <Icon size={16} className="mt-0.5 shrink-0" /><span className="flex-1 text-xs leading-5">{toast.message}</span><button aria-label="Dismiss notification" onClick={() => platform.dismissToast(toast.id)} className="rounded p-0.5 opacity-60 hover:opacity-100"><X size={14} /></button>
      </div>;
    })}
  </div>;
}
