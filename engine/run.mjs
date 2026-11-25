// Runs the Java engine's dump for a checkout: the only place Node knows Spoon exists. One dump per scan, written under
// the project's own mindmodel/.work (the same place facts go), and reused when the jar and the files have not changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jarPath } from './engine.mjs';
import { summaryHash } from './classpath.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

// Where that jar is (env, cache, or this checkout's build) is engine.mjs's question, not this module's.
export { jarPath };

// Spoon 11.5 accepts a compliance level up to 26 (JDK 25); 11.2.1 died above 21. A project on a newer JDK therefore
// gets the highest level this engine understands, and `capped` says so in the facts rather than pretending the source
// parsed at its own level.
export const MAX_COMPLIANCE = 26;
export function compliance() {
  const asked = Number(process.env.MINDMODEL_COMPLIANCE || 17);
  return String(Number.isFinite(asked) ? Math.min(asked, MAX_COMPLIANCE) : 17);
}
export function complianceCapped() {
  return Number(process.env.MINDMODEL_COMPLIANCE || 17) > MAX_COMPLIANCE;
}
{
  const saved = process.env.MINDMODEL_COMPLIANCE;
  process.env.MINDMODEL_COMPLIANCE = '27';
  assert.equal(compliance(), '26', 'a level Spoon cannot take is capped, never passed through');
  assert.equal(complianceCapped(), true);
  process.env.MINDMODEL_COMPLIANCE = '25';
  assert.equal(compliance(), '25', 'Java 25 parses at its own level');
  assert.equal(complianceCapped(), false);
  delete process.env.MINDMODEL_COMPLIANCE;
  assert.equal(compliance(), '17');
  if (saved !== undefined) process.env.MINDMODEL_COMPLIANCE = saved;
}

/** The file's own bytes, hashed: the one reading of a file that does not depend on when it was written. */
function contentHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

/**
 * Each tracked file's git blob id, and the set of files whose worktree content differs from the index or is untracked.
 * The blob id is the same on every branch switch and every clone, so a warm dump stays warm for a file nobody edited;
 * mtimes, which change on checkout, made every branch switch a cold dump for no reason. Null outside a git repo.
 */
export function gitState(root, files) {
  const git = (args) =>
    spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  const listed = git(['ls-files', '-s', '-z', '--', '*.java']);
  if (listed.status !== 0) return null;
  const blobs = new Map();
  for (const row of listed.stdout.split('\0')) {
    const m = /^\d+ ([0-9a-f]{40}) \d\t(.+)$/.exec(row);
    if (m) blobs.set(m[2], m[1]);
  }
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '*.java']);
  const dirty = new Set();
  for (const row of (status.stdout ?? '').split('\0')) {
    if (!row) continue;
    // `XY path` in the porcelain format; a rename carries the old path in the next field, which is not read here.
    const rel = row.slice(3);
    if (rel) dirty.add(rel);
  }
  return { blobs, dirty };
}

/**
 * A fingerprint of the inputs: the jar, every Java file's content identity, and the classpath summary with the
 * generated sources' own files. Stable across a branch switch (`gitState`), because every input is a content id.
 */
export function fingerprint(root, files, classpath = null) {
  const h = crypto.createHash('sha256');
  const jar = jarPath();
  if (fs.existsSync(jar)) h.update(fs.statSync(jar).mtimeMs + ':' + fs.statSync(jar).size + '\n');
  const state = gitState(root, files);
  for (const rel of [...files].sort()) {
    const blob = state && !state.dirty.has(rel) ? state.blobs.get(rel) : null;
    if (blob) {
      h.update(`${rel}:git:${blob}\n`);
      continue;
    }
    const full = path.join(root, rel);
    // Not tracked (or tracked and edited here): the bytes are the identity, and they read the same on any branch.
    h.update(`${rel}:sha:${contentHash(full)}\n`);
  }
  if (classpath) h.update(`classpath:${summaryHash(classpath, root)}\n`);
  return h.digest('hex').slice(0, 16);
}

/**
 * Dumps the checkout and returns the directory, or `{ ok: false, reason }` when the engine cannot run. A warm directory
 * whose fingerprint matches is reused as is.
 */
export function dumpFor(root, files, { outDir, force = false, classpath = null } = {}) {
  const jar = jarPath();
  if (!jar || !fs.existsSync(jar)) return { ok: false, reason: `engine jar not found: ${jar}` };
  const dir = outDir ?? path.join(root, 'mindmodel', '.work', 'dump');
  const stamp = path.join(dir, 'fingerprint');
  const want = fingerprint(root, files, classpath);
  if (!force && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === want) return { ok: true, dir };
  // Written beside the target and swapped in: two scans of the same checkout never hand a reader half a dump.
  const staging = `${dir}.${process.pid}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const list = path.join(os.tmpdir(), `mindmodel-files-${process.pid}.txt`);
  fs.writeFileSync(list, files.join('\n') + '\n');
  // The classpath and the generated source roots travel as files: one entry per line, the order the build tool gave.
  const flags = [];
  const scratch = [];
  if (classpath?.jars?.length) {
    const jars = path.join(os.tmpdir(), `mindmodel-classpath-${process.pid}.txt`);
    fs.writeFileSync(jars, classpath.jars.join('\n') + '\n');
    scratch.push(jars);
    flags.push('--classpath', jars);
  }
  if (classpath?.generatedSources?.length) {
    const gen = path.join(os.tmpdir(), `mindmodel-generated-${process.pid}.txt`);
    fs.writeFileSync(gen, classpath.generatedSources.join('\n') + '\n');
    scratch.push(gen);
    flags.push('--generated', gen);
  }
  const retired = `${dir}.${process.pid}.old`;
  let swapped = false;
  try {
    // Spoon models the whole checkout in memory: the heap flag is not optional on a large repo (fineract needs 4 GB).
    const heap = process.env.MINDMODEL_ENGINE_XMX || '4g';
    const run = spawnSync('java', [`-Xmx${heap}`, '-jar', jar, 'dump', '--compliance', compliance(), ...flags, root, list, staging], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: Number(process.env.MINDMODEL_ENGINE_TIMEOUT_MS) || 900000,
    });
    if (run.status !== 0) {
      const tail = (run.stderr || '').split('\n').filter((l) => l.trim() && !/^SLF4J/.test(l)).pop();
      const how =
        run.error?.message || (run.signal ? `engine exit ${run.status} (${run.signal})` : `engine exit ${run.status}`);
      return { ok: false, reason: tail || how };
    }
    fs.writeFileSync(path.join(staging, 'fingerprint'), want + '\n');
    fs.rmSync(retired, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, retired);
    fs.renameSync(staging, dir);
    swapped = true;
    return { ok: true, dir };
  } finally {
    // A failed run (non-zero exit, timeout, a swap that threw) must not leave staging folders behind in the project.
    if (!swapped) {
      fs.rmSync(staging, { recursive: true, force: true });
      // The swap retires the old dump first: put it back rather than leaving the checkout without a warm dump.
      if (!fs.existsSync(dir) && fs.existsSync(retired)) fs.renameSync(retired, dir);
    }
    fs.rmSync(retired, { recursive: true, force: true });
    fs.rmSync(list, { force: true });
    for (const file of scratch) fs.rmSync(file, { force: true });
  }
}
