// Import-time self-checks moved out of engine/scan.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert';
import { normPath, routePath } from '../engine/scan.mjs';

test('routePath: React Router and Angular paths', () => {
  assert.equal(routePath('<Route path="/orders/:id" element={<Order/>} />'), '/orders/:id');
  assert.equal(routePath("  { path: '/cart', component: Cart },"), '/cart');
  assert.equal(routePath("  { path: 'users/:id', component: UserComponent },", true), '/users/:id');
  assert.equal(routePath("  { path: '', component: HomeComponent },", true), '/');
  assert.equal(routePath("  { path: 'users', component: X },"), null);
});

test('normPath: placeholders replace ids and the query string goes', () => {
  assert.strictEqual(normPath('/api/orders/${o.id}/items?x=1'), '/api/orders/{}/items');
});
