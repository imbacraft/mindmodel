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
import { validate } from '../engine/validate.mjs';
import { renderPage } from '../engine/render.mjs';
import { validateSystem, renderSystemPage } from '../engine/system-render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'apps.json'), 'utf8'));
const root = (process.env.MINDMODEL_TEST_APPS ?? cfg.root).replace(/^~/, os.homedir());
const snapDir = path.join(here, 'snapshots');

// The scan date is the only value that changes between runs of the same code.
const stable = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'scannedAt' ? undefined : v)));
const digest = (facts) => summarize({ ...facts, scannedAt: 'DATE' });
const readMap = (dir, rel) =>
  rel && fs.existsSync(path.join(dir, rel)) ? JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) : null;

// Compare part by part and show the first lines that differ, not a diff of a megabyte of JSON.
function check(t, name, actual) {
  const file = path.join(snapDir, `${name}.json`);
  if (process.env.UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(actual, null, 1));
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

for (const app of cfg.apps) {
  const dir = path.join(root, app.name);
  test(`app ${app.name}`, { skip: !fs.existsSync(dir) && `${dir} not found` }, (t) => {
    const facts = stable(scan(dir)),
      out = { facts, digest: digest(facts) };
    const map = readMap(dir, app.map);
    if (map) {
      out.validation = validate(map, dir);
      out.page = renderPage(map, dir, cfg.web);
    }
    check(t, `app-${app.name}`, out);
  });
}

for (const sysCfg of cfg.systems) {
  const dir = path.join(root, sysCfg.name);
  test(`system ${sysCfg.name}`, { skip: !fs.existsSync(dir) && `${dir} not found` }, (t) => {
    const sys = systemScan(dir);
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
