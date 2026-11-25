// the flow trace follows `super.m(...)` into a generic base class
// with the subclass's type arguments, follows a port call to its implementation, and weights a status change a flow
// performs. The fixtures are Java sources on disk (test-support/fixtures/flow-effects), dumped by the real engine and
// read back as a model — the same path a scan takes. Nothing here parses Java or names a declaration by hand.
// Fixture E adds the override policy as a consumer's choice: a worker's reach follows every implementation with a
// body, the ranked path only a unique one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flowsOfLayers } from '../test-support/fixtures/flows-of-dump.mjs';
import { NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';

// The fixture layers, applied in order: the publish flow is the base; each case adds one layer of source.
const LAYERS = {
  base: ['flow-effects/base'],
  port: ['flow-effects/base', 'flow-effects/port'],
  legacy: ['flow-effects/base', 'flow-effects/port', 'flow-effects/legacy'],
  crud: ['flow-effects/base', 'flow-effects/port', 'flow-effects/crud'],
  charge: ['flow-effects/charge'],
  chargeBoth: ['flow-effects/charge', 'flow-effects/charge-both'],
  fanout: ['flow-effects/fanout'],
};

test(
  'fixture A: the trace follows super.publish into the generic base and names the subtype',
  { skip: NO_ENGINE },
  () => {
  const { flows, flowOf, model } = flowsOfLayers(LAYERS.base);
  const publish = flowOf('/vouchers/{}/publish');
  assert.ok(publish, `the publish endpoint is a flow: ${flows.map((f) => f.entry.path).join(', ')}`);
  // The base's `GenericRepo<T>.save` is a write of the entity the subclass binds.
  assert.ok(publish.steps.includes('writes Voucher'), publish.steps.join('; '));
  assert.match(publish.why.join(' | '), /entities 1 \(Voucher\) \+3/);
  // The base's receiver is the type variable `T`, which the dump writes without a type, so the status set there is
  // unresolved today: the assertion stays, and it is what fails.
  assert.match(publish.why.join(' | '), /status Voucher\.PUBLISHED \+3/);
  // Centrality needs 20 referring types; this fixture has four, so the point is absent — the doc's "(if referenced
  // enough)" and nothing else.
  assert.ok(!publish.why.some((w) => w.startsWith('centrality')), publish.why.join(' | '));
  assert.ok(publish.steps.includes('sets Voucher status PUBLISHED'), publish.steps.join('; '));
  // The state fact says why it could not name the entity, and which parameter it is.
  const baseWrite = flows[0].effects.find((e) => e.kind === 'entity');
  assert.equal(baseWrite.entity, 'shop.Voucher');
  // The type-argument binding is the fact, not the entity's name.
  const base = model.types.get('shop.AbstractVersionService');
  assert.deepEqual(base.typeParams, ['T']);
  },
);

test('fixture B: a port with one implementation is followed; with a second, it is not', { skip: NO_ENGINE }, () => {
  const one = flowsOfLayers(LAYERS.port);
  const publish = one.flowOf('/vouchers/{}/publish');
  assert.ok(publish.steps.includes('writes Contract'), `one implementation is followed: ${publish.steps.join('; ')}`);
  assert.ok(publish.steps.includes('writes Voucher'), publish.steps.join('; '));
  assert.match(publish.why.join(' | '), /entities 2 \(Voucher, Contract\) \+4/);
  assert.match(publish.why.join(' | '), /outside 1 \+3/);

  // A second implementation of the same port: which one runs is no longer a fact, so the walk stops at the port.
  const two = flowsOfLayers(LAYERS.legacy);
  const ambiguous = two.flowOf('/vouchers/{}/publish');
  assert.ok(ambiguous, 'the publish endpoint is still a flow');
  // The dump names the port and both implementations as targets of the one call, and the walk follows every target:
  // the assertion stays, and it is what fails.
  assert.ok(
    !ambiguous.steps.includes('writes Contract'),
    `two implementations are not followed: ${ambiguous.steps.join('; ')}`,
  );
  assert.ok(
    !ambiguous.steps.some((s) => /^(?:ContractService|LegacyContractService)#/.test(s)),
    `neither implementation is guessed: ${ambiguous.steps.join('; ')}`,
  );
  assert.ok(!ambiguous.why.some((w) => w.startsWith('outside')), ambiguous.why.join(' | '));
});

test('fixture C: a plain CRUD sweep called by the SPA ranks below the publish flow', { skip: NO_ENGINE }, () => {
  const { flows, flowOf } = flowsOfLayers(LAYERS.crud, {
    frontendPaths: [{ path: '/items', file: 'web/src/catalog/items.jsx' }],
  });
  const publish = flowOf('/vouchers/{}/publish');
  const crud = flowOf('/items');
  assert.ok(crud, `the CRUD endpoint is a flow: ${flows.map((f) => f.entry.path).join(', ')}`);
  assert.match(crud.why.join(' | '), /frontend-called \+4/);
  assert.match(crud.why.join(' | '), /entities 3 \(Item, Tag, Note\) \+5/);
  assert.ok(!crud.why.some((w) => w.startsWith('status')), 'no status change in the CRUD flow');
  // The publish flow's status points are the ones fixture A loses, so the CRUD sweep wins the tie it should lose.
  assert.ok(
    flows.indexOf(publish) < flows.indexOf(crud),
    `publish (${publish.score}) must outrank the CRUD sweep (${crud.score}): ${flows
      .slice(0, 4)
      .map((f) => `${f.score} ${f.entry.path}`)
      .join(', ')}`,
  );
});

// Fixture D: the entry saves unconditionally and charges only inside `if (flag)`. The dump writes each method's branch
// arms, so the charge is conditional and counts at half weight (3 -> 1, rounded down); the save does not change.
test('fixture D: an effect only an if arm reaches is conditional and weighs half', { skip: NO_ENGINE }, () => {
  const { flowOf } = flowsOfLayers(LAYERS.charge);
  const flow = flowOf('/items');
  assert.ok(flow, 'the endpoint is a flow');
  const save = flow.effects.find((e) => e.kind === 'entity');
  const charge = flow.effects.find((e) => e.kind === 'outside');
  assert.ok(save && charge, flow.effects.map((e) => e.label).join(', '));

  // The save is on the default path; only the charge is behind the decision.
  assert.equal(charge.conditional, true, 'the charge is inside `if (flag)`');
  assert.equal(charge.label, 'HTTP postForEntity() (conditional)');
  assert.ok(!save.conditional, 'the save is on the default path');
  assert.equal(save.label, 'writes Item');
  // Half of the outside-call weight (3), rounded down, and the fact says so in the score's own words.
  assert.deepEqual(flow.why, ['entry POST +3', 'entities 1 (Item) +3', 'outside 1 +1, 1 conditional']);
  assert.equal(flow.score, 7);
  assert.ok(flow.steps.includes('HTTP postForEntity() (conditional)'), flow.steps.join('; '));
});

test('fixture D2: an effect reached both conditionally and unconditionally is not conditional', { skip: NO_ENGINE }, () => {
  // The charge is called on the default path and again inside an arm: some path always runs it, so it keeps full
  // weight. The guard is an early return, the shape a service uses far more often than if/else.
  const flow = flowsOfLayers(LAYERS.chargeBoth).flowOf('/items');
  const outside = flow.effects.filter((e) => e.kind === 'outside');
  assert.equal(outside.length, 2, 'two call sites are two effects, and the score counts the one client target once');
  assert.ok(
    outside.every((e) => !e.conditional),
    'one unconditional site makes the effect unconditional',
  );
  assert.ok(
    !JSON.stringify(flow).includes('(conditional)'),
    flow.effects.map((e) => e.label).join(', '),
  );
  assert.deepEqual(flow.why, ['entry POST +3', 'entities 1 (Item) +3', 'outside 1 +3']);
  assert.equal(flow.score, 9);
});

// Fixture E: one interface, three implementations, one of them calling an outside client. The two consumers of the walk
// differ on purpose. A worker's REACH follows every override with a body (`overrides: 'all'`): a fan-out dispatch is
// the notification path, so the implementation that calls out is what the worker can do. The ranked path a reader
// walks follows the declaration and only a unique implementation (`overrides: 'unique'`): with three of them, which
// one runs is not a fact, so the path absorbs none.
test('fixture E: a worker reaches every implementation of a fan-out; the ranked path absorbs none', { skip: NO_ENGINE }, () => {
  const { flows, flowOf, model } = flowsOfLayers(LAYERS.fanout);
  // The fixture is what it claims: one declaration, three implementations.
  assert.deepEqual([...(model.implsOf.get('shop.Notifier') ?? [])].sort(), [
    'shop.HookNotifier',
    'shop.MailNotifier',
    'shop.SmsNotifier',
  ]);
  // The worker polls the queue and fans out to the interface; the mail implementation's client call is its reach.
  const worker = flows.find((f) => f.entry.kind === 'worker');
  assert.ok(
    worker,
    `the @PostConstruct poll loop is a worker: ${flows.map((f) => `${f.entry.kind} ${f.entry.path}`).join(', ')}`,
  );
  assert.equal(worker.entry.method, 'shop.NoticeWorker#start()');
  assert.deepEqual(worker.steps, ['HTTP postForEntity()'], 'the reach is the implementation that calls out');
  assert.match(worker.why.join(' | '), /outside 1 \+3/);
  assert.ok(worker.evidence.some((e) => e.includes('MailNotifier.java#send')), worker.evidence.join(', '));
  // The endpoint calls the same interface. The save is the path; neither an implementation nor its outside call is.
  const create = flowOf('/notices');
  assert.ok(create, `the endpoint is a flow: ${flows.map((f) => f.entry.path).join(', ')}`);
  assert.deepEqual(create.steps, ['writes Notice'], create.steps.join('; '));
  assert.ok(!create.steps.some((s) => /^(?:Mail|Sms|Hook)Notifier#/.test(s)), create.steps.join('; '));
  assert.ok(!create.why.some((w) => w.startsWith('outside')), create.why.join(' | '));
});
