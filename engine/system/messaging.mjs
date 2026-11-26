import { simple } from '../core/names.mjs';
import { annotationOn } from '../core/annotations.mjs';
import { placeholderOf } from '../core/placeholders.mjs';
import { listOf, tableOf } from '../catalogs/catalog.mjs';
import { dumpArgs, flatStrings, memberRow, stringArg, typeRow } from './rows.mjs';

// Placeholders like "${app.topics.orders:orders}" resolve from the service's own config, else their default.
export function resolve(value, keys) {
  const p = placeholderOf(value);
  if (!p) return { name: value };
  const k = keys.get(p.key);
  if (k && !/^\$\{/.test(k.value)) return { name: k.value, via: p.key };
  return p.def ? { name: p.def, via: `${p.key} default` } : { name: null, unresolved: p.key };
}

const quoted = (v) => `"${v}"`;

// channel argument the dump folded. The rules are the vocabulary's channel-rules, less the consume calls (a consumer
// is a channel of its own, read by extract/channels.mjs and not part of the proven connections). `recv` is the receiver
// type's simple name (a suffix: a project's own publisher extends the library's), `names` or `name` the methods.
// `<folder>/mindmodel-system.json` may add a company's own wrappers: an entry's `re` is then tested against
// `Type.method` — names the dump wrote, never source text.
export const BUILTIN = tableOf('channel-rules').filter((r) => !r.consumer);

/**
 * Messaging rows for one module: `{kind, dir, line, expr, raw, arg, recv, file}`. `expr` is the argument as the dump
 * spells it (a literal in quotes, a constant by name, `X.class`), `arg` the typed value `channelName` resolves.
 */
export function messaging(module, patterns = BUILTIN) {
  const out = [];
  const { db, types } = module ?? {};
  if (!db) return out;
  for (const t of types ?? []) {
    for (const m of t.methods ?? []) {
      const row = memberRow(module, m);
      for (const rule of patterns.filter((p) => p.annotation)) {
        const a = annotationOn(row, rule.annotation);
        if (!a) continue;
        for (const v of flatStrings(a.args?.[rule.arg]))
          out.push({
            kind: rule.kind,
            dir: rule.dir,
            line: a.line || m.start,
            expr: quoted(v),
            raw: quoted(v),
            arg: { kind: 'literal', text: quoted(v), value: { kind: 'string', value: v } },
            file: module.prefix + t.file,
            mfile: t.file,
          });
      }
      for (const c of m.calls ?? []) {
        const recvName = simple(c.recvFqn);
        for (const rule of patterns) {
          if (rule.annotation) continue;
          if (rule.recv && !recvName.endsWith(rule.recv)) continue;
          if (rule.name && c.name !== rule.name) continue;
          if (rule.names && !rule.names.includes(c.name)) continue;
          if (rule.re && !new RegExp(rule.re).test(`${recvName}.${c.name}`)) continue;
          const arg = dumpArgs(db, c)[0];
          if (!arg) continue;
          // A streams `stream(...)`/`to(...)` with a variable names no topic: Java's own Stream API looks the same.
          if (rule.named && !namedTopic(arg)) continue;
          out.push({
            kind: rule.kind,
            dir: rule.dir,
            line: c.line,
            expr: String(arg.text ?? ''),
            raw: String(arg.text ?? ''),
            arg,
            recv: rule.publisher ? recvName : undefined,
            publisher: rule.publisher,
            file: module.prefix + t.file,
            mfile: t.file,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.dir.localeCompare(b.dir));
}

/** A literal or a `Class.CONSTANT` read: the two shapes a named topic takes. */
const namedTopic = (arg) => arg.kind === 'literal' || arg.kind === 'constant';

// Jakarta EE JMS, which a listener's activation config names instead of a topic: a message-driven bean's destination is
// in `@MessageDriven`'s activation properties, and a sender sends to a field injected by JNDI name (`@Resource`).
export function jakartaJms(module) {
  const { db, types } = module ?? {};
  const out = [];
  if (!db) return out;
  for (const t of types ?? []) {
    const row = typeRow(module, t);
    const mdb = annotationOn(row, ...listOf('message-driven-annotations'));
    if (mdb) {
      const dest = messageDestination(mdb);
      if (dest)
        out.push({ kind: 'jms', dir: 'in', name: dest, line: mdb.line || t.start, file: module.prefix + t.file });
    }
    // A JNDI-injected destination: the field names the queue, and a send on that field is a producer for it.
    const injected = new Map();
    for (const f of t.fields ?? []) {
      const fieldRow = (db.membersOf(t.fqn) ?? []).find((x) => x.kind === 'field' && x.name === f.name);
      const a = annotationOn(fieldRow, 'Resource');
      if (!a) continue;
      const name = ['lookup', 'name', 'mappedName'].map((k) => flatStrings(a.args?.[k])[0]).find(Boolean);
      if (name) injected.set(`${t.fqn}#${f.name}`, name);
    }
    if (!injected.size) continue;
    for (const m of t.methods ?? [])
      for (const c of m.calls ?? []) {
        if (c.name !== 'send' && c.name !== 'convertAndSend') continue;
        const arg = dumpArgs(db, c)[0];
        const name = arg?.field ? injected.get(arg.field) : null;
        if (name) out.push({ kind: 'jms', dir: 'out', name, line: c.line, file: module.prefix + t.file });
      }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * A send on a JNDI-injected field is named by `jakartaJms`. The JMSProducer rule sees the same call with the field as
 * its argument and cannot name it, so it would add an unresolved twin: the named row stands, the twin goes.
 */
export function withoutJndiTwins(rows, jndi) {
  const named = new Set(jndi.map((x) => `${x.file}:${x.line}`));
  return rows.filter((x) => !(x.dir === 'out' && named.has(`${x.file}:${x.line}`)));
}

/**
 * The destination an MDB's activation config names: `destinationLookup`, `destinationName`, `destination`,
 * `mappedName`.
 */
function messageDestination(a) {
  const props = flatAnnotationValues(a.args?.activationConfig);
  for (const p of props) {
    const key = ['propertyName'].map((k) => flatStrings(p?.args?.[k])[0])[0];
    if (!/^destination(?:Lookup|Name)?$/.test(key ?? '')) continue;
    const value = flatStrings(p.args.propertyValue)[0];
    if (value) return value;
  }
  return flatStrings(a.args?.mappedName)[0] ?? null;
}

const flatAnnotationValues = (value) => {
  if (!value) return [];
  if (value.kind === 'array') return (value.value ?? []).flatMap((v) => flatAnnotationValues(v));
  if (value.kind !== 'annotation') return [];
  return [value.value];
};

/**
 * Folder-wide index for resolving channel expressions: string constants, simple names to FQNs, and aggregate
 * publishers.
 */
export function codeIndex(model) {
  const constants = new Map(),
    fqn = new Map(),
    aggregateOf = new Map();
  for (const t of model?.types?.values() ?? []) {
    fqn.set(t.name, t.fqn);
    for (const [id, value] of model.constants ?? []) {
      if (!id.startsWith(`${t.fqn}.`)) continue;
      const name = id.slice(t.fqn.length + 1);
      constants.set(`${t.name}.${name}`, value);
      if (!constants.has(name)) constants.set(name, value);
    }
    // An aggregate publisher (`FooDomainEventPublisher extends ...Aggregate...Publisher<Foo>`) publishes to Foo's
    // channel.
    const base = (t.supers ?? []).find((s) => /Aggregate\w*Publisher/.test(s.text ?? ''));
    const aggregate = /<\s*([\w.]+)/.exec(base?.text ?? '')?.[1];
    if (aggregate) aggregateOf.set(t.name, simple(aggregate));
  }
  return { constants, fqn, aggregateOf };
}

/** A type's simple name as the file that writes it resolves it: its imports, then the one type of that name. */
function typeNamed(model, file, name) {
  const resolved = model?.resolveIn?.(file, name);
  const hit = resolved ? model.types.get(resolved) : null;
  if (hit) return hit;
  const names = [...(model?.types?.values() ?? [])].filter((t) => t.name === name);
  return names.length === 1 ? names[0] : null;
}

// Resolve a channel expression to a name from what the dump folded. Unresolvable names stay visible as unresolved.
export function channelName(x, module, keys, ix) {
  const { db, model } = module ?? {};
  const arg = x.arg ?? {};
  // The argument as the dump spells it (a constant's name, a class literal, a variable): display, never a fact.
  const written = String(arg.text ?? x.expr ?? '');
  // A class literal (`Consumer.class`) names the event type an Eventuate publisher carries.
  if (/\.class$/.test(written)) {
    const name = written.replace(/\.class$/, '').split('.').pop();
    const type = typeNamed(model, x.mfile ?? x.file, name);
    return type ? { name: type.fqn, via: `${name}.class` } : { name: null, unresolved: written };
  }
  const literal = stringArg(arg);
  if (literal != null) {
    const r = resolve(literal, keys);
    return r.unresolved ? r : { name: r.name, via: r.via };
  }
  // A constant field: the value the dump folded, named as the source names it.
  if (arg.kind === 'constant' && arg.value?.value != null) return { name: String(arg.value.value), via: written };
  // A field or parameter injected from config (`@Value("${key}") String var`): the field's own annotation says which
  // key.
  if (arg.kind === 'field' && arg.field) {
    const owner = model?.types?.get(String(arg.field).split('#')[0]);
    const fieldRow = (db?.membersOf(owner?.fqn) ?? []).find(
      (x) => x.kind === 'field' && `${x.owner}#${x.name}` === arg.field,
    );
    const key = flatStrings(annotationOn(fieldRow, 'Value')?.args?.value)[0];
    if (key) return resolve(key, keys);
    return { name: null, unresolved: written };
  }
  // An aggregate publisher publishes to the aggregate's channel.
  if (x.publisher && x.recv) {
    const aggregate = ix.aggregateOf.get(x.recv);
    if (aggregate && ix.fqn.has(aggregate)) return { name: ix.fqn.get(aggregate), via: `${x.recv} → ${aggregate}` };
  }
  return { name: null, unresolved: written };
}
