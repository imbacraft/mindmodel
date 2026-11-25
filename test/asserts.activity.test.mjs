// Import-time self-checks moved out of engine/activity.mjs (Task 9); the assertions are unchanged.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { count, sinceCutoff } from '../engine/core/git-log.mjs';

test('count: a rename maps the old path to its current name', () => {
  assert.deepStrictEqual(
    count(
      '@@a\nM\tsrc/new/A.java\n@@b\nR100\tsrc/old/A.java\tsrc/new/A.java\n@@c\nM\tsrc/old/A.java\n@@d\nM\tREADME.md',
      ['src/new'],
    ),
    { commits: 3, of: 4 },
  );
});

test('sinceCutoff: a bare date is pinned to midnight UTC', () => {
  assert.equal(sinceCutoff('2026-05-23'), '2026-05-23T00:00:00Z');
});
