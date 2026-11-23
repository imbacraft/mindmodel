// Test-only: production resolution lives in the dump (Spoon plus the engine's library table). The self-checks build a
// tiny model by hand and need targets to walk, so this links them by name and arity inside that model — nothing else.
import assert from 'node:assert';

export function linkCalls(model) {
  const byShape = new Map();
  for (const t of model.types.values())
    for (const m of t.methods) {
      const k = `${m.name}/${m.params?.length ?? m.arity ?? 0}`;
      byShape.set(k, [...(byShape.get(k) ?? []), m.id]);
    }
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const c of m.calls ?? []) {
        if (c.kind === 'new') continue;
        // A method calling a same-named method on another type is the fixture's case; itself is never a target.
        const ids = (byShape.get(`${c.name}/${c.args?.length ?? c.argc ?? 0}`) ?? []).filter((id) => id !== m.id);
        if (ids.length) c.targets = ids;
      }
  return model;
}

{
  const model = {
    types: new Map([
      ['a.A', { fqn: 'a.A', methods: [{ id: 'a.A#go()', name: 'go', params: [], calls: [{ kind: 'call', name: 'run', args: [] }] }] }],
      ['a.B', { fqn: 'a.B', methods: [{ id: 'a.B#run()', name: 'run', params: [] }] }],
    ]),
  };
  linkCalls(model);
  assert.deepStrictEqual(model.types.get('a.A').methods[0].calls[0].targets, ['a.B#run()']);
}
