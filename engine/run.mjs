// Runs the Java engine's dump for a checkout: the only place Node knows Spoon exists. One dump per scan, written under
// the project's own mindmodel/.work (the same place facts go), and reused when the jar and the files have not changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

export function jarPath() {
  return process.env.MINDMODEL_ENGINE_JAR || path.join(REPO, 'engine-java', 'target', 'mindmodel-engine.jar');
}

export function compliance() {
  return process.env.MINDMODEL_COMPLIANCE || '17';
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
  if (!fs.existsSync(jar)) return { ok: false, reason: `engine jar not found: ${jar}` };
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
  // Spoon models the whole checkout in memory: the heap flag is not optional on a large repo (fineract needs 4 GB).
  const heap = process.env.MINDMODEL_ENGINE_XMX || '4g';
  const run = spawnSync('java', [`-Xmx${heap}`, '-jar', jar, 'dump', '--compliance', compliance(), root, list, staging], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: Number(process.env.MINDMODEL_ENGINE_TIMEOUT_MS) || 900000,
  });
  if (run.status !== 0) {
    const tail = (run.stderr || '').split('\n').filter((l) => l.trim() && !/^SLF4J/.test(l)).pop();
    return { ok: false, reason: tail || `engine exit ${run.status}${run.signal ? ` (${run.signal})` : ''}` };
  }
  fs.writeFileSync(path.join(staging, 'fingerprint'), want + '\n');
  const retired = `${dir}.${process.pid}.old`;
  fs.rmSync(retired, { recursive: true, force: true });
  if (fs.existsSync(dir)) fs.renameSync(dir, retired);
  fs.renameSync(staging, dir);
  fs.rmSync(retired, { recursive: true, force: true });
  return { ok: true, dir };
}
