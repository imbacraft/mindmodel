// Import-time self-checks moved out of engine/engine.mjs (Task 9); the assertions are unchanged.
// They were the 0.5 crash pattern: machine-state checks run when any module imports this one.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { lock, cacheJar, sha256, matches } from '../engine/io/engine-jar.mjs';

test('sha256 hashes the file it reads', () => {
  const sample = path.join(os.tmpdir(), 'mindmodel-sha-check.txt');
  fs.writeFileSync(sample, 'mindmodel\n');
  assert.equal(sha256(sample), crypto.createHash('sha256').update('mindmodel\n').digest('hex'));
  fs.rmSync(sample, { force: true });
});

test('cacheJar names the jar; the lock pins a sha256 and an https URL; a missing file does not match', () => {
  assert.match(cacheJar('1.2.3'), /mindmodel[/\\]engine[/\\]1\.2\.3[/\\]mindmodel-engine\.jar$/);
  const held = lock();
  assert.equal(held.sha256.length, 64);
  // https, or a loopback server standing in for it in a test: never plain http to somewhere else.
  assert.ok(/^https:\/\//.test(held.url) || /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(held.url), 'the engine URL must be https');
  // A path that cannot exist: the check is about `matches`, never about what this machine happens to have cached.
  const absent = path.join(os.tmpdir(), `mindmodel-absent-${process.pid}-${Date.now()}.jar`);
  assert.equal(matches(absent, held), false, 'a path with no file must not read as satisfied');
});
