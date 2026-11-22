// Snapshot tests: everything the engine produces for the test apps (facts, digests, validation results and rendered
// pages), compared with the last accepted run. The test apps are public repos cloned under test/apps.json's root
// (or $MINDMODEL_TEST_APPS); missing ones are skipped. Snapshots stay local in test/snapshots/ (gitignored).
// Run: node --test        Accept intended changes: UPDATE=1 node --test
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, summarize } from '../engine/scan.mjs';
import { systemScan, systemSummary } from '../engine/system.mjs';
import { checkSchema, validate } from '../engine/validate.mjs';
import { renderPage } from '../engine/render.mjs';
import { validateSystem, renderSystemPage } from '../engine/system-render.mjs';
import { git } from '../engine/activity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'apps.json'), 'utf8'));
const root = (process.env.MINDMODEL_TEST_APPS ?? cfg.root).replace(/^~/, os.homedir());
const snapDir = path.join(here, 'snapshots');
const FACTS_SCHEMA = JSON.parse(fs.readFileSync(path.join(here, '../schema/facts.schema.json'), 'utf8'));

// The facts contract is checked on every run, for every app and every service: a shape change that nobody documented
// fails here, not in a writer's run.
function checkFacts(facts, where) {
  const errors = [];
  checkSchema(facts, FACTS_SCHEMA, FACTS_SCHEMA.$defs ?? {}, '$', (m) => errors.push(m));
  assert.deepStrictEqual(errors.slice(0, 5), [], `${where}: facts do not match schema/facts.schema.json`);
}

// The scan date is the only value that changes between runs of the same code.
const stable = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'scannedAt' ? undefined : v)));
const digest = (facts) => summarize({ ...facts, scannedAt: 'DATE' });
const readMap = (dir, rel) =>
  rel && fs.existsSync(path.join(dir, rel)) ? JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) : null;

// Compare part by part and show the first lines that differ, not a diff of a megabyte of JSON.
function check(t, name, actual) {
  const file = path.join(snapDir, `${name}.json`);
  if (process.env.UPDATE) {
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(actual, null, 1));
    t.diagnostic(`snapshot written: ${path.relative(here, file)}`);
    return;
  }
  assert.ok(fs.existsSync(file), `${name}: no snapshot (run UPDATE=1 node --test to create it)`);
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
const skipIf = (dir, app) => (!fs.existsSync(dir) ? `${dir} not found` : moved(dir, app.commit));

for (const app of cfg.apps) {
  const dir = path.join(root, app.name),
    skip = skipIf(dir, app);
  test(`app ${app.name}`, (t) => {
    if (skip) return t.skip(skip);
    const raw = scan(dir),
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
  const dir = path.join(root, sysCfg.name),
    skip = skipIf(dir, sysCfg);
  test(`system ${sysCfg.name}`, (t) => {
    if (skip) return t.skip(skip);
    const sys = systemScan(dir);
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
