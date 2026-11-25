// The flow ranking's fixture checks, moved out of engine/extract/flows.mjs: an effectless path is not a flow; a
// transaction boundary outranks an otherwise equal flow; the order is stable; a fan-out to one client target is one
// effect; entity points stop at five; an inherited endpoint keeps its controllers apart; and a branch arm makes the
// effect it holds conditional. The Java lives on disk under test-support/fixtures and is dumped by the real engine,
// read back as a model — nothing here parses Java.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { buildFlows, flowEntries } from '../engine/extract/flows.mjs';
import { loadCatalogs } from '../engine/catalogs/catalog.mjs';
import { dumpOfLayers, NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';

const methods = ['a', 'b', 'c', 'd', 'e', 'f'];

test('an effectless entry is not a flow, the steps name the effect, and the score parts are facts', { skip: NO_ENGINE }, () => {
  const { model } = dumpOfLayers(['flows-score']);
  const endpoints = [
    { verb: 'POST', path: '/orders', handlerFqn: 'a.Ctl', handler: 'Ctl.create' },
    { verb: 'GET', path: '/orders', handlerFqn: 'a.Ctl', handler: 'Ctl.read' },
  ];
  const stateWrites = [
    { id: 'w1', family: 'state-write', entity: 'a.Order', repository: 'a.Repo', operation: 'save', method: 'a.Svc#create(Order)', line: 5, evidence: ['src/main/java/a/Svc.java:5#create'] },
  ];
  const transactions = [
    { id: 't1', family: 'transaction', kind: 'outside-in-transaction', method: 'a.Ctl#create(Order)', evidence: ['src/main/java/a/Ctl.java:9#create'] },
  ];
  const entities = [{ name: 'Order', refs: 30 }];
  const build = () =>
    buildFlows(model, { entries: flowEntries(model, endpoints), stateWrites, transactions, entities, activityOf: () => 2 });

  const flows = build();
  // Effectless entry: the GET reaches only read-only code, so it is not a flow.
  assert.deepEqual(flows.map((f) => f.entry.verb), ['POST']);
  // One effect, named at the end of the steps; the implementation is the hop, the interface is not.
  assert.deepEqual(flows[0].steps, ['Svc#create', 'writes Order']);
  // Score parts are facts, all of them listed.
  assert.deepEqual(flows[0].why, [
    'entry POST +3',
    'entities 1 (Order) +3',
    'risk outside-in-transaction +2',
    'centrality Order +2',
    'activity 2 commit(s) +1',
  ]);
  assert.equal(flows[0].score, 11);
  // Same inputs, same order (ties broken by id).
  assert.deepEqual(build(), build());
});

test('a fan-out to one client target is one effect, entity points cap at five, and a UI action is an entry', { skip: NO_ENGINE }, () => {
  const { model } = dumpOfLayers(['flows-bulk']);
  const firstWrite = 8; // the first `w.a(i)` in Bulk.java
  const pingLine = firstWrite + methods.length; // the first `h.ping(i)`
  const stateWrites = methods.map((m, i) => ({
    id: `w${i}`,
    family: 'state-write',
    entity: `u.Entity${i + 1}`,
    repository: 'u.W',
    operation: m,
    method: 'u.Bulk#go(Item)',
    line: firstWrite + i,
    evidence: [`src/main/java/u/Bulk.java:${firstWrite + i}#go`],
  }));
  // Two call sites, same client kind and target: one outside effect, not two.
  const outsideCalls = [pingLine, pingLine + 1].map((line, i) => ({
    id: `o${i}`,
    family: 'outside-call',
    kind: 'HTTP',
    client: 'RestTemplate',
    target: 'RestTemplate.ping',
    method: 'u.Bulk#go(Item)',
    line,
    evidence: [`src/main/java/u/Bulk.java:${line}#go`],
  }));
  const entries = flowEntries(model, [], loadCatalogs().map((catalog) => ({ catalog })));
  const flows = buildFlows(model, { entries, stateWrites, outsideCalls, activityOf: () => 0 });
  const bulk = flows.find((f) => f.entry.method === 'u.Bulk#go(Item)');
  assert.ok(bulk, 'the UI action is a flow');
  const why = bulk.why.join(' | ');
  assert.match(why, /entry ui-action \+3/);
  assert.match(why, /entities 6 \(cap 5\)/);
  assert.match(why, /entities .* \+7/, 'five entities: three for the aggregate, one for each further table');
  assert.match(why, /outside 1 \+3/);
});

test('an inherited endpoint keeps the two controllers apart and cites the code that runs', { skip: NO_ENGINE }, () => {
  const { model } = dumpOfLayers(['flows-inherited']);
  const endpoints = ['b.OrderCtl', 'b.InvoiceCtl'].map((fqn) => ({
    verb: 'POST',
    path: '/publish',
    handlerFqn: fqn,
    handler: `${fqn.split('.').pop()}.publish`,
    declaredIn: 'b.Base',
  }));
  const stateWrites = [
    { id: 'w1', family: 'state-write', entity: 'b.Order', repository: 'b.Repo', operation: 'save', method: 'b.Base#publish(Order)', line: 4, evidence: ['src/main/java/b/Base.java:4#publish'] },
  ];
  const flows = buildFlows(model, { entries: flowEntries(model, endpoints), stateWrites, activityOf: () => 0 });
  assert.equal(flows.length, 2, 'both controllers serve the inherited endpoint');
  assert.deepEqual(flows.map((f) => f.id).sort(), [
    'flow:b.Base#publish(Order)@b.InvoiceCtl',
    'flow:b.Base#publish(Order)@b.OrderCtl',
  ]);
  assert.ok(flows.every((f) => f.entry.cite.startsWith('src/main/java/b/Base.java:4')), 'the citation is the code that runs');
  assert.ok(flows.every((f) => f.steps[0] === 'writes Order'), 'the write on the inherited body is the effect');
});

test('an effect inside a branch arm is conditional and counts at half weight', { skip: NO_ENGINE }, () => {
  const { model } = dumpOfLayers(['flows-branch']);
  const create = model.types.get('c.Ctl').methods.find((x) => x.name === 'create');
  const arms = create.branches;
  const endpoints = [{ verb: 'POST', path: '/orders', handlerFqn: 'c.Ctl', handler: 'Ctl.create' }];
  const stateWrites = [
    { id: 'w1', family: 'state-write', entity: 'c.Order', repository: 'c.Repo', operation: 'save', method: 'c.Ctl#create(Order,boolean)', line: 8, evidence: ['src/main/java/c/Ctl.java:8#create'] },
  ];
  const outsideCalls = [
    { id: 'o1', family: 'outside-call', kind: 'HTTP', client: 'Charge', target: 'Charge.send', method: 'c.Ctl#create(Order,boolean)', line: 10, evidence: ['src/main/java/c/Ctl.java:10#create'] },
  ];
  const build = () =>
    buildFlows(model, { entries: flowEntries(model, endpoints), stateWrites, outsideCalls, activityOf: () => 0 });

  // The dump wrote the `if` arm: the charge line sits inside it, the save line does not.
  assert.ok(arms.some((b) => b.line <= 10 && 10 <= b.endLine), `the arm covers the charge: ${JSON.stringify(arms)}`);
  const arm = build()[0];
  assert.deepEqual(arm.why, ['entry POST +3', 'entities 1 (Order) +3', 'outside 1 +1, 1 conditional']);
  assert.equal(arm.score, 7, 'the conditional charge weighs half of 3, rounded down');
  const charge = arm.effects.find((e) => e.kind === 'outside');
  const save = arm.effects.find((e) => e.kind === 'entity');
  assert.equal(charge.conditional, true);
  assert.equal(charge.label, 'HTTP send() (conditional)');
  assert.ok(!save.conditional, 'the unconditional save stays full weight');
  assert.ok(arm.steps.includes('HTTP send() (conditional)'), arm.steps.join('; '));

  // Without arm facts every effect is unconditional and the score is the full 3 + 3 + 3.
  create.branches = [];
  const plain = build()[0];
  create.branches = arms;
  assert.deepEqual(plain.why, ['entry POST +3', 'entities 1 (Order) +3', 'outside 1 +3']);
  assert.equal(plain.score, 9);
  assert.ok(plain.effects.every((e) => !e.conditional));
  assert.deepEqual(plain.steps, ['writes Order', 'HTTP send()']);
});
