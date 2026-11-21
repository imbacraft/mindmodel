// Java method index: names, exact line ranges and annotations of every type and method in a file.
// Shared by the scanner (to state facts down to the method) and the validator (to resolve path#method citations).
import assert from 'node:assert';

// Blank out comments, strings, char literals and text blocks (same length, newlines kept) so braces and
// keywords inside them can't fool the parser. Quotes stay, so `"..."` still reads as a string.
export function clean(text) {
  let out = '', i = 0;
  const n = text.length, blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i], d = text[i + 1];
    let end = -1;
    if (c === '/' && d === '/') end = text.indexOf('\n', i), end = end < 0 ? n : end;
    else if (c === '/' && d === '*') end = text.indexOf('*/', i + 2), end = end < 0 ? n : end + 2;
    else if (text.startsWith('"""', i)) { end = text.indexOf('"""', i + 3); end = end < 0 ? n : end + 3; out += '"""' + blank(text.slice(i + 3, end - 3)) + '"""'; i = end; continue; }
    else if (c === '"' || c === "'") {
      let j = i + 1; while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      end = Math.min(j + 1, n); out += c + blank(text.slice(i + 1, end - 1)) + (text[end - 1] === c ? c : ''); i = end; continue;
    }
    if (end >= 0) { out += blank(text.slice(i, end)); i = end; continue; }
    out += c; i++;
  }
  return out;
}

const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try', 'else', 'do', 'return', 'new', 'throw', 'super', 'this']);

// Every `{` that opens a type or a method body, with its matching `}`.
export function index(text) {
  const src = clean(text), starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const lineOf = (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; };
  const types = [], methods = [], stack = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') stack.push(i);
    else if (src[i] === '}' && stack.length) {
      const open = stack.pop();
      let h = open - 1; while (h >= 0 && !';{}'.includes(src[h])) h--;
      const header = src.slice(h + 1, open), flat = header.replace(/\s+/g, ' ').trim();
      const annotations = [...header.matchAll(/@(\w+)(\s*\([^)]*\))?/g)].map((m) => m[1] + (m[2] ? m[2].replace(/\s+/g, ' ') : ''));
      const t = /\b(class|interface|enum|record)\s+(\w+)/.exec(flat);
      const at = (re) => { const m = re.exec(header); return m ? lineOf(h + 1 + m.index + m[0].length - m[1].length) : lineOf(open); };
      if (t && !/\bnew\s/.test(flat)) { types.push({ kind: t[1], name: t[2], start: at(new RegExp(`\\b(${t[2]})\\b`)), end: lineOf(i), open, close: i, annotations }); continue; }
      const m = /(\w+)\s*\((?:[^()]|\([^()]*\))*\)\s*(?:throws\s+[\w\s,.]+)?$/.exec(flat);
      if (!m || NOT_METHOD.has(m[1]) || /->\s*$|\bnew\s+[\w.<>]+\s*\((?:[^()]|\([^()]*\))*\)\s*$|=\s*[^=]*$/.test(flat.replace(/@\w+(\s*\([^)]*\))?/g, ''))) continue;
      methods.push({ name: m[1], start: at(new RegExp(`\\b(${m[1]})\\s*\\(`)), end: lineOf(i), open, close: i, annotations, isPublic: /\bpublic\b/.test(flat) });
    }
  }
  methods.sort((a, b) => a.start - b.start);
  return { src, lineOf, types, methods };
}

// The innermost method containing a line, or null.
export const methodAt = (idx, line) => idx.methods.filter((m) => m.start <= line && line <= m.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;

{
  const t = 'public class A {\n  // a } comment {\n  @Transactional\n  public void pay(Long id) {\n    String s = "}{";\n    String p = """\n      { not a brace\n      """;\n    run(new Sync() {\n      public void afterCommit() { go(); }\n    });\n    list.forEach(x -> { x(); });\n  }\n  int size() { return 1; }\n}\n';
  const ix = index(t);
  assert.deepStrictEqual(ix.types.map((x) => [x.name, x.start, x.end]), [['A', 1, 15]]);
  assert.deepStrictEqual(ix.methods.map((x) => [x.name, x.start, x.end]), [['pay', 4, 13], ['afterCommit', 10, 10], ['size', 14, 14]]);
  assert.deepStrictEqual(ix.methods[0].annotations, ['Transactional']);
  assert.equal(methodAt(ix, 10).name, 'afterCommit');
  assert.equal(methodAt(ix, 12).name, 'pay');
}
