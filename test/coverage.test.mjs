// Coverage must be honest about itself: sane rates, blind spots with samples, the same answer twice, and no drop
// against the accepted baseline. The baseline (test/baselines/coverage.json) is committed and small: rates as
// numerator/denominator/percent, and the sizes of the blind-spot lists. UPDATE=1 rewrites it (the owner accepts it).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../engine/scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'apps.json'), 'utf8'));
const root = (process.env.MINDMODEL_TEST_APPS ?? cfg.root).replace(/^~/, os.homedir());
const baselineFile = path.join(here, 'baselines/coverage.json');
const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};

// Annotations the shipped catalogs explain. If one of these ever shows up as unknown, a catalog stopped being
// selected (a build file the reader cannot read, an import the model cannot resolve): that is the regression this
// test exists to catch, and it is what makes the unknown list trustworthy.
const MUST_KNOW = new Set([
  // JPA / Hibernate
  'Column', 'Entity', 'Table', 'Id', 'Embedded', 'EmbeddedId', 'JoinColumn', 'ManyToOne', 'OneToMany', 'Version',
  // Lombok
  'Data', 'Builder', 'RequiredArgsConstructor', 'AllArgsConstructor', 'NoArgsConstructor', 'Getter', 'Setter', 'Value',
  // Spring core / web / tx
  'Component', 'Service', 'Repository', 'Configuration', 'Bean', 'Autowired', 'Transactional', 'RestController',
  'RequestMapping', 'GetMapping', 'PostMapping', 'Scheduled', 'Async', 'EventListener',
  // Spring data / cache / boot
  'Cacheable', 'CacheEvict', 'SpringBootApplication', 'AutoConfiguration', 'ConfigurationProperties',
  // Jakarta EE
  'Stateless', 'Stateful', 'Singleton', 'MessageDriven', 'Inject', 'Produces', 'Path',
  // Docs, validation, serialization
  'Schema', 'Operation', 'ApiResponse', 'Parameter', 'Valid', 'NotNull', 'NotBlank', 'JsonProperty',
]);

const snapshot = (cov) => ({
  rates: Object.fromEntries(cov.rates.map((r) => [r.id, [r.numerator, r.denominator, r.percent]])),
  unknownAnnotations: cov.unknownAnnotations.length,
  unknownBaseClasses: cov.unknownBaseClasses.length,
  uncataloguedDependencies: cov.uncataloguedDependenciesTotal,
});

function compare(t, app, now) {
  const was = baseline[app];
  if (!was) {
    baseline[app] = now;
    t.diagnostic(`${app}: baseline created (review test/baselines/coverage.json)`);
    return;
  }
  for (const [id, prev] of Object.entries(was.rates)) {
    const rate = now.rates[id];
    assert.ok(rate, `${app}: rate "${id}" disappeared`);
    const [num, den] = rate;
    const [wasNum, wasDen, wasPct] = prev;
    assert.ok(
      !(num < wasNum && den <= wasDen),
      `${app}: ${id} numerator dropped ${wasNum} -> ${num} with a denominator that did not grow (${den})`,
    );
    const grew = wasDen ? (den - wasDen) / wasDen : 1;
    assert.ok(!(rate[2] < wasPct && grew < 0.05), `${app}: ${id} dropped ${wasPct}% -> ${rate[2]}% (denominator +${den - wasDen})`);
    if (num !== wasNum || den !== wasDen) t.diagnostic(`${app}: ${id} ${wasNum}/${wasDen} -> ${num}/${den}`);
  }
  for (const [key, label] of [
    ['unknownAnnotations', 'unknown annotations'],
    ['unknownBaseClasses', 'unknown base classes'],
    ['uncataloguedDependencies', 'uncatalogued dependencies'],
  ]) {
    assert.ok(
      now[key] <= was[key],
      `${app}: ${label} grew ${was[key]} -> ${now[key]}; coverage of the corpus must not regress`,
    );
    if (now[key] !== was[key]) t.diagnostic(`${app}: ${label} ${was[key]} -> ${now[key]}`);
  }
}

for (const app of cfg.apps) {
  const dir = path.join(root, app.name);
  test(
    `coverage ${app.name}`,
    { skip: !fs.existsSync(dir) && `${dir} not found` },
    (t) => {
      const facts = scan(dir);
      const cov = facts.coverage;

      for (const r of cov.rates) {
        assert.ok(r.percent >= 0 && r.percent <= 100, `${r.id}: ${r.percent}%`);
        assert.ok(r.numerator <= r.denominator, `${r.id}: numerator above denominator`);
      }
      // A rate that cannot fail measures nothing: "annotations resolved" was 100% by construction and is gone.
      assert.ok(!cov.rates.some((r) => r.id === 'annotations resolved'), 'the annotations-resolved rate is removed');

      for (const u of cov.unknownAnnotations) {
        assert.ok(u.count >= 5 || u.types >= 3, `${u.name}: reported below the threshold`);
        assert.ok(u.samples.length >= 1 && u.samples.length <= 2, 'one or two samples');
        for (const s of u.samples) assert.ok(/^.+:\d+$/.test(s), `sample looks like file:line: ${s}`);
      }
      // The blind-spot list must name things nobody understands, not framework annotations a broken selection let
      // through. The top ten are what the writer reads first.
      const leaked = cov.unknownAnnotations
        .slice(0, 10)
        .map((u) => u.name.split('.').pop())
        .filter((name) => MUST_KNOW.has(name));
      assert.deepStrictEqual(leaked, [], `${app}: catalogued annotations reported as unknown`);

      // Sureness is hertzbeat's security layer: no catalog covers it, so it must show up as a dependency the engine
      // does not understand (§8, slice 1 gate).
      if (app.name === 'hertzbeat')
        assert.ok(
          cov.uncataloguedDependencies.some((d) => /sureness/i.test(d.coordinate)),
          'the blind spots must show Sureness',
        );

      assert.deepStrictEqual(facts.coverage.degradedFiles, [], 'no file failed to parse');
      compare(t, app.name, snapshot(cov));
    },
  );
}

// Determinism: the same tree gives the same coverage, blind spots included.
test('coverage is deterministic', { skip: !fs.existsSync(path.join(root, 'cargotracker')) && 'app not found' }, () => {
  const a = snapshot(scan(path.join(root, 'cargotracker')).coverage),
    b = snapshot(scan(path.join(root, 'cargotracker')).coverage);
  assert.deepStrictEqual(a, b);
});

if (process.env.UPDATE) {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 1)}\n`);
}
