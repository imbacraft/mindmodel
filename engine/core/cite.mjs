// Citations: `path[:start[-end]][#symbol[/arity]]`, the form every claim in a map cites its code with.
import assert from 'node:assert';

// Splits a citation into its parts. `#symbol/2` names one overload by its parameter count. Null when it is not one.
export function parseCite(c) {
  const m = /^([^:#]+?)(?::(\d+)(?:-(\d+))?)?(?:#(\S+?)(?:\/(\d+))?)?$/.exec(String(c ?? ''));
  if (!m) return null;
  return {
    file: m[1],
    start: m[2] ? +m[2] : null,
    end: m[3] ? +m[3] : m[2] ? +m[2] : null,
    symbol: m[4] ?? null,
    arity: m[5] != null ? +m[5] : null,
  };
}

// The citation text for a location: the inverse of parseCite. A range keeps its end; a symbol keeps its arity.
export function formatCite({ file, start = null, end = null, symbol = null, arity = null }) {
  const lines = start == null ? '' : `:${start}${end == null ? '' : `-${end}`}`;
  const sym = symbol == null ? '' : `#${symbol}${arity == null ? '' : `/${arity}`}`;
  return `${file}${lines}${sym}`;
}

{
  const cite = (file, start, end, symbol, arity) => ({ file, start, end, symbol, arity });
  assert.deepStrictEqual(parseCite('a/b.java:10-12'), cite('a/b.java', 10, 12, null, null));
  assert.deepStrictEqual(parseCite('a/B.java:5#save'), cite('a/B.java', 5, 5, 'save', null));
  assert.deepStrictEqual(parseCite('a/B.java#save/2'), cite('a/B.java', null, null, 'save', 2));
  assert.deepStrictEqual(parseCite('CLAUDE.md'), cite('CLAUDE.md', null, null, null, null));
  assert.equal(parseCite('::bad::'), null);
  assert.equal(parseCite(undefined), null);
  assert.equal(formatCite({ file: 'a/A.java', start: 2, end: 3, symbol: 'x' }), 'a/A.java:2-3#x');
  assert.equal(formatCite({ file: 'a/A.java', symbol: 'y' }), 'a/A.java#y');
  assert.equal(formatCite({ file: 'a/A.java', start: 4, end: 9, symbol: 'z', arity: 1 }), 'a/A.java:4-9#z/1');
}
