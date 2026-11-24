// Task 1 of docs/engine-improvements.md, end to end: the flow trace follows `super.m(...)` into a generic base class
// with the subclass's type arguments, follows a port call to its only implementation, and weights a status change a
// flow performs. The fixtures are source only — the extractor runs over them exactly as it runs over an app, and the
// linker stands in for Spoon by naming declarations, never implementations.
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
import { buildFlows, flowEntries } from '../engine/extract/flows.mjs';

const L = (...x) => x.join('\n');

// The voucher publish flow: a generic base that sets the status and writes through a typed repository.
const BASE = {
  'src/main/java/shop/VoucherStatus.java': L('package shop;', 'public enum VoucherStatus {', '  DRAFT,', '  REVIEW,', '  PUBLISHED', '}'),
  'src/main/java/shop/Voucher.java': L(
    'package shop;',
    'import jakarta.persistence.Entity;',
    'import jakarta.persistence.Id;',
    '@Entity',
    'public class Voucher {',
    '  @Id',
    '  private Long id;',
    '  private VoucherStatus status;',
    '  private String code;',
    '}',
  ),
  'src/main/java/shop/GenericRepo.java': L(
    'package shop;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'public interface GenericRepo<T> extends JpaRepository<T, Long> { }',
  ),
  'src/main/java/shop/AbstractVersionService.java': L(
    'package shop;',
    'public abstract class AbstractVersionService<T> {',
    '  private final GenericRepo<T> repo;',
    '  protected AbstractVersionService(GenericRepo<T> repo) {',
    '    this.repo = repo;',
    '  }',
    '  public void publish(Long id) {',
    '    T row = repo.findById(id).orElseThrow();',
    '    row.setStatus(VoucherStatus.PUBLISHED);',
    '    repo.save(row);',
    '  }',
    '}',
  ),
  'src/main/java/shop/VoucherService.java': L(
    'package shop;',
    'import org.springframework.stereotype.Service;',
    '@Service',
    'public class VoucherService extends AbstractVersionService<Voucher> {',
    '  public VoucherService(GenericRepo<Voucher> repo) {',
    '    super(repo);',
    '  }',
    '  @Override',
    '  public void publish(Long id) {',
    '    super.publish(id);',
    '  }',
    '}',
  ),
  'src/main/java/shop/VoucherController.java': L(
    'package shop;',
    'import org.springframework.web.bind.annotation.PathVariable;',
    'import org.springframework.web.bind.annotation.PutMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class VoucherController {',
    '  private final VoucherService service;',
    '  public VoucherController(VoucherService service) {',
    '    this.service = service;',
    '  }',
    '  @PutMapping("/vouchers/{id}/publish")',
    '  public void publish(@PathVariable Long id) {',
    '    service.publish(id);',
    '  }',
    '}',
  ),
};

// Fixture B: the port and its contract service, which books the contract to an outside system.
const PORT = {
  'src/main/java/shop/Contract.java': L(
    'package shop;',
    'import jakarta.persistence.Entity;',
    'import jakarta.persistence.Id;',
    '@Entity',
    'public class Contract {',
    '  @Id',
    '  private Long id;',
    '  private Long voucherId;',
    '  public Contract(Long voucherId) {',
    '    this.voucherId = voucherId;',
    '  }',
    '}',
  ),
  'src/main/java/shop/ContractRepo.java': L(
    'package shop;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'public interface ContractRepo extends JpaRepository<Contract, Long> { }',
  ),
  'src/main/java/shop/ContractPort.java': L(
    'package shop;',
    'public interface ContractPort {',
    '  void publish(Long voucherId);',
    '}',
  ),
  'src/main/java/shop/ContractService.java': L(
    'package shop;',
    'import org.springframework.stereotype.Service;',
    'import org.springframework.web.client.RestTemplate;',
    '@Service',
    'public class ContractService implements ContractPort {',
    '  private final ContractRepo repo;',
    '  private final RestTemplate restTemplate;',
    '  public ContractService(ContractRepo repo, RestTemplate restTemplate) {',
    '    this.repo = repo;',
    '    this.restTemplate = restTemplate;',
    '  }',
    '  public void publish(Long voucherId) {',
    '    repo.save(new Contract(voucherId));',
    '    restTemplate.postForEntity("https://billing.example/contracts", voucherId, Void.class);',
    '  }',
    '}',
  ),
};

