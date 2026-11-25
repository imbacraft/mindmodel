// Rule 3 of docs/one-engine.md: only the Spoon engine (`engine-java/`) reads `.java` files. Everything under `engine/`
// consumes the dump. This test is the guard: it scans the engine sources as text (a meta-test may) and fails when a
// module reads Java source, or when the allowlist names a function that no longer does — so the list can only shrink.
//
// The probes below are the shapes a Java-source read takes in this codebase: a `.java` path handed to `readFileSync`,
// `.text` of a Java source entry, `.b`/`.lines` — the body or the lines cut out of that text — and a `textOf`
// callback called with a Java path. A hit is attributed to the innermost function whose body contains it.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(here, '../engine');

// `file:function` -> why that function may still read Java source. The list is EMPTY: the only reader of `.java` is the
// Spoon engine, and every extractor queries the dump. Nothing may be added — a fact the dump cannot answer is
// `unresolved` with a reason, never a regex over source text.
export const ALLOWLIST = new Map([]);

// The two paths Phase 3 deleted. A test fails if either comes back: restoring the mini-parser (or the vendored
// tree-sitter build it needed) is not a way to answer a question the dump does not.
export const DELETED = ['engine/syntax/imports.mjs', 'engine/vendor/tree-sitter'];

// How the list emptied (docs/one-engine.md Phase 3): the doc's table was not the whole list. `engine/system.mjs` (seven
// functions) read every service's `.java`; scan read every file once for packages, imports and lines; springChains and
// shiroCodeRules read the config classes; the boot and lifecycle passes were ported before this round. All of them now
// query the dump: calls with their receiver types and typed arguments, annotations, supertypes, field types and each
// file's own package and imports.

const TEXT_OPS = 'matchAll|match|split|replace|trim|includes|indexOf|slice|test|exec|length';

// `id` names the shape, `re` finds it, `why` is what a hit means. `only`/`skip` narrow a probe whose text-shaped
// identifier is Java in some modules and YAML/properties/XML/frontend in others: those formats are out of scope.
const PROBES = [
  { id: 'read-java-path', re: /readFileSync\s*\(\s*[^)\n]{0,140}\.java\b/g, why: 'reads a .java path' },
  {
    id: 'read-java-listing',
    re: /javaFiles\([^)]*\)[\s\S]{0,240}?readFileSync\s*\(/g,
    why: 'reads the files of a .java listing',
  },
  {
    id: 'java-entry-text',
    re: new RegExp(String.raw`\b(?:j|src|f|entry)\.text\b`, 'g'),
    why: 'uses .text of a Java source entry',
  },
  {
    id: 'java-body-text',
    // `b` is a method body handed in; `x.b`/`stores.b` is a body carried on an entry.
    re: new RegExp(
      String.raw`(?:^|[^\w.$])b\s*\.\s*(?:matchAll|slice)\b` +
        String.raw`|\.b\s*\.\s*(?:matchAll|slice|split|trim|includes|replace)\b|\bx\.b\b`,
      'g',
    ),
    why: 'uses b, the body text of a Java method',
  },
  {
    id: 'java-lines-text',
    re: new RegExp(String.raw`\bf\.lines\s*\.\s*(?:${TEXT_OPS}|flatMap|forEach|map|join)\b`, 'g'),
    why: 'uses .lines, a Java file split into lines',
  },
  {
    id: 'java-lines-param',
    re: new RegExp(String.raw`(?:^|[^\w$])lines\s*\.\s*(?:${TEXT_OPS}|flatMap|forEach|map|join)\b`, 'g'),
    why: 'reads lines of Java source passed in',
    only: ['engine/extract/lifecycle.mjs', 'engine/extract/text/time.mjs'],
  },
  {
    id: 'java-line-char',
    re: /(?:^|[^\w.$])line\s*\[\s*i\s*\]/g,
    why: 'walks a line of Java source character by character',
  },
  {
    id: 'java-body-param',
    re: /\b(?:callerBody|methodText)\b/g,
    why: 'handles a Java body passed as text',
    only: ['engine/extract/lifecycle.mjs'],
  },
  {
    id: 'java-constants-scan',
    re: /\[\s*\.\.\.\s*text\s*\.\s*matchAll\b/g,
    why: 'scans Java text for static final String constants',
  },
  {
    id: 'text-reader-callback',
    re: /\btextOf\s*[(,)]/g,
    why: 'calls a textOf reader that is handed Java paths',
    // evidence/xml.mjs defines its own textOf over XML nodes, and its callers import that one: not Java.
    skip: (src) =>
      /export const textOf\b/.test(src) || /import\s*\{[^}]*\btextOf\b[^}]*\}\s*from\s*'\.\/xml\.mjs'/.test(src),
  },
  {
    id: 'java-service-text',
    re: new RegExp(
      String.raw`(?:^|[^\w.])text\s*\.\s*(?:${TEXT_OPS}|flatMap|forEach|map|join)\b|(?:exec|test)\(\s*text\b`,
      'g',
    ),
    why: 'reads text that is Java source (system.mjs reads services, not other formats)',
    only: [
      'engine/system.mjs',
      'engine/system/messaging.mjs',
      'engine/system/rest.mjs',
      'engine/system/service.mjs',
      'engine/system/folder.mjs',
      'engine/system/edges.mjs',
    ],
  },
  { id: 'tree-sitter-parse', re: /\bparser\.parse\s*\(/g, why: 'parses Java source with tree-sitter' },
  {
    id: 'imports-syntax-imports',
    re: /from\s+['"][^'"]*syntax\/imports\.mjs['"]/g,
    why: 'imports the tree-sitter package/import reader',
  },
];

