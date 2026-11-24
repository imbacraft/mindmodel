// Import-time self-checks moved out of engine/system.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert';
import { resolve, messaging, jakartaJms, channelName, restCalls, gatewayRoutes } from '../engine/system.mjs';

test('resolve: a placeholder resolves from config, else its default', () => {
  assert.deepStrictEqual(resolve('${t.orders:orders}', new Map()), { name: 'orders', via: 't.orders default' });
  assert.deepStrictEqual(resolve('${t.orders}', new Map([['t.orders', { value: 'orders-v2' }]])), {
    name: 'orders-v2',
    via: 't.orders',
  });
  assert.deepStrictEqual(resolve('${t.x}', new Map()), { name: null, unresolved: 't.x' });
});

test('messaging: built-in patterns find channel expressions, streams are not messaging', () => {
  const t =
    '@KafkaListener(id = "o", topics = "orders", groupId = "p")\ntemplate.send("payment-orders", id, o);\nbuilder.stream("stock-orders").to("orders");\n@JmsListener(destination = "${q.audit:audit}")\njmsTemplate.convertAndSend("invoices", x);\n.fromChannel(KitchenServiceChannels.COMMAND_CHANNEL)\ndomainEventPublisher.publish(Consumer.class, id, events);\n.andForAggregateType(K.CH)';
  assert.deepStrictEqual(
    messaging('StreamSupport.stream(result.spliterator(), false)\nlist.stream().map(x).collect(toList())').length,
    0,
  );
  assert.deepStrictEqual(
    messaging(t).map((x) => `${x.kind}:${x.dir}:${x.expr}`),
    [
      'kafka:in:"orders"',
      'kafka:out:"payment-orders"',
      'kafka:in:"stock-orders"',
      'kafka:out:"orders"',
      'jms:in:"${q.audit:audit}"',
      'jms:out:"invoices"',
      'kafka:in:KitchenServiceChannels.COMMAND_CHANNEL',
      'kafka:out:Consumer.class',
      'kafka:in:K.CH',
    ],
  );
});

test('jakartaJms: an MDB destination and a JNDI-injected sender', () => {
  assert.deepStrictEqual(
    jakartaJms(
      '@MessageDriven(activationConfig = {\n  @ActivationConfigProperty(\n    propertyName = "destinationLookup",\n    propertyValue = "java:app/jms/Q")})\nclass C {}',
    ),
    [{ kind: 'jms', dir: 'in', name: 'java:app/jms/Q', line: 3 }],
  );
  assert.deepStrictEqual(
    jakartaJms(
      '@Resource(lookup = "java:app/jms/Q")\nprivate Destination q;\nvoid f() { ctx.createProducer()\n  .send(q, x); }',
    ),
    [{ kind: 'jms', dir: 'out', name: 'java:app/jms/Q', line: 4 }],
  );
});

test('channelName: constant, aggregate publisher, class and @Value injection', () => {
  const ix = {
    constants: new Map([['K.CH', 'kitchenService']]),
    fqn: new Map([['Ticket', 'a.b.Ticket']]),
    aggregateOf: new Map([['TicketPub', 'Ticket']]),
  };
  assert.equal(channelName({ expr: 'K.CH' }, '', new Map(), ix).name, 'kitchenService');
  assert.equal(
    channelName({ expr: 'ticket', publisher: true, recv: 'pub' }, 'private TicketPub pub;', new Map(), ix).name,
    'a.b.Ticket',
  );
  assert.equal(channelName({ expr: 'Ticket.class' }, '', new Map(), ix).name, 'a.b.Ticket');
  assert.equal(
    channelName(
      { expr: 'queueName' },
      '@Value("${risk.queueName}")\n\tprivate String queueName;',
      new Map([['risk.queueName', { value: 'risk-q' }]]),
      ix,
    ).name,
    'risk-q',
  );
});

test('restCalls: url, Feign client and discovery hosts', () => {
  assert.deepStrictEqual(
    restCalls(
      '.uri("http://customers-service/owners/{id}")\n@FeignClient(name = "billing")\ndiscoveryClient.getInstances("customers-service").get(0)',
    ).map((x) => `${x.host}${x.path}`),
    ['customers-service/owners/{id}', 'billing', 'customers-service'],
  );
});

test('gatewayRoutes: lb:// host with its path predicates', () => {
  assert.deepStrictEqual(gatewayRoutes('uri: lb://vets-service\n  predicates:\n    - Path=/api/vet/**'), [
    { host: 'vets-service', line: 1, paths: ['/api/vet/**'] },
  ]);
});
