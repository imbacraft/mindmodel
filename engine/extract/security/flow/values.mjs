import assert from 'node:assert/strict';
import { callById } from './dump.mjs';

/**
 * The value the client sent has to reach the holder. Followed through what the dump records: the store's argument is
 * the read's own call, or a local assigned from it, or a local assigned from a call that took it (one hop). A value
 * the dump cannot place — a parameter of the sink's own method, or a value built inside a `new` whose arguments are
 * not recorded — keeps the warning: an unknown never clears a warning.
 */
export function valueReaches(read, value, q, db, weak = false, depth = 2) {
  if (!value) return true;
  const ids = new Set([read.call, read.value].filter(Boolean));
  const isRead = (v) =>
    Boolean(v) && ((v.kind === 'call' && ids.has(v.call)) || (v.kind === 'local' && ids.has(v.from)));
  if (isRead(value)) return true;
  if (value.kind === 'param') return !weak;
  // A local assigned in more than one place has no `from` in the dump (`actor = null; ... actor = c.getValue();`).
  // The servlet cookie loop is that shape. A *weak* sink (a project method merely handed the caller) does not warn
  // on it: the weakest sink warns only on what the dump can show reaching it, or every filter that re-stores the
  // caller already authenticated would be flagged.
  if (value.kind === 'local' && !value.from) return !weak;
  // A value built inline (`new UserContext(user)`): the dump names the created type, not its arguments, so what was
  // passed to the constructor is not in it. Unplaceable, and the warning stands.
  if (value.kind === 'new') return true;
  if (value.kind === 'local' && value.from && depth > 0) {
    const row = callById(db, value.from);
    if (!row) return false;
    for (let i = 0; i < (row.args ?? []).length; i++)
      for (const v of q.argValue(row, i).values)
        if (isRead(v.value) || valueReaches(read, v.value, q, db, weak, depth - 1)) return true;
    return false;
  }
  return false;
}

{
  // The value walk: a read assigned to a local that the store is handed reaches it; an unrelated local does not.
  const calls = [
    { id: 'a.F#go()@4:9', method: 'a.F#go()', name: 'getHeader', file: 'a/F.java', line: 4, args: [] },
    { id: 'a.F#go()@8:9', method: 'a.F#go()', name: 'store', file: 'a/F.java', line: 8, args: [] },
  ];
  const db = { calls, callById: (id) => calls.find((c) => c.id === id) ?? null, members: new Map(), types: new Map() };
  const q = { argValue: () => ({ values: [], unresolved: [] }) };
  const read = { kind: 'header', name: 'X-Api-Key', call: 'a.F#go()@4:9' };
  assert.ok(valueReaches(read, { kind: 'local', from: 'a.F#go()@4:9' }, q, db), 'the local is assigned from the read');
  assert.ok(!valueReaches(read, { kind: 'local', from: 'a.F#go()@5:9' }, q, db), 'an unrelated local does not reach');
  assert.ok(valueReaches(read, { kind: 'param', index: 0 }, q, db), 'a value the dump cannot place keeps the warning');
  assert.ok(valueReaches(read, null, q, db), 'a store whose argument was not recorded keeps the warning');
}
