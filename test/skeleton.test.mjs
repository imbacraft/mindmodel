// The walking skeleton, end to end: the dump -> model -> catalogs -> facts, on one real app. cargotracker is small
// enough to assert exact properties; large apps are measured in reports.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildModelFromDump } from '../engine/model/from-dump-model.mjs';
import { bindingRates } from '../engine/model/calls.mjs';
import { open } from '../engine/dump.mjs';
import { loadCatalogs, selectCatalogs } from '../engine/catalogs/catalog.mjs';
import { extractEndpoints } from '../engine/extract/endpoints.mjs';
import { extractOutside } from '../engine/extract/outside.mjs';
import { extractState } from '../engine/extract/state.mjs';
import { extractTransactions } from '../engine/extract/transactions.mjs';
import { parseCite } from '../engine/core/cite.mjs';

const root = path.join(os.homedir(), 'Projects/test-apps/cargotracker');

const hasDump = () => fs.existsSync(path.join(root, 'mindmodel/.work/dump'));

function pipeline() {
  // The dump is the only source of packages, imports, members and calls: the model is built from it, as a scan does.
  const dumpDir = path.join(root, 'mindmodel/.work/dump');
  const db = open(dumpDir);
  const sources = new Map(
    [...db.files].map(([p, f]) => [
      p,
      {
        pkg: f.package ?? '',
        imports: (f.imports ?? []).map((i) => ({ name: i.name, wildcard: !!i.wildcard, isStatic: !!i.static })),
      },
    ]),
  );
  const model = buildModelFromDump(db, sources);
  bindingRates(model);
  const imports = [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  const selected = selectCatalogs(loadCatalogs(), { imports });
  const endpoints = extractEndpoints(model, selected);
  const outside = extractOutside(model, selected);
  const state = extractState(model, selected);
  const tx = extractTransactions(model, selected, { outside, writes: state.filter((f) => f.family === 'state-write') });
  return { model, selected, endpoints, outside, state, transactions: tx.facts, transactionCounts: tx.counts };
}

const envelope = (f) => {
  assert.equal(f.family !== undefined, true, 'a fact has a family');
  assert.ok(['parsed', 'resolved', 'inferred', 'unresolved'].includes(f.confidence), f.confidence);
  assert.ok(f.why?.length >= 1, `a fact says why it exists: ${f.id}`);
  for (const e of f.evidence ?? []) assert.ok(parseCite(e), `evidence resolves: ${e}`);
};

test('skeleton: endpoints walk the whole pipeline on cargotracker', { skip: (!fs.existsSync(root) || !hasDump()) && 'app or dump not found' }, () => {
  const { endpoints: facts } = pipeline();
  assert.ok(facts.length > 0, 'the app has endpoints');
  assert.ok(facts.every((f) => f.handler && f.path), 'every fact names a handler and a path');
  assert.equal(new Set(facts.map((f) => f.id)).size, facts.length, 'ids are unique');
  for (const f of facts) {
    assert.equal(f.family, 'endpoint');
    envelope(f);
  }
});

test('skeleton: calls resolve to methods that exist, and the rates are measured', { skip: (!fs.existsSync(root) || !hasDump()) && 'app or dump not found' }, () => {
  const { model } = pipeline();
  const ids = new Set();
  for (const t of model.types.values()) for (const m of t.methods) if (m.id) ids.add(m.id);
  let calls = 0;
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const c of m.calls ?? []) {
        if (c.kind === 'new') continue;
        calls++;
        assert.ok(
          ['direct', 'super', 'impl', 'convention', 'ambiguous', 'external', 'unresolved'].includes(c.how),
          `a call names how it resolved: ${c.how}`,
        );
        // Every target a call names is a method the model holds: no invented ids.
        for (const id of c.targets ?? []) assert.ok(ids.has(id), `call target exists in the model: ${id}`);
        if (c.recvFqn && model.types.has(c.recvFqn) && c.targets?.length)
          assert.ok(c.how !== 'external', 'a project receiver with a project target is not external');
      }
  assert.ok(calls > 500, `cargotracker has call sites: ${calls}`);
  assert.ok(model.bindings.calls > 0 && model.bindings.typed <= model.bindings.calls, 'receiver typing is a rate');
  assert.ok(model.bindings.targeted <= model.bindings.project, 'project targets is a rate');
});

test('skeleton: the slice-2 families keep their envelope and ids', { skip: (!fs.existsSync(root) || !hasDump()) && 'app or dump not found' }, () => {
  const { endpoints, outside, state, transactions, transactionCounts } = pipeline();
  for (const f of [...outside, ...state, ...transactions]) envelope(f);
  for (const list of [outside, state, transactions]) {
    const ids = list.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique within a family');
  }
  // cargotracker has no HTTP client and no cache; its transactional methods are a per-class count, and it has no
  // boundary hazards — the facts list only carries those.
  assert.ok(transactionCounts.length > 0, 'the EJB app has transactional methods');
  assert.ok(transactions.every((f) => f.kind !== 'transactional'), 'a plain transactional method is a count, not a fact');
  // cargotracker sends JMS through the JMS 2.0 `JMSContext.createProducer()...send()` chain, not JmsTemplate.
  assert.ok(endpoints.length > 0, 'endpoints');
  assert.ok(outside.some((o) => o.kind === 'JMS' && o.target === 'JMSProducer.send'), 'the JMS 2.0 send is an outside call');
});
