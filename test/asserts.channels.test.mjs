// Import-time self-checks moved out of engine/extract/channels.mjs (Task 9); the assertions are unchanged.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFacts, firstString } from '../engine/extract/channels.mjs';
import { dumpOf, NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';

test('firstString: the first quoted argument, else nothing', () => {
  assert.equal(firstString(['"orders"', 'x']), '"orders"');
  assert.equal(firstString(['x']), undefined);
});

test('an aggregate subscription names the aggregate, never its quote', { skip: NO_ENGINE }, () => {
  const { model } = dumpOf({
    'src/main/java/shop/Handlers.java': `package shop;
public class Handlers {
  public Object handlers() {
    return DomainEventHandlersBuilder.forAggregateType("shop.Order").onEvent(OrderCreated.class, this::created).build();
  }
  void created(OrderCreated e) {}
}
`,
  });
  const names = channelFacts(model).filter((f) => f.via === 'aggregate').map((f) => f.channel);
  assert.deepStrictEqual(names, ['Order']);
});
