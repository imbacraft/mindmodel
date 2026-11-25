// The query layer: the one module the extractors ask about code through. Every answer comes from the dump; a question
// the dump cannot answer is `unresolved` with a reason, never a guess and never a look at Java source text.
//
// Nothing here concludes meaning — no "this is a tenant", no "this is a cookie identity". The primitives say what the
// code is shaped like; the extractor says what that shape means.
//
// What the dump cannot answer, and so what these primitives cannot either (the extractors report these, not paper over
// them):
//   - `==` / `!=` comparisons. The dump records a conditional's two branches, never its condition, so `comparedTo`
//     answers `equals`/`contains` calls only. An identity check `cookieName == NAME` is invisible to it.
//   - the index of a receiver's parameter. `recv` says `how: 'param'` and the name as written, not the index, so the
//     receiver side of a comparison is matched by name against the declaration's parameters.
//   - a local's declaration. A local is named by the call or field it was assigned from (`from`), never by its type or
//     name, so a local assigned from a literal has no id and `comparedTo` answers `no-target-id` for it.
//   - a call chained through a library type: `request.getSession().setAttribute(..)` arrives with no receiver type
//     unless the library table gives `getSession` a return type. Those calls come back as `receiver-untyped`.
import assert from 'node:assert';
import { raw, table } from '../tools/library-table.mjs';
import { targetIds } from './targets.mjs';
import { typeArgsOf } from './type-args.mjs';
import { simple } from '../core/names.mjs';

// ThreadLocal, its JDK subclass, and any project type extending either one.
const HOLDER_BASES = ['java.lang.ThreadLocal', 'java.lang.InheritableThreadLocal'];
// The framework's own context: `SecurityContextHolder.setContext(x)` or `context.setAuthentication(x)`.
const SECURITY_CONTEXT_HOLDER = 'org.springframework.security.core.context.SecurityContextHolder';
// Receivers whose `setAttribute` writes an attribute a later read of the same request can see. Data, both spellings.
const ATTRIBUTE_HOLDERS = new Set([
  'jakarta.servlet.ServletRequest',
  'jakarta.servlet.http.HttpServletRequest',
  'jakarta.servlet.http.HttpSession',
  'javax.servlet.ServletRequest',
  'javax.servlet.http.HttpServletRequest',
  'javax.servlet.http.HttpSession',
]);
// The calls that compare a value: the method names a comparison takes in Java source.
const COMPARISONS = new Set(['equals', 'equalsIgnoreCase', 'contentEquals', 'contains', 'containsKey', 'containsValue']);
// Framework calls that store a value, whose receiver may be untyped: a gap, never a `no`.
const UNTYPED_STORES = new Set(['setAttribute', 'setAuthentication', 'setContext']);

const site = (row) => ({
  method: row.method ?? null, call: row.id ?? null, file: row.file ?? null, line: row.line ?? null, col: row.col ?? null,
});
const fieldId = (row) => `${row.owner}#${row.name}`;
// A call on a ThreadLocal writes it (`set*`) or clears it (`remove`, `clear*`); anything else only reads.
const holderOp = (name) => (/^set/.test(name ?? '') ? 'write' : /^(remove|clear)/.test(name ?? '') ? 'clear' : null);

/**
 * The primitives, bound to one open dump. `db` is `engine/dump.mjs`'s `open(dir)`, or null when no engine ran: then
 * every primitive answers `unresolved` with `no-dump` rather than throwing.
 */
