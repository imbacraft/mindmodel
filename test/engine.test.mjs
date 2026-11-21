// Unit tests: each engine module carries small self-checks (assert) next to the code they test, and they run on
// import. Importing every module here runs them all; a module that fails to load fails its test.
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine');
for (const f of fs
  .readdirSync(engine)
  .filter((f) => f.endsWith('.mjs'))
  .sort())
  test(`self-checks: ${f}`, () => import(path.join(engine, f)));
