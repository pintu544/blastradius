// Placeholder shell only. The findings UI (ranked list, blast-radius
// graph visualization, chat) is built during the Graph Hacks event,
// Oct 15-18 2026.
export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
      <div className="text-center px-6">
        <h1 className="text-4xl font-bold tracking-tight">BlastRadius</h1>
        <p className="mt-3 text-slate-400">
          An AI agent that finds risky code and traces its blast radius
          through your codebase graph.
        </p>
        <p className="mt-6 text-sm text-slate-500">
          Graph Hacks 2026 entry — build starts Oct 15
        </p>
      </div>
    </div>
  );
}
