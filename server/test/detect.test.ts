// Detection rule tests: each rule gets true-positive and true-negative cases.
// Rules are pure functions over file text — no graph, no I/O.
// Run: node node_modules/vitest/vitest.mjs run test/detect.test.ts

import { describe, expect, it } from 'vitest';
import {
  detectDangerousEval,
  detectHardcodedSecrets,
  detectInsecureRandom,
  detectShellExec,
  detectSqlConcat,
  detectTodoSecurity,
  detectUnsafeInnerHTML,
  detectWeakHash,
  makeCtx,
  RULES,
} from '../src/detect/rules.js';

const ctx = (text: string) => makeCtx('src/a.js', text);

describe('rule registry', () => {
  it('exposes 8 rules with unique ids', () => {
    expect(RULES).toHaveLength(8);
    const ids = RULES.map((r) => r.ruleId);
    expect(new Set(ids).size).toBe(8);
  });
});

describe('hardcoded-secret', () => {
  it('flags a live-looking API key assignment', () => {
    const findings = detectHardcodedSecrets(ctx(`const API_KEY = 'sk-live-9f8e7d6c5b4a3210';`));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('hardcoded-secret');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].line).toBe(1);
    // The excerpt must not leak the full secret.
    expect(findings[0].excerpt).not.toContain('sk-live-9f8e7d6c5b4a3210');
    expect(findings[0].excerpt).toContain('[redacted]');
  });

  it('flags known credential prefixes anywhere on the line', () => {
    const findings = detectHardcodedSecrets(ctx(`// token ghp_abcdefghij1234567890 for deploy`));
    expect(findings).toHaveLength(1);
  });

  it('does not flag process.env usage (the right pattern)', () => {
    expect(detectHardcodedSecrets(ctx(`const key = process.env.API_KEY;`))).toHaveLength(0);
  });

  it('does not flag placeholders or short values', () => {
    expect(detectHardcodedSecrets(ctx(`const apiKey = 'xxx';`))).toHaveLength(0);
    expect(detectHardcodedSecrets(ctx(`const apiKey = 'your-key-here';`))).toHaveLength(0);
    expect(detectHardcodedSecrets(ctx(`const password = '';`))).toHaveLength(0);
  });

  it('does not flag innocent string assignments', () => {
    expect(detectHardcodedSecrets(ctx(`const greeting = 'hello world';`))).toHaveLength(0);
  });
});

describe('dangerous-eval', () => {
  it('flags eval() and new Function()', () => {
    expect(detectDangerousEval(ctx(`return eval(code);`))).toHaveLength(1);
    expect(detectDangerousEval(ctx(`const f = new Function('a', 'return a');`))).toHaveLength(1);
  });

  it('ignores comments and lookalikes', () => {
    expect(detectDangerousEval(ctx(`// never use eval() here`))).toHaveLength(0);
    expect(detectDangerousEval(ctx(`const evaluation = 1;`))).toHaveLength(0);
    expect(detectDangerousEval(ctx(`retrieval(code);`))).toHaveLength(0);
  });
});

describe('shell-exec', () => {
  const withImport = (body: string) =>
    `import { exec } from 'node:child_process';\n${body}`;

  it('flags exec with a non-literal argument', () => {
    const findings = detectShellExec(ctx(withImport(`exec(userInput, cb);`)));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });

  it('flags exec with a concatenated command', () => {
    expect(detectShellExec(ctx(withImport(`exec('ls ' + dir, cb);`)))).toHaveLength(1);
  });

  it('does not flag exec with a static literal', () => {
    expect(detectShellExec(ctx(withImport(`exec('ls -la', cb);`)))).toHaveLength(0);
  });

  it('does not flag exec-looking calls without a child_process import', () => {
    // Could be a method on any object — stay quiet without the import signal.
    expect(detectShellExec(ctx(`db.exec(query, cb);`))).toHaveLength(0);
  });
});

describe('sql-concat', () => {
  it('flags string-concatenated SQL in query()', () => {
    const findings = detectSqlConcat(ctx(`db.query('SELECT * FROM u WHERE id = ' + id);`));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });

  it('flags interpolated SQL template literals', () => {
    const findings = detectSqlConcat(ctx('db.query(`SELECT * FROM u WHERE n = ${name}`);'));
    expect(findings).toHaveLength(1);
  });

  it('flags bare query() calls too', () => {
    expect(detectSqlConcat(ctx(`return query('SELECT 1 WHERE x=' + x);`))).toHaveLength(1);
  });

  it('does not flag parameterized queries or static templates', () => {
    expect(detectSqlConcat(ctx(`db.query('SELECT * FROM u WHERE id = $1', [id]);`))).toHaveLength(0);
    expect(detectSqlConcat(ctx('db.query(`SELECT * FROM u`);'))).toHaveLength(0);
  });

  it('does not flag functions merely named like query', () => {
    expect(detectSqlConcat(ctx(`myquery('a' + b);`))).toHaveLength(0);
  });
});

describe('insecure-random', () => {
  it('flags Math.random() near a token identifier', () => {
    const findings = detectInsecureRandom(ctx(`const token = Math.random().toString(36);`));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('medium');
  });

  it('does not flag Math.random() for visuals', () => {
    expect(detectInsecureRandom(ctx(`const x = Math.random() * canvas.width;`))).toHaveLength(0);
  });
});

describe('unsafe-innerhtml', () => {
  it('flags innerHTML assigned a variable', () => {
    const findings = detectUnsafeInnerHTML(ctx(`el.innerHTML = userHtml;`));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('medium');
  });

  it('flags innerHTML assigned a concatenation', () => {
    expect(detectUnsafeInnerHTML(ctx(`el.innerHTML = '<b>' + name + '</b>';`))).toHaveLength(1);
  });

  it('does not flag literal or static-template assignments', () => {
    expect(detectUnsafeInnerHTML(ctx(`el.innerHTML = '<b>hi</b>';`))).toHaveLength(0);
    expect(detectUnsafeInnerHTML(ctx('el.innerHTML = `<b>static</b>`;'))).toHaveLength(0);
  });
});

describe('weak-hash', () => {
  it('flags md5 and sha1', () => {
    expect(detectWeakHash(ctx(`crypto.createHash('md5').update(pw);`))).toHaveLength(1);
    expect(detectWeakHash(ctx(`crypto.createHash("sha1").update(pw);`))).toHaveLength(1);
  });

  it('does not flag sha256', () => {
    expect(detectWeakHash(ctx(`crypto.createHash('sha256').update(pw);`))).toHaveLength(0);
  });
});

describe('todo-security', () => {
  it('flags security TODOs', () => {
    const findings = detectTodoSecurity(ctx(`// TODO: security — add rate limiting`));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
  });

  it('ignores ordinary TODOs', () => {
    expect(detectTodoSecurity(ctx(`// TODO: refactor this later`))).toHaveLength(0);
    expect(detectTodoSecurity(ctx(`const todo = 'security review';`))).toHaveLength(0);
  });
});
