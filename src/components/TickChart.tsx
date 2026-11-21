"use client";
import { useEffect, useRef } from "react";
import {
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { EngineOutput } from "@/engines/types";
import type { ContinuousInsights } from "@/engines/continuousEngine";
import type { JumpInsights } from "@/engines/jumpEngine";
import { useStore } from "@/store/useStore";

interface Series {
  price: ISeriesApi<"Line">;
  mid: ISeriesApi<"Line">;
  up: ISeriesApi<"Line">;
  lo: ISeriesApi<"Line">;
  markers: ISeriesMarkersPluginApi<Time>;
}

export function TickChart({ output }: { output: EngineOutput }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<Series | null>(null);
  const prices = useStore((s) => s.prices);
  const times = useStore((s) => s.times);
  const decimals = useStore((s) => s.decimals);
  const symbol = useStore((s) => s.symbol);
  const minStreak = useStore((s) => s.settings.minStreak);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#94a3b8", attributionLogo: false },
      grid: { vertLines: { color: "#1e293b55" }, horzLines: { color: "#1e293b55" } },
      timeScale: { timeVisible: true, secondsVisible: true, borderColor: "#334155" },
      rightPriceScale: { borderColor: "#334155" },
      crosshair: { mode: 1 },
    });
    const band = { color: "#a78bfa66", lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const price = c.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2 });
    series.current = {
      price,
      mid: c.addSeries(LineSeries, { ...band, color: "#a78bfa99", lineStyle: 2 }),
      up: c.addSeries(LineSeries, band),
      lo: c.addSeries(LineSeries, band),
      markers: createSeriesMarkers(price, []),
    };
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.timeScale().fitContent();
  }, [symbol]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const fam = output.family;
    s.price.applyOptions({
      lineType: fam === "step" ? LineType.WithSteps : LineType.Simple,
      priceFormat: { type: "price", precision: decimals, minMove: Math.pow(10, -decimals) },
    });
    const t = (i: number) => times[i] as UTCTimestamp;
    s.price.setData(prices.map((p, i) => ({ time: t(i), value: p })));

    const bandData = (arr: number[]) => arr.flatMap((v, i) => (Number.isFinite(v) ? [{ time: t(i), value: v }] : []));
    if (fam === "continuous") {
      const ins = output.insights as ContinuousInsights;
      s.mid.setData(bandData(ins.bbMid));
      s.up.setData(bandData(ins.bbUpper));
      s.lo.setData(bandData(ins.bbLower));
    } else {
      s.mid.setData([]);
      s.up.setData([]);
      s.lo.setData([]);
    }

    const markers: SeriesMarker<Time>[] = [];
    if (fam === "jump") {
      for (const j of (output.insights as JumpInsights).jumps)
        markers.push({ time: t(j.index), position: j.size > 0 ? "belowBar" : "aboveBar", color: "#f59e0b", shape: j.size > 0 ? "arrowUp" : "arrowDown", text: "JUMP" });
    }
    if (fam === "step") {
      // Mark the tick where a run first reaches k ≥ minStreak.
      let run = 0;
      let dir = 0;
      for (let i = 1; i < prices.length; i++) {
        const d = Math.sign(prices[i] - prices[i - 1]);
        run = d !== 0 && d === dir ? run + 1 : d !== 0 ? 1 : 0;
        dir = d;
        if (run === minStreak)
          markers.push({ time: t(i), position: d > 0 ? "aboveBar" : "belowBar", color: "#f472b6", shape: "circle", text: `${minStreak}×` });
      }
    }
    s.markers.setMarkers(markers);
  }, [prices, times, decimals, output, minStreak]);

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Live ticks · {symbol}</span>
        <span className="text-xs font-normal text-slate-500">
          {output.family === "continuous" && "Bollinger(N, 2σ) overlay"}
          {output.family === "jump" && "▲▼ detected jumps (|ΔS| > k·ATR₂₀)"}
          {output.family === "step" && "Step path · ● streak ≥ k"}
          {" · "}
          {prices.length} ticks
        </span>
      </div>
      <div ref={el} className="h-[340px] w-full" data-testid="tick-chart" />
    </div>
  );
}
