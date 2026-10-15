// BlastRadius web UI (Day 3): scan → ranked findings → blast-radius graph
// → explainability (Cypher) → "what breaks if I change X?" chat.

import { useCallback, useEffect, useState } from 'react';
import {
  SEVERITY_STYLE,
  apiAsk,
  apiBlastRadius,
  apiFindings,
  apiScan,
  type AskResult,
  type BlastRadiusView,
  type FindingItem,
  type Severity,
} from './api';
import GraphView from './components/GraphView';

function CypherBlock({ cypher }: { cypher: string }) {
  return (
    <div className="mt-4">
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">
        Cypher behind this trace
      </div>
      <pre className="text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto text-emerald-300/90">
        {cypher}
      </pre>
    </div>
  );
}

function severityBadge(sev: Severity) {
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs font-semibold rounded border ${SEVERITY_STYLE[sev] ?? SEVERITY_STYLE.low}`}
    >
      {sev.toUpperCase()}
    </span>
  );
}

export default function App() {
  const [repoInput, setRepoInput] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<string | null>(null);

  const [findings, setFindings] = useState<FindingItem[]>([]);
  const [loadingFindings, setLoadingFindings] = useState(false);
  const [findingsError, setFindingsError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [blast, setBlast] = useState<BlastRadiusView | null>(null);
  const [loadingBlast, setLoadingBlast] = useState(false);

  const [askQ, setAskQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const loadFindings = useCallback(async (repoName: string) => {
    setLoadingFindings(true);
    setFindingsError(null);
    setSelectedId(null);
    setBlast(null);
    try {
      const data = await apiFindings(repoName);
      setFindings(data.findings);
      if (data.findings.length > 0) setSelectedId(data.findings[0].id);
    } catch (e) {
      setFindingsError(e instanceof Error ? e.message : String(e));
      setFindings([]);
    } finally {
      setLoadingFindings(false);
    }
  }, []);

  const loadDemo = useCallback(() => {
    setScanError(null);
    setScanInfo('Loaded pre-scanned demo repo "vuln-demo".');
    setRepo('vuln-demo');
    void loadFindings('vuln-demo');
  }, [loadFindings]);

  // Auto-load the pre-scanned demo on first paint so judges see data at once.
  useEffect(() => {
    loadDemo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doScan = useCallback(async () => {
    const target = repoInput.trim();
    if (!target || scanning) return;
    setScanning(true);
    setScanError(null);
    setScanInfo(null);
    try {
      const result = await apiScan(target);
      setRepo(result.repo);
      setScanInfo(
        `Scanned "${result.repo}" — ${result.stats.functions ?? 0} functions, ` +
          `${result.findings.length} open findings (${result.storeKind}).`,
      );
      await loadFindings(result.repo);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }, [repoInput, scanning, loadFindings]);

  useEffect(() => {
    if (!selectedId || !repo) {
      setBlast(null);
      return;
    }
    let cancelled = false;
    setLoadingBlast(true);
    apiBlastRadius(selectedId, repo)
      .then((b) => {
        if (!cancelled) setBlast(b);
      })
      .catch(() => {
        if (!cancelled) setBlast(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingBlast(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, repo]);

  const doAsk = useCallback(async () => {
    const q = askQ.trim();
    if (!q || !repo || asking) return;
    setAsking(true);
    setAskError(null);
    setAskResult(null);
    try {
      setAskResult(await apiAsk(repo, q));
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  }, [askQ, repo, asking]);

  const selected = findings.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Blast<span className="text-red-400">Radius</span>
          </h1>
          <p className="text-sm text-slate-400">
            Risky code, traced through your codebase graph — built on FalkorDB
          </p>
        </div>
        {repo && (
          <div className="text-xs font-mono bg-slate-900 border border-slate-700 rounded px-3 py-1.5">
            repo: <span className="text-emerald-300">{repo}</span>
          </div>
        )}
      </header>

      {/* Scan bar */}
      <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center gap-3">
        <input
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doScan();
          }}
          placeholder="GitHub repo URL or local path — e.g. https://github.com/pintu544/blastradius"
          className="flex-1 min-w-64 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm placeholder:text-slate-500 focus:outline-none focus:border-red-400"
        />
        <button
          onClick={() => void doScan()}
          disabled={scanning || !repoInput.trim()}
          className="px-5 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold"
        >
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
        <button
          onClick={loadDemo}
          className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
        >
          Load vuln-demo (pre-scanned)
        </button>
      </div>
      {scanning && (
        <div className="px-6 py-2 text-sm text-amber-300">
          Scanning — cloning, parsing and analyzing… this can take ~30s for larger repos.
        </div>
      )}
      {scanError && <div className="px-6 py-2 text-sm text-red-300">Scan failed: {scanError}</div>}
      {scanInfo && !scanError && <div className="px-6 py-2 text-sm text-slate-400">{scanInfo}</div>}

      {/* Main grid */}
      <main className="px-6 py-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Findings list */}
        <section className="lg:col-span-1">
          <h2 className="text-sm uppercase tracking-wider text-slate-500 mb-2">
            Findings — ranked by impact
          </h2>
          {loadingFindings && <div className="text-sm text-slate-400">Loading findings…</div>}
          {findingsError && <div className="text-sm text-red-300">{findingsError}</div>}
          {!loadingFindings && !findingsError && findings.length === 0 && (
            <div className="text-sm text-slate-500 border border-dashed border-slate-700 rounded-lg p-4">
              No open findings — scan a repo to begin.
            </div>
          )}
          <div className="space-y-2">
            {findings.map((f) => (
              <button
                key={f.id}
                onClick={() => setSelectedId(f.id)}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${
                  f.id === selectedId
                    ? 'border-red-400/60 bg-slate-900'
                    : 'border-slate-800 bg-slate-900/50 hover:border-slate-600'
                }`}
              >
                <div className="flex items-center gap-2">
                  {severityBadge(f.severity)}
                  <span className="text-xs text-slate-500 font-mono">score {f.score.toFixed(1)}</span>
                  <span className="text-xs text-slate-500 ml-auto">
                    blast <span className="text-amber-300 font-semibold">{f.blastSize}</span>
                  </span>
                </div>
                <div className="mt-1.5 text-sm font-medium">{f.title}</div>
                <div className="mt-0.5 text-xs text-slate-500 font-mono truncate">
                  {f.file}:{f.line} · {f.ruleId}
                </div>
                {f.owner && (
                  <div className="mt-1 text-xs text-slate-400">
                    owner: <span className="text-slate-200">{f.owner.name}</span>
                  </div>
                )}
              </button>
            ))}
          </div>
        </section>

        {/* Blast radius detail */}
        <section className="lg:col-span-2">
          <h2 className="text-sm uppercase tracking-wider text-slate-500 mb-2">Blast radius</h2>
          {!selected && (
            <div className="text-sm text-slate-500 border border-dashed border-slate-700 rounded-lg p-4">
              Select a finding to trace its blast radius.
            </div>
          )}
          {selected && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                {severityBadge(selected.severity)}
                <span className="font-semibold">{selected.title}</span>
              </div>
              <p className="mt-1 text-sm text-slate-400">{selected.description}</p>
              <div className="mt-1 text-xs text-slate-500 font-mono">
                {selected.file}:{selected.line} · {selected.ruleId} · blast size {selected.blastSize} ·
                avg degree {selected.avgDegree}
                {selected.owner && (
                  <>
                    {' '}· suggested reviewer <span className="text-slate-300">{selected.owner.name}</span>
                  </>
                )}
              </div>
              <div className="mt-3">
                {loadingBlast && <div className="text-sm text-slate-400">Tracing…</div>}
                {!loadingBlast && blast && (
                  <>
                    <GraphView
                      nodes={blast.nodes}
                      edges={blast.edges}
                      flaggedId={blast.flagged?.id ?? null}
                    />
                    <CypherBlock cypher={blast.cypher} />
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Chat */}
      <section className="px-6 pb-10">
        <h2 className="text-sm uppercase tracking-wider text-slate-500 mb-2">
          Ask — what breaks if I change X?
        </h2>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex gap-3">
            <input
              value={askQ}
              onChange={(e) => setAskQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doAsk();
              }}
              placeholder={repo ? `e.g. what breaks if I change getUser? (repo: ${repo})` : 'Load or scan a repo first'}
              disabled={!repo}
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm placeholder:text-slate-500 focus:outline-none focus:border-red-400 disabled:opacity-40"
            />
            <button
              onClick={() => void doAsk()}
              disabled={asking || !askQ.trim() || !repo}
              className="px-5 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold"
            >
              {asking ? 'Asking…' : 'Ask'}
            </button>
          </div>
          {askError && <div className="mt-2 text-sm text-red-300">{askError}</div>}
          {askResult && (
            <div className="mt-3">
              <p className="text-sm text-slate-200">{askResult.summary}</p>
              <div className="mt-2 text-xs text-slate-500 font-mono">
                matched <span className="text-emerald-300">{askResult.match.name}</span> in{' '}
                {askResult.match.file}
                {askResult.finding && (
                  <>
                    {' '}· flagged: <span className="text-red-300">{askResult.finding.title}</span>
                  </>
                )}
              </div>
              <div className="mt-2">
                <GraphView
                  nodes={askResult.nodes}
                  edges={askResult.edges}
                  flaggedId={askResult.match.id}
                  height={260}
                />
              </div>
              <CypherBlock cypher={askResult.cypher} />
            </div>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-slate-600">
          BlastRadius · Graph Hacks 2026 · code graph + blast-radius tracing on FalkorDB
        </p>
      </section>
    </div>
  );
}
