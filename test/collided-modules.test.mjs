// A module that copies a sibling's class loses it in the folder dump; the system scan must notice and dump it alone.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collidedModules } from '../engine/system/folder.mjs';

function folderWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmodel-collided-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('a module whose type file kept no type collides; package-info never counts', () => {
  const root = folderWith({
    'svc/src/main/java/a/Thing.java': 'package a; class Thing {}',
    'svc/src/main/java/a/package-info.java': 'package a;',
    'lambda/src/main/java/a/Thing.java': 'package a; class Thing {}',
  });
  try {
    const modules = [path.join(root, 'svc'), path.join(root, 'lambda')];
    // The folder dump kept svc's Thing and dropped lambda's copy.
    const model = { types: new Map([['a.Thing', { file: 'svc/src/main/java/a/Thing.java' }]]) };
    const collided = collidedModules(root, modules, { files: new Map() }, model);
    assert.deepEqual([...collided], [path.join(root, 'lambda')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file the folder dump could not parse still marks its module', () => {
  const root = folderWith({ 'svc/src/main/java/a/Bad.java': 'class {' });
  try {
    const modules = [path.join(root, 'svc')];
    const db = { files: new Map([['x', { path: 'svc/src/main/java/a/Bad.java', errors: [{ reason: 'parse' }] }]]) };
    assert.deepEqual([...collidedModules(root, modules, db, null)], [path.join(root, 'svc')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
