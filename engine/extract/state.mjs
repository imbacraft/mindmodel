// L5: state. Who mutates each entity, through which repository, and where the code caches a value. A write is a call
// on a repository-typed receiver whose target (or name) mutates: the entity is the repository's type argument, so the
// fact says what changed, not just that something was called.
import assert from 'node:assert';
import { annotationIndex, meanHit, typeIndex } from '../catalogs/catalog.mjs';
import { typeArgsOf } from '../model/type-args.mjs';
import { citeOf, factOf, withUniqueIds } from './facts.mjs';

const WRITE = /^(save|saveAll|saveAndFlush|delete|deleteAll|deleteById|deleteBy|remove|removeIf|update|insert|persist|merge|flush)/;
const CACHE_ACTION = { Cacheable: 'read', CachePut: 'write', CacheEvict: 'evict' };

// The repository's entity: the first type argument of the catalog supertype it extends (`JpaRepository<Order, Long>`).
function entityOf(model, type) {
  for (const s of type.supers ?? []) {
    const args = typeArgsOf(s.text);
    if (!args.length) continue;
    // The entity is the first type argument, unless the repository is keyed differently (e.g. <Id, Entity>).
    for (const a of args) {
      const fqn = model.resolveIn(type.file, a);
      if (fqn && model.types.has(fqn)) return fqn;
    }
  }
  return null;
}

// A generic repository in an abstract base (`GenericRepo<T>`, written on the receiver's field): the entity is the
// class's own type parameter, and only the binding at a concrete subclass says which entity that is. The fact names
// the parameter and its owner; the flow substitutes them along the super hop.
function varEntityOf(model, type, method, call) {
  const recv = call.recv?.kind === 'name' ? call.recv.text : null;
  if (!recv) return null;
  const written =
    (method.params ?? []).find((p) => p.name === recv)?.type ??
    (method.locals ?? []).find((l) => l.name === recv)?.type ??
    (type.fields ?? []).find((f) => f.name === recv)?.type;
  const [arg] = typeArgsOf(written);
  const name = String(arg ?? '').trim();
  return name && (type.typeParams ?? []).includes(name) ? name : null;
}

export function extractState(model, selected) {
  const types = typeIndex(selected);
  // The repository test runs for every call on a project type: compute the answer once for the whole model.
  const repoTypes = new Set();
  for (const t of model.types.values())
    if ([t.fqn, ...(t.supers ?? []).map((x) => x.fqn)].some((f) => f && types.has(f) && types.get(f).entry.means === 'repository'))
      repoTypes.add(t.fqn);
  const repo = (t) => !!t && repoTypes.has(t.fqn);
  // A JPA EntityManager mutates too, with no repository in sight: the operation is a fact even when the entity is not
  // visible from the call (a `persist(local)` names a local, not a type).
  const em = new Map();
  for (const { catalog } of selected)
    for (const entry of catalog.calls ?? [])
      if (entry.means === 'state-write')
        for (const type of entry.types ?? [entry.type]) em.set(type, new Set(entry.methods ?? []));
  const index = annotationIndex(selected);
  const facts = [];
  for (const t of model.types.values()) {
    for (const m of t.methods)
      for (const call of m.calls ?? []) {
        if (call.recvFqn && em.has(call.recvFqn) && em.get(call.recvFqn).has(call.name)) {
          facts.push(
            factOf({
              id: `state:write unknown ${call.name}(${call.args?.[0] ?? ''})@${m.id}`,
              family: 'state-write',
              confidence: 'inferred',
              repository: call.recvFqn,
              operation: call.name,
              method: m.id,
              line: call.line,
              evidence: [citeOf(t, m)],
              why: [`receiver ${call.recvFqn} is the JPA EntityManager; the entity comes from an argument, not the call`],
            }),
          );
          continue;
        }
        if (!call.recvFqn || !model.types.has(call.recvFqn) || !repo(model.types.get(call.recvFqn))) continue;
        const entity = entityOf(model, model.types.get(call.recvFqn));
        const entityVar = entity ? null : varEntityOf(model, t, m, call);
        const mutating = WRITE.test(call.name) || (call.targets ?? []).some((id) => WRITE.test(id.slice(id.indexOf('#') + 1)));
        if (!mutating) continue;
        facts.push(
          factOf({
            id: `state:write ${entity ?? 'unknown'} ${call.name}(${call.args?.[0] ?? ''})@${m.id}`,
            family: 'state-write',
            confidence: entity && call.targets?.length ? 'resolved' : 'inferred',
            ...(entity ? { entity } : {}),
            ...(entityVar ? { entityVar, entityOwner: t.fqn } : {}),
            repository: call.recvFqn,
            operation: call.name,
            method: m.id,
            line: call.line,
            evidence: [citeOf(t, m)],
            why: [
              `receiver ${call.recvFqn} is a repository (${(types.get(call.recvFqn) ?? types.get(model.types.get(call.recvFqn).supers?.find((s) => s.fqn && types.has(s.fqn))?.fqn))?.catalog.id ?? 'catalog'})`,
              entity
                ? `entity ${entity} from the repository's type argument`
                : entityVar
                  ? `entity is the type parameter ${entityVar} of ${t.name}; the binding names it`
                  : 'no entity: the type argument did not resolve',
            ],
          }),
        );
      }
    // Cache annotations: a read-through, a refresh or an eviction is state the engine can name.
    for (const m of t.methods)
      for (const a of m.ann ?? []) {
        const hit = meanHit(index, a.fqn, 'method');
        if (hit?.entry?.means !== 'cache') continue;
        const action = CACHE_ACTION[(a.fqn ?? a.name).split('.').pop()];
        facts.push(
          factOf({
            id: `state:cache ${action}@${m.id}`,
            family: 'state-cache',
            confidence: a.fqn ? 'resolved' : 'inferred',
            action,
            method: m.id,
            evidence: [citeOf(t, m)],
            why: [`${a.name}${a.args ? `(${a.args.slice(0, 60)})` : ''} (${hit.catalog.id})`],
          }),
        );
      }
  }
  return withUniqueIds(facts);
}

