// Lifecycles: which status values each entity's status field can hold, and where this code sets them. Every answer is
// a query over the Spoon dump (`engine/model/query.mjs`); nothing here reads Java source text. A status write is a call
// whose argument has the status enum's type — a constant (the dump's typed argument) or the values the called method
// returns (the dump's `returns`/switch arms) — or a write of the entity's own status field (the dump's field accesses).
// The owner is the entity the call is made on, or the entity whose field the callee writes from that argument. A value
// the dump cannot trace is reported as unresolved, never filled in from source text.
import assert from 'node:assert/strict';
import { scheduleFacts } from './schedules.mjs';
import { queries } from '../model/query.mjs';
import { declaredId, targetIds } from '../model/targets.mjs';
import { simple } from '../core/names.mjs';
import { push } from '../core/collections.mjs';
import { patternOf } from '../catalogs/catalog.mjs';

const normFqn = (fqn) => String(fqn ?? '').replace(/\$/g, '.');
const STATUS_NAME = patternOf('status-type-name');
const STATUS_FIELD = patternOf('status-field-name');
const NO_SETTER = 'no setter found by the engine (check the code before saying it is never set)';
const HOW = {
  chooser: 'chosen by a switch/return',
  inline: 'chosen inline',
  via: 'via a variable',
  argument: 'set by the callee from the argument',
};

/** A constant's value name: `a.b.S.PAID` -> `PAID`. A nested enum keeps its `$` in the type, not in the value. */
const constantName = (value) => simple(value?.value?.value ?? value?.text ?? value?.field ?? '').split(/[<$]/)[0];
/**
 * A value that names a status without the dump declaring its type: the source wrote `OrderState.CANCELLED`, and the
 * row carries the field it read (`field: OrderState#CANCELLED`) with a reason saying the declaration is elsewhere.
 * The name it reads is the value, and the type it is read from is the one the source names.
 */
const outsideRead = (value) =>
  value?.kind === 'field' && value.reason === 'declaration-outside-dump' && value.field
    ? { type: value.typeFqn, value: String(value.field).split('#').pop() }
    : null;
const noHop = (reason, at) => ({ values: [], unresolved: [{ reason, at }] });

/** The constants one expression can be: a constant, or the two branches of a conditional (`a ? S.X : S.Y`). */
function expressionValues(value, enumFqn, at) {
  if (!value) return noHop('no-value', at);
  if (value.kind === 'unresolved') return noHop(value.reason ?? 'unresolved', at);
  if (value.kind === 'constant')
    return normFqn(value.typeFqn) === enumFqn
      ? { values: [{ value: constantName(value), cite: at?.method ?? null, how: 'direct' }], unresolved: [] }
      : noHop('other-type', at);
  if (value.kind === 'conditional') {
    const out = { values: [], unresolved: [] };
    for (const branch of [value.then, value.otherwise]) {
      const sub = expressionValues(branch, enumFqn, at);
      out.values.push(...sub.values.map((v) => ({ ...v, how: v.how === 'direct' ? 'inline' : v.how })));
      out.unresolved.push(...sub.unresolved);
    }
    return out;
  }
  return noHop(`${value.kind}-value`, at);
}

/** The constants a method returns, directly or through a switch: the dump's `returned`, cited at the method. */
function returnsIn(methodId, enumFqn, ctx, only = null) {
  const out = { values: [], unresolved: [] };
  const at = { method: methodId, call: null };
  for (const entry of only ? [only] : ctx.dump.returnsOf(methodId)) {
    const expressions = entry.kind === 'switch' ? (entry.arms ?? []).map((arm) => arm.value) : [entry.value];
    for (const expression of expressions) {
      const sub = expressionValues(expression, enumFqn, at);
      out.values.push(...sub.values.map((v) => ({ ...v, cite: methodId, how: 'chooser' })));
      out.unresolved.push(...sub.unresolved);
    }
  }
  return out;
}

