// Import-time self-check moved out of engine/system-render.mjs (Task 9); the assertion is unchanged.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { unresolved } from '../engine/system-render.mjs';

test('unresolved: names the scan could not resolve', () => {
  assert.deepStrictEqual(
    unresolved({
      channels: [{ kind: 'jms', name: null, unresolved: 'cfg.queue', out: [{ service: 'a' }], in: [] }],
      rest: [{ from: 'a', to: 'pay-host', known: false }],
      services: [{ name: 'gw', unresolvedDest: ['order.url'] }],
    }),
    [
      { service: 'a', name: 'cfg.queue', what: 'jms channel' },
      { service: 'a', name: 'pay-host', what: 'host' },
      { service: 'gw', name: 'order.url', what: 'URL setting' },
    ],
  );
});
