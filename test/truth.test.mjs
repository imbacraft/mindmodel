// Hand-checked calls (§5.1). For about thirty call sites per app, a person read the source line and the receiver's
// declaration and wrote down what the resolver must answer: the receiver type, how it was found, how the target was
// found, and the targets themselves. The engine disagreeing with even one of these is a regression in resolution,
// which the rates alone would hide (a wrong receiver still counts as typed).
//
// The files are data (test/truth/<app>.json), not expectations generated at test time: they were written from the
// source, and they change only when someone re-reads the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../engine/scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'apps.json'), 'utf8'));
const root = (process.env.MINDMODEL_TEST_APPS ?? cfg.root).replace(/^~/, os.homedir());

const APPS = ['cargotracker', 'hertzbeat', 'fineract'];

// Every call site the model holds, addressed the way a reader would: file, line, method name, receiver text.
function callIndex(model) {
  const by = new Map();
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const c of m.calls ?? []) {
        const recv = c.recv ? (c.recv.kind === 'name' ? c.recv.text : c.recv.kind) : null;
        by.set(`${t.file}|${c.line}|${c.name}|${recv}`, c);
      }
  return by;
}

for (const app of APPS) {
  const dir = path.join(root, app);
  const file = path.join(here, 'truth', `${app}.json`);
  if (!fs.existsSync(dir) || !fs.existsSync(file)) continue;
  test(`truth ${app}`, () => {
    const truth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { model } = scan(dir, { withModel: true });
    const calls = callIndex(model);
    const misses = [];
    for (const want of truth) {
      const key = `${want.file}|${want.line}|${want.call}|${want.recv}`;
      const got = calls.get(key);
      if (!got) {
        misses.push(`${want.file}:${want.line} ${want.call}: the call site is gone`);
        continue;
      }
      const actual = {
        recvFqn: got.recvFqn ?? null,
        recvHow: got.recvHow ?? null,
        how: got.how ?? null,
        targets: [...(got.targets ?? [])].sort(),
      };
      const expected = { recvFqn: want.recvFqn, recvHow: want.recvHow, how: want.how, targets: want.targets };
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        misses.push(
          `${want.file}:${want.line} ${want.call}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
    }
    assert.deepEqual(misses, [], `${app}: ${misses.length} hand-checked call(s) disagree`);
    assert.ok(truth.length >= 29, `${app}: the hand-checked sample is still there`);
  });
}