/** A local: the call it was assigned from, or the switch whose result it holds, names its values. */
function localValues(local, at, enumFqn, ctx) {
  const out = { values: [], unresolved: [] };
  if (local.from) {
    const source = ctx.byCall.get(local.from);
    if (!source) return noHop('no-source-call', at);
    for (const target of targetIds(source)) {
      const chosen = returnsIn(target, enumFqn, ctx);
      out.values.push(...chosen.values);
      out.unresolved.push(...chosen.unresolved);
    }
  } else if (at?.method) {
    // A local assigned from a switch carries no call id: the dump's `returned` names the switch by its target local.
    for (const entry of ctx.dump.returnsOf(at.method))
      if (entry.kind === 'switch' && entry.target && entry.target === local.text) {
        const chosen = returnsIn(at.method, enumFqn, ctx, entry);
        out.values.push(...chosen.values);
        out.unresolved.push(...chosen.unresolved);
      }
  }
  // The value is chosen in a helper and set here: the method that holds the local is a site too, but only when the
  // chooser is another method (a switch in this method is already cited where it is).
  for (const v of [...out.values]) if (at?.method && v.cite !== at.method) out.values.push({ value: v.value, cite: at.method, how: 'via' });
  return out.values.length || out.unresolved.length ? out : noHop('local-unresolved', at);
}

/** One call argument: its constants, a local's source, a nested call's returns, or (bounded) a parameter's callers. */
function argumentValues(call, arg, index, enumFqn, ctx, depth = 2) {
  const at = { method: call.method, call: call.id };
  if (!arg) return noHop('no-argument', at);
  if (arg.kind === 'param') {
    if (!depth) return noHop('param-depth', at);
    const found = ctx.q.argValue(call, index, depth);
    const out = { values: [], unresolved: [] };
    for (const { value, at: where, stopped } of found.values) {
      if (stopped) continue; // the hops ran out: nothing resolved, nothing guessed
      const here = { method: where?.method ?? null, call: where?.call ?? null };
      const sub = value.kind === 'local' ? localValues(value, here, enumFqn, ctx) : expressionValues(value, enumFqn, here);
      out.values.push(...sub.values.map((v) => ({ ...v, how: v.how === 'direct' ? 'argument' : v.how })));
      out.unresolved.push(...sub.unresolved);
    }
    out.unresolved.push(...found.unresolved.map((u) => ({ ...u, reason: `parameter:${u.reason}` })));
    return out.values.length || out.unresolved.length ? out : noHop('param-unresolved', at);
  }
  if (arg.kind === 'local') return localValues(arg, at, enumFqn, ctx);
  if (arg.kind === 'call' && arg.call) {
    const out = { values: [], unresolved: [] };
    const inner = ctx.byCall.get(arg.call);
    for (const target of targetIds(inner)) out.values.push(...returnsIn(target, enumFqn, ctx).values);
    if (out.values.length) return out;
  }
  if (arg.kind === 'field') return noHop('field-value', at);
  const out = expressionValues(arg, enumFqn, at);
  return out.values.length || out.unresolved.length ? out : noHop(`${arg.kind}-unresolved`, at);
}

/** The citation of one method id: `file#name`, with the range when the name is overloaded in its type. */
function citing(dump) {
  return (methodId) => {
    const m = methodId ? dump.members.get(methodId) : null;
    if (!m?.pos) return null;
    const overloaded = dump.membersOf(m.owner).some((x) => x.id !== m.id && x.name === m.name);
    return overloaded ? `${m.pos.file}:${m.pos.line}-${m.pos.endLine}#${m.name}` : `${m.pos.file}#${m.name}`;
  };
}

/**
 * The lifecycle facts: one entry per (entity, status enum), each value with the places it is set. Also returns the
 * sites the flows rank reads, and the questions the dump could not answer (as `unresolved`, with a reason).
 */
