// The shipped engine is an artifact, so what the repository promises about it must be checkable offline: the lock file
// pins version, size and digest, the plugin names the release, and the jar on disk has to be that one.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cacheJar, lock, matches, sha256 } from '../engine/engine.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = path.join(REPO, 'engine-java', 'target', 'mindmodel-engine.jar');

test('the lock names a release that the repository points at', () => {
  const held = lock();
  assert.ok(held.url.endsWith(`/engine-v${held.version}/mindmodel-engine.jar`), 'lock version and release URL must agree');
});

test('the built jar is the artifact the lock pins', { skip: !fs.existsSync(BUILT) && 'run mvn package first' }, () => {
  const held = lock();
  assert.equal(fs.statSync(BUILT).size, held.bytes, 'the jar size changed: rebuild and refresh engine.lock');
  assert.equal(sha256(BUILT), held.sha256, 'the jar content changed: publish it and refresh engine.lock');
  assert.ok(matches(BUILT, held));
});

test('a jar that differs from the lock is refused', () => {
  const held = lock();
  const dir = fs.mkdtempSync(path.join(path.dirname(BUILT), 'lock-check-'));
  const copy = path.join(dir, 'mindmodel-engine.jar');
  fs.writeFileSync(copy, 'not the engine');
  assert.equal(matches(copy, held), false, 'a wrong file must never satisfy the lock');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cache path is per version and inside the user cache', () => {
  const at = cacheJar('9.9.9');
  assert.match(at, /mindmodel[/\\]engine[/\\]9\.9\.9[/\\]mindmodel-engine\.jar$/);
  assert.equal(matches(at, lock()), false, 'a version with no cached copy must not read as satisfied');
});

// A machine that already downloaded must work as well as a fresh one: the module's self-checks may not depend on the
// cache being empty, or the second run of the plugin dies on import.
test('a populated cache does not break importing the engine', { skip: !fs.existsSync(BUILT) && 'run mvn package first' }, () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cache-'));
  const target = path.join(cache, 'mindmodel', 'engine', lock().version);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(BUILT, path.join(target, 'mindmodel-engine.jar'));
  const engineUrl = pathToFileURL(path.join(REPO, 'engine', 'engine.mjs')).href;
  const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(engineUrl)})`], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CACHE_HOME: cache, MINDMODEL_ENGINE_JAR: '' },
  });
  assert.equal(out, '', 'importing with a cached jar must stay silent');
  fs.rmSync(cache, { recursive: true, force: true });
});
