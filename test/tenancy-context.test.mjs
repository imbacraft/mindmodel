// Task 2 of docs/engine-improvements.md: a request parameter is a tenant only when it is *stored into* a
// request/context holder. Being read off the request — a @PathVariable, a query parameter — is a foreign key in the
// path, and a child id named in controllers once became "the tenant" over the repository evidence.
//
// The fixtures are Java source only; they run through the same syntax index, model, catalogs and entity extractor the
// scan uses, and the linker stands in for Spoon by naming receiver types from declarations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { index } from './fixtures/syntax-java.mjs';
import { buildModel } from './fixtures/model-from-source.mjs';
import { linkCallsTyped } from '../engine/model/link-for-tests.mjs';
import { annotationIndex, loadCatalogs, selectCatalogs, typeIndex } from '../engine/catalogs/catalog.mjs';
import { entityFacts } from '../engine/extract/entities.mjs';
import { tenancyFacts } from '../engine/extract/tenancy.mjs';

const L = (...x) => x.join('\n');

const entity = (name, extra = '') =>
  L(
    'package shop;',
    'import jakarta.persistence.Entity;',
    'import jakarta.persistence.Id;',
    '@Entity',
    `public class ${name} {`,
    '  @Id',
    '  private Long id;',
    extra,
    '}',
  );

const GENERIC_READS = [
  'findByName(String name)',
  'findByLabel(String label)',
  'findByCode(String code)',
  'findByTitle(String title)',
  'findBySlug(String slug)',
  'findByOwner(String owner)',
  'findByGroup(String group)',
  'findByNote(String note)',
  'findByKind(String kind)',
];
// `keyed` reads filter by the key; the rest are generic. Ten reads per repository (findById plus the rest), so the
// keyed ones set the filter share the tenancy rule compares against MIN_FILTER_SHARE.
const repo = (name, entityName, key, keyed = 0) =>
  L(
    'package shop;',
    'import java.util.List;',
    'import java.util.Optional;',
    'import org.springframework.data.jpa.repository.JpaRepository;',
    `public interface ${name} extends JpaRepository<${entityName}, Long> {`,
    `  Optional<${entityName}> findById(Long id);`,
    ...GENERIC_READS.slice(0, 9 - keyed).map((m) => `  List<${entityName}> ${m};`),
    ...(key ? [`  List<${entityName}> findBy${key[0].toUpperCase() + key.slice(1)}(Long ${key});`] : []),
    ...(keyed > 1 && key ? [`  long countBy${key[0].toUpperCase() + key.slice(1)}(Long ${key});`] : []),
    '}',
  );

// Fixture A: 20 entities, 5 carry childId; controllers take it as a @PathVariable and a resolver names a `findChild`
// call on it — exactly what the old "named in request-scoped code" rule counted as a tenant. Never stored.
function fixtureA() {
  const files = {};
  for (let i = 1; i <= 20; i++) {
    const name = `Row${String(i).padStart(2, '0')}`;
    files[`src/main/java/shop/${name}.java`] = entity(name, i <= 5 ? '  private Long childId;' : '');
    const key = i <= 5 ? 'childId' : null;
    files[`src/main/java/shop/${name}Repo.java`] = repo(`${name}Repo`, name, key, key ? 1 : 0);
  }
  files['src/main/java/shop/ChildController.java'] = L(
    'package shop;',
    'import org.springframework.web.bind.annotation.GetMapping;',
    'import org.springframework.web.bind.annotation.PathVariable;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class ChildController {',
    '  private final Row01Repo rows;',
    '  public ChildController(Row01Repo rows) {',
    '    this.rows = rows;',
    '  }',
    '  @GetMapping("/children/{childId}")',
    '  public Object one(@PathVariable Long childId) {',
    '    return rows.findById(childId);',
    '  }',
    '}',
  );
  files['src/main/java/shop/GuardianController.java'] = L(
    'package shop;',
    'import org.springframework.web.bind.annotation.GetMapping;',
    'import org.springframework.web.bind.annotation.PathVariable;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class GuardianController {',
    '  private final Row02Repo rows;',
    '  public GuardianController(Row02Repo rows) {',
    '    this.rows = rows;',
    '  }',
    '  @GetMapping("/guardians/{childId}/rows")',
    '  public Object rows(@PathVariable Long childId) {',
    '    return rows.findByChildId(childId);',
    '  }',
    '}',
  );
  // The old rule's match: a type named for a resolver, calling a method named after the field's noun.
  files['src/main/java/shop/ChildResolver.java'] = L(
    'package shop;',
    'import jakarta.servlet.http.HttpServletRequest;',
    'public class ChildResolver {',
    '  private final Row03Repo rows;',
    '  public ChildResolver(Row03Repo rows) {',
    '    this.rows = rows;',
    '  }',
    '  public Object resolve(HttpServletRequest request) {',
    '    String childId = request.getParameter("childId");',
    '    return findChild(rows, Long.valueOf(childId));',
    '  }',
    '  private Object findChild(Row03Repo rows, Long id) {',
    '    return rows.findById(id);',
    '  }',
    '}',
  );
  return files;
}