function lifecycleFacts({ dump, files = null, entities = [], enums = [], shortlist = null, repoEntity = new Map() }) {
  const sites = [];
  const unresolved = [];
  if (!dump) return { lifecycle: [], sites, unresolved: [{ reason: 'no-dump', at: null }] };
  // The app's own files: the dump spans the whole checkout, but a module the deployable excludes is not this app.
  const inApp = (file) => !files || file == null || files.has(file);
  const q = queries(dump);
  const cite = citing(dump);
  const ctx = { dump, q, byCall: new Map(dump.calls.map((c) => [c.id, c])) };

  // The app's status enums, in the order the model lists their types: the digest's order, and the values' order.
  const appEnums = new Map();
  for (const en of enums) {
    const found = [...dump.types.values()].find(
      (t) => t.kind === 'enum' && simple(t.fqn) === en.name && t.pos?.file === en.file,
    );
    if (found && STATUS_NAME.test(simple(found.fqn))) appEnums.set(normFqn(found.fqn), en);
  }
  const valuesOf = (fqn) => (appEnums.get(fqn)?.values?.length ? appEnums.get(fqn).values : dump.membersOf(fqn).filter((m) => m.kind === 'enumConstant').map((m) => m.name));

  // One pair per (entity, status enum): two entities sharing an enum are two lifecycles, the doc's own bug.
  const pairs = [];
  for (const e of entities)
    for (const field of e.fields ?? []) {
      const enumFqn = normFqn(field.typeFqn);
      if (!appEnums.has(enumFqn)) continue;
      pairs.push({ entity: e.name, entityFqn: e.type?.fqn ?? e.fqn, field: field.name, enumFqn, values: valuesOf(enumFqn) });
    }
  const order = new Map([...appEnums.keys()].map((k, i) => [k, i]));
  pairs.sort((a, b) => order.get(a.enumFqn) - order.get(b.enumFqn) || a.entity.localeCompare(b.entity) || a.field.localeCompare(b.field));
  for (const pair of pairs) pair.setting = new Map(pair.values.map((v) => [v, { set: [], conditional: [] }]));

  /** Records one site: the digest's wording plus the flat fact the flow rank reads. One site once. */
  const seen = new Set();
  const mark = (pair, value, citeText, how, method, line, note = null) => {
    if (!value || !citeText) return;
    const wording = note ?? HOW[how] ?? how;
    const key = `${pair.entity}\u0000${value}\u0000${citeText}\u0000${wording}`;
    if (seen.has(key)) return;
    seen.add(key);
    const slot = pair.setting.get(value) ?? { set: [], conditional: [] };
    pair.setting.set(value, slot);
    slot.set.push(how === 'direct' && !note ? citeText : `${citeText} (${wording})`);
    sites.push({ entity: pair.entity, value, method: method ?? null, line: line ?? null, evidence: [citeText] });
  };

  // Which method writes which field from which parameter: the callee side of a status write (`setStatus(status)`).
  const paramWriters = new Map();
  for (const pair of pairs)
    for (const row of dump.fieldAccessOf(`${pair.entityFqn}#${pair.field}`))
      if (row.op === 'write' && row.value?.kind === 'param' && row.value.index != null) {
        const key = `${row.method}\u0000${row.value.index}`;
        push(paramWriters, key, pair);
      }

  // The entity a Lombok builder setter writes. The synthesis names the builder `Entity.Builder` and marks its members
  // `generated: lombok`; the entity is that owner without the suffix, and only when the dump declares it. A builder the
  // source itself declares (`OrderBuilder`) has no such owner and stays unattributed.
  const BUILDER_SUFFIX = '.Builder';
  const builtEntity = (targetId) => {
    const member = dump.members.get(targetId);
    if (!member || member.generated !== 'lombok') return null;
    const owner = String(member.owner ?? '');
    if (!owner.endsWith(BUILDER_SUFFIX)) return null;
    const entity = owner.slice(0, -BUILDER_SUFFIX.length);
    return dump.types.has(entity) ? entity : null;
  };

  // A write of the entity's own status field: the dump's field accesses carry the value, so a field default, a
  // constructor assignment and a setter body are one shape.
  for (const pair of pairs)
    for (const row of dump.fieldAccessOf(`${pair.entityFqn}#${pair.field}`)) {
      if (row.op !== 'write' || !inApp(row.file)) continue;
      const at = { method: row.method, call: null };
      const found =
        row.value?.kind === 'param'
          ? parameterValues(row, pair, ctx)
          : row.value?.kind === 'local'
            ? localValues(row.value, at, pair.enumFqn, ctx)
            : expressionValues(row.value, pair.enumFqn, at);
      for (const v of found.values) mark(pair, v.value, v.cite ? cite(v.cite) : cite(row.method), v.how, v.cite ?? row.method, row.line);
      unresolved.push(...found.unresolved);
    }

  // A call whose argument has the status enum's type: on the entity itself, into a method that writes its field, or on
  // the Lombok builder of the entity (`Booking.builder().status(x)`).
  for (const call of dump.calls) {
    if (call.via === 'methodRef' || call.origin === 'error' || !inApp(call.file)) continue;
    const args = dump.argsOf(call.id);
    args.forEach((arg, index) => {
      const type = normFqn(arg?.typeFqn);
      if (!STATUS_NAME.test(simple(type))) return;
      // The type whose instance receives the call: the receiver the dump typed, or the entity a Lombok builder setter
      // belongs to. Both are facts of the call row, not a reading of the argument's text.
      const receivers = new Set(
        [normFqn(q.receiverEntity(call).type), ...targetIds(call).map(builtEntity)].filter(Boolean),
      );
      const owners = pairs.filter(
        (p) =>
          p.enumFqn === type &&
          (receivers.has(p.entityFqn) ||
            targetIds(call).some((t) => (paramWriters.get(`${t}\u0000${index}`) ?? []).includes(p))),
      );
      if (!owners.length) {
        // A status constant handed to nothing this dump can name may still be a write: reported, not dropped.
        if (arg.kind === 'constant') unresolved.push({ reason: 'no-owner', at: { method: call.method, call: call.id, line: call.line } });
        return;
      }
      const found = argumentValues(call, arg, index, type, ctx, 2);
      for (const pair of owners)
        for (const v of found.values) mark(pair, v.value, v.cite ? cite(v.cite) : cite(call.method), v.how, v.cite ?? call.method, call.line);
      // A value a helper chose and this site hands over: the helper writes the constant, this call sets it, and the
      // wording names both — `.status(initialStatus)` where `initialStatus` came from `resolveInitialBookingStatus`.
      if (arg.kind === 'local' && arg.from)
        for (const pair of owners)
          for (const v of found.values)
            if (v.cite && v.cite !== call.method)
              mark(pair, v.value, cite(call.method), 'direct', call.method, call.line, `chosen in ${cite(v.cite)}`);
      unresolved.push(...found.unresolved);
    });
  }

  // A @Modifying repository query is a conditional update: the last status constant is the new value, the others the
  // values it matches on. The repository's entity is the call graph's own repository→entity map.
  for (const call of dump.calls)
    for (const target of targetIds(call)) {
      if (!inApp(call.file)) continue;
      const member = dump.members.get(target);
      if (!member || dump.annotation(member, 'Modifying') == null) continue;
      const constants = (call.args ?? []).filter((a) => a?.kind === 'constant' && STATUS_NAME.test(simple(a.typeFqn)));
      if (!constants.length) continue;
      const entity = repoEntity.get(simple(member.owner));
      for (const pair of pairs) {
        if (entity !== pair.entity || normFqn(constants[constants.length - 1].typeFqn) !== pair.enumFqn) continue;
        const from = constants.slice(0, -1).map(constantName).join('/') || '?';
        const value = constantName(constants[constants.length - 1]);
        const slot = pair.setting.get(value) ?? { set: [], conditional: [] };
        pair.setting.set(value, slot);
        slot.conditional.push(`${cite(call.method)} (from ${from} via ${call.name})`);
      }
    }

  // A method whose declared return type is the status enum chooses its constants: for an enum with one owner, record
  // that choice at the method (the dump's `returns`), as the digest always has. With several owners the entity a value
  // belongs to is not in the return type, so those are recorded only where a call hands the value to a field.
  const byEnum = new Map();
  for (const pair of pairs) push(byEnum, pair.enumFqn, pair);
  for (const [enumFqn, group] of byEnum) {
    if (group.length !== 1) continue;
    const [pair] = group;
    const simpleName = simple(pair.enumFqn);
    for (const member of dump.members.values()) {
      if (member.kind !== 'method' || simple(member.returns) !== simpleName || !inApp(member.pos?.file)) continue;
      for (const v of returnsIn(member.id, enumFqn, ctx).values)
        mark(pair, v.value, cite(member.id), v.how, member.id, member.pos?.line ?? null);
    }
  }

  // The digest's sentences: the entity and enum, then every value with its conditional and plain sets.
  const lifecycle = [];
  for (const pair of pairs) {
    const rows = [...pair.setting.values()];
    const hasConditional = rows.some((s) => s.conditional.length);
    lifecycle.push(
      `${pair.entity}.${simple(pair.enumFqn)}${hasConditional ? ' (has conditional updates: plain sets below skip that guard)' : ''}`,
    );
    for (const [value, slot] of pair.setting) {
      const set = [...new Set(slot.set)].sort();
      const conditional = [...new Set(slot.conditional)].sort();
      const parts = [
        conditional.length && `conditional update in ${conditional.join(', ')}`,
        set.length && `${hasConditional ? 'PLAIN set' : 'set'} in ${set.join(', ')}`,
      ].filter(Boolean);
      lifecycle.push(`  ${value}: ${parts.join('; ') || NO_SETTER}`);
    }
  }

  const constants = constantStatuses({ dump, entities, shortlist, ctx, cite, unresolved, inApp });
  lifecycle.push(...constants.lifecycle);
  sites.push(...constants.sites);
  const outside = outsideStatuses({ dump, declared: new Set(appEnums.keys()), entities, cite, unresolved, inApp });
  lifecycle.push(...outside.lifecycle);
  sites.push(...outside.sites);

  return { lifecycle, sites, unresolved };
}

