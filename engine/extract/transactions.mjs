// L5: transactions. Which methods run in a transaction, which start their own, and the four ways the boundary leaks:
// an outside call inside a transaction, an outside call before a save with no transaction, work deferred to after
// commit, and an observer that runs after success. Everything here is a model link, not a regex over the text.
import assert from 'node:assert';
import { annotationIndex, listOf, meanHit, patternOf, simpleMeans } from '../catalogs/catalog.mjs';
import { citeOf, factOf, methodIdOf, withUniqueIds } from './facts.mjs';
import { parseCite } from '../core/cite.mjs';

const NO_TX = patternOf('no-transaction-args');
const EJB_BEAN = listOf('ejb-bean-annotations');

// The catalog meaning of one annotation, at a placement; `inferred` when only a simple name matched.
function meaning(model, type, ann, on, index) {
  const fqn = ann.fqn ?? null;
  const hit = meanHit(index, fqn, on);
  if (hit) return { ...hit, how: fqn ? 'resolved' : 'inferred' };
  const hits = simpleMeans(index, (ann.name ?? '').split('.').pop(), on);
  return hits.length === 1 ? { ...hits[0], how: 'inferred' } : null;
}

// Every method a call can lead to, one or two hops out, staying inside the project. The id index is built once per
// scan and passed in: rebuilding it per method was quadratic on fineract.
// `deferred` holds the methods that register after-commit work: what they hand over runs after the commit, so the
// walk does not continue through them.
function reachable(byId, start, depth = 2, deferred = new Set()) {
  const seen = new Set([start.id]);
  const out = [{ type: start.type, method: start.method }];
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const { method } of frontier)
      for (const call of method.calls ?? [])
        for (const id of call.targets ?? []) {
          if (seen.has(id) || !byId.has(id) || deferred.has(id)) continue;
          seen.add(id);
          const hit = byId.get(id);
          out.push(hit);
          next.push(hit);
        }
    frontier = next;
  }
  return out;
}

