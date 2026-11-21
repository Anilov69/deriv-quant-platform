"use client";
import { useEffect, useState } from "react";
import { useStore } from "@/store/useStore";

export function Toast() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  const cls = toast.kind === "error" ? "border-red-600 bg-red-950 text-red-200" : toast.kind === "success" ? "border-emerald-600 bg-emerald-950 text-emerald-200" : "border-sky-600 bg-slate-900 text-slate-200";
  return (
    <div className={`fixed bottom-4 right-4 z-[60] max-w-sm rounded-lg border px-4 py-3 text-sm shadow-xl ${cls}`} role="status">
      {toast.text}
    </div>
  );
}
