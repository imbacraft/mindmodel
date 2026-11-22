// Lifecycle helpers moved out of deep.mjs (which is meant to disappear). A status chosen inline
// (`cond ? ENUM.A : ENUM.B`, possibly across lines) inside a method that sets a status sets both values.
import assert from 'node:assert/strict';

export function chosenInline({ enumName, value, stmt, methodText }) {
  if (!stmt.includes('?')) return false;
  if (!new RegExp(`\\b${enumName}\\.${value}\\b`).test(stmt)) return false;
  return /\.(set\w*Status|status)\s*\(/.test(methodText ?? '');
}

assert.equal(chosenInline({ enumName: 'S', value: 'A', stmt: 'x ? S.A : S.B', methodText: 'o.setStatus(x)' }), true);
assert.equal(chosenInline({ enumName: 'S', value: 'A', stmt: 'x ? S.A : S.B', methodText: 'return 1;' }), false);
