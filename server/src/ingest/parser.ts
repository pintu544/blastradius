// JS/TS parsing with tree-sitter (WASM via web-tree-sitter — no native builds).
//
// Per file we extract:
//   - Function nodes: declarations, arrow functions assigned to consts,
//     class methods, exported functions, `x.y = () => {}` assignments.
//     Top-level (module scope) calls are attributed to a synthetic
//     `<module>` function so CALLS edges stay uniform.
//   - Class nodes with their methods.
//   - Import statements: `import ... from '...'` (named / default /
//     namespace) and `require('...')` (identifier or destructured).
//   - Raw calls: `foo()`, `obj.method()`, `new Foo()`, `this.method()`.
//     Cross-file resolution to CALLS edges happens in resolve.ts.

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { Parser, Language, type Node as TSNode } from 'web-tree-sitter';

export type SourceLanguage = 'javascript' | 'typescript';

export interface RawCall {
  /** Callee name, e.g. `foo` in `foo()` or `bar` in `obj.bar()`. */
  name: string;
  /** Receiver, e.g. `obj` in `obj.bar()`, `this` in `this.bar()`, else null. */
  receiver: string | null;
  line: number;
}

export interface ParsedFunction {
  name: string;
  qualifiedName: string;
  kind: 'declaration' | 'arrow' | 'function-expression' | 'method' | 'module';
  startLine: number;
  endLine: number;
  exported: boolean;
  isDefault: boolean;
  /** Enclosing class name for methods (used to resolve `this.x()`). */
  className: string | null;
  calls: RawCall[];
}

export interface ParsedClass {
  name: string;
  startLine: number;
  endLine: number;
  methods: string[];
  exported: boolean;
  isDefault: boolean;
}

export interface ParsedImport {
  module: string;
  /** Local names bound by the import (after alias resolution use `aliases`). */
  names: string[];
  /** local -> original name for `import {a as b}` / require destructuring. */
  aliases: Record<string, string>;
  defaultName: string | null;
  namespaceName: string | null;
  line: number;
  kind: 'import' | 'require';
}

export interface ParsedFile {
  /** Repo-relative posix path. */
  path: string;
  language: SourceLanguage;
  loc: number;
  functions: ParsedFunction[];
  classes: ParsedClass[];
  imports: ParsedImport[];
}

// ---------------------------------------------------------------------------
// Language loading (singleton)
// ---------------------------------------------------------------------------

interface LoadedLanguages {
  javascript: Language;
  typescript: Language;
  tsx: Language;
}

let languagesPromise: Promise<LoadedLanguages> | null = null;

function wasmPath(pkg: string, file: string): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return path.join(path.dirname(pkgJson), file);
}

export function ensureLanguages(): Promise<LoadedLanguages> {
  if (!languagesPromise) {
    languagesPromise = (async () => {
      await Parser.init();
      const [javascript, typescript, tsx] = await Promise.all([
        Language.load(wasmPath('tree-sitter-javascript', 'tree-sitter-javascript.wasm')),
        Language.load(wasmPath('tree-sitter-typescript', 'tree-sitter-typescript.wasm')),
        Language.load(wasmPath('tree-sitter-typescript', 'tree-sitter-tsx.wasm')),
      ]);
      return { javascript, typescript, tsx };
    })();
  }
  return languagesPromise;
}

const parsers = new Map<SourceLanguage, Parser>();

export async function getParser(lang: SourceLanguage): Promise<Parser> {
  let p = parsers.get(lang);
  if (!p) {
    const langs = await ensureLanguages();
    p = new Parser();
    p.setLanguage(lang === 'javascript' ? langs.javascript : lang === 'typescript' ? langs.typescript : langs.tsx);
    parsers.set(lang, p);
  }
  return p;
}

export function languageForExtension(ext: string): SourceLanguage | null {
  switch (ext.toLowerCase()) {
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'tsx' as SourceLanguage; // mapped to the tsx grammar in getParser
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Per-file parsing
// ---------------------------------------------------------------------------

interface WalkState {
  source: string;
  file: ParsedFile;
  /** Qualified names of enclosing functions (for nested fn qualifiedName). */
  scope: string[];
  /** Enclosing class names (for `this.` resolution and method qnames). */
  classStack: string[];
  /** Names exported via `export { a, b as c }` — applied after the walk. */
  exportNames: { local: string; exported: string }[];
}

const lineOf = (n: TSNode) => n.startPosition.row + 1;
const endLineOf = (n: TSNode) => n.endPosition.row + 1;
const textOf = (n: TSNode) => n.text;

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === '`')) return s.slice(1, -1);
  return s;
}

