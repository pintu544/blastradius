// InMemoryGraphStore — default graph backend for local dev and tests.
// Faithful implementation of the GraphStore contract: nodes keyed by id,
// edges deduplicated on (from, to, type), adjacency kept for neighbor walks.

import type { NeighborsOptions, GraphStore } from './store.js';
import {
  emptyStats,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type GraphStats,
} from './types.js';

const EDGE_KEY = (e: GraphEdge) => `${e.from}\u0000${e.to}\u0000${e.type}`;

export class InMemoryGraphStore implements GraphStore {
  readonly kind = 'memory' as const;

  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private outAdj = new Map<string, Set<string>>(); // node id -> edge keys
  private inAdj = new Map<string, Set<string>>();

  async upsertNode(node: GraphNode): Promise<void> {
    const existing = this.nodes.get(node.id);
    if (existing) {
      existing.props = { ...existing.props, ...node.props };
    } else {
      this.nodes.set(node.id, { ...node, props: { ...node.props } });
    }
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    const key = EDGE_KEY(edge);
    if (this.edges.has(key)) return; // dedupe
    // Only link nodes that exist — keeps the graph referentially clean.
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    this.edges.set(key, edge);
    this.addToAdj(this.outAdj, edge.from, key);
    this.addToAdj(this.inAdj, edge.to, key);
  }

  private addToAdj(adj: Map<string, Set<string>>, id: string, key: string): void {
    let set = adj.get(id);
    if (!set) {
      set = new Set();
      adj.set(id, set);
    }
    set.add(key);
  }

  async getNode(id: string): Promise<GraphNode | undefined> {
    return this.nodes.get(id);
  }

  async neighbors(id: string, opts: NeighborsOptions = {}): Promise<GraphNode[]> {
    const { type, direction = 'both' } = opts;
    const keys = new Set<string>();
    if (direction === 'out' || direction === 'both') {
      for (const k of this.outAdj.get(id) ?? []) keys.add(k);
    }
    if (direction === 'in' || direction === 'both') {
      for (const k of this.inAdj.get(id) ?? []) keys.add(k);
    }
    const result: GraphNode[] = [];
    for (const k of keys) {
      const edge = this.edges.get(k);
      if (!edge) continue;
      if (type && edge.type !== type) continue;
      const otherId = edge.from === id ? edge.to : edge.from;
      const node = this.nodes.get(otherId);
      if (node) result.push(node);
    }
    return result;
  }

  async stats(): Promise<GraphStats> {
    const s = emptyStats();
    for (const node of this.nodes.values()) {
      switch (node.label) {
        case 'File': s.files++; break;
        case 'Function': s.functions++; break;
        case 'Class': s.classes++; break;
        case 'Import': s.imports++; break;
        case 'Commit': s.commits++; break;
        case 'Author': s.authors++; break;
      }
    }
    for (const edge of this.edges.values()) {
      const counter: Record<EdgeType, keyof GraphStats> = {
        CALLS: 'callsEdges',
        IMPORTS: 'importsEdges',
        DEFINES: 'definesEdges',
        TOUCHED: 'touchedEdges',
        OWNS: 'ownsEdges',
        AUTHORED: 'authoredEdges',
      };
      s[counter[edge.type]]++;
    }
    return s;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