export function extractTransactions(model, selected, { outside = [], writes = [] } = {}) {
  const index = annotationIndex(selected);
  const byId = model.methodsById;
  // A method that registers after-commit work (a catalog `means: after-commit` call) defers whatever it hands over.
  const afterCommitCalls = [];
  for (const { catalog } of selected)
    for (const c of catalog.calls ?? []) if (c.means === 'after-commit') afterCommitCalls.push(c);
  const deferred = new Set();
  for (const t of model.types.values())
    for (const m of t.methods)
      if (
        (m.calls ?? []).some((c) =>
          afterCommitCalls.some((e) => (e.types ?? [e.type]).includes(c.recvFqn) && (!e.methods || e.methods.includes(c.name))),
        )
      )
        deferred.add(m.id);
  const facts = [];
  // A plain `@Transactional` method is not a fact: there are thousands of them and no page can use them. The count
  // per class is what a reader needs; the boundary kinds below stay because each is a hazard with a citation.
  const counts = new Map();
  const outsideByMethod = new Map();
  for (const f of outside) if (f.method) outsideByMethod.set(f.method, [...(outsideByMethod.get(f.method) ?? []), f]);
  const writesById = new Map();
  for (const w of writes) writesById.set(w.method, [...(writesById.get(w.method) ?? []), w]);

  for (const t of model.types.values()) {
    const typeTx = (t.ann ?? [])
      .map((a) => meaning(model, t, a, 'type', index))
      .find((h) => h?.entry?.means === 'transactional');
    const ejb = (t.ann ?? []).some((a) => EJB_BEAN.has((a.name ?? '').split('.').pop()));
    const beanManaged = (t.ann ?? []).some((a) => /TransactionManagement/.test(a.name ?? '') && /BEAN/.test(a.args ?? ''));
    for (const m of t.methods) {
      if (!m.id) continue;
      const own = (m.ann ?? [])
        .map((a) => ({ hit: meaning(model, t, a, 'method', index), ann: a }))
        .find((x) => x.hit?.entry?.means === 'transactional');
      const off = (m.ann ?? []).some((a) => NO_TX.test(a.args ?? ''));
      const transactional = !off && (!!own || (!!typeTx && m.isPublic) || (ejb && !beanManaged && m.isPublic));
      if (transactional) {
        const requiresNew = /REQUIRES_NEW/.test(own?.ann?.args ?? '') || /REQUIRES_NEW/.test(typeTx?.entry?.means ?? '');
        if (!requiresNew) {
          counts.set(t.fqn, (counts.get(t.fqn) ?? 0) + 1);
        } else
        facts.push(
          factOf({
            id: `transaction:${requiresNew ? 'requires-new' : 'transactional'}@${m.id}`,
            family: 'transaction',
            confidence: own?.hit?.how ?? (ejb ? 'inferred' : 'resolved'),
            kind: requiresNew ? 'requires-new' : 'transactional',
            method: m.id,
            evidence: [citeOf(t, m)],
            why: [
              own
                ? `${own.ann.name}${own.ann.args ? `(${own.ann.args})` : ''} (${own.hit.catalog.id})`
                : ejb
                  ? `EJB bean: container-managed transaction by default`
                  : `class ${typeTx.entry ? 'has a transactional annotation' : 'is transactional'}`,
            ],
          }),
        );
      }
      // After-commit work: an annotation, a CDI observer phase, or a synchronization registered by hand.
      for (const a of m.ann ?? []) {
        const hit = meaning(model, t, a, 'method', index);
        if (hit?.entry?.means === 'after-commit')
          facts.push(
            factOf({
              id: `transaction:after-commit annotation@${m.id}`,
              family: 'transaction',
              confidence: hit.how,
              kind: 'after-commit',
              mechanism: 'annotation',
              method: m.id,
              evidence: [citeOf(t, m)],
              why: [`${a.name}${a.args ? `(${a.args})` : ''} (${hit.catalog.id})`],
            }),
          );
        if (/^Observes/.test(a.name ?? '') && /AFTER_SUCCESS/.test(a.args ?? ''))
          facts.push(
            factOf({
              id: `transaction:after-commit observer@${m.id}`,
              family: 'transaction',
              confidence: 'resolved',
              kind: 'after-commit',
              mechanism: 'observer',
              method: m.id,
              evidence: [citeOf(t, m)],
              why: [`${a.name}(${a.args}) after success`],
            }),
          );
      }
      // `TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() { afterCommit… })`
      const sync = (m.calls ?? []).find((c) => {
        const hit = (selected.flatMap((s) => s.catalog.calls ?? [])).find(
          (e) => e.means === 'after-commit' && (e.types ?? [e.type]).includes(c.recvFqn) && (!e.methods || e.methods.includes(c.name)),
        );
        return !!hit;
      });
      if (sync) {
        const after = t.methods.find((n) => n.name === 'afterCommit' && n.start >= m.start && n.end <= m.end);
        if (after)
          facts.push(
            factOf({
              id: `transaction:after-commit synchronization@${m.id}`,
              family: 'transaction',
              confidence: 'resolved',
              kind: 'after-commit',
              mechanism: 'synchronization',
              method: m.id,
              runs: (after.calls ?? []).flatMap((c) => c.targets ?? []),
              evidence: [citeOf(t, m), citeOf(t, after)],
              why: [`${sync.name} at :${sync.line}, afterCommit at :${after.start}`],
            }),
          );
      }
      // The seam: an outside call inside a transaction, directly or through a project target.
      if (transactional) {
        const reached = reachable(byId, { type: t, method: m }, 2, deferred);
        const outs = reached.flatMap(({ type, method }) =>
          (outsideByMethod.get(method.id) ?? []).map((f) => ({ ...f, via: method === m || method.name === m.name ? null : `${type.name}.${method.name}` })),
        );
        const unique = new Map(outs.map((o) => [o.id, o]));
        if (unique.size)
          facts.push(
            factOf({
              id: `transaction:outside-in-transaction@${m.id}`,
              family: 'transaction',
              confidence: [...unique.values()].every((o) => o.confidence === 'resolved') ? 'resolved' : 'inferred',
              kind: 'outside-in-transaction',
              method: m.id,
              // The project hop first: "DashboardService.createOrUpdateDashboard -> RestTemplate.postForEntity". The
              // client alone says where it leaves the process, not which service made the call, and the line is cut.
              outside: [...unique.values()].map(
                (o) => `${o.via ? `${o.via} → ` : ''}${o.target}${o.line ? ` at :${o.line}` : ''}`,
              ),
              evidence: [citeOf(t, m), ...new Set([...unique.values()].map((o) => `${o.evidence[0]}`))],
              why: ['the method runs in a transaction and reaches an outside client inside it'],
            }),
          );
      }
      // The seam without a transaction: an outside call, then a save, in one public method.
      if (!transactional && m.isPublic) {
        const direct = (outsideByMethod.get(m.id) ?? []).map((f) => ({ f, line: f.line ?? lineOf(f) })).filter((x) => x.line);
        const saves = (writesById.get(m.id) ?? []).map((w) => ({ w, line: w.line ?? lineOf(w) })).filter((x) => x.line);
        if (direct.length && saves.length && Math.min(...direct.map((x) => x.line)) < Math.max(...saves.map((x) => x.line)))
          facts.push(
            factOf({
              id: `transaction:outside-then-save@${m.id}`,
              family: 'transaction',
              confidence: 'resolved',
              kind: 'outside-then-save',
              method: m.id,
              outside: direct.map((x) => `${x.f.target} at :${x.line}`),
              saves: saves.map((x) => `${x.w.operation} ${x.w.entity ?? ''} at :${x.line}`.trim()),
              evidence: [citeOf(t, m), ...new Set([...direct.map((x) => x.f.evidence[0]), ...saves.map((x) => x.w.evidence[0])])],
              why: ['no transaction: the outside call happens before the database write'],
            }),
          );
      }
    }
  }
  const byClass = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return { facts: withUniqueIds(facts), counts: byClass };
}

const lineOf = (f) => parseCite(f.evidence?.[0])?.start || null;

