import { useMemo } from "react";
import { runEngine } from "@/engines";
import { buildSignals, recommended } from "@/lib/signals";
import { useStore } from "@/store/useStore";

export function useAnalysis() {
  const family = useStore((s) => s.family);
  const prices = useStore((s) => s.prices);
  const times = useStore((s) => s.times);
  const decimals = useStore((s) => s.decimals);
  const settings = useStore((s) => s.settings);
  const quotes = useStore((s) => s.quotes);
  const availability = useStore((s) => s.availability[s.symbol]);
  const guardrails = useStore((s) => s.guardrails);
  const balance = useStore((s) => s.balance);

  const output = useMemo(() => runEngine(family, { prices, times, decimals, settings }), [family, prices, times, decimals, settings]);
  const rows = useMemo(
    () => buildSignals(output.candidates, quotes, availability, guardrails, balance),
    [output, quotes, availability, guardrails, balance],
  );
  const best = useMemo(() => recommended(rows), [rows]);
  return { output, rows, best };
}
