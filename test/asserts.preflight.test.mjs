// Import-time self-checks moved out of engine/preflight.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { javaMajor, parseBranchLine } from '../engine/preflight.mjs';
import { preflightLines } from '../engine/classpath.mjs';

test('parseBranchLine: ahead/behind and no upstream', () => {
  assert.deepStrictEqual(parseBranchLine('## main...origin/main [ahead 1, behind 3]'), {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 3,
  });
  assert.deepStrictEqual(parseBranchLine('## feature/x'), { branch: 'feature/x', upstream: null, ahead: 0, behind: 0 });
});

test('javaMajor: no java on the PATH is null', () => {
  assert.equal(javaMajor({ PATH: '' }), null);
});

test('the classpath is an info line, and only Maven running project code asks first', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mindmodel-preflight-'));
  try {
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>');
    const auto = preflightLines(dir, { env: {}, files: ['pom.xml'] });
    assert.equal(auto[0].level, 'info');
    assert.match(auto[0].text, /local Maven repository/);
    assert.equal(auto.length, 1);

    // `.mvn/jvm.config` adds JVM arguments to every Maven run: that is the one confirm.
    fs.mkdirSync(path.join(dir, '.mvn'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.mvn', 'jvm.config'), '-Xmx1g\n');
    const risky = preflightLines(dir, { env: {}, files: ['pom.xml'] });
    assert.equal(risky[1].level, 'confirm');
    assert.match(risky[1].text, /executes project code \(\.mvn\/jvm\.config\)/);

    assert.deepStrictEqual(preflightLines(dir, { env: { MINDMODEL_CLASSPATH: 'off' }, files: ['pom.xml'] }), [
      { level: 'info', text: 'No classpath: MINDMODEL_CLASSPATH=off. Library types stay unresolved.' },
    ]);

    fs.rmSync(path.join(dir, 'pom.xml'));
    fs.writeFileSync(path.join(dir, 'build.gradle'), "plugins { id 'java' }\n");
    const gradle = preflightLines(dir, { env: {}, files: ['build.gradle'] });
    assert.equal(gradle[0].level, 'info');
    assert.match(gradle[0].text, /Gradle build/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
