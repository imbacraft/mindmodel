// Confidence levels, best first. A fact's confidence is the weakest level among the links it rests on.
import assert from 'node:assert';

const RANK = { resolved: 0, inferred: 1, unresolved: 2 };
export const weakest = (...levels) => levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'resolved');

{
  assert.equal(weakest('resolved', 'inferred', 'resolved'), 'inferred');
  assert.equal(weakest('resolved', 'resolved'), 'resolved');
  assert.equal(weakest('inferred', 'unresolved'), 'unresolved');
}
