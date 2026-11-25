// The model, built from the dump. Spoon already answered every question of identity and reach — what a type is, where
// its annotations point, what its fields are typed as, which methods it has, and what each call reaches — so nothing
// here resolves anything: it arranges the answers in the shape the extractors read.
import assert from 'node:assert';
import { simple } from './names.mjs';
import { push } from './collections.mjs';

const typeNameOf = (text) => (text ?? '').replace(/<[\s\S]*/, '').replace(/\[\]/g, '').trim();

const JAVA_LANG = new Set([
  'String', 'Object', 'Class', 'Enum', 'Record', 'Throwable', 'Exception', 'RuntimeException', 'Error',
  'IllegalArgumentException', 'IllegalStateException', 'UnsupportedOperationException', 'NullPointerException',
  'ArithmeticException', 'InterruptedException', 'IndexOutOfBoundsException', 'ClassCastException',
  'Runnable', 'Thread', 'ThreadLocal', 'Iterable', 'Comparable', 'Cloneable', 'AutoCloseable',
  'Integer', 'Long', 'Short', 'Byte', 'Double', 'Float', 'Boolean', 'Character', 'Number', 'Math', 'StrictMath',
  'System', 'StringBuilder', 'StringBuffer', 'CharSequence', 'Void', 'Package', 'Process', 'Runtime',
  'Deprecated', 'Override', 'SuppressWarnings', 'FunctionalInterface', 'SafeVarargs',
]);