// Fixture B: the key is set into a ThreadLocal holder by a filter, and only 20% of the keyed reads filter by it — the
// existing holder path must keep working on evidence the filter share alone would reject. (`tenantId` itself is not a
// candidate at all: NOT_A_KEY excludes every `tenant\w*Id` field, so this fixture uses the name hertzbeat uses.)
function fixtureB() {
  const files = {};
  for (let i = 1; i <= 20; i++) {
    const name = `Row${String(i).padStart(2, '0')}`;
    files[`src/main/java/shop/${name}.java`] = entity(name, i <= 5 ? '  private Long workspaceId;' : '');
    const key = i <= 5 ? 'workspaceId' : null;
    files[`src/main/java/shop/${name}Repo.java`] = repo(`${name}Repo`, name, key, key ? 2 : 0);
  }
  files['src/main/java/shop/WorkspaceContext.java'] = L(
    'package shop;',
    'public class WorkspaceContext {',
    '  private static final ThreadLocal<Long> CURRENT_WORKSPACE = new ThreadLocal<>();',
    '  public void setWorkspace(Long id) {',
    '    CURRENT_WORKSPACE.set(id);',
    '  }',
    '  public Long currentWorkspace() {',
    '    return CURRENT_WORKSPACE.get();',
    '  }',
    '}',
  );
  // The holder is injected, not called statically: the fixture's linker resolves a receiver through its declared type,
  // the way the dump's recv.type does, and a static call's receiver is a type name it does not carry.
  files['src/main/java/shop/WorkspaceFilter.java'] = L(
    'package shop;',
    'import jakarta.servlet.Filter;',
    'import jakarta.servlet.http.HttpServletRequest;',
    'public class WorkspaceFilter implements Filter {',
    '  private final WorkspaceContext holder;',
    '  public WorkspaceFilter(WorkspaceContext holder) {',
    '    this.holder = holder;',
    '  }',
    '  public void doFilter(HttpServletRequest request) {',
    '    Long workspaceId = Long.valueOf(request.getHeader("X-Workspace"));',
    '    holder.setWorkspace(workspaceId);',
    '  }',
    '}',
  );
  return files;
}

// Fixture C: the key is stored through a wrapper helper — `setupForSubscription(Long subscriptionId)` gets the key,
// builds a context object around it and hands that to a ThreadLocal setter. Reading the key is not storing it, but
// flowing it into a chain that ends in a store is, whether it is passed directly or wrapped.
function fixtureC() {
  const files = {};
  for (let i = 1; i <= 20; i++) {
    const name = `Row${String(i).padStart(2, '0')}`;
    files[`src/main/java/shop/${name}.java`] = entity(name, i <= 5 ? '  private Long subscriptionId;' : '');
    const key = i <= 5 ? 'subscriptionId' : null;
    files[`src/main/java/shop/${name}Repo.java`] = repo(`${name}Repo`, name, key, key ? 2 : 0);
  }
  files['src/main/java/shop/ResolvedTenantContext.java'] = L(
    'package shop;',
    'public class ResolvedTenantContext {',
    '  private final Long subscriptionId;',
    '  public ResolvedTenantContext(Long subscriptionId) {',
    '    this.subscriptionId = subscriptionId;',
    '  }',
    '}',
  );
  files['src/main/java/shop/TenantContext.java'] = L(
    'package shop;',
    'public class TenantContext {',
    '  private final ThreadLocal<ResolvedTenantContext> RESOLVED = new ThreadLocal<>();',
    '  public void setResolvedContext(ResolvedTenantContext ctx) {',
    '    RESOLVED.set(ctx);',
    '  }',
    '}',
  );
  // The helper the app actually calls: the key arrives as a parameter and is wrapped in the stored object.
  files['src/main/java/shop/TenantContextSetup.java'] = L(
    'package shop;',
    'public class TenantContextSetup {',
    '  private final TenantContext context;',
    '  public TenantContextSetup(TenantContext context) {',
    '    this.context = context;',
    '  }',
    '  public void setupForSubscription(Long subscriptionId) {',
    '    context.setResolvedContext(new ResolvedTenantContext(subscriptionId));',
    '  }',
    '}',
  );
  files['src/main/java/shop/Subscription.java'] = L(
    'package shop;',
    'public class Subscription {',
    '  public Long getSubscriptionId() {',
    '    return null;',
    '  }',
    '}',
  );
  files['src/main/java/shop/CalendarSyncJob.java'] = L(
    'package shop;',
    'public class CalendarSyncJob {',
    '  private final TenantContextSetup setup;',
    '  public CalendarSyncJob(TenantContextSetup setup) {',
    '    this.setup = setup;',
    '  }',
    '  public void run(Subscription subscription) {',
    '    setup.setupForSubscription(subscription.getSubscriptionId());',
    '  }',
    '}',
  );
  return files;
}

