// Import-time self-checks moved out of engine/extract/entities.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { elementType, snake } from '../engine/extract/entities.mjs';

test('elementType: generics peeled to the element, plain types unchanged', () => {
  assert.deepStrictEqual(elementType('List<Booking>'), 'Booking');
  assert.deepStrictEqual(elementType('Set<TenantFile>'), 'TenantFile');
  assert.deepStrictEqual(elementType('String'), 'String');
});

test('snake: camel case and acronym runs', () => {
  assert.equal(snake('WorkspaceMember'), 'workspace_member');
  assert.equal(snake('ALERTRecord'), 'alert_record');
});
