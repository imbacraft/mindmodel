// One scan per app per test run: the first test file that needs an app's facts writes them to a gitignored cache, the
// rest read it. The key covers every file under engine/ and schema/ plus the app's pinned commit, so any engine or
// schema change invalidates every entry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../engine/scan.mjs';
import { execFileSync } from 'node:child_process';
import { loadApps } from '../test/apps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(here, '../test');
const cacheDir = path.join(testDir, 'snapshots', '.cache');

function hashTree(dirs) {
  const h = crypto.createHash('sha256');
  for (const dir of dirs) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else h.update(path.relative(here, p)).update(fs.readFileSync(p));
      }
    };
    walk(dir);
  }
  return h.digest('hex').slice(0, 16);
}

const engineKey = hashTree([path.join(here, '../engine'), path.join(here, '../schema')]);
const cfg = loadApps(testDir);
const commitOf = (name) => (cfg.apps.find((a) => a.name === name) ?? {}).commit ?? 'unknown';

export function cacheKey(name) {
  return `${name}-${crypto.createHash('sha256').update(`${engineKey}:${commitOf(name)}`).digest('hex').slice(0, 12)}`;
}

// A scan starts a JVM; four files scanning at once means four multi-gigabyte JVMs and a suite that takes three times
// as long (or dies on memory). Slots are files, so the limit holds across the test runner's separate processes; a slot
// whose process is gone is reclaimed rather than blocking the run.
const SCAN_SLOTS = 2;
const slotDir = path.join(os.tmpdir(), 'mindmodel-scan-slots');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withScanSlot(run) {
  fs.mkdirSync(slotDir, { recursive: true });
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    for (let i = 0; i < SCAN_SLOTS; i++) {
      const slot = path.join(slotDir, `slot-${i}`);
      try {
        fs.writeFileSync(slot, String(process.pid), { flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const holder = Number(fs.readFileSync(slot, 'utf8').trim() || 0);
        if (holder && !alive(holder)) fs.rmSync(slot, { force: true });
        continue;
      }
      try {
        return run();
      } finally {
        fs.rmSync(slot, { force: true });
      }
    }
    if (Date.now() > deadline) throw new Error('scan slot: waited 15 minutes for a free slot');
    sleep(250);
  }
}

// `withModel` needs the in-memory model, which is not serialisable: those callers scan (once per file) and share the
// result themselves.
const dirty = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return true; // not a git checkout: do not trust a cache keyed on a commit
  }
};

export function cachedScan(name, dir, { withModel = false } = {}) {
  if (withModel) return withScanSlot(() => scan(dir, { withModel }));
  // An app under development changes without the commit moving: never serve it from cache.
  if (dirty(dir)) return withScanSlot(() => scan(dir));
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${cacheKey(name)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const facts = withScanSlot(() => scan(dir));
  fs.writeFileSync(file, JSON.stringify(facts));
  return facts;
}