{
  // A project with one transactional method that calls an HTTP client, one afterCommit registration, and one
  // non-transactional public method that calls outside and then saves.
  const model = {
    types: new Map([
      [
        'a.Svc',
        {
          fqn: 'a.Svc',
          file: 'a/Svc.java',
          name: 'Svc',
          ann: [],
          methods: [
            {
              id: 'a.Svc#pay()',
              name: 'pay',
              start: 5,
              end: 20,
              isPublic: true,
              ann: [{ name: 'Transactional', fqn: 'org.springframework.transaction.annotation.Transactional', args: '', line: 4 }],
              calls: [{ kind: 'call', name: 'exchange', recvFqn: 'org.springframework.web.client.RestTemplate', recvHow: 'field', targets: [], line: 7 }],
            },
            {
              id: 'a.Svc#store(Order)',
              name: 'store',
              start: 22,
              end: 30,
              isPublic: true,
              ann: [],
              calls: [
                { kind: 'call', name: 'send', recvFqn: 'org.springframework.kafka.core.KafkaTemplate', recvHow: 'field', targets: [], line: 24 },
                { kind: 'call', name: 'save', recvFqn: 'a.OrderRepository', recvHow: 'field', targets: ['a.OrderRepository#save(Order)'], line: 26 },
              ],
            },
            {
              id: 'a.Svc#later()',
              name: 'later',
              start: 40,
              end: 52,
              isPublic: true,
              ann: [],
              calls: [
                {
                  kind: 'call',
                  name: 'registerSynchronization',
                  recvFqn: 'org.springframework.transaction.support.TransactionSynchronizationManager',
                  recvHow: 'static',
                  targets: [],
                  line: 42,
                },
              ],
            },
            {
              // Transactional, and it hands its work to the after-commit registration: not a seam.
              id: 'a.Svc#run()',
              name: 'run',
              start: 55,
              end: 60,
              isPublic: true,
              ann: [{ name: 'Transactional', fqn: 'org.springframework.transaction.annotation.Transactional', args: '', line: 54 }],
              calls: [{ kind: 'call', name: 'later', targets: ['a.Svc#later()'], line: 56 }],
            },
            { id: 'a.Svc#afterCommit()', name: 'afterCommit', start: 44, end: 46, ann: [], calls: [{ kind: 'call', name: 'persist', targets: ['a.Svc#persist()'] }] },
            { id: 'a.Svc#persist()', name: 'persist', start: 48, end: 50, ann: [], calls: [] },
          ],
        },
      ],
    ]),
  };
  const selected = [
    {
      catalog: {
        id: 'spring-tx',
        annotations: [{ fqn: 'org.springframework.transaction.annotation.Transactional', means: 'transactional' }],
        calls: [
          {
            types: ['org.springframework.transaction.support.TransactionSynchronizationManager'],
            methods: ['registerSynchronization'],
            means: 'after-commit',
          },
        ],
      },
    },
  ];
  model.methodsById = new Map(
    [...model.types.values()].flatMap((t) => t.methods.filter((m) => m.id).map((m) => [m.id, { type: t, method: m }])),
  );
  const outside = [
    { id: 'o1', family: 'outside-call', kind: 'HTTP', client: 'RestTemplate', target: 'RestTemplate.exchange', method: 'a.Svc#pay()', evidence: ['a/Svc.java#pay'], confidence: 'resolved' },
    { id: 'o2', family: 'outside-call', kind: 'Kafka', client: 'KafkaTemplate', target: 'KafkaTemplate.send', method: 'a.Svc#store(Order)', evidence: ['a/Svc.java:24#store'], confidence: 'resolved' },
    // The work handed to the after-commit registration: it runs after the commit, so it is not inside the transaction.
    { id: 'o3', family: 'outside-call', kind: 'HTTP', client: 'RestTemplate', target: 'RestTemplate.exchange', method: 'a.Svc#afterCommit()', evidence: ['a/Svc.java:45#afterCommit'], confidence: 'resolved' },
  ];
  const writes = [{ id: 'w1', family: 'state-write', entity: 'a.Order', repository: 'a.OrderRepository', operation: 'save', method: 'a.Svc#store(Order)', evidence: ['a/Svc.java:26#store'], confidence: 'resolved' }];
  const { facts, counts } = extractTransactions(model, selected, { outside, writes });
  const kinds = facts.map((f) => f.kind).sort();
  assert.deepStrictEqual(kinds, ['after-commit', 'outside-in-transaction', 'outside-then-save']);
  // The plain transactional methods are a count per class, not facts.
  assert.deepStrictEqual(counts, [{ type: 'a.Svc', count: 2 }]);
  // `run` reaches the outside call only through the registration: deferred work, never a seam.
  assert.ok(!facts.some((f) => f.method === 'a.Svc#run()'), 'the walk stops at an after-commit registration');
  const sync = facts.find((f) => f.mechanism === 'synchronization');
  assert.deepStrictEqual(sync.runs, ['a.Svc#persist()']);
  assert.deepStrictEqual(facts.find((f) => f.kind === 'outside-then-save').saves, ['save a.Order at :26']);
}