function registerFunction(
  state: WalkState,
  opts: {
    name: string;
    kind: ParsedFunction['kind'];
    node: TSNode;
    exported?: boolean;
    isDefault?: boolean;
  },
): ParsedFunction {
  const scopePrefix = state.scope.length > 0 ? `${state.scope.join('.')}.` : '';
  const fn: ParsedFunction = {
    name: opts.name,
    qualifiedName: `${scopePrefix}${opts.name}`,
    kind: opts.kind,
    startLine: lineOf(opts.node),
    endLine: endLineOf(opts.node),
    exported: opts.exported ?? false,
    isDefault: opts.isDefault ?? false,
    className: state.classStack.length > 0 ? state.classStack[state.classStack.length - 1] : null,
    calls: [],
  };
  state.file.functions.push(fn);
  return fn;
}

/** Record call_expressions / new_expressions in a subtree, WITHOUT
 *  registering nested declarations (those are handled by walkDeclarations). */
function collectCalls(node: TSNode, fn: ParsedFunction): void {
  const visit = (n: TSNode): void => {
    if (n.type === 'call_expression' || n.type === 'new_expression') {
      const callee = n.childForFieldName(n.type === 'call_expression' ? 'function' : 'constructor');
      if (callee) recordCallee(callee, fn, lineOf(n));
    }
    // Don't descend into nested function bodies here — walkDeclarations
    // visits them separately so calls attach to the right function.
    if (
      n.type === 'function_declaration' ||
      n.type === 'generator_function_declaration' ||
      n.type === 'arrow_function' ||
      n.type === 'function_expression' ||
      n.type === 'method_definition'
    ) {
      return;
    }
    for (const child of n.namedChildren) visit(child);
  };
  visit(node);
}

function recordCallee(callee: TSNode, fn: ParsedFunction, line: number): void {
  if (callee.type === 'identifier') {
    fn.calls.push({ name: textOf(callee), receiver: null, line });
  } else if (callee.type === 'member_expression') {
    const obj = callee.childForFieldName('object');
    const prop = callee.childForFieldName('property');
    if (obj && prop) {
      const objText = obj.type === 'this' ? 'this' : textOf(obj);
      fn.calls.push({ name: textOf(prop), receiver: objText, line });
    }
  }
}

function functionValueKind(node: TSNode): ParsedFunction['kind'] | null {
  if (node.type === 'arrow_function') return 'arrow';
  if (node.type === 'function_expression') return 'function-expression';
  return null;
}

