// Java string expressions, as annotations write them: string literals and constant names joined with '+'.
// A path made of constants ("{" + JOB_ID + "}") must be resolved or reported, never half-printed.
import assert from 'node:assert';

// Split on a separator at depth 0, keeping quotes and braces intact. Commas inside strings and generics stay put.
export function splitTop(expr, sep = '+') {
  const out = [];
  let cur = '',
    depth = 0,
    quote = false;
  for (let i = 0; i < (expr ?? '').length; i++) {
    const ch = expr[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += expr[++i] ?? '';
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', "'": "'", b: '\b', f: '\f' };

function unescape(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e) =>
    e.length === 5 && e[0] === 'u' ? String.fromCharCode(parseInt(e.slice(1), 16)) : (ESCAPES[e] ?? e),
  );
}

// '{"/a", "/b"}' -> '"/a"' (a one-element array of paths is the same path in Spring and JAX-RS).
export function firstArrayItem(expr) {
  const t = (expr ?? '').trim();
  if (!t.startsWith('{')) return t;
  const inner = t.slice(1, t.lastIndexOf('}') >= 0 ? t.lastIndexOf('}') : t.length);
  return splitTop(inner, ',').map((x) => x.trim()).find((x) => x.startsWith('"')) ?? '';
}

// Evaluate a string expression. Each literal is itself; each identifier is a constant the caller resolves. Anything
// unresolved is listed by name and left out of `text`, so the caller can mark the whole path part as `{?}`.
export function evalString(expr, resolveConst) {
  const unresolved = [];
  let text = '';
  for (const raw of splitTop(firstArrayItem(expr), '+')) {
    const part = raw.trim();
    const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(part);
    if (lit) {
      text += unescape(lit[1]);
      continue;
    }
    const name = /^([\w$]+\.)*[\w$]+$/.exec(part);
    if (name) {
      const value = resolveConst?.(part);
      if (value == null) unresolved.push(part);
      else text += value;
      continue;
    }
    unresolved.push(part);
  }
  return { text, unresolved };
}

{
  assert.deepStrictEqual(splitTop('"a,b" + C.D + "x"'), ['"a,b"', 'C.D', '"x"']);
  assert.equal(evalString('"/v1/jobs"', () => null).text, '/v1/jobs');
  assert.deepStrictEqual(evalString('"{" + ID + "}"', (n) => (n === 'ID' ? 'jobId' : null)), {
    text: '{jobId}',
    unresolved: [],
  });
  assert.deepStrictEqual(evalString('"{" + MISSING + "}"', () => null), { text: '{}', unresolved: ['MISSING'] });
  assert.deepStrictEqual(evalString('SHORT + "/" + HIST', (n) => ({ SHORT: 'short-name', HIST: 'runhistory' })[n]), {
    text: 'short-name/runhistory',
    unresolved: [],
  });
  assert.equal(evalString('{"/a", "/b"}', () => null).text, '/a');
  assert.equal(evalString('"a\\"b"', () => null).text, 'a"b');
  assert.deepStrictEqual(evalString('valueOf(1)', () => null).unresolved, ['valueOf(1)']);
}