/** A field write whose value is a parameter: every caller's argument at that index is what the field receives. */
function parameterValues(row, pair, ctx) {
  const out = { values: [], unresolved: [] };
  for (const call of ctx.dump.callersOf(row.method)) {
    const index = row.value.index;
    const found = argumentValues(call, ctx.dump.argsOf(call.id)[index], index, pair.enumFqn, ctx, 1);
    out.values.push(...found.values);
    out.unresolved.push(...found.unresolved);
  }
  return out.values.length || out.unresolved.length ? out : noHop('no-caller', { method: row.method, call: null });
}

/**
 * Status fields that hold constants instead of an enum (byte/int/String codes): a value handed to a method that writes
 * the field. Only values this code sets are listed, and a field nothing sets is reported as unresolved.
 */
function constantStatuses({ dump, entities, shortlist, ctx, cite, unresolved, inApp }) {
  const lifecycle = [];
  const sites = [];
  for (const e of entities) {
    if (shortlist && !shortlist.has(e.name)) continue;
    const entityFqn = e.type?.fqn ?? e.fqn;
    for (const field of e.fields ?? []) {
      if (!STATUS_FIELD.test(field.name) || STATUS_NAME.test(simple(field.typeFqn))) continue;
      const writes = dump.fieldAccessOf(`${entityFqn}#${field.name}`).filter((r) => r.op === 'write' && inApp(r.file));
      if (!writes.length) continue;
      const found = new Map();
      const take = (value, wording, method, line) => {
        if (!value) return;
        if (!found.has(value)) found.set(value, { where: new Set(), method, line });
        found.get(value).where.add(wording);
      };
      for (const row of writes) {
        const at = { method: row.method, call: null };
        for (const branch of row.value?.kind === 'conditional' ? [row.value.then, row.value.otherwise] : [row.value]) {
          if (branch?.kind !== 'constant') continue;
          take(constantName(branch), cite(row.method), row.method, row.line);
        }
      }
      for (const call of dump.calls)
        for (const [i, arg] of dump.argsOf(call.id).entries()) {
          if (arg?.kind !== 'constant' || !inApp(call.file)) continue;
          const writesIt = targetIds(call).some((t) =>
            writes.some((r) => r.method === t && r.value?.kind === 'param' && r.value.index === i),
          );
          if (writesIt) take(constantName(arg), cite(call.method), call.method, call.line);
        }
      if (!found.size) {
        unresolved.push({ reason: 'no-write', at: { entity: e.name, field: field.name } });
        continue;
      }
      lifecycle.push(`${e.name}.${field.name} (${field.type} constants, not an enum: only values seen being set are listed)`);
      for (const [value, w] of found) {
        const where = [...w.where].sort();
        lifecycle.push(`  ${value}: set in ${where.slice(0, 6).join(', ')}${where.length > 6 ? ` +${where.length - 6}` : ''}`);
        sites.push({ entity: e.name, value, method: w.method, line: w.line, evidence: where.slice(0, 6) });
      }
    }
  }
  return { lifecycle, sites };
}

