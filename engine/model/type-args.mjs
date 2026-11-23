// The type arguments of a written type: "JpaRepository<Order, Long>" -> ["Order", "Long"]. Generics nest, so the split
// is depth-aware; no model, no resolution — a text helper the facts use where the source is already a string.
import assert from 'node:assert';

export function typeArgsOf(text) {
  if (!text || text.indexOf('<') < 0) return [];
  const m = /<([\s\S]+)>/.exec(text);
  if (!m) return [];
  const out = [];
  let depth = 0,
    cur = '';
  for (const ch of m[1]) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

assert.deepStrictEqual(typeArgsOf('JpaRepository<Order, Long>'), ['Order', 'Long']);
assert.deepStrictEqual(typeArgsOf('Map<String, List<Order>>'), ['String', 'List<Order>']);
assert.deepStrictEqual(typeArgsOf('Order'), []);
