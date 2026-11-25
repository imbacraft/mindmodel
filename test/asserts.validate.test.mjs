// Import-time self-checks moved out of engine/validate.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert';
import { parseCite } from '../engine/core/cite.mjs';

const parsed = (file, start, end, symbol, arity) => ({ file, start, end, symbol, arity });

test('parseCite: path, range, symbol and arity forms', () => {
  assert.deepStrictEqual(parseCite('a/b.java:10-12'), parsed('a/b.java', 10, 12, null, null));
  assert.deepStrictEqual(parseCite('CLAUDE.md'), parsed('CLAUDE.md', null, null, null, null));
  assert.deepStrictEqual(parseCite('a/B.java:5#save'), parsed('a/B.java', 5, 5, 'save', null));
  assert.deepStrictEqual(parseCite('a/B.java#save/2'), parsed('a/B.java', null, null, 'save', 2));
});