/**
 * A status enum declared outside the app's own types (another module, a shared library): listed by simple name, only
 * when this code sets it, and only the values it sets. The values are the typed constants the dump carries.
 */
function outsideStatuses({ dump, declared, entities, cite, unresolved, inApp }) {
  const lifecycle = [];
  const sites = [];
  const groups = new Map();
  // One group per enum, by simple name: the section lists an outside enum by name, and Spoon names the same type with
  // and without its package depending on whether the file imports it (a static import qualifies, a type access may not).
  const take = (typeFqn, value, method, line) => {
    const name = simple(typeFqn);
    if (!groups.has(name)) groups.set(name, { simple: name, sites: new Map() });
    const g = groups.get(name);
    if (!g.sites.has(value)) g.sites.set(value, { where: new Set(), method, line });
    g.sites.get(value).where.add(cite(method));
  };
  // A status enum the engine never saw declared: a shared module's, or a library's. An enum this dump declares is
  // either an app enum (a lifecycle of its own, above) or belongs to another module of the same checkout, so it is not
  // "declared outside" — and a field holding one is still a status field here, which is why holding the entity's
  // status is not what excludes it.
  const declaredNames = new Set([...dump.types.keys()].map(simple));
  const outside = (type) =>
    STATUS_NAME.test(simple(type)) &&
    !declared.has(normFqn(type)) &&
    !dump.types.has(normFqn(type)) &&
    !declaredNames.has(simple(type));
  // The entity whose status field holds each outside enum, when exactly one does: a value set there is that entity's
  // transition, which is what the flow rank reads. Two entities sharing an enum leave it unattributed, not guessed.
  const ownerOf = new Map();
  for (const e of entities ?? [])
    for (const field of e.fields ?? [])
      if (STATUS_FIELD.test(String(field.name)) && STATUS_NAME.test(simple(field.typeFqn))) {
        const type = simple(field.typeFqn);
        ownerOf.set(type, ownerOf.has(type) ? null : e.name);
      }
  // A status constant handed to a method that writes it into a field of that type (a setter, by the callee's body).
  const writers = new Set();
  for (const row of dump.fields)
    if (row.op === 'write' && row.value?.kind === 'param' && row.value.index != null && inApp(row.file))
      writers.add(`${row.method}\u0000${row.value.index}`);
  for (const call of dump.calls)
    for (const [i, arg] of dump.argsOf(call.id).entries()) {
      const read = arg?.kind === 'constant' ? null : outsideRead(arg);
      if (!(arg?.kind === 'constant' || read) || !outside(read ? read.type : arg.typeFqn) || !inApp(call.file)) continue;
      const setter = /^(?:set\w*(?:Status|State)|status|state)$/.test(call.name ?? '');
      if (!setter && !targetIds(call).some((t) => writers.has(`${t}\u0000${i}`))) continue;
      take(read ? read.type : arg.typeFqn, read ? read.value : constantName(arg), call.method, call.line);
    }
  // A default written into a status field: `this.status = SomeStatus.PENDING` — a constant, or a static read of a field
  // whose type this dump does not declare (`OrderState.CANCELLED`).
  for (const row of dump.fields) {
    if (row.op !== 'write' || !inApp(row.file)) continue;
    if (!STATUS_FIELD.test(String(row.field).split('#').pop())) continue;
    const read = row.value?.kind === 'constant' ? null : outsideRead(row.value);
    const value = row.value?.kind === 'constant' ? row.value : read;
    if (!value || !outside(read ? read.type : row.value.typeFqn)) continue;
    take(read ? read.type : row.value.typeFqn, read ? read.value : constantName(row.value), row.method, row.line);
  }
  for (const [name, g] of groups) {
    if (!g.sites.size) {
      unresolved.push({ reason: 'no-set', at: { enum: name } });
      continue;
    }
    lifecycle.push(`${g.simple} (declared outside this repo)`);
    for (const [value, w] of g.sites) {
      const where = [...w.where].sort();
      lifecycle.push(`  ${value}: set in ${where.slice(0, 6).join(', ')}${where.length > 6 ? ` +${where.length - 6}` : ''}`);
      sites.push({ entity: ownerOf.get(name) ?? null, value, method: w.method, line: w.line, evidence: where.slice(0, 6) });
    }
  }
  return { lifecycle, sites };
}

