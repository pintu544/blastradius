// Typed client for the BlastRadius server API (Day 3).
// Base URL comes from Vite env, falling back to the local dev server.

export const API_BASE: string =
  import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface FindingItem {
  id: string;
  ruleId: string;
  severity: Severity;
  title: string;
  description: string;
  file: string;
  line: number;
  status: string;
  score: number;
  blastSize: number;
  avgDegree: number;
  owner: { name: string; email: string } | null;
}

export interface GraphNodeView {
  id: string;
  name: string;
  file: string;
}

export interface GraphEdgeView {
  from: string;
  to: string;
}

export interface BlastRadiusView {
  finding: { id: string; ruleId: string; severity: string; title: string; file: string; line: number };
  flagged: { id: string; label: string; name: string; file: string } | null;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  cypher: string;
}

export interface AskResult {
  match: { id: string; name: string; file: string };
  finding: { id: string; ruleId: string; severity: string; title: string } | null;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  cypher: string;
  summary: string;
}

export interface ScanResult {
  repo: string;
  scannedAt: string;
  stats: Record<string, number>;
  storeKind: string;
  fallbackWarning: string | null;
  findings: FindingItem[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export function apiStats(repo: string) {
  return req<{ repo: string; scannedAt: string; stats: Record<string, number> }>(
    `/api/stats?repo=${encodeURIComponent(repo)}`,
  );
}

export function apiFindings(repo: string) {
  return req<{ repo: string; scannedAt: string; open: number; findings: FindingItem[] }>(
    `/api/findings?repo=${encodeURIComponent(repo)}`,
  );
}

export function apiBlastRadius(findingId: string, repo: string) {
  return req<BlastRadiusView>(
    `/api/blast-radius/${encodeURIComponent(findingId)}?repo=${encodeURIComponent(repo)}`,
  );
}

export function apiScan(repo: string) {
  return req<ScanResult>('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, memory: true }),
  });
}

export function apiAsk(repo: string, q: string) {
  return req<AskResult>(
    `/api/ask?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(q)}`,
  );
}

export const SEVERITY_STYLE: Record<Severity, string> = {
  critical: 'bg-red-500/15 text-red-300 border-red-500/40',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  low: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
};