function walkDeclarations(node: TSNode, state: WalkState, exported: boolean): void {
  const { file } = state;

  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) {
        // Anonymous (e.g. `export default function () {}`) → name it `default`.
        const fn = registerFunction(state, {
          name: 'default',
          kind: 'declaration',
          node,
          exported,
          isDefault: exported,
        });
        const body = node.childForFieldName('body');
        if (body) collectCalls(body, fn);
        return;
      }
      const fn = registerFunction(state, {
        name: textOf(nameNode),
        kind: 'declaration',
        node,
        exported,
      });
      state.scope.push(fn.qualifiedName);
      const body = node.childForFieldName('body');
      if (body) collectCalls(body, fn);
      const params = node.childForFieldName('parameters');
      if (params) collectCalls(params, fn);
      for (const child of node.namedChildren) {
        if (child !== nameNode && child !== body && child !== params) walkDeclarations(child, state, false);
      }
      state.scope.pop();
      return;
    }

    case 'variable_declarator': {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (nameNode && valueNode) {
        const kind = functionValueKind(valueNode);
        if (kind && nameNode.type === 'identifier') {
          const fn = registerFunction(state, { name: textOf(nameNode), kind, node: valueNode, exported });
          state.scope.push(fn.qualifiedName);
          const body = valueNode.childForFieldName('body');
          if (body) collectCalls(body, fn);
          state.scope.pop();
          return;
        }
        // require('...') — including destructured: const {a, b} = require('m')
        if (valueNode.type === 'call_expression') {
          const callee = valueNode.childForFieldName('function');
          if (callee?.type === 'identifier' && textOf(callee) === 'require') {
            recordRequire(node, nameNode, valueNode, state);
            return;
          }
        }
      }
      for (const child of node.namedChildren) walkDeclarations(child, state, false);
      return;
    }

    case 'class_declaration': {
      const nameNode = node.childForFieldName('name');
      const className = nameNode ? textOf(nameNode) : `<anonymous>@${lineOf(node)}`;
      const cls: ParsedClass = {
        name: className,
        startLine: lineOf(node),
        endLine: endLineOf(node),
        methods: [],
        exported,
        isDefault: false,
      };
      file.classes.push(cls);
      const body = node.childForFieldName('body');
      if (nameNode) state.scope.push(className);
      if (className) state.classStack.push(className);
      // Walk methods explicitly so qualifiedName becomes Class.method.
      const walkMethods = (n: TSNode): void => {
        for (const child of n.namedChildren) {
          if (child.type === 'method_definition') {
            const mName = child.childForFieldName('name');
            const methodName = mName ? textOf(mName) : `<anonymous>@${lineOf(child)}`;
            cls.methods.push(methodName);
            const fn = registerFunction(state, {
              name: methodName,
              kind: 'method',
              node: child,
              exported,
            });
            // Override qualifiedName with the class prefix.
            fn.qualifiedName = `${className}.${methodName}`;
            const mBody = child.childForFieldName('body');
            if (mBody) collectCalls(mBody, fn);
          } else {
            walkMethods(child);
          }
        }
      };
      if (body) walkMethods(body);
      if (className) state.classStack.pop();
      if (nameNode) state.scope.pop();
      return;
    }

    case 'method_definition': {
      // Object-literal shorthand methods, or methods missed above.
      const mName = node.childForFieldName('name');
      const methodName = mName ? textOf(mName) : `<anonymous>@${lineOf(node)}`;
      const fn = registerFunction(state, { name: methodName, kind: 'method', node, exported });
      const mBody = node.childForFieldName('body');
      if (mBody) collectCalls(mBody, fn);
      return;
    }

    case 'assignment_expression': {
      // `foo.bar = () => {}` / `module.exports.x = function () {}`
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      const kind = right ? functionValueKind(right) : null;
      if (left && right && kind && left.type === 'member_expression') {
        const obj = left.childForFieldName('object');
        const prop = left.childForFieldName('property');
        if (obj && prop) {
          const qname = `${textOf(obj)}.${textOf(prop)}`;
          const fn = registerFunction(state, {
            name: textOf(prop),
            kind,
            node: right,
            exported: textOf(obj) === 'module' || textOf(obj) === 'exports' || exported,
          });
          fn.qualifiedName = qname;
          const body = right.childForFieldName('body');
          if (body) collectCalls(body, fn);
          return;
        }
      }
      for (const child of node.namedChildren) walkDeclarations(child, state, false);
      return;
    }

    case 'export_statement': {
      // NOTE: `default` is an *anonymous* token in the grammar, so it never
      // appears in namedChildren — detect it via the raw children list.
      const isDefaultExport = node.children.some((c) => !c.isNamed && c.type === 'default');
      for (const child of node.namedChildren) {
        if (child.type === 'export_clause') {
          for (const spec of child.namedChildren) {
            if (spec.type === 'export_specifier') {
              const nameNode = spec.childForFieldName('name');
              const aliasNode = spec.childForFieldName('alias');
              if (nameNode) {
                state.exportNames.push({
                  local: textOf(nameNode),
                  exported: aliasNode ? textOf(aliasNode) : textOf(nameNode),
                });
              }
            }
          }
        } else {
          const before = file.functions.length;
          const classesBefore = file.classes.length;
          walkDeclarations(child, state, true);
          // `export default <declaration>` — flag what was just registered.
          if (isDefaultExport) {
            for (let i = before; i < file.functions.length; i++) {
              file.functions[i].isDefault = true;
            }
            for (let i = classesBefore; i < file.classes.length; i++) {
              file.classes[i].isDefault = true;
              file.classes[i].exported = true;
            }
          }
        }
      }
      return;
    }

    case 'import_statement': {
      recordImport(node, state);
      return;
    }

    case 'export_default_declaration': {
      // Some TS grammar versions use this node type.
      for (const child of node.namedChildren) walkDeclarations(child, state, true);
      const last = file.functions[file.functions.length - 1];
      if (last) {
        last.isDefault = true;
        last.name = 'default';
        last.qualifiedName = 'default';
      }
      return;
    }

    default: {
      for (const child of node.namedChildren) walkDeclarations(child, state, exported);
    }
  }
}

function recordImport(node: TSNode, state: WalkState): void {
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return;
  const imp: ParsedImport = {
    module: stripQuotes(textOf(sourceNode)),
    names: [],
    aliases: {},
    defaultName: null,
    namespaceName: null,
    line: lineOf(node),
    kind: 'import',
  };
  const visitClause = (clause: TSNode): void => {
    for (const child of clause.namedChildren) {
      if (child.type === 'identifier') {
        imp.defaultName = textOf(child);
      } else if (child.type === 'named_imports') {
        for (const spec of child.namedChildren) {
          if (spec.type !== 'import_specifier') continue;
          const nameNode = spec.childForFieldName('name');
          const aliasNode = spec.childForFieldName('alias');
          if (!nameNode) continue;
          const original = textOf(nameNode);
          const local = aliasNode ? textOf(aliasNode) : original;
          imp.names.push(local);
          imp.aliases[local] = original;
        }
      } else if (child.type === 'namespace_import') {
        const id = child.namedChildren.find((c) => c.type === 'identifier');
        if (id) imp.namespaceName = textOf(id);
      }
    }
  };
  for (const child of node.namedChildren) {
    if (child.type === 'import_clause') visitClause(child);
  }
  state.file.imports.push(imp);
}

