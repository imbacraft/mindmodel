// Import-time self-checks moved out of engine/extract/tenancy.mjs (Task 9); the assertions are unchanged.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOT_A_KEY } from '../engine/extract/tenancy.mjs';

test('NOT_A_KEY: ids are excluded, identifier fields are not', () => {
  assert.equal(NOT_A_KEY.test('id'), true);
  assert.equal(NOT_A_KEY.test('workspaceId'), false);
});
