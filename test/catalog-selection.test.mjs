// Task 10: a Spring app that injects with javax.inject must not report @Inject as an unknown annotation. The cdi
// catalog spells every FQN both ways (jakarta.inject.Inject / javax.inject.Inject), but its `when` rule named only the
// jakarta packages, so the catalog was never selected for an app on javax.inject: the resolved FQN was missing from
// the index, and the simple-name fallback — which deliberately consults the *selected* catalogs only — found nothing.
//
// The `jakarta.annotation.`/`javax.annotation.` packages are deliberately not in that rule: `ejb.json` claims them and
// the two catalogs disagree about the meaning (@PostConstruct is `startup` there, `lifecycle` here), so a Spring app
// that merely imports `javax.annotation.concurrent.ThreadSafe` would flip @PostConstruct's meaning by selecting cdi.
// Both entries stay reachable — once cdi is selected for javax.inject, `javax.annotation.PostConstruct` is in its index
// (the fixture below uses it), and an EE app selects them through ejb.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotationIndex, loadCatalogs, meanOf, selectCatalogs, simpleMeans } from '../engine/catalogs/catalog.mjs';
import { cachedFixtureScan } from '../test-support/scan-cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const jar = process.env.MINDMODEL_ENGINE_JAR ?? path.join(path.dirname(here), 'engine-java/target/mindmodel-engine.jar');
const skip = fs.existsSync(jar) ? false : 'engine jar not built (mvn -f engine-java/pom.xml package)';

const catalogs = loadCatalogs();
const cdi = (opts) => selectCatalogs(catalogs, opts).some((s) => s.catalog.id === 'cdi');

test('cdi is selected by either spelling of its dependencies', () => {
  for (const dep of [
    'jakarta.enterprise:jakarta.enterprise.cdi-api',
    'jakarta.platform:jakarta.jakartaee-api',
    'javax.inject:javax.inject',
    'javax.enterprise:cdi-api',
    'javax:javaee-api',
  ])
    assert.ok(cdi({ deps: [dep] }), `dep ${dep} selects cdi`);
});

test('cdi is selected by either spelling of its packages', () => {
  for (const imp of [
    'jakarta.inject.Inject',
    'jakarta.enterprise.inject.Produces',
    'jakarta.interceptor.Interceptor',
    'javax.inject.Inject',
    'javax.enterprise.inject.Produces',
    'javax.interceptor.Interceptor',
    'javax.decorator.Decorator',
  ])
    assert.ok(cdi({ imports: [imp] }), `import ${imp} selects cdi`);
});

test('Inject resolves by FQN and, when unresolved, by simple name', () => {
  const index = annotationIndex(selectCatalogs(catalogs, { imports: ['javax.inject.Inject'] }));
  assert.equal(meanOf(index, 'javax.inject.Inject', 'field')?.means, 'injected');
  // The wildcard case: `import javax.inject.*;` plus `@Inject` has no FQN, so coverage asks by simple name.
  assert.ok(simpleMeans(index, 'Inject', 'field').length >= 1);
});

test('a Spring app on javax.inject reports no unknown Inject', { skip }, () => {
  const facts = cachedFixtureScan('inject-app');
  assert.equal(facts.runtime.engine.spoon, true, 'the fixture is scanned with the engine dump');
  const unknown = facts.coverage.unknownAnnotations.map((u) => u.name);
  assert.deepStrictEqual(
    unknown.filter((n) => n === 'Inject' || n.endsWith('.Inject')),
    [],
  );
  // Every annotation the fixture uses — @Service, @Inject (imported and wildcard), @PostConstruct — has a meaning.
  const all = facts.coverage.rates.find((r) => r.id === 'annotations understood');
  assert.deepStrictEqual([all.numerator, all.denominator], [9, 9]);
});
