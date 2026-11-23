// L5: outside calls. A call whose receiver type a catalog names as an outside client (HTTP, mail, Kafka, RabbitMQ,
// JMS, SQS) is a fact: this method reaches the outside world, through this client. The receiver is resolved by the
// model (§5.1), so the fact follows a field, a parameter, a local or a chain alike.
import assert from 'node:assert';
import { factOf, citeOf, withUniqueIds } from './facts.mjs';

// type FQN -> [{ means, kind, methods: Set|null }]
export function callIndex(selected) {
  const byType = new Map();
  for (const { catalog } of selected)
    for (const entry of catalog.calls ?? []) {
      if (entry.means !== 'outside-call') continue;
      for (const type of entry.types ?? (entry.type ? [entry.type] : [])) {
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push({ kind: entry.kind ?? 'outside', methods: entry.methods ? new Set(entry.methods) : null });
      }
    }
  return byType;
}

export function extractOutside(model, selected) {
  const index = callIndex(selected);
  const facts = [];
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const call of m.calls ?? []) {
        const entry = index.get(call.recvFqn)?.find((e) => !e.methods || e.methods.has(call.name));
        if (!entry) continue;
        const client = call.recvFqn.split('.').pop();
        facts.push(
          factOf({
            id: `outside:${entry.kind} ${call.recvFqn}.${call.name}@${m.id}`,
            family: 'outside-call',
            confidence: 'resolved',
            kind: entry.kind,
            client,
            method: m.id,
            line: call.line,
            target: `${client}.${call.name}`,
            evidence: [citeOf(t, m)],
            why: [`receiver ${call.recvFqn} (${call.recvHow}) named an outside client by the ${entry.kind} catalog`],
          }),
        );
      }
  return withUniqueIds(facts);
}

{
  const model = {
    types: new Map([
      [
        'a.Svc',
        {
          fqn: 'a.Svc',
          file: 'a/Svc.java',
          name: 'Svc',
          methods: [
            {
              id: 'a.Svc#pay()',
              name: 'pay',
              start: 1,
              end: 5,
              calls: [
                { kind: 'call', name: 'exchange', recvFqn: 'org.springframework.web.client.RestTemplate', recvHow: 'field', targets: [] },
                { kind: 'call', name: 'log', recvFqn: 'org.slf4j.Logger', recvHow: 'field', targets: [] },
              ],
            },
          ],
        },
      ],
    ]),
  };
  const selected = [
    {
      catalog: {
        id: 'spring-web',
        calls: [
          { type: 'org.springframework.web.client.RestTemplate', methods: ['exchange', 'postForEntity'], means: 'outside-call', kind: 'HTTP' },
        ],
      },
    },
  ];
  const facts = extractOutside(model, selected);
  assert.deepStrictEqual(facts.map((f) => [f.kind, f.target, f.method]), [['HTTP', 'RestTemplate.exchange', 'a.Svc#pay()']]);
  assert.match(facts[0].why[0], /outside client/);
}
