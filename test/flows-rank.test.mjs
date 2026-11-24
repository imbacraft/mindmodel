// The two rank signals added after the flow list shipped: visibility scales with the number of distinct frontend
// call sites, and a flow that writes an entity the facts give a lifecycle (a status set somewhere) moves a core object.
// Both are fact counts: the endpoint verb, the frontend's call sites, the lifecycle family. No method, type or path
// name is read for a rank. The fixture is Java source on disk (test-support/fixtures/flows-rank), dumped by the real
// engine and read back as a model — the same path a scan takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_WEIGHTS } from '../engine/extract/flows.mjs';
import { flowsOfLayers } from '../test-support/fixtures/flows-of-dump.mjs';
import { NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';

const SUPPORTING = ['flows-rank/supporting'];

test('a lifecycle-entity write outranks a supporting-row write of the same entry kind', { skip: NO_ENGINE }, () => {
  const { flows, flowOf, deep } = flowsOfLayers(SUPPORTING);
  const statusSets = deep.statusSets;
  // The lifecycle fact exists for Order and not for AuditRow — that is the whole input to the bonus.
  assert.ok(
    statusSets.some((s) => s.entity === 'Order'),
    `the lifecycle family found Order's status site: ${statusSets.map((s) => s.entity).join(', ')}`,
  );
  assert.ok(!statusSets.some((s) => s.entity === 'AuditRow'), 'AuditRow has no status site');
  const orders = flowOf('/orders');
  const audit = flowOf('/audit');
  assert.ok(orders && audit, `both endpoints are flows: ${flows.map((f) => f.entry.path).join(', ')}`);
  // Same entry kind, same one written entity: only the lifecycle fact separates them.
  assert.equal(orders.entry.kind, audit.entry.kind);
  assert.match(orders.why[0], /^entry POST \+3$/, orders.why[0]);
  assert.match(orders.why[1], /^entities 1 \(Order\) \+3$/, orders.why[1]);
  assert.match(audit.why[1], /^entities 1 \(AuditRow\) \+3$/, audit.why[1]);
  assert.match(orders.why.join(' | '), new RegExp(`core object Order \\+${FLOW_WEIGHTS.coreObject}`));
  assert.ok(!audit.why.some((w) => w.startsWith('core object')), audit.why.join(' | '));
  assert.equal(orders.score - audit.score, FLOW_WEIGHTS.coreObject);
  assert.ok(
    flows.indexOf(orders) < flows.indexOf(audit),
    `the lifecycle write ranks first: ${flows.map((f) => `${f.score} ${f.entry.path}`).join(', ')}`,
  );
});

test('visibility scales with distinct frontend call sites, and stops at four', { skip: NO_ENGINE }, () => {
  const sites = (n, file = 'web/src/orders/index.tsx', line0 = 10) =>
    Array.from({ length: n }, (_, i) => ({ path: '/orders', file, line: line0 + i }));
  const frontendOf = (paths) => flowsOfLayers(SUPPORTING, { frontendPaths: paths }).flowOf('/orders');

  const none = frontendOf([]);
  assert.ok(!none.why.some((w) => w.startsWith('frontend-called')), 'no frontend caller, no points');
  const one = frontendOf(sites(1));
  assert.match(one.why.join(' | '), /frontend-called \+4(?: \||$)/);
  // Two and three call sites: the middle rung.
  for (const n of [2, 3]) {
    const f = frontendOf(sites(n));
    const want = new RegExp(`frontend-called ${n} sites \\+${FLOW_WEIGHTS.frontendSpread}`);
    assert.match(f.why.join(' | '), want, `n=${n}`);
    assert.equal(f.score - none.score, FLOW_WEIGHTS.frontendSpread);
  }
  // Four and five: the cap, so a page count cannot run away with the rank.
  for (const n of [4, 5]) {
    const f = frontendOf(sites(n));
    assert.match(f.why.join(' | '), new RegExp(`frontend-called ${n} sites \\+${FLOW_WEIGHTS.frontendWide}`), `n=${n}`);
    assert.equal(f.score - none.score, FLOW_WEIGHTS.frontendWide);
  }
  // Two fetches on one page are one caller: the site is the file when the fact carries no line.
  const samePage = frontendOf(sites(2, 'web/src/orders/index.tsx').map(({ path, file }) => ({ path, file })));
  assert.match(samePage.why.join(' | '), /frontend-called \+4(?: \||$)/, 'one file, however many calls');
});
