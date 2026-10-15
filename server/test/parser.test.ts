// Parser unit tests — tree-sitter extraction for JS/TS.
// Run: npx vitest run test/parser.test.ts

import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/ingest/parser.js';
import { functionNodeId, resolveCalls } from '../src/ingest/resolve.js';

describe('parseSource — declarations', () => {
  it('parses function declarations and records their calls', async () => {
    const f = await parseSource(
      `function a() { b(); }\nfunction b() { return 1; }`,
      'a.js',
      'javascript',
    );
    expect(f.functions.map((x) => x.name).sort()).toEqual(['a', 'b']);
    const a = f.functions.find((x) => x.name === 'a')!;
    expect(a.calls).toEqual([{ name: 'b', receiver: null, line: 1 }]);
    expect(a.startLine).toBe(1);
    expect(a.qualifiedName).toBe('a');
  });

  it('parses arrow functions assigned to consts', async () => {
    const f = await parseSource(`const f = () => { g(); };\nconst h = async (x) => x;`, 'a.js', 'javascript');
    const fn = f.functions.find((x) => x.name === 'f')!;
    expect(fn.kind).toBe('arrow');
    expect(fn.calls[0].name).toBe('g');
  });

  it('parses class methods and this-calls', async () => {
    const f = await parseSource(
      `class C {\n  m() { this.n(); }\n  n() {}\n}`,
      'a.js',
      'javascript',
    );
    expect(f.classes.map((c) => c.name)).toEqual(['C']);
    const m = f.functions.find((x) => x.name === 'm')!;
    expect(m.kind).toBe('method');
    expect(m.qualifiedName).toBe('C.m');
    expect(m.className).toBe('C');
    expect(m.calls).toEqual([{ name: 'n', receiver: 'this', line: 2 }]);
  });

  it('marks exported and default-exported functions', async () => {
    const f = await parseSource(
      `export function e() {}\nexport default function d() {}\nfunction p() {}\nexport { p };`,
      'a.js',
      'javascript',
    );
    const byName = (n: string) => f.functions.find((x) => x.name === n)!;
    expect(byName('e').exported).toBe(true);
    expect(byName('d').exported).toBe(true);
    expect(byName('d').isDefault).toBe(true);
    expect(byName('p').exported).toBe(true);
  });

  it('parses member calls and new expressions', async () => {
    const f = await parseSource(
      `function a() {\n  obj.method(1);\n  const x = new Foo();\n}`,
      'a.js',
      'javascript',
    );
    const a = f.functions.find((x) => x.name === 'a')!;
    expect(a.calls).toContainEqual({ name: 'method', receiver: 'obj', line: 2 });
    expect(a.calls).toContainEqual({ name: 'Foo', receiver: null, line: 3 });
  });
});

describe('parseSource — imports', () => {
  it('parses named, default and namespace imports', async () => {
    const f = await parseSource(
      `import def, { a, b as c } from './mod.js';\nimport * as ns from './other.js';`,
      'a.js',
      'javascript',
    );
    expect(f.imports).toHaveLength(2);
    const [first, second] = f.imports;
    expect(first.module).toBe('./mod.js');
    expect(first.defaultName).toBe('def');
    expect(first.names).toEqual(['a', 'c']);
    expect(first.aliases).toEqual({ a: 'a', c: 'b' });
    expect(second.namespaceName).toBe('ns');
  });

  it('parses require() with identifier and destructuring', async () => {
    const f = await parseSource(
      `const m = require('./m.js');\nconst { x, y: z } = require('./n.js');`,
      'a.js',
      'javascript',
    );
    expect(f.imports).toHaveLength(2);
    expect(f.imports[0].kind).toBe('require');
    expect(f.imports[0].defaultName).toBe('m');
    expect(f.imports[1].names).toEqual(['x', 'z']);
    expect(f.imports[1].aliases).toEqual({ x: 'x', z: 'y' });
  });
});

describe('parseSource — TypeScript', () => {
  it('parses typed functions, classes and interfaces', async () => {
    const f = await parseSource(
      `interface Opts { verbose: boolean; }\n` +
        `export function run(opts: Opts): number { return helper(1); }\n` +
        `function helper(n: number): number { return n; }\n` +
        `export default class Svc {\n  start(): void { this.stop(); }\n  stop(): void {}\n}`,
      'a.ts',
      'typescript',
    );
    expect(f.functions.map((x) => x.name).sort()).toEqual(['helper', 'run', 'start', 'stop']);
    expect(f.classes.map((c) => c.name)).toEqual(['Svc']);
    expect(f.classes[0].isDefault).toBe(true);
    const run = f.functions.find((x) => x.name === 'run')!;
    expect(run.calls[0].name).toBe('helper');
    const start = f.functions.find((x) => x.name === 'start')!;
    expect(start.calls).toEqual([{ name: 'stop', receiver: 'this', line: 5 }]);
  });
});

describe('resolveCalls', () => {
  it('resolves same-file calls', async () => {
    const f = await parseSource(`function a() { b(); }\nfunction b() {}`, 'a.js', 'javascript');
    const edges = resolveCalls([f]);
    const aId = functionNodeId('a.js', f.functions.find((x) => x.name === 'a')!);
    const bId = functionNodeId('a.js', f.functions.find((x) => x.name === 'b')!);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: aId, to: bId, type: 'CALLS' });
  });

  it('resolves cross-file calls through named imports', async () => {
    const index = await parseSource(
      `import { add } from './math.js';\nconst t = add(1, 2);`,
      'src/index.js',
      'javascript',
    );
    const math = await parseSource(`export function add(a, b) { return a + b; }`, 'src/math.js', 'javascript');
    const edges = resolveCalls([index, math]);
    const addId = functionNodeId('src/math.js', math.functions[0]);
    expect(edges.some((e) => e.to === addId && e.type === 'CALLS')).toBe(true);
  });

  it('resolves default-import class method calls', async () => {
    const index = await parseSource(
      `import App from './app.js';\nfunction boot() { App.render(); }`,
      'src/index.js',
      'javascript',
    );
    const app = await parseSource(
      `export default class App {\n  static render() {}\n}`,
      'src/app.js',
      'javascript',
    );
    const edges = resolveCalls([index, app]);
    const renderId = functionNodeId(
      'src/app.js',
      app.functions.find((x) => x.name === 'render')!,
    );
    expect(edges.some((e) => e.to === renderId)).toBe(true);
  });

  it('leaves external calls unresolved', async () => {
    const f = await parseSource(
      `import _ from 'lodash';\nfunction a() { _.map([1]); console.log('x'); }`,
      'a.js',
      'javascript',
    );
    expect(resolveCalls([f])).toHaveLength(0);
  });
});