function recordRequire(
  declarator: TSNode,
  nameNode: TSNode,
  callNode: TSNode,
  state: WalkState,
): void {
  const args = callNode.childForFieldName('arguments');
  const firstArg = args?.namedChildren[0];
  if (!firstArg || firstArg.type !== 'string') return;
  const imp: ParsedImport = {
    module: stripQuotes(textOf(firstArg)),
    names: [],
    aliases: {},
    defaultName: null,
    namespaceName: null,
    line: lineOf(declarator),
    kind: 'require',
  };
  if (nameNode.type === 'identifier') {
    imp.defaultName = textOf(nameNode);
  } else if (nameNode.type === 'object_pattern') {
    for (const child of nameNode.namedChildren) {
      // `{ x }` -> shorthand_property_identifier_pattern
      // `{ y: z }` -> pair_pattern with key/value fields
      const isShorthand =
        child.type === 'shorthand_property_identifier_pattern' ||
        child.type === 'shorthand_property_identifier';
      const keyNode =
        child.childForFieldName('name') ?? child.childForFieldName('key') ?? (isShorthand ? child : null);
      const valueNode = child.childForFieldName('value');
      if (isShorthand && keyNode) {
        imp.names.push(textOf(keyNode));
        imp.aliases[textOf(keyNode)] = textOf(keyNode);
      } else if (keyNode) {
        const local = valueNode ? textOf(valueNode) : textOf(keyNode);
        imp.names.push(local);
        imp.aliases[local] = textOf(keyNode);
      }
    }
  }
  state.file.imports.push(imp);
}

/** Parse source text that is already in memory (used by tests and the scanner). */
export async function parseSource(
  source: string,
  relPath: string,
  language: SourceLanguage,
): Promise<ParsedFile> {
  const parser = await getParser(language);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${relPath}`);
  const file: ParsedFile = {
    path: relPath,
    language,
    loc: source === '' ? 0 : source.split('\n').length,
    functions: [],
    classes: [],
    imports: [],
  };
  const state: WalkState = {
    source,
    file,
    scope: [],
    classStack: [],
    exportNames: [],
  };

  // Synthetic `<module>` function: owns every top-level call so CALLS edges
  // stay uniform (file → function → function).
  const moduleFn = registerFunction(state, {
    name: '<module>',
    kind: 'module',
    node: tree.rootNode,
    exported: false,
  });

  for (const child of tree.rootNode.namedChildren) {
    walkDeclarations(child, state, false);
  }

  // Top-level calls attach to the synthetic module function.
  const topLevelCalls: RawCall[] = [];
  const harvestTopLevel = (n: TSNode): void => {
    if (n.type === 'call_expression' || n.type === 'new_expression') {
      const callee = n.childForFieldName(n.type === 'call_expression' ? 'function' : 'constructor');
      if (callee) {
        const before = moduleFn.calls.length;
        recordCallee(callee, moduleFn, lineOf(n));
        topLevelCalls.push(...moduleFn.calls.slice(before));
      }
    }
    const isDecl =
      n.type === 'function_declaration' ||
      n.type === 'generator_function_declaration' ||
      n.type === 'class_declaration' ||
      n.type === 'variable_declarator' ||
      n.type === 'method_definition' ||
      n.type === 'export_statement' ||
      n.type === 'export_default_declaration' ||
      n.type === 'import_statement' ||
      n.type === 'assignment_expression';
    if (!isDecl) {
      for (const child of n.namedChildren) harvestTopLevel(child);
    } else if (n.type === 'variable_declarator') {
      // `const x = foo();` at top level — the call belongs to <module>.
      const value = n.childForFieldName('value');
      if (value && !functionValueKind(value)) harvestTopLevel(value);
    } else if (n.type === 'export_statement' || n.type === 'export_default_declaration') {
      for (const child of n.namedChildren) {
        if (child.type !== 'export_clause' && child.type !== 'default') harvestTopLevel(child);
      }
    }
  };
  for (const child of tree.rootNode.namedChildren) harvestTopLevel(child);
  void topLevelCalls;

  // Apply `export { a, b as c }` markers (incl. `export { x as default }`).
  for (const { local, exported: exportedName } of state.exportNames) {
    const fn = file.functions.find((f) => f.name === local && f.kind !== 'module');
    if (fn) {
      fn.exported = true;
      if (exportedName === 'default') fn.isDefault = true;
    }
  }

  // Drop the synthetic module function when it has no calls (noise).
  if (moduleFn.calls.length === 0) {
    file.functions = file.functions.filter((f) => f !== moduleFn);
  }
  return file;
}
