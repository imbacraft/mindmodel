// The two rates over the model the facts are built from. Resolution is not here: the dump owns it (Spoon, with
// the engine's library table for chains), so this file counts what the dump answered and nothing else.
import assert from 'node:assert';

/** Counts calls, typed receivers, project receivers, project targets and ambiguous sites; writes `model.bindings`. */
export function bindingRates(model) {
  const rate = { calls: 0, typed: 0, project: 0, targeted: 0, ambiguous: 0 };
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const call of m.calls ?? []) {
        if (call.kind === 'new') continue;
        rate.calls++;
        if (call.recvFqn) rate.typed++;
        if (call.recvFqn && model.types.has(call.recvFqn)) {
          rate.project++;
          if (call.how === 'ambiguous') rate.ambiguous++;
          else if (call.targets?.length) rate.targeted++;
        }
      }
  model.bindings = rate;
  return rate;
}

{
  const model = {
    types: new Map([
      [
        'a.A',
        {
          fqn: 'a.A',
          methods: [{ calls: [{ kind: 'call', recvFqn: 'a.B', targets: ['a.B#x()'] }, { kind: 'new' }] }],
        },
      ],
      ['a.B', { fqn: 'a.B', methods: [] }],
    ]),
  };
  const rate = bindingRates(model);
  assert.deepStrictEqual(rate, { calls: 1, typed: 1, project: 1, targeted: 1, ambiguous: 0 });
  assert.strictEqual(model.bindings, rate);
}