// Fixture C: a plain CRUD endpoint, called by the SPA, writing three entities and setting no status.
const CRUD = {
  'src/main/java/shop/Item.java': L('package shop;', 'import jakarta.persistence.Entity;', '@Entity', 'public class Item { }'),
  'src/main/java/shop/Tag.java': L('package shop;', 'import jakarta.persistence.Entity;', '@Entity', 'public class Tag { }'),
  'src/main/java/shop/Note.java': L('package shop;', 'import jakarta.persistence.Entity;', '@Entity', 'public class Note { }'),
  'src/main/java/shop/ItemRepo.java': L(
    'package shop;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'public interface ItemRepo extends JpaRepository<Item, Long> { }',
  ),
  'src/main/java/shop/TagRepo.java': L(
    'package shop;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'public interface TagRepo extends JpaRepository<Tag, Long> { }',
  ),
  'src/main/java/shop/NoteRepo.java': L(
    'package shop;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'public interface NoteRepo extends JpaRepository<Note, Long> { }',
  ),
  'src/main/java/shop/CatalogController.java': L(
    'package shop;',
    'import org.springframework.web.bind.annotation.PostMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class CatalogController {',
    '  private final ItemRepo items;',
    '  private final TagRepo tags;',
    '  private final NoteRepo notes;',
    '  public CatalogController(ItemRepo items, TagRepo tags, NoteRepo notes) {',
    '    this.items = items;',
    '    this.tags = tags;',
    '    this.notes = notes;',
    '  }',
    '  @PostMapping("/items")',
    '  public void create(Item item) {',
    '    items.save(item);',
    '    tags.save(new Tag());',
    '    notes.save(new Note());',
    '  }',
    '}',
  ),
};

// Test D (below) needs the branch facts the engine's dump would carry; until the dump writes them, this file derives
// them from the same source with the same vendored grammar: the line ranges of if/else arms, switch groups and catch
// bodies. The condition expression is never an arm, so a call written in an `if (...)` test stays unconditional.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from '../engine/vendor/tree-sitter/web-tree-sitter.mjs';

