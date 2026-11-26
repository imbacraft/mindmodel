// The profile file's git state comes from the real git helper: a tracked profile file says so, an ignored one names the
// ignore rule. The helper returns { out, reason }, so a check on the object itself would call every file tracked.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bootFacts } from '../engine/extract/boot.mjs';
import { git } from '../engine/io/git.mjs';

function repo() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mindmodel-boot-git-'));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const res = 'src/main/resources';
  put('build.gradle', "plugins { id 'org.springframework.boot' }\n");
  put(`${res}/application.yml`, 'spring:\n  profiles:\n    active: local\n');
  put(`${res}/application-local.yml`, 'server:\n  port: 8080\n');
  put(`${res}/application-prod.yml`, 'server:\n  port: 9090\n');
  put('.gitignore', `${res}/application-local.yml\n`);
  const sh = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  sh(['init', '-q']);
  sh(['add', 'build.gradle', `${res}/application.yml`, `${res}/application-prod.yml`, '.gitignore']);
  return root;
}

function profileLine(root) {
  const files = ['build.gradle', 'src/main/resources/application.yml', 'src/main/resources/application-local.yml',
    'src/main/resources/application-prod.yml'].map((f) => path.join(root, f));
  const rel = (f) => path.relative(root, f);
  const lines = bootFacts({ root, files, rel, git, app: null });
  return lines.find((l) => l.startsWith('profile:'));
}

test('profile file: an ignored file says it is not in git and names the rule', () => {
  const root = repo();
  try {
    assert.match(
      profileLine(root),
      /local \(.*\); src\/main\/resources\/application-local\.yml is NOT in git \(ignored by \.gitignore:1\): /,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('profile file: a tracked file says it is in git', () => {
  const root = repo();
  try {
    fs.writeFileSync(path.join(root, '.gitignore'), '');
    fs.writeFileSync(path.join(root, 'src/main/resources/application.yml'), 'spring:\n  profiles:\n    active: prod\n');
    assert.match(profileLine(root), /prod \(.*\); src\/main\/resources\/application-prod\.yml \(in git\)$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