export function queries(db) {
  const noDump = (what) => ({ [what]: [], unresolved: [{ reason: 'no-dump', at: null }] });

  // A primitive may be handed either the call row or its id.
  let readsCache = null;
  const rowOf = (call) => (typeof call === 'string' ? db.callById(call) : (call ?? null));

  // The library table's type set: a receiver is a library type only if the generated table says so, never a regex.
  let library = null;
  const libraryTypes = () => (library ??= table().types);

  /** The ThreadLocal base a field type reaches through supertypes — the project's, or a library stub's — or null. */
  const holderBase = (fqn, seen = new Set()) => {
    if (!fqn || seen.has(fqn)) return null;
    if (HOLDER_BASES.includes(fqn)) return fqn;
    seen.add(fqn);
    const supers = db.type(fqn)?.supertypes ?? (db.library?.get(fqn)?.supers ?? []).map((f) => ({ fqn: f }));
    for (const s of supers) {
      const hit = holderBase(s.fqn, seen);
      if (hit) return hit;
    }
    return null;
  };

  /**
   * The type a call is made on when its receiver is a type rather than an object, as the dump spells it. A resolved
   * static call says `kind: 'static'`; a call on a type Spoon could not resolve — a library class with no classpath —
   * arrives as `how: 'local'` with the type's written name in `text`, so its upper-case last segment is the only
   * evidence there is: [heuristic], which is why a store it produces is `inferred` unless the classpath named the type.
   */
  const calledOnType = (c) => {
    const recv = c.recv ?? {};
    if (recv.kind === 'static' || recv.how === 'static') return recv.type ? { key: recv.type, type: recv.type } : null;
    const written = String(recv.text ?? '').replace(/<[\s\S]*$/, '').replace(/\[\]$/, '').trim();
    if (!written || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(written)) return null;
    if (!/^[A-Z]/.test(written.split('.').pop())) return null;
    return { key: written, type: written };
  };

  /**
   * The holder field a call is made on: the nearest holder field read written at or before the call on its own line.
   * `HOLDER.set(x)` writes the field row at the same column; `a.HOLDER.set(x)` puts the read before the call.
   */
  const holderReads = () => {
    if (readsCache) return readsCache;
    const map = new Map();
    for (const t of db.types.values())
      for (const m of db.membersOf(t.fqn)) {
        if (m.kind !== 'field' || !(m.modifiers ?? []).includes('static')) continue;
        if (!holderBase(m.typeFqn ?? raw(m.type))) continue;
        for (const r of db.fieldAccessOf(fieldId(m))) {
          if (r.op !== 'read') continue;
          const k = `${r.file}\u0000${r.line}`;
          map.set(k, [...(map.get(k) ?? []), r]);
        }
      }
    readsCache = map;
    return map;
  };

  const readOf = (reads, call) => {
    let best = null;
    for (const r of reads.get(`${call.file}\u0000${call.line}`) ?? [])
      if (r.col <= call.col && (!best || r.col > best.col)) best = r;
    return best;
  };

  /**
   * Methods reachable from one method through resolved targets, the entry method included at depth 0, breadth first.
   * A call that never resolved is listed in `unresolved`: the reach may be missing a step there.
   */
  const reach = (methodId, depth = 2) => {
    if (!db) return noDump('methods');
    const methods = [{ id: methodId, depth: 0 }];
    const seen = new Set([methodId]);
    const gaps = [];
    let frontier = [methodId];
    // Every method the reach holds is looked at, its own calls included: a call that never resolved is a gap in the
    // reach whether or not the depth allows following it further.
    for (let d = 0; d <= depth && frontier.length; d++) {
      const next = [];
      for (const id of frontier)
        for (const c of [...db.callsOf(id), ...db.methodRefsIn(id)]) {
          const reached = targetIds(c);
          if (!reached.length) {
            if (c.origin === 'unresolved' || c.origin === 'error')
              gaps.push({ ...site(c), name: c.name, owner: id, depth: d, reason: c.reason ?? c.origin });
            continue;
          }
          if (d === depth) continue;
          for (const t of reached)
            if (!seen.has(t)) {
              seen.add(t);
              next.push(t);
              methods.push({ id: t, depth: d + 1 });
            }
        }
      frontier = next;
    }
    return { methods, unresolved: gaps };
  };

  /**
   * The value of one argument: a `param` is followed to every caller's argument at that index, one hop by default.
   * Every value comes back with the call site it was read at; a path that is unresolved is reported, and a value left
   * as a `param` because the hops ran out says `stopped: 'depth'` so nothing looks resolved that is not.
   */
  const argValue = (call, i, depth = 1) => {
    if (!db) return noDump('values');
    const row = rowOf(call);
    if (!row) return { values: [], unresolved: [{ reason: 'no-call', at: null }] };
    const arg = db.argsOf(row.id)[i];
    const at = { ...site(row), arg: i };
    if (arg === undefined) return { values: [], unresolved: [{ reason: 'no-argument', at }] };
    const out = { values: [], unresolved: [] };
    const take = (value, method, left, where) => {
      if (!value) return out.unresolved.push({ reason: 'no-value', at: where });
      if (value.kind === 'unresolved') return out.unresolved.push({ reason: value.reason ?? 'unresolved', at: where });
      if (value.kind !== 'param') return out.values.push({ value, at: where });
      // A lambda's own parameter is not the enclosing method's: no call site can supply it.
      if (value.inLambda) return out.unresolved.push({ reason: 'lambda-parameter', at: where });
      if (left < 1) return out.values.push({ value, at: where, stopped: 'depth' });
      const callers = db.callersOf(method);
      if (!callers.length) return out.unresolved.push({ reason: 'no-caller', at: where });
      for (const c of callers) {
        const here = { ...site(c), arg: value.index };
        // A method reference names a method without calling it: its argument is whatever the target type supplies.
        if (c.via === 'methodRef') {
          out.unresolved.push({ reason: 'method-reference', at: here });
          continue;
        }
        const next = db.argsOf(c.id)[value.index];
        if (next === undefined) out.unresolved.push({ reason: 'no-argument', at: here });
        else take(next, c.method, left - 1, here);
      }
    };
    take(arg, row.method, depth, at);
    return out;
  };

  /**
   * The static fields holding a ThreadLocal (or a project subclass of one), with the methods that write it and the
   * methods that clear it. A call on a holder type that matches no field row is unresolved: it holds something, but
   * the dump cannot say which field.
   */
  let holderCache = null;
  const holders = () => {
    if (holderCache) return holderCache;
    if (!db) return noDump('holders');
    const list = [];
    const gaps = [];
    for (const t of db.types.values())
      for (const m of db.membersOf(t.fqn)) {
        if (m.kind !== 'field' || !(m.modifiers ?? []).includes('static')) continue;
        if (!m.type && !m.typeFqn) {
          gaps.push({ field: fieldId(m), owner: m.owner, reason: 'no-type' });
          continue;
        }
        const type = m.typeFqn ?? raw(m.type);
        const base = holderBase(type);
        if (!base) continue;
        // The element type is written on the field (`ThreadLocal<String>`) or on the supertype of a project holder.
        const supertype = db.type(type)?.supertypes?.find((s) => s.fqn === base)?.text ?? null;
        const element = typeArgsOf(m.type)[0] ?? typeArgsOf(supertype)[0] ?? null;
        list.push({ field: fieldId(m), owner: m.owner, type, base, element, writes: [], clears: [] });
      }
    const byField = new Map(list.map((h) => [h.field, h]));
    const reads = holderReads();
    for (const c of db.calls) {
      if (c.via === 'methodRef') continue; // a reference names a method; it does not write the holder
      const op = holderOp(c.name);
      const read = readOf(reads, c);
      if (!read) {
        if (op && holderBase(c.recv?.type)) gaps.push({ ...site(c), reason: 'holder-not-a-field', type: c.recv.type });
        continue;
      }
      const holder = byField.get(read.field);
      if (!holder || !op) continue;
      const hit = { method: c.method, call: c.id, name: c.name, file: c.file, line: c.line, col: c.col };
      (op === 'write' ? holder.writes : holder.clears).push(hit);
    }
    // A holder the classpath named: a static call-path field on a class Spoon read from a jar. Its write and clear
    // happen inside the library, so `writes`/`clears` stay empty here and a static call on the type is the store
    // (`stores()`). Resolved, because the field's declared type is the dump's own answer.
    for (const t of db.library?.values() ?? []) {
      if (t.unresolved) continue;
      for (const f of t.fields ?? []) {
        if (!(f.modifiers ?? []).includes('static')) continue;
        const type = f.typeFqn ?? raw(f.type);
        const base = holderBase(type);
        if (!base) continue;
        const element = typeArgsOf(f.type)[0] ?? null;
        list.push({
          field: `${t.fqn}#${f.name}`,
          owner: t.fqn,
          type,
          base,
          element,
          writes: [],
          clears: [],
          origin: 'library',
          confidence: 'resolved',
          via: 'classpath',
        });
      }
    }
    holderCache = { holders: list, unresolved: gaps };
    return holderCache;
  };

  /** The holder row a static call's receiver names, when that receiver's type is a holder (`Holder.set(x)`). */
  const holderOf = (c) => {
    const on = calledOnType(c);
    if (!on) return null;
    for (const h of holders().holders) if (h.owner === on.type || h.owner === on.key) return h;
    return null;
  };

  /** One call as a store, by the shape that writes something a later read of the same request can see. */
  const storeOf = (c, reads) => {
    const read = readOf(reads, c);
    const op = holderOp(c.name);
    if (read && op) return { kind: 'holder', field: read.field, op };
    if (c.name === 'setAuthentication' && simple(c.recv?.type) === 'SecurityContext')
      return { kind: 'security-context', holder: SECURITY_CONTEXT_HOLDER, how: 'setAuthentication' };
    if (c.name === 'setContext' && c.recv?.type === SECURITY_CONTEXT_HOLDER)
      return { kind: 'security-context', holder: SECURITY_CONTEXT_HOLDER, how: 'setContext' };
    if (c.name === 'setAttribute' && ATTRIBUTE_HOLDERS.has(c.recv?.type)) return { kind: 'request-attribute', holder: c.recv.type };
    return null;
  };

  /**
   * The stores in one method and its reach: a holder write, `SecurityContextHolder`, or a request attribute. A store
   * call whose receiver the dump could not type is unresolved — it may be a store, and saying no would be a guess.
   */
  const stores = (methodId, depth = 2) => {
    if (!db) return noDump('stores');
    const found = [];
    const { methods, unresolved } = reach(methodId, depth);
    const gaps = unresolved.map((g) => ({ ...g, reason: `call-not-resolved:${g.reason}` }));
    const reads = holderReads();
    for (const { id, depth: d } of methods)
      for (const c of db.callsOf(id)) {
        const at = { method: id, depth: d, call: c.id, file: c.file, line: c.line, col: c.col };
        // A call on a *library* holder type is the store: its setter's body is inside the jar, so no field write of
        // this project's ever shows it. A project holder needs no shortcut — the reach walks its setter and finds the
        // field write itself, and counting both would make one store into two.
        const op = holderOp(c.name);
        const holder = op && c.via !== 'methodRef' ? holderOf(c) : null;
        if (holder?.origin === 'library' && !readOf(reads, c)) {
          found.push({
            kind: 'holder',
            field: holder.field,
            op,
            ...(holder.origin === 'library' ? { via: 'classpath' } : {}),
            ...at,
            args: c.args ?? [],
          });
          continue;
        }
        const store = storeOf(c, reads);
        if (store) found.push({ ...store, ...at, args: c.args ?? [] });
        // A store-shaped call the dump could not resolve is a gap: it may be a store, and saying no would be a guess.
        else if (UNTYPED_STORES.has(c.name) && !c.recv?.type) gaps.push({ ...at, name: c.name, reason: 'receiver-untyped' });
        else if (holderOp(c.name) && holderBase(c.recv?.type)) gaps.push({ ...at, name: c.name, reason: 'holder-not-a-field' });
      }
    return { stores: found, unresolved: gaps };
  };

  /**
   * The project type whose instance receives the call — the entity a setter writes, whether the receiver is a local, a
   * field or a repository call's result. A library or unknown receiver, or a static call, has no instance: unresolved.
   */
  const receiverEntity = (call) => {
    if (!db) return { type: null, unresolved: 'no-dump' };
    const row = rowOf(call);
    if (!row) return { type: null, unresolved: 'no-call' };
    const type = row.recv?.type ?? null;
    const how = row.recv?.how ?? null;
    if (!type) return { type: null, how, unresolved: 'receiver-untyped' };
    if (how === 'static' || row.recv?.kind === 'static') return { type, how, unresolved: 'static-call' };
    if (db.types.has(type)) return { type, how, unresolved: null };
    return { type, how, unresolved: libraryTypes()[type] ? 'library-receiver' : 'not-a-project-type' };
  };

  /**
   * The calls in one method whose result is compared against a given parameter (`{method, index}`) or local
   * (`{method, from}`): `equals`, `contains` and their spellings. A parameter matches on either side of the call; a
   * local only on the argument side, since a receiver carries no id for it, and only when the dump knows what it was
   * assigned from. `==` is not in the dump: see the header.
   */
  const comparedTo = (target) => {
    if (!db) return noDump('comparisons');
    if (!target?.method) return { comparisons: [], unresolved: [{ reason: 'no-method', at: null }] };
    const member = db.members.get(target.method);
    if (!member) return { comparisons: [], unresolved: [{ reason: 'no-method-in-dump', at: null }] };
    // A local is named by the call or field it was assigned from; one assigned from a literal has no id at all.
    if (target.index == null && !target.from) return { comparisons: [], unresolved: [{ reason: 'no-target-id', at: null }] };
    const name = target.index != null ? (member.params ?? [])[target.index]?.name ?? null : null;
    const matches = (value) => {
      if (!value) return false;
      if (target.index != null) return value.kind === 'param' && value.index === target.index;
      return value.kind === 'local' && value.from === target.from;
    };
    const comparisons = [];
    const gaps = [];
    for (const c of db.callsOf(target.method)) {
      if (!COMPARISONS.has(c.name)) continue;
      const at = site(c);
      let matched = false;
      (c.args ?? []).forEach((a, i) => {
        if (matches(a)) {
          matched = true;
          comparisons.push({ ...at, name: c.name, side: 'argument', arg: i });
        } else if (a.kind === 'unresolved') gaps.push({ ...at, arg: i, reason: a.reason ?? 'unresolved' });
      });
      // `name.equals(x)`: the receiver carries no parameter index, so the declaration's parameter name is the join.
      if (!matched && name && c.recv?.how === 'param' && c.recv.text === name)
        comparisons.push({ ...at, name: c.name, side: 'receiver', arg: null, matchedBy: 'name' });
    }
    return { comparisons, unresolved: gaps };
  };

  /**
   * A store whose lifetime is one request, found by shape and never by a name: in one method, a static call on a
   * type T inside a `try` block — directly, or in a project method the block reaches within two hops — and a static
   * call on the same T directly inside that `try`'s `finally`. Clearing in the finalizer is what makes it per-request.
   * A store whose call sits in an `if`/`else` arm is `conditional`. When T is a library type with no classpath, the
   * receiver's written name is all the dump has, so the answer is `inferred`, never `resolved`.
   */
  const scopedStores = (methodId) => {
    if (!db) return noDump('stores');
    const member = db.members.get(methodId);
    if (!member) return { stores: [], unresolved: [{ reason: 'no-method', at: null }] };
    const blocks = (member.tryBlocks ?? []).filter(
      (b) => Number.isFinite(b?.start) && Number.isFinite(b?.end) && Number.isFinite(b?.finallyStart),
    );
    const calls = blocks.length ? db.callsOf(methodId) : [];
    const out = [];
    for (const block of blocks) {
      // The finalizer's types: the same written type must appear there, or the try is not a request-scoped store.
      const cleared = new Map();
      for (const c of calls) {
        if (!(c.line >= block.finallyStart && c.line <= block.finallyEnd)) continue;
        const on = calledOnType(c);
        if (on) cleared.set(`${on.key}|${c.name}`, c);
      }
      if (!cleared.size) continue;
      const clearTypes = new Set([...cleared.keys()].map((k) => k.split('|')[0]));
      // Everything the try body can call: its own calls, then the calls of the project methods those reach, two hops.
      const found = [];
      const seen = new Set([methodId]);
      let frontier = [{ id: methodId, conditional: false }];
      for (let hop = 0; hop < 2 && frontier.length; hop++) {
        const next = [];
        for (const { id, conditional } of frontier) {
          const owner = db.members.get(id);
          const arms = (owner?.branches ?? []).filter((b) => b?.kind === 'if' || b?.kind === 'else');
          const inArm = (line) => arms.some((a) => a.start <= line && line <= a.end);
          for (const c of db.callsOf(id)) {
            // `hop === 0` is the try body itself; later hops are the project methods it reaches, body and all.
            if (hop === 0 && !(c.line >= block.start && c.line <= block.end)) continue;
            // A store reached through an `if` arm is conditional, however many hops away it is written.
            const reached = conditional || inArm(c.line);
            const on = calledOnType(c);
            if (on) found.push({ on, call: c, conditional: reached });
            for (const t of targetIds(c))
              if (!seen.has(t) && db.members.has(t)) (seen.add(t), next.push({ id: t, conditional: reached }));
          }
        }
        frontier = next;
      }
      for (const f of found) {
        if (!clearTypes.has(f.on.key)) continue;
        // The finalizer's call is a different method (`setContext` / `clearContext`): one call cannot be its own clear.
        const clear = [...cleared.entries()].find(([k]) => k.startsWith(`${f.on.key}|`))?.[1];
        if (clear?.name === f.call.name) continue;
        out.push({
          kind: 'holder',
          field: null,
          holder: f.on.type,
          op: 'write',
          via: 'try-finally-pattern',
          conditional: f.conditional,
          method: f.call.method ?? methodId,
          depth: 0,
          call: f.call.id,
          file: f.call.file,
          line: f.call.line,
          col: f.call.col ?? null,
          args: f.call.args ?? [],
          clearedAt: clear ? { call: clear.id, file: clear.file, line: clear.line } : null,
        });
      }
    }
    const unique = new Map(out.map((s) => [`${s.call}|${s.holder}`, s]));
    return { stores: [...unique.values()], unresolved: [] };
  };

  return { reach, argValue, holders, stores, scopedStores, receiverEntity, comparedTo };
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check on a written-out dump, so the hop and the reach are exercised without the engine jar. The fixture-based
// checks (every primitive against test/dump-fixture through the real engine) live in test/query.test.mjs.
{
  const arg = (kind, extra) => ({ text: 'x', kind, type: 'java.lang.String', ...extra });
  const row = (method, name, at, args, targets = []) => ({
    method, id: `${method}@${at}`, file: 'a/A.java', line: Number(at.split(':')[0]), col: Number(at.split(':')[1]),
    name, args, targets, origin: targets.length ? 'java' : 'library',
    recv: { type: 'java.lang.String', kind: 'instance', how: 'param', text: 'value' },
  });
  const calls = [
    row('a.A#entry()', 'middle', '6:9', [arg('literal', { value: 'lit' })], ['a.A#middle(String)']),
    row('a.A#middle(String)', 'inner', '10:9', [arg('param', { index: 0 })], ['a.A#inner(String)']),
    row('a.A#middle(String)', 'equals', '14:16', [arg('param', { index: 0 })]),
  ];
  const members = ['entry()', 'middle(String)', 'inner(String)'].map((sig) => ({
    kind: 'method', owner: 'a.A', name: sig.replace(/\(.*/, ''), id: `a.A#${sig}`,
    params: sig === 'entry()' ? [] : [{ type: 'String', name: 'value' }],
  }));
  const stub = {
    calls,
    types: new Map([['a.A', { fqn: 'a.A', supertypes: [] }]]),
    members: new Map(members.map((m) => [m.id, m])),
    membersOf: (fqn) => members.filter((m) => m.owner === fqn),
    callsOf: (id) => calls.filter((c) => c.method === id),
    callersOf: (id) => calls.filter((c) => c.targets.includes(id)),
    methodRefsIn: () => [],
    argsOf: (id) => calls.find((c) => c.id === id)?.args ?? [],
    callById: (id) => calls.find((c) => c.id === id) ?? null,
    fieldAccessOf: () => [],
    type: (fqn) => stub.types.get(fqn) ?? null,
  };
  const q = queries(stub);
  assert.deepStrictEqual(q.reach('a.A#entry()', 1).methods, [{ id: 'a.A#entry()', depth: 0 }, { id: 'a.A#middle(String)', depth: 1 }]);
  // One hop by default: the caller's literal is the value, read at the caller's call site.
  const one = q.argValue('a.A#middle(String)@10:9', 0, 1);
  assert.deepStrictEqual(one.values.map((v) => v.value.kind), ['literal']);
  assert.equal(one.values[0].at.call, 'a.A#entry()@6:9');
  // With no hop allowed the value stays a `param` and says so, rather than passing for an answer.
  const none = q.argValue('a.A#middle(String)@10:9', 0, 0);
  assert.deepStrictEqual(none.values.map((v) => v.stopped), ['depth']);
  assert.deepStrictEqual(one.unresolved, []);
  // An index the call does not have is unresolved, not an empty list that reads as "nothing".
  assert.deepStrictEqual(q.argValue('a.A#middle(String)@10:9', 1).unresolved.map((u) => u.reason), ['no-argument']);
  assert.deepStrictEqual(q.comparedTo({ method: 'a.A#middle(String)', index: 0 }).comparisons.map((c) => [c.name, c.side]), [['equals', 'argument']]);
  assert.deepStrictEqual(q.comparedTo({ method: 'a.A#entry()', index: 0 }).comparisons, [], 'a method with no call has nothing compared');
  assert.equal(q.receiverEntity(calls[1]).unresolved, 'library-receiver', 'String is a library receiver');
  assert.deepStrictEqual(queries(null).holders(), { holders: [], unresolved: [{ reason: 'no-dump', at: null }] });
}
