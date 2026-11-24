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

/** A fingerprint of the inputs: the jar and every Java file's path, size and mtime. */
export function fingerprint(root, files) {
  const h = crypto.createHash('sha256');
  const jar = jarPath();
  if (fs.existsSync(jar)) h.update(fs.statSync(jar).mtimeMs + ':' + fs.statSync(jar).size);
  for (const rel of [...files].sort()) {
    const st = fs.statSync(path.join(root, rel));
    h.update(`${rel}:${st.size}:${st.mtimeMs}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Dumps the checkout and returns the directory, or `{ ok: false, reason }` when the engine cannot run. A warm directory
 * whose fingerprint matches is reused as is.
 */
export function dumpFor(root, files, { outDir, force = false } = {}) {
  const jar = jarPath();
  if (!jar || !fs.existsSync(jar)) return { ok: false, reason: `engine jar not found: ${jar}` };
  const dir = outDir ?? path.join(root, 'mindmodel', '.work', 'dump');
  const stamp = path.join(dir, 'fingerprint');
  const want = fingerprint(root, files);
  if (!force && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === want) return { ok: true, dir };
  // Written beside the target and swapped in: two scans of the same checkout never hand a reader half a dump.
  const staging = `${dir}.${process.pid}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const list = path.join(os.tmpdir(), `mindmodel-files-${process.pid}.txt`);
  fs.writeFileSync(list, files.join('\n') + '\n');
  const retired = `${dir}.${process.pid}.old`;
  let swapped = false;
  try {
    // Spoon models the whole checkout in memory: the heap flag is not optional on a large repo (fineract needs 4 GB).
    const heap = process.env.MINDMODEL_ENGINE_XMX || '4g';
    const run = spawnSync('java', [`-Xmx${heap}`, '-jar', jar, 'dump', '--compliance', compliance(), root, list, staging], {
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
  }
}
