import { listOf } from '../../../catalogs/catalog.mjs';
import { simple } from '../../../core/names.mjs';
import { targetIds } from '../../../model/targets.mjs';
import { callById, memberAt, simpleType } from '../flow/dump.mjs';
import { identityStores } from '../flow/stores.mjs';
import { isIdentityType } from './types.mjs';

// The caller slots: a field, or a project method's parameter, that carries the authenticated caller itself.
const CALLER_SIMPLE = listOf('caller-types');

/**
 * The identity sinks a reach performs, each with the value it stores: the security context made current, a holder of
 * the project's own type (`ThreadLocal<User>`, `ThreadLocal<ResolvedTenantContext>`), a caller-typed field, or a
 * project method handed the caller. A ThreadLocal<String> is a user source and never a sink: the element type decides.
 */
export function securitySinks(entryId, q, db, model, holders) {
  const sinks = [];
  const { methods } = q.reach(entryId, 2);
  for (const { id } of methods) {
    const member = memberAt(db, id);
    if (!member) continue;
    const label = `${simple(member.owner)}#${member.name}`;
    const params = member.params ?? [];
    for (const store of identityStores(q, id, db)) {
      const args = store.args ?? callById(db, store.call)?.args ?? [];
      if (store.kind === 'security-context') {
        const recv = callById(db, store.call)?.recv?.typeFqn;
        sinks.push({
          method: label,
          what:
            `${store.unresolved ? 'unresolved:' : ''}${simpleType(recv ?? 'SecurityContext')}.` +
            `${store.how ?? 'setAuthentication'}`,
          cite: `${store.file}:${store.line}`,
          arg: args[0] ?? null,
        });
        continue;
      }
      if (store.kind !== 'holder') continue; // a request attribute is a user source, not a security sink
      const holder = store.field ? holders.find((h) => h.field === store.field) : null;
      if (!holder) {
        // A store found by shape: the holder's type is in no jar this run could read, so its element is unknown.
        // That is
        // an inferred sink, not a silence — the store is real and the value it carries may be the caller.
        if (store.via !== 'try-finally-pattern') continue;
        sinks.push({
          method: label,
          what: `thread-local ${simpleType(store.holder)} (element unresolved)`,
          cite: `${store.file}:${store.line}`,
          arg: args[0] ?? null,
          element: 'unresolved',
          holderType: store.holder,
          confidence: 'inferred',
          // Evidence, not an accusation: with the element unknown the engine cannot tell a caller from a tenant, and a
          // warning that says "any client can claim that identity" about a tenant store would be wrong.
          inferred: true,
        });
        continue;
      }
      if (!isIdentityType(model, holder.element, db)) continue;
      // A setter that only forwards its own parameter is not the sink: its call sites are. Counting both would make two
      // warnings for one store, but dropping the sink entirely loses the path — the caller builds the value from a
      // cookie (`Ctx.builder().systemUser(system)`), and that cookie is the acting identity too.
      if (args[0]?.kind === 'param' && params[args[0].index]?.name === args[0].text) {
        for (const caller of methods) {
          const owner = memberAt(db, caller.id);
          if (!owner) continue;
          const callerLabel = `${simple(owner.owner)}#${owner.name}`;
          for (const c of db.callsOf(caller.id)) {
            if (!targetIds(c).includes(id)) continue;
            sinks.push({
              method: callerLabel,
              what: `thread-local ${String(store.field).split('#').pop()} (${simpleType(holder.element)})`,
              cite: `${c.file}:${c.line}`,
              arg: db.argsOf(c.id)[args[0].index] ?? null,
              holderType: holder.owner,
              // Evidence, not an accusation: a sink moved to a call site would otherwise accuse a filter whose
              // verification call the dump could not type (`manager.authenticate(...)`): a wrong claim on two real
              // apps.
              inferred: true,
            });
          }
        }
        continue;
      }
      sinks.push({
        method: label,
        what: `thread-local ${String(store.field).split('#').pop()} (${simpleType(holder.element)})`,
        cite: `${store.file}:${store.line}`,
        arg: args[0] ?? null,
        holderType: holder.owner,
      });
    }
    // A field of the caller type (`Authentication`, `Principal`) the method assigns: the dump's own field write.
    for (const f of db.fields ?? [])
      if (f.method === id && f.op === 'write' && f.field) {
        const field = db.members.get(f.field);
        if (!CALLER_SIMPLE.has(simpleType(field?.type ?? field?.typeFqn ?? ''))) continue;
        sinks.push({
          method: label,
          what: `field ${String(f.field).split('#').pop()} (${simpleType(field?.type)})`,
          cite: `${f.file}:${f.line}`,
          arg: f.value ?? null,
        });
      }
    // A call handing the value to a project method whose parameter is the caller, or whose own parameter it stores
    // in a holder of a project type (`setResolvedContext(new ResolvedTenantContext(user))`).
    for (const c of db.callsOf(id))
      for (const target of targetIds(c)) {
        const hit = memberAt(db, target);
        if (!hit || hit.kind !== 'method') continue;
        const callerAt = (hit.params ?? []).findIndex((p) => CALLER_SIMPLE.has(simpleType(p.type)));
        if (callerAt >= 0) {
          sinks.push({
            method: label,
            what: `${simple(hit.owner)}#${hit.name}(${hit.params[callerAt].name})`,
            cite: `${c.file}:${c.line}`,
            arg: c.args?.[callerAt] ?? null,
            weak: true,
          });
          continue;
        }
        const slot = projectHolderSlot(hit, c, q, db, model);
        if (slot)
          sinks.push({
            method: label,
            what: `${simple(hit.owner)}#${hit.name}(${slot.name})`,
            cite: `${c.file}:${c.line}`,
            arg: slot.arg,
            weak: true,
          });
      }
  }
  // A holder the reach typed one frame down makes the shape-found sink for the same holder redundant, and its
  // `(element unresolved)` label false: the element is in the dump.
  const typed = new Set(sinks.filter((s) => !s.inferred && s.holderType).map((s) => s.holderType));
  return typed.size ? sinks.filter((s) => !(s.inferred && s.holderType && typed.has(s.holderType))) : sinks;
}

/**
 * The parameter of a project method that stands for an identity: it is stored into a holder of the project's own type,
 * and the value at this call site is built here — `new UserContext(user)` is the client's id becoming an identity. A
 * record the method looked up (`setTenant(tenant)`) is a tenant-source fact, not an identity.
 */
export function projectHolderSlot(hit, call, q, db, model) {
  const params = hit.params ?? [];
  for (const store of q.stores(hit.id, 0).stores) {
    if (store.kind !== 'holder' || store.op === 'clear') continue;
    const holder = q.holders().holders.find((h) => h.field === store.field);
    if (!holder || !isIdentityType(model, holder.element, db)) continue;
    const args = callById(db, store.call)?.args ?? [];
    if (args[0]?.kind !== 'param') continue; // the method builds its own value: found in its own body
    const built = builtValue(q, call, args[0].index, db, model);
    if (built) return { name: params[args[0].index]?.name ?? '_', arg: built };
  }
  return null;
}

/** The project value built at a call site: the dump says `new` and names the created type. */
export const builtValue = (q, call, i, db, model) => {
  for (const { value } of q.argValue(call, i).values)
    if (value.kind === 'new' && isIdentityType(model, value.created ?? value.typeFqn, db)) return value;
  return null;
};
