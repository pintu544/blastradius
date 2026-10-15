// Detection orchestration: run rules -> Finding nodes + FLAGGED_IN edges ->
// blast-radius REACHES edges -> status carry-over -> memory merge.
//
// Called by the scanner after CALLS edges are written (Day 2, analyze step).
// All writes go through the provided putNode/putEdge so the scanner's local
// node/edge arrays (and therefore the snapshot) stay in sync with the store.

import type { GraphStore } from '../graph/store.js';
import {
  findingKey,
  findingNodeId,
  SEVERITY_WEIGHT,
  type FindingSeverity,
  type FindingStatus,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from '../graph/types.js';
import { functionNodeId } from '../ingest/resolve.js';
import type { ParsedFile } from '../ingest/parser.js';
import { reachableFunctions } from '../agent/tools.js';
import { makeCtx, RULES, type RawFinding } from './rules.js';

export interface FindingRecord {
  id: string;
  ruleId: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  file: string;
  line: number;
  status: FindingStatus;
  /** Functions reachable downstream via CALLS (depth <= BLAST_DEPTH). */
  blastSize: number;
  /** Carried over from a previous scan (finding still present, was fixed). */
  carriedFixed: boolean;
}

export interface AnalyzeDeps {
  store: GraphStore;
  putNode(node: GraphNode): Promise<void>;
  putEdge(edge: GraphEdge): Promise<void>;
  onLog?: (msg: string) => void;
}

export interface AnalyzeOptions {
  repo: string;
  previous?: GraphSnapshot | null;
}

const BLAST_DEPTH = 5;

function sessionNodeId(repo: string, at: number): string {
  return `session:${repo}:${at}`;
}

function noteNodeId(repo: string, at: number, n: number): string {
  return `note:${repo}:${at}:${n}`;
}

/** The finding's own function node id, or the file node id when outside one. */
function flagTargetId(
  parsed: ParsedFile,
  fileId: string,
  line: number,
): string {
  let best: { id: string; span: number } | null = null;
  for (const fn of parsed.functions) {
    if (line >= fn.startLine && line <= fn.endLine) {
      const span = fn.endLine - fn.startLine;
      if (!best || span < best.span) {
        best = { id: functionNodeId(parsed.path, fn), span };
      }
    }
  }
  return best ? best.id : fileId;
}

export async function analyzeGraph(
  parsed: ParsedFile[],
  sources: Map<string, string>,
  deps: AnalyzeDeps,
  opts: AnalyzeOptions,
): Promise<FindingRecord[]> {
  const { store, putNode, putEdge, onLog } = deps;
  const log = onLog ?? (() => {});
  const now = Date.now();
  const records: FindingRecord[] = [];

  // --- 1. Previous-scan memory: carried statuses + notes/sessions ---------
  const carriedStatus = new Map<string, FindingStatus>();
  const carriedNotes: GraphNode[] = [];
  const carriedSessions: GraphNode[] = [];
  const carriedRemembers: GraphEdge[] = [];
  if (opts.previous) {
    for (const n of opts.previous.nodes) {
      if (n.label === 'Finding') {
        const ruleId = n.props['ruleId'];
        const file = n.props['file'];
        const line = n.props['line'];
        if (typeof ruleId === 'string' && typeof file === 'string' && typeof line === 'number') {
          carriedStatus.set(findingKey(ruleId, file, line), n.props['status'] === 'fixed' ? 'fixed' : 'open');
        }
      } else if (n.label === 'Note') {
        carriedNotes.push(n);
      } else if (n.label === 'Session') {
        carriedSessions.push(n);
      }
    }
    for (const e of opts.previous.edges) {
      if (e.type === 'REMEMBERS') carriedRemembers.push(e);
    }
  }

  // --- 2. Run rules -> Finding nodes + FLAGGED_IN -------------------------
  let rawCount = 0;
  for (const pf of parsed) {
    const text = sources.get(pf.path);
    if (text === undefined) continue;
    const ctx = makeCtx(pf.path, text);
    const fileId = `file:${pf.path}`;
    for (const rule of RULES) {
      let raws: RawFinding[];
      try {
        raws = rule.detect(ctx);
      } catch (err) {
        log(`  detect warning: ${rule.ruleId} on ${pf.path}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const raw of raws) {
        rawCount++;
        const id = findingNodeId(opts.repo, raw.ruleId, pf.path, raw.line);
        const key = findingKey(raw.ruleId, pf.path, raw.line);
        const carried = carriedStatus.get(key);
        const status: FindingStatus = carried ?? 'open';
        await putNode({
          id,
          label: 'Finding',
          props: {
            ruleId: raw.ruleId,
            severity: raw.severity,
            title: raw.title,
            description: raw.description,
            file: pf.path,
            line: raw.line,
            excerpt: raw.excerpt,
            status,
            createdAt: new Date(now).toISOString(),
            ...(carried === 'fixed' ? { carriedFixed: true } : {}),
          },
        });
        const targetId = flagTargetId(pf, fileId, raw.line);
        await putEdge({ from: id, to: targetId, type: 'FLAGGED_IN' });

        // --- 3. Blast radius -> REACHES ------------------------------------
        const { nodes: reached } = await reachableFunctions(store, targetId, BLAST_DEPTH);
        for (const fn of reached) {
          await putEdge({ from: id, to: fn.id, type: 'REACHES' });
        }
        records.push({
          id,
          ruleId: raw.ruleId,
          severity: raw.severity,
          title: raw.title,
          description: raw.description,
          file: pf.path,
          line: raw.line,
          status,
          blastSize: reached.length,
          carriedFixed: carried === 'fixed',
        });
      }
    }
  }
  log(`Detection: ${rawCount} raw hits -> ${records.length} findings.`);

  // --- 4. Memory: carry notes/sessions, open a new session ----------------
  for (const n of carriedNotes) await putNode(n);
  for (const n of carriedSessions) await putNode(n);
  for (const e of carriedRemembers) await putEdge(e);

  const sessionId = sessionNodeId(opts.repo, now);
  await putNode({
    id: sessionId,
    label: 'Session',
    props: { startedAt: new Date(now).toISOString(), repo: opts.repo },
  });
  let noteN = 0;
  for (const n of carriedNotes) {
    await putEdge({ from: sessionId, to: n.id, type: 'REMEMBERS' });
  }
  const openCount = records.filter((r) => r.status === 'open').length;
  const summaryId = noteNodeId(opts.repo, now, noteN++);
  await putNode({
    id: summaryId,
    label: 'Note',
    props: {
      text:
        `Scan of ${opts.repo}: ${records.length} findings ` +
        `(${openCount} open, ${records.length - openCount} carried as fixed).`,
      createdAt: new Date(now).toISOString(),
    },
  });
  await putEdge({ from: sessionId, to: summaryId, type: 'REMEMBERS' });
  log(`Memory: new session ${sessionId}, carried ${carriedNotes.length} notes.`);

  // Deterministic order for the report: severity first, then blast size.
  records.sort(
    (a, b) =>
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      b.blastSize - a.blastSize ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  return records;
}
