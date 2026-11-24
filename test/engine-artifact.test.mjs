// The shipped engine is an artifact, so what the repository promises about it must be checkable offline: the lock file
// pins version, size and digest, the plugin names the release, and the jar on disk has to be that one.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { cacheJar, lock, matches, sha256 } from '../engine/engine.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const BUILT = path.join(REPO, 'engine-java', 'target', 'mindmodel-engine.jar');

test('the plugin version and the engine lock agree', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(lock().version, plugin.version, 'plugin.json and engine.lock must name the same release');
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
