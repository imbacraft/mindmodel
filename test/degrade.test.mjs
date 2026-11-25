// Degradation is loud: every fallback an engine module takes is recorded with its reason (engine/core/degrade.mjs). The
// test suite runs strict, so each case below asserts the error, and withDegradation() opts out where a degraded answer
// is the point of the case, then asserts the reason the user would see.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTRACT } from '../engine/dump.mjs';
import { readFacts, validate, citeCandidates } from '../engine/validate.mjs';
import { parseCite } from '../engine/core/cite.mjs';
import { classpathDegradations } from '../engine/scan/model.mjs';
import { isStrict, withDegradation } from '../engine/core/degrade.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mindmodel-degrade-'));

test('strict mode is on for the suite, and withDegradation turns it off for its call only', () => {
  assert.equal(isStrict(), true);
  assert.equal(withDegradation(() => isStrict()).value, false);
  assert.equal(isStrict(), true);
});

test('missing facts: strict throws; the degraded read says what the budget then does', () => {
  const missing = path.join(scratch(), 'facts.json');
  assert.throws(() => readFacts(missing), /budget uses the widest tier/);
  const { value, reasons } = withDegradation(() => readFacts(missing));
  assert.equal(value, null);
  assert.match(reasons[0], /no .*facts\.json: the budget uses the widest tier and no security warnings apply/);
});

test('a dump without its files is unreadable, so the overload checks are off, loudly', () => {
  const root = scratch();
  const dump = path.join(root, 'mindmodel', '.work', 'dump');
  fs.mkdirSync(dump, { recursive: true });
  const row = (x) => `${JSON.stringify(x)}\n`;
  fs.writeFileSync(path.join(dump, 'meta.json'), JSON.stringify({ contract: CONTRACT, counts: {} }));
  const pos = { file: 'X.java', line: 1, col: 1, endLine: 2, endCol: 1 };
  fs.writeFileSync(path.join(dump, 'types.ndjson'), row({ fqn: 'demo.X', kind: 'class', supertypes: [], ann: [], pos }));
  fs.writeFileSync(path.join(dump, 'members.ndjson'), '');
  const map = {};
  assert.throws(() => validate(map, root), /the overload checks are off/, 'strict: the partial dump is an error');
  const { value } = withDegradation(() => validate(map, root));
  assert.ok(
    value.warnings.some((w) => w.startsWith('degraded: mindmodel/.work/dump cannot be read (') && w.endsWith('are off')),
    `the warning reaches validate's output: ${value.warnings.join(' | ')}`,
  );
});

test('a Java file the dump knows nothing about cannot take a symbol check silently', () => {
  const pc = parseCite('X.java#save/2');
  const declared = new Map([['Other.java', { methods: [], types: [] }]]);
  assert.throws(() => citeCandidates(declared, pc), /overload check for #save is off/);
  const { value, reasons } = withDegradation(() => citeCandidates(declared, pc));
  assert.equal(value, null);
  assert.deepStrictEqual(reasons, ['dump has no declarations for X.java: the overload check for #save is off']);
  assert.equal(citeCandidates(null, pc), null, 'no dump at all is said once, where the dump is read');
  assert.equal(citeCandidates(declared, parseCite('X.java:3')), null, 'a cite with no symbol needs no declarations');
});

test('validate passes the scan\'s own degradations on as warnings', () => {
  const facts = { runtime: { degraded: ['no classpath (no mvn on PATH): library types stay unresolved'] } };
  const { warnings } = validate({}, scratch(), null, facts);
  assert.ok(warnings.includes('scan degraded: no classpath (no mvn on PATH): library types stay unresolved'));
});

test('classpath: none is a degradation unless the user switched it off', () => {
  const none = { mode: 'none', reason: 'no mvn on PATH', jars: [], failedModules: [] };
  assert.throws(() => classpathDegradations(none), /no classpath \(no mvn on PATH\)/);
  assert.doesNotThrow(() => classpathDegradations({ ...none, optOut: true }), 'MINDMODEL_CLASSPATH=off is a choice');
  const partial = { mode: 'maven-offline', jars: [], failedModules: [{ module: 'app', reason: 'x' }] };
  assert.throws(() => classpathDegradations(partial), /1 module\(s\) unresolved offline \(app\)/);
  const { reasons } = withDegradation(() => classpathDegradations(partial));
  assert.equal(reasons.length, 1);
});

test('a MINDMODEL_ENGINE_JAR that does not exist fails; it does not fall back to another copy', () => {
  const script = `import(${JSON.stringify(path.join(here, '../engine/io/engine-jar.mjs'))})
    .then(async (m) => console.log(JSON.stringify(await m.ensure({ download: false }))));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, MINDMODEL_ENGINE_JAR: path.join(scratch(), 'missing.jar') },
  });
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, false);
  assert.match(out.reason, /MINDMODEL_ENGINE_JAR is .*missing\.jar, which does not exist/);
});
