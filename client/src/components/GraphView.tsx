// Hand-rolled SVG blast-radius graph (Day 3).
// Layered left-to-right layout: the flagged source sits at layer 0 (red),
// downstream functions fan out to the right. No graph library — plain SVG.

import { useMemo } from 'react';
import type { GraphEdgeView, GraphNodeView } from '../api';

interface Props {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  /** Id of the flagged source node (rendered red). */
  flaggedId?: string | null;
  height?: number;
}

const NODE_W = 176;
const NODE_H = 34;
const LAYER_X = 230;
const ROW_Y = 52;
const PAD = 28;

function shortLabel(name: string): string {
  const base = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return base.length > 22 ? `${base.slice(0, 21)}…` : base;
}

export default function GraphView({ nodes, edges, flaggedId, height = 380 }: Props) {
  const layout = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    for (const n of nodes) {
      out.set(n.id, []);
      indeg.set(n.id, 0);
    }
    for (const e of edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      out.get(e.from)!.push(e.to);
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }

    // BFS layers from the flagged source (or from roots if none given).
    const starts = flaggedId && byId.has(flaggedId)
      ? [flaggedId]
      : nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
    const layer = new Map<string, number>();
    const queue: string[] = [];
    for (const s of starts.length > 0 ? starts : nodes.slice(0, 1).map((n) => n.id)) {
      if (!layer.has(s)) {
        layer.set(s, 0);
        queue.push(s);
      }
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      const d = layer.get(id)!;
      for (const next of out.get(id) ?? []) {
        if (!layer.has(next)) {
          layer.set(next, d + 1);
          queue.push(next);
        }
      }
    }
    // Anything unreachable goes in a final overflow layer.
    let maxLayer = 0;
    for (const l of layer.values()) maxLayer = Math.max(maxLayer, l);
    for (const n of nodes) {
      if (!layer.has(n.id)) layer.set(n.id, maxLayer + 1);
    }

    const layers: string[][] = [];
    for (const [id, l] of layer) {
      (layers[l] ??= []).push(id);
    }
    const positions = new Map<string, { x: number; y: number }>();
    const totalH = Math.max(height, Math.max(...layers.map((l) => l.length)) * ROW_Y + PAD * 2);
    layers.forEach((ids, l) => {
      const colH = ids.length * ROW_Y;
      const y0 = (totalH - colH) / 2 + ROW_Y / 2;
      ids.forEach((id, i) => {
        positions.set(id, { x: PAD + l * LAYER_X, y: y0 + i * ROW_Y });
      });
    });
    const width = PAD * 2 + layers.length * LAYER_X;
    return { positions, width, height: totalH };
  }, [nodes, edges, flaggedId, height]);

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
        No downstream functions — this finding is isolated.
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="w-full rounded-lg bg-slate-950/60 border border-slate-800"
      role="img"
      aria-label="Blast radius call graph"
    >
      <defs>
        <marker id="br-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#f59e0b" fillOpacity="0.7" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const a = layout.positions.get(e.from);
        const b = layout.positions.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x + NODE_W}
            y1={a.y}
            x2={b.x - 4}
            y2={b.y}
            stroke="#f59e0b"
            strokeOpacity="0.55"
            strokeWidth="1.5"
            markerEnd="url(#br-arrow)"
          />
        );
      })}
      {nodes.map((n) => {
        const p = layout.positions.get(n.id);
        if (!p) return null;
        const isFlagged = n.id === flaggedId;
        return (
          <g key={n.id}>
            <title>{`${n.name}\n${n.file}`}</title>
            <rect
              x={p.x}
              y={p.y - NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              rx="8"
              fill={isFlagged ? '#7f1d1d' : '#1e293b'}
              stroke={isFlagged ? '#ef4444' : '#475569'}
              strokeWidth={isFlagged ? 2 : 1}
            />
            <text
              x={p.x + NODE_W / 2}
              y={p.y + 4}
              textAnchor="middle"
              fontSize="12"
              fontFamily="ui-monospace, monospace"
              fill={isFlagged ? '#fecaca' : '#cbd5e1'}
            >
              {shortLabel(n.name)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
