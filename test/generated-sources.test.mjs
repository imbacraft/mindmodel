// An annotation processor's output, as the dump reads it: the types are in the model because project code calls into
// them, and not one row about them is written. The fixture is a contract-first controller and a generated mapper, both
// shaped as a real processor writes them.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dumpOfLayers, NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';
import { loadCatalogs, selectCatalogs } from '../engine/catalogs/catalog.mjs';
import { extractEndpoints } from '../engine/extract/endpoints.mjs';

const ROOT = 'target/generated-sources';
const withGenerated = () => dumpOfLayers(['generated-stubs'], { generated: [ROOT] });
const withoutGenerated = () => dumpOfLayers(['generated-stubs']);

const fileOf = (row) => String(row.file ?? row.pos?.file ?? '');

test('generated sources: in the model for resolution, not one row in the dump', { skip: NO_ENGINE }, () => {
  const { db } = withGenerated();
  assert.equal(db.meta.classpath.generatedDirs, 1, 'the dump says it read one generated root');
  assert.equal(db.meta.classpath.generatedFiles, 2, 'and both of its files were in the model');

  // Nothing generated is written anywhere: no type, member, call, field, file or library row.
  assert.deepEqual([...db.types.keys()].filter((fqn) => fqn.startsWith('gen.')), [], 'no type row');
  assert.deepEqual([...db.members.keys()].filter((id) => id.startsWith('gen.')), [], 'no member row');
  assert.deepEqual(db.calls.filter((c) => fileOf(c).startsWith(ROOT)), [], 'no call row from a generated body');
  assert.deepEqual(db.fields.filter((f) => fileOf(f).startsWith(ROOT)), [], 'no field access from a generated body');
  assert.deepEqual([...db.library.keys()].filter((fqn) => fqn.startsWith('gen.')), [],
    'a generated type is not a library type either');
  assert.ok([...db.files.keys()].every((f) => !f.startsWith(ROOT)), 'and its file is not in files.ndjson');
  assert.ok(db.type('gen.mapper.OrderMapperImpl') === null, 'the loader cannot see it at all');
});

test('generated sources: the project still resolves into them', { skip: NO_ENGINE }, () => {
  const { db } = withGenerated();
  // A project call into a generated mapper: the receiver is typed by the stub and the target is its signature.
  const call = db.callsOf('app.GeneratedUse#label(Order)').find((c) => c.name === 'toDto');
  assert.ok(call, 'the project calls the generated mapper');
  assert.equal(call.recv.type, 'gen.mapper.OrderMapperImpl', 'the stub typed the receiver');
  assert.ok(db.targetsOf(call).some((id) => id.startsWith('gen.mapper.OrderMapperImpl#toDto(')),
    `the call reaches a generated signature: ${db.targetsOf(call)}`);
  // The project's own call after it is still resolved: nothing the stubs add costs a fact.
  const own = db.callsOf('app.GeneratedUse#label(Order)').find((c) => c.name === 'nameOf');
  assert.deepEqual(db.targetsOf(own), ['app.GeneratedUse#nameOf(OrderDto)']);

  // A generated interface is a supertype, written as the project wrote it and never as a dumped type.
  const controller = db.type('app.OrderController');
  assert.deepEqual(controller.supertypes.map((s) => [s.text, s.fqn]), [['OrderApi', 'gen.api.OrderApi']]);
});

test('generated sources: the endpoints this scan reports do not depend on them', { skip: NO_ENGINE }, () => {
  const imports = ({ model }) => [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  const endpoints = (dumped) =>
    extractEndpoints(dumped.model, selectCatalogs(loadCatalogs(), { imports: imports(dumped) }))
      .map((f) => `${f.verb} ${f.path} ${f.handler}`)
      .sort();
  // The controller's three mappings live on the generated interface, which the map does not read: the count is the
  // project's own mapping either way, exactly as it was before the stub was introduced.
  assert.deepEqual(endpoints(withGenerated()), ['GET /status StatusController.status']);
  assert.deepEqual(endpoints(withoutGenerated()), ['GET /status StatusController.status']);
});
