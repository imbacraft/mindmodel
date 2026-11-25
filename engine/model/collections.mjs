// Map of lists: appends in place, so a loop of pushes stays linear.
import assert from 'node:assert';

// Appends `value` to the list under `key`, creating the list on first use.
export function push(map, key, value) {
  (map.get(key) ?? map.set(key, []).get(key)).push(value);
}

{
  const m = new Map();
  push(m, 'a', 1);
  push(m, 'b', 2);
  push(m, 'a', 3);
  assert.deepStrictEqual([...m], [['a', [1, 3]], ['b', [2]]]);
}
