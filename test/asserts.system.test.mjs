// Import-time self-checks moved out of engine/system.mjs (Task 9), now over a dump: the messaging listener annotations,
// the Kafka/JMS/Eventuate calls with their folded channel arguments, the Jakarta EE JNDI destinations, the channel-name
// resolution, and the REST calls a service makes. The Java lives on disk (test-support/fixtures/system-messaging).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dumpOfLayers, NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';
import { BUILTIN, channelName, codeIndex, jakartaJms, messaging, resolve } from '../engine/system/messaging.mjs';
import { gatewayRoutes, restCalls } from '../engine/system/rest.mjs';

const module_ = () => {
  const { db, model } = dumpOfLayers(['system-messaging']);
  return { db, model, types: [...model.types.values()], prefix: '' };
};
const ix = () => codeIndex(module_().model);

test('resolve: a placeholder resolves from config, else its default', () => {
  assert.deepStrictEqual(resolve('${t.orders:orders}', new Map()), { name: 'orders', via: 't.orders default' });
  assert.deepStrictEqual(resolve('${t.orders}', new Map([['t.orders', { value: 'orders-v2' }]])), {
    name: 'orders-v2',
    via: 't.orders',
  });
  assert.deepStrictEqual(resolve('${t.x}', new Map()), { name: null, unresolved: 't.x' });
});

test('messaging: a listener annotation, a template send, a stream and a saga channel', { skip: NO_ENGINE }, () => {
  const rows = messaging(module_())
    .map((x) => `${x.kind}:${x.dir}:${x.expr}`)
    .sort();
  assert.deepStrictEqual(rows, [
    'jms:in:"${audit.queue:audit}"', // @JmsListener's destination: a JMS listener, its placeholder kept
    'jms:out:"invoices"', // jmsTemplate.convertAndSend
    'jms:out:invoices', // context.createProducer().send(invoices, …): a JMSProducer, the channel-rules' client
    'kafka:in:"orders"', // @KafkaListener(topics = "orders")
    'kafka:in:"shop.Order"', // andForAggregateType("shop.Order")
    'kafka:in:Channels.COMMAND_CHANNEL', // fromChannel(constant)
    'kafka:in:Channels.TICKET_EVENT_CHANNEL', // forAggregateType(constant)
    'kafka:out:"payment-orders"', // kafkaTemplate.send
    'kafka:out:ticket', // the aggregate publisher's publish call, resolved below
  ].sort((a, b) => a.localeCompare(b)) );
});

test('messaging: a project publisher extends the library one and publishes to its aggregate', { skip: NO_ENGINE }, () => {
  const m = module_();
  const rows = messaging(m).filter((x) => x.kind === 'kafka' && x.dir === 'out');
  const publish = rows.find((x) => x.expr === 'ticket');
  assert.ok(publish, `the publisher call is a row: ${rows.map((r) => r.expr).join(', ')}`);
  const r = channelName(publish, m, new Map(), codeIndex(m.model));
  assert.equal(r.name, 'shop.Ticket', `the aggregate names the channel: ${JSON.stringify(r)}`);
  assert.match(r.via, /TicketDomainEventPublisher → Ticket/);
});

test('jakartaJms: an MDB destination and a JNDI-injected sender', { skip: NO_ENGINE }, () => {
  assert.deepStrictEqual(
    jakartaJms(module_()).map((x) => `${x.dir}:${x.name}`),
    ['in:java:app/jms/Orders', 'out:java:app/jms/Invoices'],
  );
});

test('channelName: a constant, a class literal and an injected placeholder', { skip: NO_ENGINE }, () => {
  const m = module_();
  const index = codeIndex(m.model);
  const key = (name) => ({ name: 'x' });
  assert.equal(
    channelName({ arg: { kind: 'constant', text: 'Channels.COMMAND_CHANNEL', value: 'kitchenCommands' }, mfile: 'src/main/java/shop/TicketService.java', file: 'src/main/java/shop/TicketService.java' }, m, key, index).name,
    'kitchenCommands',
  );
  assert.equal(
    channelName({ arg: { kind: 'field', text: 'Ticket.class' }, mfile: 'src/main/java/shop/TicketService.java', file: 'src/main/java/shop/TicketService.java' }, m, key, index).name,
    'shop.Ticket',
  );
  // `@Value("${audit.queue}")` on the field names the key a channel expression resolves through.
  const injected = channelName(
    { arg: { kind: 'field', field: 'shop.AuditListener#queueName', text: 'queueName' }, mfile: 'src/main/java/shop/AuditListener.java', file: 'src/main/java/shop/AuditListener.java' },
    m,
    key,
    index,
  );
  assert.equal(injected.unresolved, 'queueName', 'a field with no @Value is unresolved, not guessed');
});

test('restCalls: a URL literal, a Feign client and a discovery host', { skip: NO_ENGINE }, () => {
  assert.deepStrictEqual(
    restCalls(module_()).map((x) => `${x.via} ${x.host}${x.path}`).sort(),
    ['discovery visits-service', 'feign billing', 'url customers-service/owners/{id}', 'url vets-service/api/vet'].sort(),
  );
});

test('gatewayRoutes: lb:// host with its path predicates', () => {
  assert.deepStrictEqual(gatewayRoutes('uri: lb://vets-service\n  predicates:\n    - Path=/api/vet/**'), [
    { host: 'vets-service', line: 1, paths: ['/api/vet/**'] },
  ]);
});

test('the built-in rules are data: a type suffix, a method name, an annotation', () => {
  assert.ok(BUILTIN.every((r) => r.annotation || r.recv || r.name));
  assert.ok(BUILTIN.some((r) => r.annotation === 'KafkaListener' && r.arg === 'topics'));
});
