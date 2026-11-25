"use client";

import { useEffect, useRef } from "react";
import { createChart, createSeriesMarkers, LineSeries, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from "lightweight-charts";
import type { Tick } from "@/types";

export function TickChart({ ticks, jumps }: { ticks: Tick[]; jumps: number[] }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Line">[]>([]);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const instance = createChart(container.current, {
      height: 300,
      layout: { background: { color: "#0b121d" }, textColor: "#64748b", fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
      grid: { vertLines: { color: "#172033" }, horzLines: { color: "#172033" } },
      crosshair: { mode: 0, vertLine: { color: "#475569" }, horzLine: { color: "#475569" } },
      rightPriceScale: { borderColor: "#1e293b", scaleMargins: { top: 0.12, bottom: 0.18 } },
      timeScale: { borderColor: "#1e293b", timeVisible: true, secondsVisible: false, rightOffset: 3 },
      handleScroll: true,
      handleScale: true,
    });
    const price = instance.addSeries(LineSeries, { color: "#22d3ee", lineWidth: 2, priceFormat: { type: "price", precision: 5, minMove: 0.00001 } });
    const upper = instance.addSeries(LineSeries, { color: "rgba(167,139,250,.45)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const lower = instance.addSeries(LineSeries, { color: "rgba(167,139,250,.45)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const middle = instance.addSeries(LineSeries, { color: "rgba(148,163,184,.4)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    series.current = [price, upper, lower, middle];
    markers.current = createSeriesMarkers(price, []);
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.applyOptions({ width: container.current?.clientWidth ?? 0 }));
    observer.observe(container.current);
    return () => { observer.disconnect(); markers.current?.detach(); markers.current = null; instance.remove(); chart.current = null; series.current = []; };
  }, []);

  useEffect(() => {
    if (!chart.current || series.current.length !== 4 || ticks.length === 0) return;
    const [price, upper, lower, middle] = series.current;
    const data = ticks.map((tick) => ({ time: tick.epoch as UTCTimestamp, value: tick.quote }));
    price.setData(data);
    const period = 20;
    const upperData: { time: UTCTimestamp; value: number }[] = [];
    const lowerData: { time: UTCTimestamp; value: number }[] = [];
    const middleData: { time: UTCTimestamp; value: number }[] = [];
    for (let index = period - 1; index < ticks.length; index += 1) {
      const slice = ticks.slice(index - period + 1, index + 1);
      const mean = slice.reduce((sum, tick) => sum + tick.quote, 0) / period;
      const variance = slice.reduce((sum, tick) => sum + (tick.quote - mean) ** 2, 0) / period;
      const deviation = Math.sqrt(variance);
      const time = ticks[index].epoch as UTCTimestamp;
      upperData.push({ time, value: mean + 2 * deviation });
      lowerData.push({ time, value: mean - 2 * deviation });
      middleData.push({ time, value: mean });
    }
    upper.setData(upperData);
    lower.setData(lowerData);
    middle.setData(middleData);
    const jumpSet = new Set(jumps);
    markers.current?.setMarkers(ticks.flatMap((tick, index) => jumpSet.has(index) ? [{ time: tick.epoch as UTCTimestamp, position: "aboveBar" as const, color: "#fbbf24", shape: "arrowDown" as const, text: "J" }] : []));
    chart.current.timeScale().fitContent();
  }, [ticks, jumps]);

  return <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0b121d]">
    <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Tick price <span className="ml-2 font-normal normal-case tracking-normal text-slate-600">20-period Bollinger · σ = 2</span></div>
      <div className="flex gap-3 text-[9px] text-slate-500"><span className="text-cyan-400">● PRICE</span><span className="text-violet-400">● BANDS</span><span className="text-amber-400">▼ JUMP</span></div>
    </div>
    <div ref={container} className="w-full" />
  </div>;
}
