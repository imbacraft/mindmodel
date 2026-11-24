// The two rank signals added after the flow list shipped: visibility scales with the number of distinct frontend
// call sites, and a flow that writes an entity the facts give a lifecycle (a status set somewhere) moves a core object.
// Both are fact counts: the endpoint verb, the frontend's call sites, the lifecycle family. No method, type or path
// name is read for a rank. The fixtures are source only; the extractors run over them as they run over an app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { index } from './fixtures/syntax-java.mjs';
import { buildModel } from './fixtures/model-from-source.mjs';
import { linkCallsTyped } from '../engine/model/link-for-tests.mjs';
import { loadCatalogs, selectCatalogs } from '../engine/catalogs/catalog.mjs';
import { extractEndpoints } from '../engine/extract/endpoints.mjs';
import { extractState } from '../engine/extract/state.mjs';
import { extractOutside } from '../engine/extract/outside.mjs';
import { javaFacts } from '../engine/extract/lifecycle.mjs';
import { buildFlows, flowEntries, FLOW_WEIGHTS } from '../engine/extract/flows.mjs';

const L = (...x) => x.join('\n');

// Two POST endpoints, each writing exactly one entity. `Order` has a lifecycle (its status is set in a method the
// endpoint does not call); `AuditRow` is a supporting row with no status anywhere. Same entry kind, same breadth.
const SUPPORTING = {
  'src/main/java/rank/OrderStatus.java': L('package rank;', 'public enum OrderStatus {', '  NEW,', '  PAID', '}'),
  'src/main/java/rank/Order.java': L(
    'package rank;',
    'import jakarta.persistence.Entity;',
    'import jakarta.persistence.Id;',
    '@Entity',
    'public class Order {',
    '  @Id',
    '  private Long id;',
    '  private OrderStatus status;',
    '}',
  ),
  'src/main/java/rank/OrderRepo.java': L(
    'package rank;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'public interface OrderRepo extends JpaRepository<Order, Long> { }',
  ),
  'src/main/java/rank/OrderService.java': L(
    'package rank;',
    'import org.springframework.stereotype.Service;',
    '@Service',
    'public class OrderService {',
    '  private final OrderRepo repo;',
    '  public OrderService(OrderRepo repo) {',
    '    this.repo = repo;',
    '  }',
    '  public void create(Order o) {',
    '    repo.save(o);',
    '  }',
    '  public void markPaid(Long id) {',
    '    Order o = repo.findById(id).orElseThrow();',
    '    o.setStatus(OrderStatus.PAID);',
    '    repo.save(o);',
    '  }',
    '}',
  ),
  'src/main/java/rank/OrderController.java': L(
    'package rank;',
    'import org.springframework.web.bind.annotation.PostMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class OrderController {',
    '  private final OrderService service;',
    '  public OrderController(OrderService service) {',
    '    this.service = service;',
    '  }',
    '  @PostMapping("/orders")',
    '  public void create(Order o) {',
    '    service.create(o);',
    '  }',
    '}',
  ),
  'src/main/java/rank/AuditRow.java': L(
    'package rank;',
    'import jakarta.persistence.Entity;',
    'import jakarta.persistence.Id;',
    '@Entity',
    'public class AuditRow {',
    '  @Id',
    '  private Long id;',
    '}',
  ),
  'src/main/java/rank/AuditRepo.java': L(
    'package rank;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'public interface AuditRepo extends JpaRepository<AuditRow, Long> { }',
  ),
  'src/main/java/rank/AuditController.java': L(
    'package rank;',
    'import org.springframework.web.bind.annotation.PostMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class AuditController {',
    '  private final AuditRepo repo;',
    '  public AuditController(AuditRepo repo) {',
    '    this.repo = repo;',
    '  }',
    '  @PostMapping("/audit")',
    '  public void write(AuditRow row) {',
    '    repo.save(row);',
    '  }',
    '}',
  ),
};

// One build, the order scan.mjs uses: syntax -> model -> catalogs -> the real extractors -> the rank.
function build(files, { frontendPaths = [] } = {}) {
  const model = buildModel(Object.entries(files).map(([p, text]) => ({ p, text, ix: index(text) })));
  linkCallsTyped(model);
  const imports = [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  const selected = selectCatalogs(loadCatalogs(), { imports });
  const endpoints = extractEndpoints(model, selected);
  const stateWrites = extractState(model, selected).filter((f) => f.family === 'state-write');
  const outsideCalls = extractOutside(model, selected);
  const types = [...model.types.values()];
  const entities = types
    .filter((t) => (t.ann ?? []).some((a) => /(?:^|\.)Entity$/.test(a.fqn ?? '')))
    .map((t) => ({
      name: t.name,
      fields: (t.fields ?? []).map((f) => ({ name: f.name, type: String(f.type ?? '').replace(/<.*/, '').split('.').pop() })),
    }));
  const enums = types
    .filter((t) => t.kind === 'enum')
    .map((t) => ({ name: t.name, file: t.file, line: t.start, values: t.enumValues ?? t.constants ?? [] }));
  const java = types.map((t) => ({
    p: t.file,
    name: t.name,
    kind: t.kind,
    methods: t.methods,
    fields: t.fields ?? [],
    ix: {},
    text: files[t.file],
  }));
  const deep = javaFacts({
    java,
    repoEntity: new Map(),
    enums,
    entities,
    shortlist: new Set(entities.map((e) => e.name)),
  });
  const flows = buildFlows(model, {
    entries: flowEntries(model, endpoints, selected),
    stateWrites,
    outsideCalls,
    statusSets: deep.statusSets,
    entities: entities.map((e) => ({ name: e.name, refs: 0 })),
    activityOf: () => 0,
    selected,
    exactTargets: true,
    frontendPaths,
  });
  return { flows, flowOf: (path) => flows.find((f) => f.entry.path === path), statusSets: deep.statusSets };
}

test('a lifecycle-entity write outranks a supporting-row write of the same entry kind', () => {
  const { flows, flowOf, statusSets } = build(SUPPORTING);
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

test('visibility scales with distinct frontend call sites, and stops at four', () => {
  const sites = (n, file = 'web/src/orders/index.tsx', line0 = 10) =>
    Array.from({ length: n }, (_, i) => ({ path: '/orders', file, line: line0 + i }));
  const frontendOf = (paths) => build(SUPPORTING, { frontendPaths: paths }).flowOf('/orders');

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
