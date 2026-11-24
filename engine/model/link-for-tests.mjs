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

// Typed linking for fixtures that mean to exercise the walk: a call resolves through its receiver's *declared* type,
// as the dump's compiler answer does, and names that declaration only. A port call therefore stops at the port and a
// `super.` call at the superclass — following those is the walk's job, not the linker's, or the fixture would prove
// nothing about the walk. `recvHow` gets the dump's vocabulary (field, local, param, this, super), which is what the
// super rule reads.
export function linkCallsTyped(model) {
  const methodOf = (fqn, name, argc) =>
    model.types.get(fqn)?.methods.find((m) => m.name === name && (m.params?.length ?? 0) === argc) ?? null;
  // The nearest declaration along the supertype chain: the code a call runs is the first type that declares it.
  const along = (fqn, name, argc, seen = new Set()) => {
    if (!fqn || seen.has(fqn)) return null;
    seen.add(fqn);
    const hit = methodOf(fqn, name, argc);
    if (hit) return hit;
    for (const s of model.types.get(fqn)?.supers ?? []) {
      const found = along(s.fqn, name, argc, seen);
      if (found) return found;
    }
    return null;
  };
  const superclassOf = (t) =>
    (t.supers ?? []).find((s) => ['class', 'record', 'enum'].includes(model.types.get(s.fqn)?.kind))?.fqn ?? null;
  const at = (t, m, name) => {
    if ((m.params ?? []).some((p) => p.name === name)) return 'param';
    if ((m.locals ?? []).some((l) => l.name === name)) return 'local';
    if ((t.fields ?? []).some((f) => f.name === name)) return 'field';
    return null;
  };
  const writtenTypeOf = (t, m, name) =>
    (m.params ?? []).find((p) => p.name === name)?.type ??
    (m.locals ?? []).find((l) => l.name === name)?.type ??
    (t.fields ?? []).find((f) => f.name === name)?.type ??
    null;
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const c of m.calls ?? []) {
        if (c.kind === 'new') continue;
        const argc = c.args?.length ?? c.argc ?? 0;
        const recv = c.recv?.kind === 'name' ? c.recv.text : null;
        let hit = null;
        if (recv === 'super') {
          c.recvHow = 'super';
          c.recvFqn = superclassOf(t);
          hit = along(superclassOf(t), c.name, argc);
        } else if (!recv || recv === 'this') {
          if (recv === 'this') c.recvHow = 'this';
          c.recvFqn = t.fqn;
          hit = along(t.fqn, c.name, argc);
        } else {
          c.recvHow = at(t, m, recv);
          const written = writtenTypeOf(t, m, recv);
          const receiver = written ? model.resolveIn(t.file, written.replace(/<.*/, '')) : null;
          // The dump's `recv.type`: the receiver's declared type, which is what makes a write a write.
          c.recvFqn = receiver;
          hit = along(receiver, c.name, argc);
        }
        if (hit && hit.id !== m.id) c.targets = [hit.id];
      }
  return model;
}

{
  // `super.publish` names the superclass method; a call on a port names the port's declaration, not its implementation.
  const model = {
    types: new Map([
      [
        'a.Base',
        {
          fqn: 'a.Base',
          kind: 'class',
          supers: [],
          methods: [{ id: 'a.Base#publish(Long)', name: 'publish', params: [{ name: 'id', type: 'Long' }], calls: [] }],
        },
      ],
      [
        'a.Sub',
        {
          fqn: 'a.Sub',
          kind: 'class',
          supers: [{ fqn: 'a.Base', text: 'Base' }],
          fields: [],
          methods: [
            {
              id: 'a.Sub#publish(Long)',
              name: 'publish',
              params: [{ name: 'id', type: 'Long' }],
              calls: [{ kind: 'call', name: 'publish', args: ['id'], recv: { kind: 'name', text: 'super' } }],
            },
          ],
        },
      ],
      [
        'a.Port',
        {
          fqn: 'a.Port',
          kind: 'interface',
          supers: [],
          methods: [{ id: 'a.Port#go()', name: 'go', params: [], calls: [] }],
        },
      ],
      [
        'a.Impl',
        {
          fqn: 'a.Impl',
          kind: 'class',
          supers: [{ fqn: 'a.Port', text: 'Port' }],
          methods: [{ id: 'a.Impl#go()', name: 'go', params: [], calls: [] }],
        },
      ],
      [
        'a.Caller',
        {
          fqn: 'a.Caller',
          kind: 'class',
          supers: [],
          fields: [{ name: 'port', type: 'Port' }],
          methods: [
            {
              id: 'a.Caller#run()',
              name: 'run',
              params: [],
              calls: [{ kind: 'call', name: 'go', args: [], recv: { kind: 'name', text: 'port' } }],
            },
          ],
        },
      ],
    ]),
    resolveIn: (file, name) => ({ Port: 'a.Port' })[name] ?? null,
  };
  linkCallsTyped(model);
  assert.equal(model.types.get('a.Sub').methods[0].calls[0].targets[0], 'a.Base#publish(Long)');
  assert.equal(model.types.get('a.Sub').methods[0].calls[0].recvHow, 'super');
  assert.equal(model.types.get('a.Caller').methods[0].calls[0].targets[0], 'a.Port#go()');
  assert.equal(model.types.get('a.Caller').methods[0].calls[0].recvHow, 'field');
}