const modulesUnder = (dir) => {
  const out = [];
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'vendor') visit(p); // engine/vendor/ is the pinned tree-sitter build, not ours
      } else if (e.name.endsWith('.mjs')) out.push(p);
    }
  };
  visit(dir);
  return out;
};

// --- functions and their bodies -----------------------------------------------------
// Only declarations at column 0 start a function. Some of them (`viewsOf`, `tableOf`) are local helpers written at
// column 0 inside `scan`, which is why a hit is attributed by body span, not by the nearest preceding declaration.
const DECL = /^(?:export\s+)?(?:async\s+)?function\s+([\w$]+)|^(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=/gm;

const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$|\b(?:return|typeof|case|in|of|new|delete|void)$/;

/** Index of the quote closing the `'`/`"` string that starts at `i`. */
function skipQuoted(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === src[i]) return j;
  }
  return src.length;
}

/** Index of the backtick closing the template that starts at `i`; `${...}` may hold strings and templates. */
function skipTemplate(src, i) {
  let depth = 0;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (depth === 0) {
      if (c === '`') return j;
      if (c === '$' && src[j + 1] === '{') {
        depth = 1;
        j++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '`') j = skipTemplate(src, j);
    else if (c === '"' || c === "'") j = skipQuoted(src, j);
  }
  return src.length;
}

/** Index just past a string, template or regex literal, or a comment, starting at `i`; otherwise `i`. */
function skipLiteral(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const n = src.indexOf('\n', i);
    return n < 0 ? src.length : n;
  }
  if (c === '/' && src[i + 1] === '*') {
    const n = src.indexOf('*/', i);
    return n < 0 ? src.length : n + 1;
  }
  if (c === '"' || c === "'") return skipQuoted(src, i);
  if (c === '`') return skipTemplate(src, i);
  if (c === '/') {
    let p = i - 1;
    while (p >= 0 && /\s/.test(src[p])) p--;
    if (!(p < 0 || REGEX_BEFORE.test(src.slice(Math.max(0, p - 10), p + 1)))) return i;
    let inClass = false;
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '[') inClass = true;
      else if (src[j] === ']') inClass = false;
      else if (src[j] === '/' && !inClass) return j; // a `/` in a character class does not end the literal
    }
  }
  return i;
}

/** Index just past the closing delimiter matching the one at `at`, skipping literals and comments. */
function matchDelim(src, at, open, close) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const skip = skipLiteral(src, i);
    if (skip !== i) {
      i = skip;
      continue;
    }
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Index of the first `;` at depth 0 from `from`: the end of an expression body. */
function exprEnd(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const skip = skipLiteral(src, i);
    if (skip !== i) {
      i = skip;
      continue;
    }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth < 0) return i;
    } else if (c === ';' && depth === 0) return i;
  }
  return src.length;
}

/** Index just past the body of the declaration whose name ends at `from`. */
function bodyEnd(src, from) {
  const skip = (n) => {
    while (n < src.length && /\s/.test(src[n])) n++;
    return n;
  };
  let i = skip(from);
  if (src[i] === '=') {
    i = skip(i + 1);
    if (src.startsWith('async', i)) i = skip(i + 5);
  }
  const value = i;
  let body = value;
  if (src[body] === '(') {
    const afterParams = skip(matchDelim(src, body, '(', ')'));
    if (src.startsWith('=>', afterParams)) body = skip(afterParams + 2);
    else if (src[afterParams] === '{') body = afterParams; // a `function` declaration
    else body = value; // a parenthesised value, not a function head
  } else if (/^[\w$]/.test(src[body] ?? '')) {
    let j = body;
    while (j < src.length && /[\w$]/.test(src[j])) j++;
    const afterName = skip(j);
    if (src.startsWith('=>', afterName)) body = skip(afterName + 2);
  }
  return src[body] === '{' ? matchDelim(src, body, '{', '}') - 1 : exprEnd(src, body);
}

