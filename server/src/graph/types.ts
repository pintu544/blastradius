// Graph model types for BlastRadius Day 1 ingestion.
//
// Node labels and relationship types follow PLAN.md §2 ("Proposed graph data
// model"). Day 1 populates: File, Function, Class, Import, Commit, Author and
// DEFINES / CALLS / IMPORTS / AUTHORED / TOUCHED / OWNS edges. Finding,
// Session and Note labels arrive on Day 2.

export type NodeLabel =
  | 'File'
  | 'Function'
  | 'Class'
  | 'Import'
  | 'Commit'
  | 'Author';

export type EdgeType =
  | 'DEFINES'
  | 'CALLS'
  | 'IMPORTS'
  | 'AUTHORED'
  | 'TOUCHED'
  | 'OWNS';

export type PropValue = string | number | boolean | string[];

export interface GraphNode {
  /** Deterministic, unique-within-one-repo id, e.g. `fn:src/index.js:main#12`. */
  id: string;
  label: NodeLabel;
  props: Record<string, PropValue>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  props?: Record<string, PropValue>;
}

export interface GraphStats {
  files: number;
  functions: number;
  classes: number;
  imports: number;
  commits: number;
  authors: number;
  callsEdges: number;
  importsEdges: number;
  definesEdges: number;
  touchedEdges: number;
  ownsEdges: number;
  authoredEdges: number;
}

export function emptyStats(): GraphStats {
  return {
    files: 0,
    functions: 0,
    classes: 0,
    imports: 0,
    commits: 0,
    authors: 0,
    callsEdges: 0,
    importsEdges: 0,
    definesEdges: 0,
    touchedEdges: 0,
    ownsEdges: 0,
    authoredEdges: 0,
  };
}

/** Full snapshot of one repo graph — written by the scanner for the API. */
export interface GraphSnapshot {
  repo: string;
  scannedAt: string;
  stats: GraphStats;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
