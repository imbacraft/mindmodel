// Load tests: every module under engine/ must import cleanly. The assert self-checks live in
// test/asserts.<module>.test.mjs, not at the top of the modules (Task 9); a module that fails to load fails its test.
import '../test-support/strict.mjs';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine');
const SKIP = new Set(['vendor']);

// Every module under engine/, including the layered subfolders; vendored code is not ours to self-check.
function modules(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) modules(p, out);
    } else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

for (const f of modules(engine).sort()) {
  const name = path.relative(engine, f).split(path.sep).join('/');
  test(`loads: ${name}`, () => import(f));
}