// The fact families this module owns. Schedules come off the model's annotation and call rows (`extract/schedules.mjs`);
// the lifecycle family below reads only the dump.
export function javaFacts({ java = [], dump = null, model = null, repoEntity = new Map(), enums = [], entities = [], shortlist = null }) {
  const db = dump ?? model?.dump ?? null;
  const overloaded = (f, m) => (f.methods ?? []).some((n) => n !== m && n.name === m.name);
  const cite = (f, m) => (overloaded(f, m) ? `${f.p ?? f.file}:${m.start}-${m.end}#${m.name}` : `${f.p ?? f.file}#${m.name}`);
  const files = new Set(java.map((j) => j.p ?? j.file));
  const { lifecycle, sites, unresolved } = lifecycleFacts({ dump: db, files, entities, enums, shortlist, repoEntity });
  const schedules = scheduleFacts({ files: java, cite });
  return { lifecycle, statusSets: sites, schedules, unresolved };
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check on a written-out dump: a constant argument, a setter reached through a parameter, and a switch result a
// helper chooses. The fixture-based checks (a real dump of test/dump-fixture) live in test/lifecycle-choices.test.mjs.
{
  const call = (method, id, name, targets, recv, args) => ({
    method, id, file: `${method.split('#')[0].replace(/\./g, '/')}.java`, line: Number(id.split(':')[0].split('@')[1]), col: Number(id.split(':')[1]),
    name, targets, origin: 'java', recv, args,
  });
  const calls = [
    call('shop.Svc#direct()', 'shop.Svc#direct()@3:5', 'setStatus', ['shop.Order#setStatus(shop.Status)'], { typeFqn: 'shop.Order', how: 'local' },
      [{ text: 'shop.Status.PAID', kind: 'constant', typeFqn: 'shop.Status', value: { kind: 'enum', value: 'shop.Status.PAID' } }]),
    call('shop.Order#setStatus(shop.Status)', 'shop.Order#setStatus(shop.Status)@8:5', 'setStatus', [], { typeFqn: 'shop.Order', how: 'this' },
      [{ text: 's', kind: 'param', typeFqn: 'shop.Status', index: 0 }]),
    call('shop.Svc#mark(shop.Status)', 'shop.Svc#mark(shop.Status)@12:5', 'setStatus', ['shop.Order#setStatus(shop.Status)'], { typeFqn: 'shop.Order', how: 'field' },
      [{ text: 's', kind: 'param', typeFqn: 'shop.Status', index: 0 }]),
    call('shop.Caller#run()', 'shop.Caller#run()@20:5', 'mark', ['shop.Svc#mark(shop.Status)'], { typeFqn: 'shop.Svc', how: 'field' },
      [{ text: 'shop.Status.NEW', kind: 'constant', typeFqn: 'shop.Status', value: { kind: 'enum', value: 'shop.Status.NEW' } }]),
  ];
  const members = [
    ...['NEW', 'PAID', 'GONE'].map((name) => ({ kind: 'enumConstant', owner: 'shop.Status', name })),
    { kind: 'method', owner: 'shop.Svc', name: 'direct', id: 'shop.Svc#direct()', pos: { file: 'shop/Svc.java', line: 3, endLine: 4 } },
    { kind: 'method', owner: 'shop.Order', name: 'setStatus', id: 'shop.Order#setStatus(shop.Status)', params: [{ name: 's', type: 'Status' }],
      pos: { file: 'shop/Order.java', line: 7, endLine: 9 } },
    { kind: 'method', owner: 'shop.Svc', name: 'mark', id: 'shop.Svc#mark(shop.Status)', params: [{ name: 's', type: 'Status' }],
      pos: { file: 'shop/Svc.java', line: 11, endLine: 13 } },
    { kind: 'method', owner: 'shop.Caller', name: 'run', id: 'shop.Caller#run()', pos: { file: 'shop/Caller.java', line: 19, endLine: 21 } },
    { kind: 'method', owner: 'shop.Svc', name: 'choose', id: 'shop.Svc#choose()', returns: 'Status',
      returned: [{ kind: 'switch', line: 30, col: 9, arms: [{ labels: ['A'], value: { text: 'shop.Status.NEW', kind: 'constant', typeFqn: 'shop.Status', value: { kind: 'enum', value: 'shop.Status.NEW' } } }] }],
      pos: { file: 'shop/Svc.java', line: 29, endLine: 34 } },
    { kind: 'field', owner: 'shop.Order', name: 'status', type: 'Status', typeFqn: 'shop.Status', pos: { file: 'shop/Order.java', line: 4, endLine: 4 } },
  ];
  const fields = [{ method: 'shop.Order#setStatus(shop.Status)', field: 'shop.Order#status', op: 'write', line: 8, value: { text: 's', kind: 'param', typeFqn: 'shop.Status', index: 0 } }];
  const types = new Map([
    ['shop.Order', { fqn: 'shop.Order', kind: 'class', pos: { file: 'shop/Order.java', line: 1, endLine: 10 }, ann: [] }],
    ['shop.Status', { fqn: 'shop.Status', kind: 'enum', pos: { file: 'shop/Status.java', line: 1, endLine: 4 } }],
  ]);
  const byOwner = new Map();
  for (const m of members) push(byOwner, m.owner, m);
  const dump = {
    types, members: new Map(members.filter((m) => m.id).map((m) => [m.id, m])), calls, fields,
    membersOf: (fqn) => byOwner.get(fqn) ?? [], callsOf: (id) => calls.filter((c) => c.method === id),
    callersOf: (id) => calls.filter((c) => (c.targets ?? []).includes(id)), argsOf: (id) => calls.find((c) => c.id === id)?.args ?? [],
    fieldAccessOf: (id) => fields.filter((f) => f.field === id), returnsOf: (id) => dump.members.get(id)?.returned ?? [],
    annotation: () => null, type: (fqn) => types.get(fqn) ?? null, methodRefsIn: () => [],
  };
  const entities = [{ name: 'Order', type: { fqn: 'shop.Order' }, fields: [{ name: 'status', type: 'Status', typeFqn: 'shop.Status' }] }];
  const enums = [{ name: 'Status', file: 'shop/Status.java', line: 1, values: ['NEW', 'PAID', 'GONE'] }];
  const { lifecycle, sites } = lifecycleFacts({ dump, entities, enums });
  assert.match(lifecycle[0], /^Order\.Status/);
  assert.match(lifecycle.find((l) => l.startsWith('  PAID:')), /set in shop\/Svc\.java#direct/);
  // The setter's parameter is followed to its caller: the constant written by a caller is the site.
  assert.match(lifecycle.find((l) => l.startsWith('  NEW:')), /set in shop\/Caller\.java#run \(set by the callee from the argument\)/);
  assert.match(lifecycle.find((l) => l.startsWith('  GONE:')), /no setter found/);
  assert.ok(sites.some((s) => s.value === 'PAID' && s.entity === 'Order'), 'the flow rank reads the sites');
  assert.deepEqual(lifecycleFacts({ dump: null }).unresolved.map((u) => u.reason), ['no-dump']);
}