await Parser.init();
const parser = new Parser();
parser.setLanguage(
  await Language.load(path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/vendor/tree-sitter/tree-sitter-java.wasm')),
);

function branchArms(text) {
  const tree = parser.parse(text);
  const arms = [];
  const push = (node, kind) => {
    if (node) arms.push({ start: node.startPosition.row + 1, end: node.endPosition.row + 1, kind });
  };
  const walk = (node) => {
    if (node.type === 'if_statement') {
      push(node.childForFieldName('consequence'), 'if');
      push(node.childForFieldName('alternative'), 'else');
    } else if (node.type === 'catch_clause') {
      push(
        node.namedChildren.find((c) => c.type === 'block'),
        'catch',
      );
    } else if (node.type === 'switch_block_statement_group' || node.type === 'switch_rule') push(node, 'switch');
    for (const child of node.namedChildren) walk(child);
  };
  walk(tree.rootNode);
  tree.delete();
  return arms;
}

// The dump's `branches` on each method: every arm that lies wholly inside the method's line range.
function attachBranches(model, files) {
  for (const t of model.types.values()) {
    const text = files[t.file];
    if (!text) continue;
    const arms = branchArms(text);
    for (const m of t.methods) {
      const inner = arms.filter((a) => m.start <= a.start && a.end <= m.end);
      if (inner.length) m.branches = inner;
    }
  }
}

// One build: syntax -> model -> catalogs -> the real extractors, exactly the order scan.mjs uses.
function build(files, { frontendPaths = [], branches = false } = {}) {
  const model = buildModel(Object.entries(files).map(([p, text]) => ({ p, text, ix: index(text) })));
  linkCallsTyped(model);
  // Branch facts must be on the model before the walk reads them, exactly as the dump supplies them before the scan.
  if (branches) attachBranches(model, files);
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
  // The scanner hands the lifecycle family model methods (with ids), fields and the source text.
  const entries = types.map((t) => ({
    p: t.file,
    name: t.name,
    kind: t.kind,
    methods: t.methods,
    fields: t.fields ?? [],
    ix: {},
    text: files[t.file],
  }));
  const deep = javaFacts({
    java: entries,
    repoEntity: new Map(),
    enums,
    entities,
    shortlist: new Set(entities.map((e) => e.name)),
  });
  // Centrality counts the types that refer to an entity, as entities.mjs does; a fixture is far below the threshold.
  const refs = (name) =>
    types.filter((t) => (t.fields ?? []).some((f) => String(f.typeFqn ?? '').split('.').pop() === name)).length;
  const flows = buildFlows(model, {
    entries: flowEntries(model, endpoints, selected),
    stateWrites,
    outsideCalls,
    statusSets: deep.statusSets,
    entities: entities.map((e) => ({ name: e.name, refs: refs(e.name) })),
    activityOf: () => 0,
    selected,
    exactTargets: true,
    frontendPaths,
  });
  const flowOf = (path) => flows.find((f) => f.entry.path === path);
  return { model, endpoints, deep, flows, flowOf };
}

test('fixture A: the trace follows super.publish into the generic base and names the subtype', () => {
  const { flows, flowOf, deep, model } = build(BASE);
  const publish = flowOf('/vouchers/{}/publish');
  assert.ok(publish, `the publish endpoint is a flow: ${flows.map((f) => f.entry.path).join(', ')}`);
  // The base's `GenericRepo<T>.save` is a write of the entity the subclass binds.
  assert.ok(publish.steps.includes('writes Voucher'), publish.steps.join('; '));
  assert.match(publish.why.join(' | '), /entities 1 \(Voucher\) \+3/);
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
});

test('fixture B: a port with one implementation is followed; with a second, it is not', () => {
  const withPort = {
    ...BASE,
    'src/main/java/shop/VoucherService.java': L(
      'package shop;',
      'import org.springframework.stereotype.Service;',
      '@Service',
      'public class VoucherService extends AbstractVersionService<Voucher> {',
      '  private final ContractPort contractPort;',
      '  public VoucherService(GenericRepo<Voucher> repo, ContractPort contractPort) {',
      '    super(repo);',
      '    this.contractPort = contractPort;',
      '  }',
      '  @Override',
      '  public void publish(Long id) {',
      '    super.publish(id);',
      '    contractPort.publish(id);',
      '  }',
      '}',
    ),
    ...PORT,
  };
  const one = build(withPort);
  const publish = one.flowOf('/vouchers/{}/publish');
  assert.ok(publish.steps.includes('writes Contract'), `one implementation is followed: ${publish.steps.join('; ')}`);
  assert.ok(publish.steps.includes('writes Voucher'), publish.steps.join('; '));
  assert.match(publish.why.join(' | '), /entities 2 \(Voucher, Contract\) \+4/);
  assert.match(publish.why.join(' | '), /outside 1 \+3/);

  // A second implementation of the same port: which one runs is no longer a fact, so the walk stops at the port.
  const two = build({
    ...withPort,
    'src/main/java/shop/LegacyContractService.java': L(
      'package shop;',
      'import org.springframework.stereotype.Service;',
      '@Service',
      'public class LegacyContractService implements ContractPort {',
      '  public void publish(Long voucherId) {',
      '    log(voucherId);',
      '  }',
      '  private void log(Long voucherId) { }',
      '}',
    ),
  });
  const ambiguous = two.flowOf('/vouchers/{}/publish');
  assert.ok(ambiguous, 'the publish endpoint is still a flow');
  assert.ok(!ambiguous.steps.includes('writes Contract'), `two implementations are not followed: ${ambiguous.steps.join('; ')}`);
  assert.ok(
    !ambiguous.steps.some((s) => /^(?:ContractService|LegacyContractService)#/.test(s)),
    `neither implementation is guessed: ${ambiguous.steps.join('; ')}`,
  );
  assert.ok(!ambiguous.why.some((w) => w.startsWith('outside')), ambiguous.why.join(' | '));
});

test('fixture C: a plain CRUD sweep called by the SPA ranks below the publish flow', () => {
  const { flows, flowOf } = build(
    {
      ...BASE,
      ...PORT,
      ...CRUD,
      'src/main/java/shop/VoucherService.java': L(
        'package shop;',
        'import org.springframework.stereotype.Service;',
        '@Service',
        'public class VoucherService extends AbstractVersionService<Voucher> {',
        '  private final ContractPort contractPort;',
        '  public VoucherService(GenericRepo<Voucher> repo, ContractPort contractPort) {',
        '    super(repo);',
        '    this.contractPort = contractPort;',
        '  }',
        '  @Override',
        '  public void publish(Long id) {',
        '    super.publish(id);',
        '    contractPort.publish(id);',
        '  }',
        '}',
      ),
    },
    { frontendPaths: [{ path: '/items', file: 'web/src/catalog/items.jsx' }] },
  );
  const publish = flowOf('/vouchers/{}/publish');
  const crud = flowOf('/items');
  assert.ok(crud, `the CRUD endpoint is a flow: ${flows.map((f) => f.entry.path).join(', ')}`);
  assert.match(crud.why.join(' | '), /frontend-called \+4/);
  assert.match(crud.why.join(' | '), /entities 3 \(Item, Tag, Note\) \+5/);
  assert.ok(!crud.why.some((w) => w.startsWith('status')), 'no status change in the CRUD flow');
  assert.ok(
    flows.indexOf(publish) < flows.indexOf(crud),
    `publish (${publish.score}) must outrank the CRUD sweep (${crud.score}): ${flows
      .slice(0, 4)
      .map((f) => `${f.score} ${f.entry.path}`)
      .join(', ')}`,
  );
});

// Fixture D: the entry saves unconditionally and charges only inside `if (flag)`. With the arm's line range on the
// method, the charge is conditional and counts at half weight (3 -> 1, rounded down); the save does not change.
const CHARGE = {
  'src/main/java/shop/Item.java': L(
    'package shop;',
    'import jakarta.persistence.Entity;',
    'import jakarta.persistence.Id;',
    '@Entity',
    'public class Item {',
    '  @Id',
    '  private Long id;',
    '}',
  ),
  'src/main/java/shop/ItemRepo.java': L(
    'package shop;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    'public interface ItemRepo extends JpaRepository<Item, Long> { }',
  ),
  'src/main/java/shop/OrderController.java': L(
    'package shop;',
    'import org.springframework.web.bind.annotation.PostMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    'import org.springframework.web.client.RestTemplate;',
    '@RestController',
    'public class OrderController {',
    '  private final ItemRepo items;',
    '  private final RestTemplate restTemplate;',
    '  public OrderController(ItemRepo items, RestTemplate restTemplate) {',
    '    this.items = items;',
    '    this.restTemplate = restTemplate;',
    '  }',
    '  @PostMapping("/items")',
    '  public void create(Item item, boolean flag) {',
    '    items.save(item);',
    '    if (flag) {',
    '      restTemplate.postForEntity("https://billing.example/charge", item, Void.class);',
    '    }',
    '  }',
    '}',
  ),
};

test('fixture D: an effect only an if arm reaches is conditional and weighs half', () => {
  const { flowOf } = build(CHARGE);
  const flow = flowOf('/items');
  assert.ok(flow, 'the endpoint is a flow');
  const save = flow.effects.find((e) => e.kind === 'entity');
  const charge = flow.effects.find((e) => e.kind === 'outside');
  assert.ok(save && charge, flow.effects.map((e) => e.label).join(', '));

  // Today, with no branch fact: both effects are unconditional and the score is the full 3 + 3 + 3.
  assert.ok(!save.conditional && !charge.conditional);
  assert.ok(!JSON.stringify(flow).includes('conditional'), 'a flow with no branch facts says nothing about branches');
  assert.deepEqual(flow.why, ['entry POST +3', 'entities 1 (Item) +3', 'outside 1 +3']);
  assert.equal(flow.score, 9);

  // The same app, with the arm the dump would write: only the charge is behind the decision.
  const arm = build(CHARGE, { branches: true }).flowOf('/items');
  const armSave = arm.effects.find((e) => e.kind === 'entity');
  const armCharge = arm.effects.find((e) => e.kind === 'outside');
  assert.equal(armCharge.conditional, true, 'the charge is inside `if (flag)`');
  assert.equal(armCharge.label, 'HTTP postForEntity() (conditional)');
  assert.ok(!armSave.conditional, 'the save is on the default path');
  assert.equal(armSave.label, 'writes Item');
  // Half of the outside-call weight (3), rounded down, and the fact says so in the score's own words.
  assert.deepEqual(arm.why, ['entry POST +3', 'entities 1 (Item) +3', 'outside 1 +1, 1 conditional']);
  assert.equal(arm.score, 7);
  assert.ok(arm.steps.includes('HTTP postForEntity() (conditional)'), arm.steps.join('; '));
});

test('fixture D2: an effect reached both conditionally and unconditionally is not conditional', () => {
  // The charge is called on the default path and again inside an arm: some path always runs it, so it keeps full
  // weight. The guard is an early return, the shape a service uses far more often than if/else.
  const both = {
    ...CHARGE,
    'src/main/java/shop/OrderController.java': L(
      'package shop;',
      'import org.springframework.web.bind.annotation.PostMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      'import org.springframework.web.client.RestTemplate;',
      '@RestController',
      'public class OrderController {',
      '  private final ItemRepo items;',
      '  private final RestTemplate restTemplate;',
      '  public OrderController(ItemRepo items, RestTemplate restTemplate) {',
      '    this.items = items;',
      '    this.restTemplate = restTemplate;',
      '  }',
      '  @PostMapping("/items")',
      '  public void create(Item item, boolean flag) {',
      '    items.save(item);',
      '    restTemplate.postForEntity("https://billing.example/charge", item, Void.class);',
      '    if (flag) {',
      '      restTemplate.postForEntity("https://billing.example/charge", item, Void.class);',
      '    }',
      '  }',
      '}',
    ),
  };
  const flow = build(both, { branches: true }).flowOf('/items');
  const outside = flow.effects.filter((e) => e.kind === 'outside');
  assert.equal(outside.length, 2, 'two call sites are two effects, and the score counts the one client target once');
  assert.ok(outside.every((e) => !e.conditional), 'one unconditional site makes the effect unconditional');
  assert.ok(!JSON.stringify(flow).includes('(conditional)'), flow.effects.map((e) => e.label).join(', '));
  assert.deepEqual(flow.why, ['entry POST +3', 'entities 1 (Item) +3', 'outside 1 +3']);
  assert.equal(flow.score, 9);
});
