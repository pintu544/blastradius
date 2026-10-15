// Cross-file call resolution: turns the parser's RawCalls into CALLS edges.
//
// Resolution order for `foo()` in file F:
//   1. a function named `foo` defined in F (top-level first, then nested),
//   2. a name imported into F (`import {foo}`, `import foo`, `const {foo} =
//      require(...)`) — resolved through the imported file's exports.
// Resolution for `obj.method()`:
//   1. `this.method()` / `ClassName.method()` → method of the enclosing or
//      named class,
//   2. `ns.method()` where `ns` is a namespace import → exported `method`
//      in the imported file,
//   3. `Def.method()` where `Def` is a default import → method of the
//      default-exported class in the imported file,
//   4. `ClassName.method()` where the class is defined in F.
// Anything else (stdlib, npm packages, dynamic lookups) is left unresolved —
// deliberately, not a bug: BlastRadius models the repo's own call graph.

import * as path from 'node:path';
import type { GraphEdge } from '../graph/types.js';
import type { ParsedClass, ParsedFile, ParsedFunction, ParsedImport } from './parser.js';

export const fileNodeId = (relPath: string): string => `file:${relPath}`;

export const functionNodeId = (relPath: string, fn: ParsedFunction): string =>
  `fn:${relPath}:${fn.qualifiedName}#${fn.startLine}`;

export const classNodeId = (relPath: string, className: string): string =>
  `class:${relPath}:${className}`;

export const importNodeId = (relPath: string, imp: ParsedImport): string =>
  `import:${relPath}#${imp.line}:${imp.module}`;

const EXTENSIONS = ['', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
const INDEX_FILES = ['index.js', 'index.jsx', 'index.ts', 'index.tsx', 'index.mjs', 'index.cjs'];

/** Resolve a relative import specifier to a parsed file in the repo. */
export function resolveModuleFile(
  fromPath: string,
  module: string,
  filesByPath: Map<string, ParsedFile>,
): ParsedFile | null {
  if (!module.startsWith('.')) return null; // external package / builtin
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), module));
  // Direct hit first (specifier already has the right extension, e.g. './math.js').
  const direct = filesByPath.get(base);
  if (direct) return direct;
  // Otherwise try the extension-stripped stem with every known extension, so
  // './app.js' also resolves to 'src/app.ts' (TS-style extension probing).
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (const e of EXTENSIONS) {
    const hit = filesByPath.get(stem + e);
    if (hit) return hit;
  }
  for (const index of INDEX_FILES) {
    const hit = filesByPath.get(path.posix.join(base, index));
    if (hit) return hit;
  }
  return null;
}

function topLevelFirst(fns: ParsedFunction[]): ParsedFunction[] {
  return [...fns].sort((a, b) => {
    const aTop = a.qualifiedName === a.name ? 0 : 1;
    const bTop = b.qualifiedName === b.name ? 0 : 1;
    return aTop - bTop || a.startLine - b.startLine;
  });
}

function findFunctionInFile(file: ParsedFile, name: string): ParsedFunction | null {
  const matches = file.functions.filter((f) => f.name === name);
  if (matches.length === 0) return null;
  return topLevelFirst(matches)[0];
}

function findDefaultExport(file: ParsedFile): ParsedFunction | null {
  return file.functions.find((f) => f.isDefault) ?? null;
}

function findDefaultClass(file: ParsedFile): ParsedClass | null {
  return file.classes.find((c) => c.isDefault) ?? null;
}

function findMethod(file: ParsedFile, className: string, method: string): ParsedFunction | null {
  return (
    file.functions.find((f) => f.kind === 'method' && f.className === className && f.name === method) ??
    null
  );
}

/** Resolve every raw call in every file to a CALLS GraphEdge. */
export function resolveCalls(files: ParsedFile[]): GraphEdge[] {
  const filesByPath = new Map(files.map((f) => [f.path, f]));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const emit = (fromId: string, toId: string, line: number): void => {
    if (fromId === toId) return;
    const key = `${fromId}\u0000${toId}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: fromId, to: toId, type: 'CALLS', props: { line } });
  };

  for (const file of files) {
    // Pre-resolve this file's imports once.
    const resolvedImports = file.imports.map((imp) => ({
      imp,
      target: resolveModuleFile(file.path, imp.module, filesByPath),
    }));

    for (const fn of file.functions) {
      const fromId = functionNodeId(file.path, fn);
      for (const call of fn.calls) {
        const toId = resolveOneCall(file, fn, call.name, call.receiver, resolvedImports);
        if (toId) emit(fromId, toId, call.line);
      }
    }
  }
  return edges;
}

interface ResolvedImport {
  imp: ParsedImport;
  target: ParsedFile | null;
}

function resolveOneCall(
  file: ParsedFile,
  fn: ParsedFunction,
  name: string,
  receiver: string | null,
  resolvedImports: ResolvedImport[],
): string | null {
  if (receiver === null) {
    // 1. Same-file function.
    const local = findFunctionInFile(file, name);
    if (local) return functionNodeId(file.path, local);
    // 2. Imported name.
    for (const { imp, target } of resolvedImports) {
      if (!target) continue;
      if (imp.defaultName === name) {
        const def = findDefaultExport(target);
        if (def) return functionNodeId(target.path, def);
        // Default-exported class used as a constructor: link to its constructor.
        const cls = findDefaultClass(target);
        if (cls) {
          const ctor = findMethod(target, cls.name, 'constructor');
          if (ctor) return functionNodeId(target.path, ctor);
        }
        continue;
      }
      if (imp.names.includes(name)) {
        const original = imp.aliases[name] ?? name;
        const exported = findFunctionInFile(target, original);
        // Prefer exported matches, but a same-file fallback is still the
        // repo's own code, so accept any match.
        if (exported) return functionNodeId(target.path, exported);
      }
    }
    return null;
  }

  // receiver.method()
  // 1. this.method() or ClassName.method() on the enclosing class.
  const selfClass = receiver === 'this' ? fn.className : receiver === fn.className ? fn.className : null;
  if (selfClass) {
    const method = findMethod(file, selfClass, name);
    if (method) return functionNodeId(file.path, method);
  }
  // 2/3. Imported namespace / default-import-as-class.
  for (const { imp, target } of resolvedImports) {
    if (!target) continue;
    if (imp.namespaceName === receiver) {
      const exported = findFunctionInFile(target, name);
      if (exported) return functionNodeId(target.path, exported);
    } else if (imp.defaultName === receiver) {
      // `Def.method()` where Def is a default import: method of the
      // default-exported class (or a same-named class) in the target file.
      const cls =
        findDefaultClass(target) ?? target.classes.find((c) => c.name === receiver) ?? null;
      if (cls) {
        const method = findMethod(target, cls.name, name);
        if (method) return functionNodeId(target.path, method);
      }
    }
  }
  // 4. Same-file class.
  const cls = file.classes.find((c) => c.name === receiver);
  if (cls) {
    const method = findMethod(file, cls.name, name);
    if (method) return functionNodeId(file.path, method);
  }
  return null;
}
