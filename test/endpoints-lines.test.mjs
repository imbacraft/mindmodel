// Endpoint extraction, end to end from the dump: a mapping's path (its constants folded where the dump folded them, a
// visible `{?}` where it could not), overloads as separate facts, an inherited mapping served by the concrete class,
// a re-annotated override listed once, the JAX-RS application path, and an excluded deployable contributing nothing.
// The Java lives on disk (test-support/fixtures/endpoints-lines); nothing here parses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dumpOfLayers, NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';
import { selectCatalogs, loadCatalogs } from '../engine/catalogs/catalog.mjs';
import { extractEndpoints } from '../engine/extract/endpoints.mjs';

test('endpoints: folded constants, overloads, inheritance, an unresolvable path and an excluded module', { skip: NO_ENGINE }, () => {
  const { model } = dumpOfLayers(['endpoints-lines']);
  const selected = selectCatalogs(loadCatalogs(), {
    imports: [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name)),
  });
  const facts = extractEndpoints(model, selected, { include: (p) => !p.includes('/gw/') });

  assert.deepEqual(
    facts
      .map((f) => [f.verb, f.path, f.handler, f.confidence])
      .sort((a, b) => a.join(' ').localeCompare(b.join(' '))),
    [
      ['GET', '/api/x', 'C.list', 'resolved'], // an overload: same path and name, a different fact
      ['GET', '/api/x', 'C.list', 'resolved'],
      ['GET', '/api/x1/{}', 'C.built', 'resolved'], // constants resolved through the model
      ['GET', '/api/{?}', 'C.unknown', 'unresolved'], // never a half-printed path, never an unbalanced brace
      ['GET', '/inherited/list', 'Sub.list', 'resolved'], // an override without an annotation keeps the mapping
      ['GET', '/inherited/remove', 'Sub.remove', 'resolved'], // an inherited method, served by the concrete class
      ['GET', '/inherited/save2', 'Sub.save', 'resolved'], // a re-annotated override, listed once
      ['GET', '/root/rest/a', 'R.get', 'resolved'], // JAX-RS app path applies to the JAX-RS resource
      ['POST', '/api/y', 'C.create', 'resolved'],
      ['POST', '/root/rest', 'R.post', 'resolved'],
      // `resolved`, not `inferred`: the resource imports `jakarta.ws.rs.Path` exactly, so no catalog hint is needed.
    ].sort((a, b) => a.join(' ').localeCompare(b.join(' '))),
  );
  // Facts sort by the file and line of the mapping that declares them.
  const order = facts.map((f) => [f.file, f.line]);
  const sorted = order.slice().sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
  assert.deepEqual(order, sorted, 'facts are in file order');

  // The base class holds the running method for `remove`, so the fact names it; an override runs in the controller.
  const inherited = facts.find((f) => f.handler === 'Sub.remove');
  assert.equal(inherited.declaredIn, 'demo.Base');
  assert.equal(inherited.evidence.length, 2);
  assert.match(inherited.evidence[0], /demo\/Base\.java:\d+$/);
  assert.match(inherited.evidence[1], /demo\/Base\.java:\d+-\d+#remove$/);
  assert.equal(facts.find((f) => f.handler === 'Sub.list').declaredIn, undefined);
  assert.equal(facts.filter((f) => f.handler === 'Sub.save').length, 1);
  assert.ok(!facts.some((f) => f.handlerFqn === 'demo.Base'), 'an abstract class contributes no endpoint of its own');
  assert.ok(!facts.some((f) => f.file.includes('/gw/')), 'excluded deployables contribute no facts');
  assert.ok(
    !facts.some((f) => f.file.startsWith('src/main/java/demo/') && f.path.startsWith('/root')),
    'Spring never takes the JAX-RS prefix',
  );
  assert.match(facts.find((f) => f.handler === 'C.unknown').why.join(';'), /unresolved constant Elsewhere.PATH/);
  assert.equal(new Set(facts.map((f) => f.id)).size, facts.length);
  const own = facts.find((f) => f.handler === 'C.list' && f.path === '/api/x');
  assert.match(own.id, /^endpoint:GET \/api\/x@demo\.C#list\/0$/);
});
