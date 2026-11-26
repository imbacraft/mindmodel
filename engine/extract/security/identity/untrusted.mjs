import assert from 'node:assert/strict';

// What makes a stored value untrusted, decided here and nowhere else. A holder warning claims that the client chose the
// value it stored, so the value must be request-derived: a header, parameter, cookie or body that the stored value is
// built from. This is the judgement that places a built value; the walk that follows the value is in flow/values.mjs.

/**
 * A `new` argument with its constructor's own arguments placed, so the walk can follow them. The constructor is the one
 * `new` row on the same line of the same method, of the created type; anything else (none, or several) stays unplaced,
 * and an unplaced value keeps its warning: an unknown never clears one.
 */
export function placedArg(db, row, arg) {
  if (arg?.kind !== 'new' || !row) return arg;
  const made = arg.created ?? arg.typeFqn;
  const ctors = (db?.callsOf?.(row.method) ?? []).filter(
    (c) => c.name === '<init>' && c.file === row.file && c.line === row.line && c.recv?.typeFqn === made,
  );
  return ctors.length === 1 ? { ...arg, ctor: ctors[0] } : arg;
}

{
  const row = { method: 'a.F#go()', file: 'a/F.java', line: 4 };
  const ctor = { id: 'c', name: '<init>', file: 'a/F.java', line: 4, recv: { typeFqn: 'a.Route' }, args: [] };
  const dbOne = { callsOf: () => [ctor, { ...ctor, id: 'other', line: 5 }] };
  assert.equal(placedArg(dbOne, row, { kind: 'new', created: 'a.Route' }).ctor, ctor, 'one constructor on the line');
  assert.equal(placedArg(dbOne, row, { kind: 'new', created: 'a.Other' }).ctor, undefined, 'no such constructor');
  const twice = { callsOf: () => [ctor, { ...ctor, id: 'twin' }] };
  const two = placedArg(twice, row, { kind: 'new', created: 'a.Route' });
  assert.equal(two.ctor, undefined, 'two candidates stay unplaced');
}
