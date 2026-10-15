// Graph model types for BlastRadius Day 1 ingestion + Day 2 detection/agent.
//
// Node labels and relationship types follow PLAN.md §2 ("Proposed graph data
// model"). Day 1 populates: File, Function, Class, Import, Commit, Author and
// DEFINES / CALLS / IMPORTS / AUTHORED / TOUCHED / OWNS edges. Day 2 adds:
// Finding, Session, Note and FLAGGED_IN / REACHES / REMEMBERS edges.

export type NodeLabel =
  | 'File'
  | 'Function'
  | 'Class'
  | 'Import'
  | 'Commit'
  | 'Author'
  | 'Finding'
  | 'Session'
  | 'Note';

export type EdgeType =
  | 'DEFINES'
  | 'CALLS'
  | 'IMPORTS'
  | 'AUTHORED'
  | 'TOUCHED'
  | 'OWNS'
  | 'FLAGGED_IN'
  | 'REACHES'
  | 'REMEMBERS';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type FindingStatus = 'open' | 'fixed';

/** Numeric weight per severity for impact ranking. */
export const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

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
  findings: number;
  sessions: number;
  notes: number;
  callsEdges: number;
  importsEdges: number;
  definesEdges: number;
  touchedEdges: number;
  ownsEdges: number;
  authoredEdges: number;
  flaggedInEdges: number;
  reachesEdges: number;
  remembersEdges: number;
}

export function emptyStats(): GraphStats {
  return {
    files: 0,
    functions: 0,
    classes: 0,
    imports: 0,
    commits: 0,
    authors: 0,
    findings: 0,
    sessions: 0,
    notes: 0,
    callsEdges: 0,
    importsEdges: 0,
    definesEdges: 0,
    touchedEdges: 0,
    ownsEdges: 0,
    authoredEdges: 0,
    flaggedInEdges: 0,
    reachesEdges: 0,
    remembersEdges: 0,
  };
}

/** Deterministic finding id: stable across scans so status carries over. */
export function findingNodeId(
  repo: string,
  ruleId: string,
  file: string,
  line: number,
): string {
  return `finding:${repo}:${ruleId}:${file}#${line}`;
}

/** Key used to carry a finding's status across scans. */
export function findingKey(ruleId: string, file: string, line: number): string {
  return `${ruleId}\u0000${file}\u0000${line}`;
}

/** Full snapshot of one repo graph — written by the scanner for the API. */
export interface GraphSnapshot {
  repo: string;
  scannedAt: string;
  stats: GraphStats;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
