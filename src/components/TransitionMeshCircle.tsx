import { useEffect, useId, useState } from "react";
import type { ReactElement } from "react";
import type { MeshWindow } from "@/utils/transitionMeshMath";
import { nodeTone } from "@/utils/transitionMeshMath";

interface Props {
  label: string;
  mesh: MeshWindow;
  center: number;
  disabled?: boolean;
  onLookbackChange: (value: number) => void;
}

interface Palette {
  fill: string;
  stroke: string;
  text: string;
}

const TONES: Record<string, Palette> = {
  hot: { fill: "#34d399", stroke: "#6ee7b7", text: "#052e16" },
  runner: { fill: "#60a5fa", stroke: "#93c5fd", text: "#082f49" },
  cold: { fill: "#fb7185", stroke: "#fda4af", text: "#4c0519" },
  mid: { fill: "#0f1a24", stroke: "#334155", text: "#cbd5e1" },
};

const SIZE = 320;
const CX = SIZE / 2;
const CY = SIZE / 2;
const RING = 116;
const NODE = 24;

function nodePosition(digit: number): { x: number; y: number } {
  const angle = (-90 + digit * 36) * (Math.PI / 180);
  return { x: CX + RING * Math.cos(angle), y: CY + RING * Math.sin(angle) };
}

export default function TransitionMeshCircle({ label, mesh, center, disabled, onLookbackChange }: Props): ReactElement {
  const uid = useId().replace(/:/g, "");
  const [draft, setDraft] = useState(String(mesh.lookback));
  useEffect(() => setDraft(String(mesh.lookback)), [mesh.lookback]);
  const commitLookback = () => {
    const value = Number(draft);
    if (Number.isFinite(value)) {
      const next = Math.min(300, Math.max(20, Math.round(value)));
      setDraft(String(next));
      onLookbackChange(next);
    } else {
      setDraft(String(mesh.lookback));
    }
  };
  const markerId = "mesh-arrow-" + uid;
  const positions = Array.from({ length: 10 }, (_unused, digit) => nodePosition(digit));
  const outgoing = mesh.transitions[center] ?? new Array<number>(10).fill(0);
  const outgoingTotal = outgoing.reduce((sum, count) => sum + count, 0);
  const maxOutgoing = Math.max(1, ...outgoing);
  const centerCount = center >= 0 ? mesh.counts[center] : 0;
  const centerPct = mesh.total > 0 ? (centerCount / mesh.total) * 100 : 0;
  const edges: ReactElement[] = [];

  for (let from = 0; from < 10; from += 1) {
    for (let to = 0; to < 10; to += 1) {
      const count = mesh.transitions[from][to];
      if (count <= 0) continue;
      const weight = count / maxOutgoing;
      const highlighted = from === center;
      const start = positions[from];
      const end = positions[to];
      if (from === to) {
        const angle = (-90 + from * 36) * (Math.PI / 180);
        const x = start.x + Math.cos(angle) * (NODE + 7);
        const y = start.y + Math.sin(angle) * (NODE + 7);
        edges.push(
          <circle
            key={"self-" + from}
            cx={x}
            cy={y}
            r={4 + weight * 2}
            fill="none"
            stroke={highlighted ? "#4ade80" : "#334155"}
            strokeOpacity={highlighted ? 0.85 : 0.35}
            strokeWidth={highlighted ? 1.5 + weight * 2 : 0.8}
          />,
        );
        continue;
      }
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const x1 = start.x + ux * (NODE + 1);
      const y1 = start.y + uy * (NODE + 1);
      const x2 = end.x - ux * (NODE + 5);
      const y2 = end.y - uy * (NODE + 5);
      edges.push(
        <line
          key={from + "-" + to}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={highlighted ? "#4ade80" : "#334155"}
          strokeOpacity={highlighted ? 0.8 : 0.35}
          strokeWidth={highlighted ? 1 + weight * 3 : 0.85}
          markerEnd={highlighted ? "url(#" + markerId + ")" : undefined}
        />,
      );
    }
  }

  const nodes = positions.map((position, digit) => {
    const tone = nodeTone(mesh, digit);
    const palette = TONES[tone];
    const isCenter = digit === center;
    const count = mesh.counts[digit];
    const pct = mesh.percentages[digit];
    return (
      <g key={"node-" + digit}>
        <circle
          cx={position.x}
          cy={position.y}
          r={NODE}
          fill={palette.fill}
          stroke={isCenter ? "#f8fafc" : palette.stroke}
          strokeWidth={isCenter ? 2.5 : 1}
        />
        <text
          x={position.x}
          y={position.y - 3}
          textAnchor="middle"
          fontSize="14"
          fontWeight="700"
          fill={palette.text}
          fontFamily="ui-monospace, SFMono-Regular, monospace"
        >
          {digit}
        </text>
        <text
          x={position.x}
          y={position.y + 10}
          textAnchor="middle"
          fontSize="7"
          fill={palette.text}
          opacity={0.85}
          fontFamily="ui-monospace, SFMono-Regular, monospace"
        >
          {count} / {pct.toFixed(1)}%
        </text>
      </g>
    );
  });

  return (
    <article className="rounded border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted">{label}</h3>
        <label className="flex items-center gap-1 text-[10px] text-muted">
          Window
          <input
            type="number"
            min={20}
            max={300}
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitLookback}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitLookback();
              }
            }}
            className="w-16 rounded border border-line bg-ink px-1.5 py-1 font-mono text-[11px] text-slate-100 outline-none focus:border-accent disabled:opacity-50"
          />
        </label>
      </div>

      <svg viewBox={"0 0 " + SIZE + " " + SIZE} className="h-auto w-full" role="img" aria-label={label + " transition mesh"}>
        <defs>
          <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#4ade80" />
          </marker>
        </defs>
        <circle cx={CX} cy={CY} r={RING + NODE + 4} fill="none" stroke="#1f2d3a" strokeDasharray="2 6" />
        <circle cx={CX} cy={CY} r={RING - NODE - 6} fill="#0b141d" stroke="#1f2d3a" />
        {edges}
        {nodes}
        <text x={CX} y={CY - 6} textAnchor="middle" fontSize="44" fontWeight="700" fill="#f8fafc" fontFamily="ui-monospace, SFMono-Regular, monospace">
          {center >= 0 ? center : "-"}
        </text>
        <text x={CX} y={CY + 14} textAnchor="middle" fontSize="8" fill="#869bb0" letterSpacing="2">
          LIVE LAST DIGIT
        </text>
        <text x={CX} y={CY + 28} textAnchor="middle" fontSize="9" fill="#cbd5e1" fontFamily="ui-monospace, SFMono-Regular, monospace">
          {centerCount} / {mesh.total} - {centerPct.toFixed(1)}%
        </text>
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted">
        {mesh.total === 0 ? (
          <span>Waiting for the first tick in this window.</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: TONES.hot.fill }} /> #1 {mesh.hottest} ({mesh.hottestCount})</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: TONES.runner.fill }} /> #2 {mesh.runnerUp} ({mesh.runnerUpCount})</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: TONES.cold.fill }} /> cold {mesh.coldest.join(", ")}</span>
            <span className="ml-auto">{outgoingTotal} outgoing lines</span>
          </>
        )}
      </div>
    </article>
  );
}
