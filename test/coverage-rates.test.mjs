// Coverage rates, end to end from the dump: what the engine understood and what it did not, computed from the model
// the scan built. The Java lives on disk (test-support/fixtures/coverage-rates) and is dumped by the real engine; the
// facts, catalogs and build files are plain inputs a scan also supplies.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dumpOfLayers, NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';
import { coverage } from '../engine/checks/coverage.mjs';

const coverageLine = (cov) => cov.line;

test('coverage: the rates, the blind spots it reports and the ones it stays quiet about', { skip: NO_ENGINE }, () => {
  const { model } = dumpOfLayers(['coverage-rates']);
  model.degraded = new Set();
  const selected = [
    {
      catalog: {
        id: 'spring-web',
        when: { deps: ['org.springframework.boot:spring-boot-starter-web'] },
        annotations: [
          { fqn: 'org.springframework.web.bind.annotation.GetMapping', means: 'endpoint', verb: 'GET' },
          { fqn: 'org.springframework.web.bind.annotation.RestController', means: 'controller' },
        ],
      },
      why: 'test',
    },
    {
      catalog: {
        id: 'lombok',
        when: { deps: ['org.projectlombok:lombok'] },
        annotations: [{ fqn: 'lombok.Builder.Default', means: 'ignore' }],
        types: [{ fqn: 'org.springframework.data.jpa.repository.JpaRepository', means: 'repository' }],
      },
      why: 'test',
    },
  ];
  const facts = [
    { family: 'endpoint', handler: 'C.get', path: '/x' },
    { family: 'endpoint', handler: 'C.other', path: '/' },
  ];
  const build = [
    { file: 'pom.xml', group: 'a', deps: [{ group: 'com.nobody', artifact: 'thing' }, { group: 'org.projectlombok', artifact: 'lombok' }] },
    { file: 'pom.xml', group: 'a', deps: [{ group: 'a', artifact: 'a-core' }, { group: 'com.unused', artifact: 'lib' }] },
  ];
  const rels = [
    'src/main/java/a/C.java',
    'src/main/java/a/UsesThing.java',
    'web/app.kt',
    'web/build.gradle',
    'tools/t.groovy',
  ];
  const cov = coverage(model, facts, selected, { build, rels });
  const pct = Object.fromEntries(cov.rates.map((r) => [r.id, r.percent]));
  assert.equal(pct['supertypes resolved'], 100); // a.repo.Base resolves through the fixture's import
  assert.equal(pct['endpoints with a fully resolved path'], 100); // both fixture facts name no constant
  // Rates that are 100% by construction are gone: they measure nothing.
  assert.ok(!cov.rates.some((r) => r.id === 'endpoints with a handler' || r.id === 'endpoints with a path'));
  // 11 meaningful annotations; CompanyThing (5 uses) is the only one nobody explains. Builder.Default resolves to
  // lombok.Builder.Default through its owner, and D's unimported GetMapping still matches the one catalog that has it.
  // Rare (2 uses) is below the reporting threshold and stays out of the blind-spot list.
  assert.deepStrictEqual(
    [pct['annotations understood'], cov.rates.find((r) => r.id === 'annotations understood').denominator],
    [36, 11],
  );
  assert.deepStrictEqual(
    cov.unknownAnnotations.map((u) => [u.name, u.count, u.types]),
    [['CompanyThing', 5, 1]],
  );
  // A JDK/Jakarta base is not a blind spot; a library base is, once three types extend it.
  assert.deepStrictEqual(cov.unknownBaseClasses.map((b) => [b.name, b.count]), [['a.repo.Base', 3]]);
  // The project's own module is not a dependency, Lombok is catalogued, and `com.nobody:thing` is imported by a file.
  // `com.unused:lib` is declared but imported nowhere, so it is counted, not listed: ranking is by use.
  assert.deepStrictEqual(cov.uncataloguedDependencies.map((d) => [d.coordinate, d.files]), [['com.nobody:thing', 1]]);
  assert.equal(cov.uncataloguedDependenciesTotal, 2);
  assert.deepStrictEqual(cov.unparsedLanguages, { kotlin: 1, groovy: 1, scala: 0 });
  assert.match(coverageLine(cov), /annotations understood 36% \(4\/11\)/);
  // The digest line names the blind spots, not just the rates: a writer can act on a name.
  assert.match(coverageLine(cov), /unknown base classes 1/);
  assert.match(coverageLine(cov), /uncatalogued deps 2/);
  // Ambiguous targets is its own rate (§6.1): it exists even at zero, and the digest only prints it when non-zero.
  const amb = cov.rates.find((r) => r.id === 'ambiguous targets');
  assert.ok(amb, 'ambiguous targets is a rate');
  assert.equal(amb.denominator, cov.rates.find((r) => r.id === 'project targets').denominator);
  assert.doesNotMatch(coverageLine(cov), /ambiguous targets/);
});