/** `a.b.C<D>` -> `a.b.C`; a written list `A, B<C, D>` -> both names. */
function splitTypes(text) {
  const out = [];
  let depth = 0,
    cur = '';
  for (const ch of text ?? '') {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// The dump names an annotation as the author wrote it; the file's imports turn that into an FQN, as javac would.
const annOf = (row, line, resolveIn) =>
  (row.ann ?? []).map((a) => ({
    name: simple(a.name),
    fqn: resolveIn ? resolveIn(a.name) ?? a.name : a.name,
    args: a.raw ?? '',
    line: a.line || line,
  }));

/** Where a declaration starts, annotations included: the line every citation and evidence string quotes. */
export const startsAt = (row, line) => {
  const lines = (row.ann ?? []).map((a) => a.line).filter((n) => Number.isFinite(n) && n > 0);
  return lines.length ? Math.min(line, ...lines) : line;
};

/** Builds the symbol model from a dump: types, members, calls, constants. `sources` maps a file to its written
 *  package and imports, used only by `resolveIn` for names inside bodies. */
export function buildModelFromDump(dump, sources = new Map(), known = new Set()) {
  const types = new Map(),
    byFile = new Map(),
    implsOf = new Map(),
    constants = new Map(),
    external = new Set(),
    degraded = new Set();
  for (const row of dump.types.values()) {
    // Every row here is the project's own code: an annotation processor's output never becomes one (contract 6).
    const file = row.pos?.file ?? '';
    types.set(row.fqn, {
      kind: row.kind,
      name: simple(row.fqn),
      fqn: row.fqn,
      enclosing: row.enclosing ?? null,
      file,
      pkg: '',
      start: startsAt(row, row.pos?.line ?? 1),
      end: row.pos?.endLine ?? row.pos?.line ?? 1,
      nameLine: startsAt(row, row.pos?.line ?? 1),
      // A generic base (`AbstractVersionService<T>`) binds its parameters where a subclass names its arguments; the
      // flow needs the parameter list to do that.
      typeParams: row.typeParams ?? [],
      modifiers: row.modifiers ?? [],
      // An abstract class serves nothing by itself: its mappings run in its concrete subclasses.
      abstract: (row.modifiers ?? []).includes('abstract'),
      ann: [],
      supers: (row.supertypes ?? []).map((s) => ({ kind: s.kind, text: s.text, fqn: s.fqn ?? null })),
      fields: [],
      methods: [],
      enumValues: [],
    });
    push(byFile, file, row.fqn);
  }

  // Annotations name types, so they resolve once every type is registered.
  const resolveIn = resolver(sources, types, known);
  for (const row of dump.types.values()) {
    const t = types.get(row.fqn);
    t.ann = annOf(row, row.pos?.line ?? 1, (name) => resolveIn(t.file, name));
  }

  // A package belongs to the outermost type of a nested chain, which is registered by then in source order.
  for (const t of types.values()) {
    if (!t.enclosing) {
      const at = t.fqn.lastIndexOf('.');
      t.pkg = at > 0 ? t.fqn.slice(0, at) : '';
    }
  }
  for (const t of types.values()) if (t.enclosing) t.pkg = types.get(t.enclosing)?.pkg ?? '';
  for (const t of types.values())
    for (const s of t.supers) {
      if (!s.fqn) continue;
      if (types.has(s.fqn)) push(implsOf, s.fqn, t.fqn);
      else external.add(s.fqn);
    }

  for (const t of types.values())
    for (const member of dump.membersOf(t.fqn)) {
      const at = member.pos ?? { line: t.start, endLine: t.start };
      if (member.kind === 'enumConstant') {
        t.enumValues.push(member.name);
        continue;
      }
      if (member.kind === 'field') {
        t.fields.push({
          name: member.name,
          type: member.type ?? '',
          typeFqn: member.typeFqn ?? null,
          line: at.line,
          modifiers: member.modifiers ?? [],
          ann: annOf(member, at.line, (name) => resolveIn(t.file, name)),
          synthetic: member.generated,
        });
        // Only a scalar has a string spelling: an array or annotation constant stringifies to "[object Object]",
        // which an extractor would then read as a name.
        const value = member.value?.value;
        if (member.value && member.value.kind !== 'unresolved' && typeof value !== 'object')
          constants.set(`${t.fqn}.${member.name}`, String(value));
        continue;
      }
      if (member.kind !== 'method' && member.kind !== 'constructor') continue;
      t.methods.push({
        id: member.id,
        name: member.name,
        returns: member.returns ?? null,
        params: (member.params ?? []).map((p) => ({
          name: p.name ?? '',
          type: p.type ?? '',
          ann: annOf({ ann: p.ann ?? [] }, at.line, (name) => resolveIn(t.file, name)),
        })),
        ann: annOf(member, at.line, (name) => resolveIn(t.file, name)),
        hasBody: member.hasBody !== false,
        // `public static void main(String[])`: the dump's answer, so an entry point is never a regex over text.
        isMain: member.isMain === true,
        isPublic: (member.modifiers ?? []).includes('public'),
        returnText: member.returns ?? null,
        start: startsAt(member, at.line),
        end: at.endLine ?? at.line,
        // The name sits on the declaration line; the annotations above it are `start`/`nameLine`, which is what a
        // mapping's evidence cites. A flow cites the method, so it uses this line.
        nameLine: startsAt(member, at.line),
        signatureLine: at.line,
        modifiers: member.modifiers ?? [],
        loops: member.loops ?? [],
        // The dump's decision arms: the flow marks an effect reached only through one as conditional.
        branches: member.branches ?? [],
        // The dump's `try` ranges: a store whose lifetime is one request is read off the try/finally shape.
        tryBlocks: member.tryBlocks ?? [],
        synthetic: member.generated,
        calls: [],
      });
    }

  // Calls join their own method by id, the same string every layer keys a method by.
  const methodsById = new Map();
  for (const t of types.values()) for (const m of t.methods) if (m.id) methodsById.set(m.id, { type: t, method: m });
  for (const row of dump.calls) {
    // A method reference is a call row of its own; it names a method and does not call it.
    if (row.via === 'methodRef') continue;
    const method = methodsById.get(row.method)?.method;
    if (!method || row.origin === 'error') continue;
    // Each target is `{id, kind}`: the declaration Spoon resolved, then its overrides.
    const targets = row.targets ?? [];
    const call = {
      kind: 'call',
      // The dump's own row id: a reader hands it back to the query layer for the typed arguments (`argsOf`), the
      // receiver's type arguments and the targets.
      id: row.id ?? null,
      name: row.name,
      line: row.line,
      col: row.col ?? null,
      // Arguments are typed objects; the extractors read the written text of the first two.
      args: (row.args ?? []).slice(0, 2).map((a) => (typeof a === 'string' ? a : a?.text ?? '')),
      recvFqn: row.recv?.type ?? null,
      recvHow: row.recv?.how ?? row.recv?.kind ?? null,
      // The receiver's written type arguments at this site, as the dump spells them: `["shop.Voucher"]` for a call
      // made through `Base<Voucher>`, `["T"]` for one through a field declared `GenericRepo<T>`.
      typeArgs: row.recv?.typeArgs ?? [],
      targets: targets.map((t) => t.id),
      // Which of the targets is the declaration and which an override: the walk's policy reads this, never the order.
      targetKinds: new Map(targets.map((t) => [t.id, t.kind])),
      // True only when the dump says the call reaches exactly one implementation of a bodiless declaration.
      uniqueImpl: row.uniqueImpl === true,
      how: howOf(row),
      origin: row.origin,
    };
    if (row.reason) call.reason = row.reason;
    // The receiver in the vocabulary the truth files address: a written name, a call, a type, or `super`.
    const recv = receiverOf(row);
    if (recv) call.recv = recv;
    method.calls.push(call);
  }

  const resolveConst = (file, owner, name) => {
    if (name.includes('.')) {
      const at = name.lastIndexOf('.');
      const ownerFqn = resolveIn(file, name.slice(0, at));
      return ownerFqn ? (constants.get(`${ownerFqn}.${name.slice(at + 1)}`) ?? null) : null;
    }
    const own = constants.get(`${owner}.${name}`);
    if (own != null) return own;
    const statics = (sources.get(file)?.imports ?? []).filter((i) => i.isStatic && !i.wildcard);
    for (const i of statics) if (simple(i.name) === name) return constants.get(i.name) ?? null;
    return null;
  };
  for (const file of sources.keys())
    if (sources.get(file)?.degraded) degraded.add(file);
  // Catalog selection reads which frameworks the build uses; that is the file's own imports, unchanged.
  const importsOf = new Map([...sources].map(([file, s]) => [file, { pkg: s.pkg ?? '', imports: s.imports ?? [] }]));
  // `dump` rides on the model so an extractor can ask the query layer about code without a second plumbing path: the
  // dump is the only reader of Java, and the model is built from it. Null when the caller had none (tests, fixtures).
  // `methodsById`: every method by id, with the type that declares it.
  return {
    types, byFile, importsOf, external, implsOf, degraded, resolveIn, constants, resolveConst, dump, methodsById,
  };
}

/**
 * A written receiver, as the truth files address it: a name, a chained call, or nothing. The engine prints a type
 * fully qualified (`java.util.List`) where the author wrote `List`, so a leading package is dropped — the first
 * segment that starts with a capital names the type.
 */
function receiverOf(row) {
  const written = row.recv?.text ?? null;
  if (!written) return null;
  // A static call written without a receiver inside its own class: Spoon names the class, the author did not.
  if (row.recv.kind === 'static' && String(row.method ?? '').startsWith(`${row.recv.type}#`)) return null;
  const segments = written.split('.');
  const firstType = segments.findIndex((s) => /^[A-Z]/.test(s));
  const text = firstType > 0 ? segments.slice(firstType).join('.') : written;
  return { kind: text.includes('(') ? 'call' : 'name', text };
}

// `direct` when the answer names one declaration of the receiver's own type, `impl` when it reaches an implementation
// or several, `external` for a library, `unresolved` when the engine could not answer. The vocabulary the facts speak.
function howOf(row) {
  const targets = (row.targets ?? []).map((t) => t?.id).filter(Boolean);
  // `arity` is a member lookup that found exactly one member: it names a target just as the compiler does.
  if (row.origin === 'java' || row.origin === 'lombok' || row.origin === 'arity') {
    // A generated member (Lombok's builder step) has a receiver but no declaration to name: the chain typed it.
    if (!targets.length) return row.reason === 'lombok-builder' ? 'generated' : 'unresolved';
    return targets.length > 1 || (targets.length === 1 && targets[0].split('#')[0] !== row.recv?.type)
      ? 'impl'
      : 'direct';
  }
  return row.origin === 'library' ? 'external' : 'unresolved';
}

/** Names as written in one file, resolved from that file's imports and its own package. Only bodies need this. */
function resolver(sources, types, known = new Set()) {
  const cache = new Map();
  // Built once from every registered type: a simple name nested in two types is ambiguous and maps to null.
  const nested = new Map();
  for (const [fqn, t] of types) if (t.enclosing) nested.set(simple(fqn), nested.has(simple(fqn)) ? null : fqn);
  const forFile = (file) => {
    if (cache.has(file)) return cache.get(file);
    const source = sources.get(file) ?? { pkg: '', imports: [] };
    const singles = new Map(
      (source.imports ?? []).filter((i) => !i.wildcard && !i.isStatic).map((i) => [simple(i.name), i.name]),
    );
    const wildcards = (source.imports ?? []).filter((i) => i.wildcard && !i.isStatic).map((i) => i.name);
    const resolve = (name) => {
      const text = typeNameOf(name);
      if (!text) return null;
      if (text.includes('.')) {
        const [head, ...rest] = text.split('.');
        const owner = singles.get(head) ?? (types.has(`${source.pkg}.${head}`) ? `${source.pkg}.${head}` : null) ?? nested.get(head);
        return owner ? [owner, ...rest].join('.') : text;
      }
      if (singles.has(text)) return singles.get(text);
      if (types.has(`${source.pkg}.${text}`)) return `${source.pkg}.${text}`;
      if (nested.has(text)) return nested.get(text);
      if (JAVA_LANG.has(text)) return `java.lang.${text}`;
      const hits = wildcards.map((w) => `${w}.${text}`).filter((fqn) => types.has(fqn));
      if (hits.length === 1) return hits[0];
      // A wildcard import supplies a name javac has never seen here when a framework says the package holds it
      // (`jakarta.persistence.*` and `@Entity`). The catalogs are that knowledge; a lone wildcard is enough.
      const hinted = wildcards.map((w) => `${w}.${text}`).find((fqn) => known.has(fqn));
      if (hinted) return hinted;
      return wildcards.length === 1 ? `${wildcards[0]}.${text}` : null;
    };
    cache.set(file, resolve);
    return resolve;
  };
  return (file, name) => forFile(file)(name);
}

{
  const mk = (rows, members, calls = []) => {
    const types = new Map(rows.map((r) => [r.fqn, r]));
    const byOwner = new Map();
    for (const m of members) push(byOwner, m.owner, m);
    return { types, membersOf: (fqn) => byOwner.get(fqn) ?? [], calls };
  };
  const dump = mk(
    [
      {
        fqn: 'a.Port', kind: 'interface', supertypes: [], ann: [],
        pos: { file: 'src/a/Port.java', line: 1, endLine: 4 },
      },
      {
        fqn: 'a.Impl', kind: 'class', supertypes: [{ kind: 'interface', text: 'Port', fqn: 'a.Port' }],
        ann: [{ name: 'org.springframework.stereotype.Service', raw: '', args: {} }],
        pos: { file: 'src/a/Impl.java', line: 1, endLine: 9 },
      },
    ],
    [
      {
        kind: 'field', owner: 'a.Impl', name: 'PATH', type: 'String', typeFqn: 'java.lang.String',
        modifiers: ['static', 'final'], ann: [], value: { kind: 'string', value: '/x' },
        pos: { file: 'src/a/Impl.java', line: 2, endLine: 2 },
      },
      {
        kind: 'method', owner: 'a.Impl', name: 'find', id: 'a.Impl#find(Long)',
        params: [{ name: 'id', type: 'Long', ann: [] }], ann: [], hasBody: true,
        branches: [{ start: 5, end: 6, kind: 'if' }],
        pos: { file: 'src/a/Impl.java', line: 4, endLine: 8 },
      },
    ],
    [
      {
        method: 'a.Impl#find(Long)', file: 'src/a/Impl.java', line: 5, name: 'save', argc: 0,
        recv: { type: 'a.Port', how: 'field' }, targets: [{ id: 'a.Port#save()', kind: 'declared' }], origin: 'java', args: [],
      },
    ],
  );
  const model = buildModelFromDump(dump, new Map([['src/a/Impl.java', { pkg: 'a', imports: [] }]]));
  assert.deepStrictEqual([...model.types.keys()], ['a.Port', 'a.Impl']);
  const impl = model.types.get('a.Impl');
  assert.equal(impl.pkg, 'a');
  assert.deepStrictEqual(impl.ann.map((a) => a.fqn), ['org.springframework.stereotype.Service']);
  assert.deepStrictEqual(impl.supers.map((s) => s.fqn), ['a.Port']);
  assert.equal(impl.fields[0].typeFqn, 'java.lang.String');
  assert.equal(model.constants.get('a.Impl.PATH'), '/x');
  assert.equal(model.resolveConst('src/a/Impl.java', 'a.Impl', 'PATH'), '/x');
  assert.equal(impl.methods[0].id, 'a.Impl#find(Long)');
  assert.deepStrictEqual(impl.methods[0].branches, [{ start: 5, end: 6, kind: 'if' }]);
  assert.deepStrictEqual(impl.methods[0].calls[0], {
    kind: 'call', id: null, name: 'save', line: 5, col: null, args: [], recvFqn: 'a.Port', recvHow: 'field', typeArgs: [],
    targets: ['a.Port#save()'], targetKinds: new Map([['a.Port#save()', 'declared']]), uniqueImpl: false,
    how: 'direct', origin: 'java',
  });
  assert.deepStrictEqual(model.implsOf.get('a.Port'), ['a.Impl']);
  assert.equal(model.resolveIn('src/a/Impl.java', 'Port'), 'a.Port');
}