// One build: syntax -> model -> catalogs -> the entity extractor, exactly the order the scan uses.
function tenancyOf(files) {
  const model = buildModel(Object.entries(files).map(([p, text]) => ({ p, text, ix: index(text) })));
  linkCallsTyped(model);
  const imports = [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  const selected = selectCatalogs(loadCatalogs(), { imports });
  const entFacts = entityFacts(model, annotationIndex(selected), typeIndex(selected));
  return tenancyFacts(entFacts, { model });
}

test('fixture A: a child id read off the request is not a tenant key', () => {
  const tenancy = tenancyOf(fixtureA());
  // The counts the doc's fixture names, so the fixture is what it claims: 5 of 20 entities, 10% of the keyed reads.
  const childId = tenancy.candidates.find((c) => c.key === 'childId');
  assert.ok(childId, `childId is a candidate: ${tenancy.candidates.map((c) => c.key).join(', ')}`);
  assert.equal(childId.counts.entities, 5);
  assert.equal(childId.counts.of, 20);
  assert.equal(childId.counts.filteredMethods, 5);
  assert.equal(childId.counts.repoMethods, 50);
  assert.equal(childId.counts.filteredPercent, 10);
  assert.equal(childId.holder, null, `nothing stores childId in a holder: ${childId.holder}`);
  assert.equal(childId.passed, false, 'the filter share is the only evidence, and 10% is below the 50% cut');
  assert.match(childId.why.join(' | '), /never stored into a context holder/);
  // The digest's line for this app: no key at all.
  assert.equal(tenancy.key, null);
  assert.deepEqual(tenancy.coverage.withKey, []);
});

test('fixture B: the key stored into a ThreadLocal by a filter still wins on a 20% filter share', () => {
  const tenancy = tenancyOf(fixtureB());
  assert.equal(tenancy.key, 'workspaceId');
  const chosen = tenancy.candidates.find((c) => c.key === 'workspaceId');
  assert.equal(chosen.counts.filteredPercent, 20, 'below MIN_FILTER_SHARE, so only the holder can carry it');
  assert.equal(chosen.holder, 'WorkspaceFilter#doFilter', `the filter stores it: ${chosen.holder}`);
  assert.match(chosen.why.join(' | '), /stored into a request\/context holder by WorkspaceFilter#doFilter/);
  assert.deepEqual(tenancy.coverage.withKey, ['Row01', 'Row02', 'Row03', 'Row04', 'Row05']);
});

test('fixture C: a key stored through a wrapper helper into a ThreadLocal counts as a holder', () => {
  const tenancy = tenancyOf(fixtureC());
  const chosen = tenancy.candidates.find((c) => c.key === 'subscriptionId');
  assert.ok(chosen, `subscriptionId is a candidate: ${tenancy.candidates.map((c) => c.key).join(', ')}`);
  assert.equal(chosen.counts.filteredPercent, 20, 'below MIN_FILTER_SHARE, so only the holder can carry it');
  assert.equal(chosen.holder, 'TenantContextSetup#setupForSubscription');
  assert.equal(chosen.passed, true);
  assert.equal(tenancy.key, 'subscriptionId');
  assert.deepEqual(tenancy.coverage.withKey, ['Row01', 'Row02', 'Row03', 'Row04', 'Row05']);
});
