// Static detection rules for BlastRadius Day 2.
//
// Each rule is a small PURE function over file text: no graph access, no I/O,
// which makes true/false-positive unit testing trivial. Rules run against
// every parsed JS/TS file; the analyze step (detect/analyze.ts) turns
// RawFindings into Finding nodes + FLAGGED_IN edges.
//
// These are deliberately conservative heuristics (line-based, not full data
// flow). A flagged line is "worth a human look", not proof of exploitability.
// Known limitation: template-string / comment edge cases can cause misses;
// each rule documents what it deliberately ignores.

import type { FindingSeverity } from '../graph/types.js';

export interface FileCtx {
  /** Repo-relative posix path. */
  path: string;
  text: string;
  lines: string[];
}

export interface RawFinding {
  ruleId: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  /** 1-based line number. */
  line: number;
  /** Short code excerpt (secrets are masked). */
  excerpt: string;
}

export interface DetectionRule {
  ruleId: string;
  severity: FindingSeverity;
  /** Short human title, e.g. "Hardcoded API secret". */
  title: string;
  detect(ctx: FileCtx): RawFinding[];
}

export function makeCtx(path: string, text: string): FileCtx {
  return { path, text, lines: text.split('\n') };
}

/** True for lines that are entirely a JS/TS comment. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function excerptOf(line: string): string {
  const t = line.trim();
  return t.length > 120 ? t.slice(0, 117) + '...' : t;
}

/** Mask a secret value, keeping a hint of its shape: `sk-liv…[redacted]`. */
function maskSecret(value: string): string {
  const head = value.slice(0, Math.min(6, value.length));
  return `${head}…[redacted]`;
}

function hit(
  ruleId: string,
  severity: FindingSeverity,
  title: string,
  line: number,
  rawLine: string,
  description: string,
): RawFinding {
  return { ruleId, severity, title, description, line, excerpt: excerptOf(rawLine) };
}

// ---------------------------------------------------------------------------
// 1. hardcoded-secret (high)
// ---------------------------------------------------------------------------

