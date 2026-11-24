// Import-time self-checks moved out of engine/preflight.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert';
import { javaMajor, parseBranchLine } from '../engine/preflight.mjs';

test('parseBranchLine: ahead/behind and no upstream', () => {
  assert.deepStrictEqual(parseBranchLine('## main...origin/main [ahead 1, behind 3]'), {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 3,
  });
  assert.deepStrictEqual(parseBranchLine('## feature/x'), { branch: 'feature/x', upstream: null, ahead: 0, behind: 0 });
});

test('javaMajor: no java on the PATH is null', () => {
  assert.equal(javaMajor({ PATH: '' }), null);
});
