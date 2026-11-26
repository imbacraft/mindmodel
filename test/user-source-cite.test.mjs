// The API-token source is cited at the Authorization header read. The rule's loop variable is not the call it keys on,
// so citing that variable pointed at the method's first call (a `new` row since contract 8). The first getHeader is the
// tenant header, not the token.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { userSourcesOf } from '../engine/scan/security.mjs';

test('API token: cited at the getHeader line, not the first call of the method', () => {
  const type = {
    name: 'TenantAwareBasicAuthenticationFilter',
    file: 'f/TenantAwareBasicAuthenticationFilter.java',
    methods: [
      {
        name: 'doFilterInternal',
        calls: [
          { name: '<init>', kind: 'new', line: 102, args: [] },
          { name: 'getHeader', line: 113, args: ['TENANT_ID_REQUEST_HEADER'] },
          { name: 'getHeader', line: 133, args: ['"Authorization"'] },
          { name: 'setAuthentication', line: 157, args: ['null'] },
        ],
      },
    ],
  };
  const model = { types: new Map([[type.name, type]]) };
  const [source] = userSourcesOf(model, []).filter((u) => u.kind === 'API token');
  assert.deepEqual(source.cites, ['f/TenantAwareBasicAuthenticationFilter.java:133']);
});
