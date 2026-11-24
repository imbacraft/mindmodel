// Import-time self-checks moved out of engine/extract/lifecycle.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chosenInline } from '../engine/extract/lifecycle.mjs';

test('chosenInline: only a method that sets a status decides the enum value', () => {
  assert.equal(chosenInline({ enumName: 'S', value: 'A', stmt: 'x ? S.A : S.B', methodText: 'o.setStatus(x)' }), true);
  assert.equal(chosenInline({ enumName: 'S', value: 'A', stmt: 'x ? S.A : S.B', methodText: 'return 1;' }), false);
});
