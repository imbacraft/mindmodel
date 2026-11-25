// One scan per app, system and fixture per test run: the first test file that needs one writes its facts to a
// gitignored cache, the rest read it. The key covers every file under engine/, schema/ and the Java engine's sources and
// jar, the entry's pinned commit (or the fixture's own bytes), and the classpath variables the scan reads, so any change
// to the engine or its inputs invalidates the entry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../engine/scan.mjs';
import { withDegradation } from '../engine/core/degrade.mjs';
import { systemScan } from '../engine/system.mjs';
import { execFileSync } from 'node:child_process';
import { loadApps } from '../test/apps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(here, '../test');
const cacheDir = path.join(testDir, 'snapshots', '.cache');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

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

// The Java engine decides what the dump says, so a rebuilt jar invalidates every entry too: the tree that reads it and
// the artifact it reads are one engine, and a cache keyed on the Node half alone serves a scan of the old answers.
const jar = path.join(here, '../engine-java/target/mindmodel-engine.jar');
const jarStamp = fs.existsSync(jar) ? `${fs.statSync(jar).size}:${fs.statSync(jar).mtimeMs}` : 'none';
const engineKey = sha(
  `${hashTree([path.join(here, '../engine'), path.join(here, '../schema'), path.join(here, '../engine-java/src')])}${jarStamp}`,
).slice(0, 16);
const cfg = loadApps(testDir);

// The scan reads these; an entry made under one setting must not answer for another.
const envKey = () => ['MINDMODEL_CLASSPATH', 'MINDMODEL_M2'].map((k) => process.env[k] ?? '').join('|');

// `what` names the entry, `version` is what must match for it to be valid. The file name is the digest of both.
function cacheFile(what, version) {
  return path.join(cacheDir, `${what}-${sha(`${engineKey}:${version}`).slice(0, 12)}.json`);
}

const readCache = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing, or unreadable: scan again
  }
};

// Written under a temp name and renamed: two test files may finish the same entry at once, and a reader must never see
// half of a file.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
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

// Serve the entry from cache, or run `scanFn` once and keep its JSON. A hit and a miss return the same shape.
function memo(what, version, scanFn) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = cacheFile(what, version);
  const hit = readCache(file);
  if (hit) return hit;
  const text = JSON.stringify(withScanSlot(scanFn));
  writeAtomic(file, text);
  return JSON.parse(text);
}

// An app under development changes without the commit moving: a dirty checkout is never served from cache. The scanner
// writes its own output into `mindmodel/` and `mindmodel-system/` (at the root or one folder down, a service's), so
// those untracked folders do not make a checkout dirty.
const OUTPUT = /^(?:[^/]+\/)?mindmodel(?:-system)?\//;
const dirty = (dir) => {
  try {
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    return status.split('\n').some((line) => line.trim() && !OUTPUT.test(line.slice(3)));
  } catch {
    return true; // not a git checkout: do not trust a cache keyed on a commit
  }
};

const entryOf = (list, name) => list.find((a) => a.name === name) ?? {};
const commitOf = (list, name) => entryOf(list, name).commit ?? 'unknown';

// Tests run strict, but no test checkout can build a classpath offline (Gradle is not implemented, Maven cannot fetch
// a parent POM), so "no classpath" is the one allowed degradation. Anything else the scan gave up on fails the test,
// whether the facts were scanned now or served from the cache.
const ALLOWED = /^no classpath \(/;
const tolerant = (fn) => () => withDegradation(fn).value;
function refuseDegraded(label, facts) {
  const unexpected = (facts?.runtime?.degraded ?? []).filter((r) => !ALLOWED.test(r));
  if (unexpected.length) throw new Error(`${label}: the scan degraded: ${unexpected.join('; ')}`);
  return facts;
}

// `withModel` needs the in-memory model, which is not serialisable: those callers scan (once per file) and share the
// result themselves.
export function cachedScan(name, dir, { withModel = false } = {}) {
  if (withModel) return withScanSlot(tolerant(() => scan(dir, { withModel })));
  const run = tolerant(() => scan(dir));
  const facts = dirty(dir) ? withScanSlot(run) : memo(`app-${name}`, `${commitOf(cfg.apps, name)}:${envKey()}`, run);
  return refuseDegraded(`app ${name}`, facts);
}

export function cachedSystemScan(name, dir) {
  const run = tolerant(() => systemScan(dir));
  const sys = dirty(dir) ? withScanSlot(run) : memo(`system-${name}`, `${commitOf(cfg.systems, name)}:${envKey()}`, run);
  for (const s of sys.services ?? []) refuseDegraded(`system ${name}, service ${s.name}`, s.facts);
  return sys;
}

// A fixture is read in place: its bytes are the key, and the scan runs on a copy (a scan writes beside the code).
export function cachedFixtureScan(name) {
  const dir = path.join(here, 'fixtures', name);
  const scratch = () => {
    const copy = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mindmodel-fixture-scan-'));
    try {
      fs.cpSync(dir, copy, { recursive: true });
      return withDegradation(() => scan(copy)).value;
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  };
  return refuseDegraded(`fixture ${name}`, memo(`fixture-${name}`, `${hashTree([dir])}:${envKey()}`, scratch));
}
