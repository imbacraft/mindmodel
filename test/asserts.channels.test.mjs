// Import-time self-checks moved out of engine/extract/channels.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstString } from '../engine/extract/channels.mjs';

test('firstString: the first quoted argument, else nothing', () => {
  assert.equal(firstString(['"orders"', 'x']), '"orders"');
  assert.equal(firstString(['x']), undefined);
});