const SECRET_PREFIXES =
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[bap]-?[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

// varName = 'literal' / varName: 'literal' where the name smells like a secret.
const SECRET_ASSIGNMENT =
  /^\s*(?:(?:const|let|var)\s+)?([A-Za-z0-9_$]*?(?:api[_-]?key|secret|token|password|passwd|pwd)[A-Za-z0-9_$]*)\s*[:=]\s*['"`]([^'"`]+)['"`]/i;

const PLACEHOLDER_VALUE = /^(?:xxx+|your-|example|test|changeme|placeholder|\*+|todo|none|null|undefined)/i;

export function detectHardcodedSecrets(ctx: FileCtx): RawFinding[] {
  const out: RawFinding[] = [];
  ctx.lines.forEach((line, i) => {
    const lineNo = i + 1;
    const prefix = SECRET_PREFIXES.exec(line);
    if (prefix) {
      out.push(
        hit(
          'hardcoded-secret',
          'high',
          'Hardcoded API secret',
          lineNo,
          line.replace(prefix[1], maskSecret(prefix[1])),
          `Line ${lineNo} contains a value shaped like a live credential ` +
            `(${describePrefix(prefix[1])}). Rotate it and move it to an env var or secret store.`,
        ),
      );
      return;
    }
    const m = SECRET_ASSIGNMENT.exec(line);
    if (m) {
      const value = m[2];
      // process.env.X is the RIGHT pattern — never flag it.
      if (/process\.env\./.test(line)) return;
      if (value.length < 8 || PLACEHOLDER_VALUE.test(value)) return;
      out.push(
        hit(
          'hardcoded-secret',
          'high',
          'Hardcoded API secret',
          lineNo,
          line.replace(value, maskSecret(value)),
          `Line ${lineNo} assigns a literal secret to "${m[1]}". ` +
            `Move it to an env var or secret store.`,
        ),
      );
    }
  });
  return out;
}

function describePrefix(secret: string): string {
  if (secret.startsWith('sk-')) return 'OpenAI-style API key';
  if (secret.startsWith('ghp_') || secret.startsWith('github_pat_')) return 'GitHub token';
  if (secret.startsWith('AKIA')) return 'AWS access key';
  if (secret.startsWith('xox')) return 'Slack token';
  if (secret.includes('PRIVATE KEY')) return 'private key material';
  return 'API credential';
}

// ---------------------------------------------------------------------------
// 2. dangerous-eval (high)
// ---------------------------------------------------------------------------

export function detectDangerousEval(ctx: FileCtx): RawFinding[] {
  const out: RawFinding[] = [];
  ctx.lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    const lineNo = i + 1;
    if (/\beval\s*\(/.test(line)) {
      out.push(
        hit(
          'dangerous-eval',
          'high',
          'Direct eval() call',
          lineNo,
          line,
          `Line ${lineNo} calls eval(), which executes a string as code. ` +
            `Any attacker-controlled input reaching it is remote code execution.`,
        ),
      );
    } else if (/\bnew\s+Function\s*\(/.test(line)) {
      out.push(
        hit(
          'dangerous-eval',
          'high',
          'new Function() constructor',
          lineNo,
          line,
          `Line ${lineNo} builds a function from a string (same risk class as eval). ` +
            `Prefer static code or a sandboxed evaluator.`,
        ),
      );
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// 3. shell-exec (high) — child_process exec/spawn with non-literal args
// ---------------------------------------------------------------------------

const CHILD_PROCESS_IMPORT = /['"]node:child_process['"]|['"]child_process['"]/;
const SHELL_CALL = /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/;

/** Extract the first argument text (naive paren-depth scan, 300 char cap). */
function firstArg(line: string, openParenIdx: number): string {
  let depth = 0;
  let out = '';
  for (let i = openParenIdx; i < line.length && out.length < 300; i++) {
    const ch = line[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) {
      break;
    } else if (depth >= 1) {
      out += ch;
    }
  }
  return out.trim();
}

export function detectShellExec(ctx: FileCtx): RawFinding[] {
  if (!CHILD_PROCESS_IMPORT.test(ctx.text) && !/\bchild_process\s*\./.test(ctx.text)) {
    return []; // exec( could be anything — avoid false positives without the import.
  }
  const out: RawFinding[] = [];
  ctx.lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    const m = SHELL_CALL.exec(line);
    if (!m) return;
    const arg = firstArg(line, m.index + m[0].length - 1);
    if (!arg) return;
    const literalString = /^(['"`])/.test(arg);
    const isPlainLiteral =
      literalString && !arg.includes('+') && !arg.includes('${');
    if (isPlainLiteral) return; // exec('ls -la') — static, not interesting.
    out.push(
      hit(
        'shell-exec',
        'high',
        'Shell command with non-literal argument',
        i + 1,
        line,
        `Line ${i + 1} passes a non-literal argument to child_process.${m[1]}(). ` +
          `If any part is user-controlled this is command injection; use execFile with an argv array.`,
      ),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// 4. sql-concat (high) — string-built SQL in query/execute calls
// ---------------------------------------------------------------------------

// A function literally named query/execute taking a concatenated string is
// overwhelmingly likely to be a SQL call — match both `db.query(` and bare
// `query(` (but not `myquery(` or `obj.queryX(`).
const SQL_CALL = /(?:^|[^\w$])(query|execute)\s*\(/;
const SQL_KEYWORD = /\b(select|insert|update|delete|where|from)\b/i;

export function detectSqlConcat(ctx: FileCtx): RawFinding[] {
  const out: RawFinding[] = [];
  ctx.lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    const m = SQL_CALL.exec(line);
    if (!m) return;
    const arg = firstArg(line, m.index + m[0].length - 1);
    if (!arg) return;
    const concatenated = arg.includes('+');
    const interpolatedTemplate =
      arg.includes('`') && arg.includes('${') && SQL_KEYWORD.test(arg);
    if (!concatenated && !interpolatedTemplate) return;
    out.push(
      hit(
        'sql-concat',
        'high',
        'SQL built by string concatenation',
        i + 1,
        line,
        `Line ${i + 1} builds SQL by concatenating/interpolating strings in ${m[1]}(). ` +
          `Use parameterized queries ($1 / ?) instead — this shape is SQL injection.`,
      ),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// 5. insecure-random (medium) — Math.random() for security-sensitive values
// ---------------------------------------------------------------------------

const SENSITIVE_USE = /(token|session|password|secret|otp|nonce|uuid|guid|api[_-]?key|salt|csrf|auth)/i;

export function detectInsecureRandom(ctx: FileCtx): RawFinding[] {
  const out: RawFinding[] = [];
  ctx.lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (!/Math\.random\s*\(\)/.test(line)) return;
    const window = [ctx.lines[i - 1] ?? '', line, ctx.lines[i + 1] ?? ''].join('\n');
    if (!SENSITIVE_USE.test(window)) return;
    out.push(
      hit(
        'insecure-random',
        'medium',
        'Math.random() for a security-sensitive value',
        i + 1,
        line,
        `Line ${i + 1} uses Math.random() near a security-sensitive identifier. ` +
          `Math.random() is predictable — use crypto.randomBytes() / crypto.getRandomValues().`,
      ),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// 6. unsafe-innerhtml (medium) — innerHTML assigned a non-literal
// ---------------------------------------------------------------------------

export function detectUnsafeInnerHTML(ctx: FileCtx): RawFinding[] {
  const out: RawFinding[] = [];
  ctx.lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    const m = /\.innerHTML\s*=\s*(.+?);?\s*$/.exec(line);
    if (!m) return;
    const rhs = m[1].trim();
    // A single string literal (or a static template) is safe. Anything else —
    // identifier, concatenation, call, interpolated template — is flagged.
    const singleLiteral =
      /^'(?:[^'\\]|\\.)*'$/.test(rhs) ||
      /^"(?:[^"\\]|\\.)*"$/.test(rhs) ||
      (/^`[\s\S]*`$/.test(rhs) && !rhs.includes('${'));
    if (singleLiteral) return;
    out.push(
      hit(
        'unsafe-innerhtml',
        'medium',
        'innerHTML assigned non-literal content',
        i + 1,
        line,
        `Line ${i + 1} assigns a non-literal expression to innerHTML. ` +
          `Unsanitized HTML here is XSS — use textContent or a sanitizer.`,
      ),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// 7. weak-hash (medium) — md5/sha1 password-style hashing
// ---------------------------------------------------------------------------

export function detectWeakHash(ctx: FileCtx): RawFinding[] {
  const out: RawFinding[] = [];
  ctx.lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    const m = /createHash\s*\(\s*['"](md5|md4|sha1)['"]\s*\)/i.exec(line);
    if (!m) return;
    out.push(
      hit(
        'weak-hash',
        'medium',
        `Weak hash algorithm (${m[1].toLowerCase()})`,
        i + 1,
        line,
        `Line ${i + 1} hashes with ${m[1].toLowerCase()}, which is broken for ` +
          `integrity/password use. Use SHA-256+ (or bcrypt/scrypt/argon2 for passwords).`,
      ),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// 8. todo-security (low) — acknowledged-but-unfixed security debt
// ---------------------------------------------------------------------------

export function detectTodoSecurity(ctx: FileCtx): RawFinding[] {
  const out: RawFinding[] = [];
  ctx.lines.forEach((line, i) => {
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b[^\n]*\bsecur/i.test(line)) {
      out.push(
        hit(
          'todo-security',
          'low',
          'Unresolved security TODO',
          i + 1,
          line,
          `Line ${i + 1} has a TODO/FIXME explicitly about security. ` +
            `Track it or fix it — security debt rots fastest.`,
        ),
      );
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const RULES: DetectionRule[] = [
  { ruleId: 'hardcoded-secret', severity: 'high', title: 'Hardcoded API secret', detect: detectHardcodedSecrets },
  { ruleId: 'dangerous-eval', severity: 'high', title: 'Dangerous eval()', detect: detectDangerousEval },
  { ruleId: 'shell-exec', severity: 'high', title: 'Shell command injection', detect: detectShellExec },
  { ruleId: 'sql-concat', severity: 'high', title: 'SQL string concatenation', detect: detectSqlConcat },
  { ruleId: 'insecure-random', severity: 'medium', title: 'Insecure randomness', detect: detectInsecureRandom },
  { ruleId: 'unsafe-innerhtml', severity: 'medium', title: 'Unsafe innerHTML', detect: detectUnsafeInnerHTML },
  { ruleId: 'weak-hash', severity: 'medium', title: 'Weak hash algorithm', detect: detectWeakHash },
  { ruleId: 'todo-security', severity: 'low', title: 'Security TODO', detect: detectTodoSecurity },
];