const functionsOf = (src) => {
  const out = [];
  for (const m of src.matchAll(DECL)) {
    const start = m.index,
      line = src.slice(0, start).split('\n').length,
      end = bodyEnd(src, m.index + m[0].length);
    out.push({ name: m[1] ?? m[2], line, start, end });
  }
  return out;
};

const lineAt = (src, index) => src.slice(0, index).split('\n').length;

/** The innermost declared function containing `index`, or `<module>` for an import or a top-level constant. */
const ownerOf = (functions, index) => {
  let owner = null,
    span = Infinity;
  for (const f of functions)
    if (f.start <= index && index <= f.end && f.end - f.start < span) {
      owner = f.name;
      span = f.end - f.start;
    }
  return owner ?? '<module>';
};

/** Every place one module reads Java source: `{ 'engine/x.mjs:fn': [{line, probe, why}] }`. */
function hitsIn(rel, src) {
  const found = new Map();
  const functions = functionsOf(src);
  for (const probe of PROBES) {
    if (probe.only && !probe.only.includes(rel)) continue;
    if (probe.skip?.(src)) continue;
    for (const m of src.matchAll(probe.re)) {
      const key = `${rel}:${ownerOf(functions, m.index)}`;
      if (!found.has(key)) found.set(key, []);
      found.get(key).push({ line: lineAt(src, m.index), probe: probe.id, why: probe.why });
    }
  }
  return found;
}

const offences = () => {
  const found = new Map();
  for (const file of modulesUnder(ENGINE)) {
    const rel = path.relative(path.join(here, '..'), file).split(path.sep).join('/');
    for (const [key, hits] of hitsIn(rel, fs.readFileSync(file, 'utf8'))) found.set(key, hits);
  }
  return new Map([...found.entries()].sort(([a], [b]) => a.localeCompare(b)));
};

// Two failures, both matter: a function that reads Java and is not listed, and a listed function that has stopped
// reading it (the list may only shrink).
const guardDiff = (found, allow) => ({
  unlisted: [...found.keys()].filter((k) => !allow.has(k)),
  stale: [...allow.keys()].filter((k) => !found.has(k)),
});

const shown = (entry) => entry.map((o) => `  line ${o.line} ${o.probe}: ${o.why}`).join('\n');

test('engine/ reads Java source only where the allowlist says it may', () => {
  const found = offences();
  const { unlisted, stale } = guardDiff(found, ALLOWLIST);
  assert.deepStrictEqual(
    unlisted,
    [],
    'engine/ reads Java source outside the allowlist (only the Spoon dump may read .java):\n' +
      unlisted.map((k) => `${k}\n${shown(found.get(k))}`).join('\n') +
      '\nNew code never needs an entry: a fact the dump cannot answer is `unresolved`, not a regex.',
  );
  assert.deepStrictEqual(
    stale,
    [],
    `ALLOWLIST entries no longer read Java source — delete them:\n${stale.map((k) => `  ${k}`).join('\n')}`,
  );
});

test('the deleted reader is gone: neither the mini-parser nor the vendored tree-sitter exists', () => {
  const back = DELETED.filter((p) => fs.existsSync(path.join(here, '..', p)));
  assert.deepStrictEqual(
    back,
    [],
    `these paths were deleted in Phase 3 and must stay deleted (the dump is the only reader of Java):\n${back.map((p) => `  ${p}`).join('\n')}`,
  );
});

test('the guard bites: a new Java reader and a stale entry are both reported', () => {
  // A module that read a .java file the way the allowlisted ones do: caught, and owned by the function around it.
  const src = [
    'export function reads() {',
    "  const text = fs.readFileSync('a/B.java', 'utf8');",
    '  return text;',
    '}',
  ].join('\n');
  const found = hitsIn('engine/x.mjs', src);
  assert.deepStrictEqual([...found.keys()], ['engine/x.mjs:reads']);
  assert.ok(found.get('engine/x.mjs:reads').some((h) => h.probe === 'read-java-path'));
  // …and the same after a `textOf` handover, or a `.text` slice.
  const viaCallback = hitsIn('engine/y.mjs', 'export function a(textOf) {\n  return textOf("x").split(";");\n}');
  assert.deepStrictEqual([...viaCallback.keys()], ['engine/y.mjs:a']);
  const viaEntry = hitsIn('engine/z.mjs', 'export const b = (j) => j.text.split("\\n");');
  assert.deepStrictEqual([...viaEntry.keys()], ['engine/z.mjs:b']);
  // An allowlisted function that stops offending is stale, not silently tolerated.
  const allow = new Map([['engine/x.mjs:reads', 'why']]);
  assert.deepStrictEqual(guardDiff(new Map([['engine/q.mjs:gone', []]]), allow), {
    unlisted: ['engine/q.mjs:gone'],
    stale: ['engine/x.mjs:reads'],
  });
});
