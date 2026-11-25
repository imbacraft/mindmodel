// Name and path helpers the engine shares. Each one replaces copies that behaved the same on every input.
import assert from 'node:assert';

// The last segment of a qualified name (`a.b.C` -> `C`); empty for nothing.
export const simple = (name) => String(name ?? '').split('.').pop();

// Test code by path: the Java layouts `src/test/`, `src/it/` and `src/integrationTest/`.
export const isTestPath = (p) => /\/src\/(test|it|integrationTest)\//.test(p ?? '');
// The scan's rule: the same as `isTestPath` without `src/integrationTest/`, kept as it was.
export const isSrcTestOrItPath = (p) => /\/src\/(test|it)\//.test(p ?? '');
// `src/test/` alone: the folder the Java model and the resource scans leave out.
export const isSrcTestPath = (p) => /\/src\/test\//.test(p ?? '');

{
  assert.equal(simple('a.b.Order'), 'Order');
  assert.equal(simple('Order'), 'Order');
  assert.equal(simple(null), '');
  assert.equal(simple(undefined), '');
  assert.equal(isTestPath('svc/src/integrationTest/java/A.java'), true);
  assert.equal(isSrcTestOrItPath('svc/src/integrationTest/A.java'), false);
  assert.equal(isSrcTestOrItPath('svc/src/it/A.java'), true);
  assert.equal(isSrcTestPath('svc/src/it/A.java'), false);
  assert.equal(isSrcTestPath('svc/src/test/A.java'), true);
  assert.equal(isSrcTestPath(undefined), false);
}
