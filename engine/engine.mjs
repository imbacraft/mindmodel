#!/usr/bin/env node
// Where the Java engine's jar comes from, and how a machine that has never built it gets one.
//
// The jar is not in the repository: one per release would put ~15 MB into every clone forever. Instead `engine.lock`
// pins the version, the size and the sha256 of the artifact published on the GitHub release; a copy is kept per version
// in the user's cache, verified before every use, and fetched once when preflight finds no jar at all.
//
// Resolution order: $MINDMODEL_ENGINE_JAR (a developer's or air-gapped machine's own jar, used as given), the cache,
// then `engine-java/target/` (a checkout that has run `mvn package`). Only the last step of `ensure` touches the network,
// and it is the only network access in the whole product.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const LOCK = path.join(REPO, 'engine-java', 'engine.lock');

export function lock() {
  const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  for (const key of ['version', 'sha256', 'url', 'bytes'])
    if (!held[key]) throw new Error(`engine.lock has no ${key}`);
  return held;
}

/** `~/.cache/mindmodel/engine/<version>/mindmodel-engine.jar`, honouring XDG_CACHE_HOME. */
export function cacheJar(version = lock().version) {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'mindmodel', 'engine', version, 'mindmodel-engine.jar');
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Does this file match what the lock pins? Size first: it answers in one stat for the common mismatched-file case. */
export function matches(file, held = lock()) {
  if (!fs.existsSync(file)) return false;
  if (fs.statSync(file).size !== held.bytes) return false;
  return sha256(file) === held.sha256;
}

let located; // undefined until asked; then `{ path, source }` or null

/**
 * The jar to run and where it came from, or null: a developer's own jar, then the verified cached copy, then a
 * checkout's build. A cached copy whose digest disagrees is removed rather than used. Answered once per process, so a
 * 15 MB digest is not read twice.
 */
export function locate() {
  if (located !== undefined) return located;
  const fromEnv = process.env.MINDMODEL_ENGINE_JAR;
  if (fromEnv && fs.existsSync(fromEnv)) return (located = { path: fromEnv, source: 'env' });
  const held = lock();
  const cached = cacheJar(held.version);
  if (matches(cached, held)) return (located = { path: cached, source: 'cache' });
  if (fs.existsSync(cached)) fs.rmSync(cached, { force: true });
  const built = path.join(REPO, 'engine-java', 'target', 'mindmodel-engine.jar');
  if (fs.existsSync(built)) return (located = { path: built, source: 'build' });
  return (located = null);
}

/** The jar to run, or null. See `locate`. */
export function jarPath() {
  return locate()?.path ?? null;
}

/**
 * A jar, downloaded if need be. Returns `{ ok, path, source }` or `{ ok: false, reason }`; the reason is a sentence the
 * preflight prints and the caller acts on — a run never starts half-equipped.
 */
export async function ensure({ download = true, log = () => {} } = {}) {
  const found = locate();
  if (found) return { ok: true, ...found };
  const held = lock();
  const cached = cacheJar(held.version);
  if (!download)
    return {
      ok: false,
      reason: `engine jar not found (no cache copy, no build); set MINDMODEL_ENGINE_JAR to a jar or run mvn -f engine-java/pom.xml package`,
    };
  log(`downloading the mindmodel engine ${held.version} (${Math.round(held.bytes / 1048576)} MB, once per version)`);
  const dir = path.dirname(cached);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${cached}.${process.pid}.tmp`;
  try {
    const response = await fetch(held.url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${held.url}`);
    fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
    if (!matches(temp, held)) throw new Error('checksum mismatch: the downloaded jar is not the published one');
    fs.renameSync(temp, cached);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    return {
      ok: false,
      reason: `engine download failed (${error.message}); offline? set MINDMODEL_ENGINE_JAR to a local jar`,
    };
  }
  // One version at a time: a stale engine from an older release is what a wrong scan would come from.
  for (const other of fs.readdirSync(path.dirname(dir)))
    if (other !== held.version) fs.rmSync(path.join(path.dirname(dir), other), { recursive: true, force: true });
  located = { path: cached, source: 'download' };
  return { ok: true, ...located };
}
