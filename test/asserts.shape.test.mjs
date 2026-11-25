// Import-time self-checks moved out of engine/shape.mjs (Task 9); the assertions are unchanged.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { shape } from '../engine/shape.mjs';

test('shape: required and optional fields of an object', () => {
  assert.equal(
    shape(
      {
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'integer' } } },
      },
      {},
    ),
    '{\n  a: string\n  b?: [integer]\n}',
  );
});
