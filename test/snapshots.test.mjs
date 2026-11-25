// Snapshot tests: everything the engine produces for the test apps (facts, digests, validation results and rendered
// pages), compared with the last accepted run. The test apps are public repos cloned under test/apps.json's root
// (or $MINDMODEL_TEST_APPS); missing ones are skipped, and `slow` apps run only with SLOW=1. Snapshots stay local in
// test/snapshots/ (gitignored), so the first run on a fresh clone records them and skips; later runs compare. With
// SLOW=1 and CI=1 a missing checkout or snapshot fails. Accept intended changes: UPDATE=1 node --test
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../engine/scan.mjs';
import { cachedScan, cachedSystemScan } from '../test-support/scan-cache.mjs';
import { systemSummary } from '../engine/system.mjs';
import { validate } from '../engine/validate.mjs';
import { checkSchema } from '../engine/core/schema.mjs';
import { renderPage } from '../engine/render.mjs';
import { validateSystem, renderSystemPage } from '../engine/system-render.mjs';
import { git } from '../engine/activity.mjs';
import { STRICT, corpusSkip, dirOf, loadApps, requireCheckout } from './apps.mjs';

// A snapshot is a fact about the engine, not about this machine: a populated ~/.m2 changes receiver typing, so the
// corpus is always read without a classpath. The classpath itself is tested in test/classpath.test.mjs.
process.env.MINDMODEL_CLASSPATH = 'off';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadApps(here);
const root = process.env.MINDMODEL_TEST_APPS ?? cfg.root;
const snapDir = path.join(here, 'snapshots');
const FACTS_SCHEMA = JSON.parse(fs.readFileSync(path.join(here, '../schema/facts.schema.json'), 'utf8'));

// The facts contract is checked on every run, for every app and every service: a shape change that nobody documented
// fails here, not in a writer's run.
function checkFacts(facts, where) {
  const errors = [];
  checkSchema(facts, FACTS_SCHEMA, FACTS_SCHEMA.$defs ?? {}, '$', (m) => errors.push(m));
  assert.deepStrictEqual(errors.slice(0, 5), [], `${where}: facts do not match schema/facts.schema.json`);
}

// The scan date and the stage timings are the values that change between runs of the same code.
const stable = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'scannedAt' || k === 'timings' ? undefined : v)));
const digest = (facts) => summarize({ ...facts, scannedAt: 'DATE' });
const readMap = (dir, rel) =>
  rel && fs.existsSync(path.join(dir, rel)) ? JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) : null;

// Compare part by part and show the first lines that differ, not a diff of a megabyte of JSON.
// A snapshot that does not exist yet is written and the test is skipped: on a fresh clone (snapshots are gitignored)
// the first run records the baseline instead of failing, and the second run compares against it.
function check(t, name, actual) {
  const file = path.join(snapDir, `${name}.json`);
  const exists = fs.existsSync(file);
  if (!exists && !process.env.UPDATE && STRICT)
    assert.fail(`${name}: no snapshot recorded (CI with SLOW=1 needs one: run once without CI to record it)`);
  if (process.env.UPDATE || !exists) {
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(actual, null, 1));
    if (!exists && !process.env.UPDATE)
      return t.skip(`snapshot created: ${path.relative(here, file)} — re-run to compare`);
    t.diagnostic(`snapshot written: ${path.relative(here, file)}`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const a = JSON.stringify(actual[key], null, 1)?.split('\n') ?? [],
      e = JSON.stringify(expected[key], null, 1)?.split('\n') ?? [];
    const i = a.findIndex((line, n) => line !== e[n]),
      at = i < 0 ? (a.length === e.length ? -1 : Math.min(a.length, e.length)) : i;
    if (at < 0) continue;
    const show = (lines) =>
      lines
        .slice(Math.max(0, at - 2), at + 3)
        .map((l) => `    ${l.slice(0, 200)}`)
        .join('\n');
    assert.fail(
      `${name}: "${key}" changed at line ${at + 1} (UPDATE=1 to accept)\n  expected:\n${show(e)}\n  actual:\n${show(a)}`,
    );
  }
}

// A snapshot describes one commit of a test app. Skip (do not fail) when the clone has moved, so a pulled app does
// not look like a regression; update "commit" in apps.json when the new state is intended.
function moved(dir, commit) {
  if (!commit) return null;
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (!head) return `cannot read HEAD in ${dir}`;
  return head === commit ? null : `app at ${head.slice(0, 8)}, snapshots pinned to ${commit.slice(0, 8)}`;
}
for (const app of cfg.apps) {
  const dir = dirOf({ ...cfg, root }, app);
  test(`app ${app.name}`, { skip: corpusSkip(app, dir) }, (t) => {
    requireCheckout(dir);
    const skip = moved(dir, app.commit);
    if (skip) return t.skip(skip);
    const raw = cachedScan(app.name, dir),
      facts = stable(raw),
      out = { facts, digest: digest(facts) };
    // The contract is checked on the real facts: `stable` drops scannedAt, which the schema requires.
    checkFacts(raw, `app ${app.name}`);
    const map = readMap(dir, app.map);
    if (map) {
      out.validation = validate(map, dir);
      out.page = renderPage(map, dir, cfg.web, facts);
    }
    check(t, `app-${app.name}`, out);
  });
}

for (const sysCfg of cfg.systems) {
  const dir = dirOf({ ...cfg, root }, sysCfg);
  test(`system ${sysCfg.name}`, { skip: corpusSkip(sysCfg, dir) }, (t) => {
    requireCheckout(dir);
    const skip = moved(dir, sysCfg.commit);
    if (skip) return t.skip(skip);
    const sys = cachedSystemScan(sysCfg.name, dir);
    for (const s of sys.services) checkFacts(s.facts, `system ${sysCfg.name}/${s.name}`);
    const out = {
      system: stable({ ...sys, services: sys.services.map(({ facts, ...s }) => s) }),
      digest: systemSummary(sys),
      services: Object.fromEntries(
        sys.services.map((s) => [s.name, { facts: stable(s.facts), digest: digest(s.facts) }]),
      ),
    };
    const map = readMap(dir, sysCfg.map);
    if (map) {
      out.validation = validateSystem(map, sys, dir);
      if (!out.validation.errors.length) out.page = renderSystemPage(map, sys, dir, cfg.web);
    }
    check(t, `system-${sysCfg.name}`, out);
  });
}