{
  const model = {
    types: new Map([
      [
        'a.OrderRepository',
        {
          fqn: 'a.OrderRepository',
          file: 'a/OrderRepository.java',
          name: 'OrderRepository',
          supers: [{ text: 'JpaRepository<Order, Long>', fqn: 'org.springframework.data.jpa.repository.JpaRepository' }],
          methods: [{ id: 'a.OrderRepository#save(Order)', name: 'save', start: 3, end: 3, params: [{ name: 'o', type: 'Order' }], ann: [], calls: [] }],
        },
      ],
      [
        'a.Svc',
        {
          fqn: 'a.Svc',
          file: 'a/Svc.java',
          name: 'Svc',
          supers: [],
          methods: [
            {
              id: 'a.Svc#accept(Order)',
              name: 'accept',
              start: 5,
              end: 9,
              ann: [{ name: 'CacheEvict', fqn: 'org.springframework.cache.annotation.CacheEvict', args: '"orders"', line: 4 }],
              calls: [
                { kind: 'call', name: 'save', recvFqn: 'a.OrderRepository', recvHow: 'field', targets: ['a.OrderRepository#save(Order)'], line: 6 },
                { kind: 'call', name: 'findById', recvFqn: 'a.OrderRepository', recvHow: 'field', targets: [], line: 7 },
              ],
            },
          ],
        },
      ],
    ]),
    resolveIn: (file, name) => (name === 'Order' ? 'a.Order' : name === 'JpaRepository' ? 'org.springframework.data.jpa.repository.JpaRepository' : null),
  };
  model.types.set('a.Order', { fqn: 'a.Order', file: 'a/Order.java', name: 'Order', supers: [], methods: [] });
  const selected = [
    {
      catalog: {
        id: 'spring-data',
        types: [{ fqn: 'org.springframework.data.jpa.repository.JpaRepository', means: 'repository' }],
        annotations: [{ fqn: 'org.springframework.cache.annotation.CacheEvict', means: 'cache' }],
      },
    },
  ];
  const facts = extractState(model, selected);
  assert.deepStrictEqual(
    facts.map((f) => [f.family, f.entity ?? f.action]),
    [
      ['state-write', 'a.Order'],
      ['state-cache', 'evict'],
    ],
  );
  assert.equal(facts[0].operation, 'save');
  // A read on the repository (`findById`) is not a write.
  assert.equal(facts.length, 2);
}
