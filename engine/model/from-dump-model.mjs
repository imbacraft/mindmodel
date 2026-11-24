// The model, built from the dump. Spoon already answered every question of identity and reach — what a type is, where
// its annotations point, what its fields are typed as, which methods it has, and what each call reaches — so nothing
// here resolves anything: it arranges the answers in the shape the extractors read.
import assert from 'node:assert';

const simpleOf = (name) => String(name ?? '').split('.').pop();
export const typeNameOf = (text) => (text ?? '').replace(/<[\s\S]*/, '').replace(/\[\]/g, '').trim();

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
    name: simpleOf(a.name),
    fqn: resolveIn ? resolveIn(a.name) ?? a.name : a.name,
    args: a.raw ?? '',
    line: a.line || line,
  }));

/** Where a declaration starts, annotations included: the line every citation and evidence string quotes. */
const startsAt = (row, line) => {
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
  // Built before the walk and read during it: it answers from the map as it fills, and only names written in a body
  // or an annotation ever reach it.
  const resolveIn = resolver(sources, types, known);

  for (const row of dump.types.values()) {
    const file = row.pos?.file ?? '';
    types.set(row.fqn, {
      kind: row.kind,
      name: simpleOf(row.fqn),
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
      ann: annOf(row, row.pos?.line ?? 1, (name) => resolveIn(file, name)),
      supers: (row.supertypes ?? []).map((s) => ({ kind: s.kind, text: s.text, fqn: s.fqn ?? null })),
      fields: [],
      methods: [],
      enumValues: [],
    });
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(row.fqn);
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
      if (types.has(s.fqn)) implsOf.set(s.fqn, [...(implsOf.get(s.fqn) ?? []), t.fqn]);
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
        const value = member.value?.value;
        if (member.value && member.value.kind !== 'unresolved')
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
        synthetic: member.generated,
        calls: [],
      });
    }

  // Calls join their own method by id, the same string every layer keys a method by.
  const byId = new Map();
  for (const t of types.values()) for (const m of t.methods) byId.set(m.id, m);
  for (const row of dump.calls) {
    const method = byId.get(row.method);
    if (!method || row.origin === 'error') continue;
    const call = {
      kind: 'call',
      name: row.name,
      line: row.line,
      args: row.args ?? [],
      recvFqn: row.recv?.type ?? null,
      recvHow: row.recv?.how ?? row.recv?.kind ?? null,
      targets: row.targets ?? [],
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
    for (const i of statics) if (simpleOf(i.name) === name) return constants.get(i.name) ?? null;
    return null;
  };
  for (const file of sources.keys())
    if (sources.get(file)?.degraded) degraded.add(file);
  // Catalog selection reads which frameworks the build uses; that is the file's own imports, unchanged.
  const importsOf = new Map([...sources].map(([file, s]) => [file, { pkg: s.pkg ?? '', imports: s.imports ?? [] }]));
  return { types, byFile, importsOf, external, implsOf, degraded, resolveIn, constants, resolveConst };
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
  const targets = row.targets ?? [];
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
  const forFile = (file) => {
    if (cache.has(file)) return cache.get(file);
    const source = sources.get(file) ?? { pkg: '', imports: [] };
    const singles = new Map(
      (source.imports ?? []).filter((i) => !i.wildcard && !i.isStatic).map((i) => [simpleOf(i.name), i.name]),
    );
    const wildcards = (source.imports ?? []).filter((i) => i.wildcard && !i.isStatic).map((i) => i.name);
    const nested = new Map();
    for (const fqn of types.keys())
      if (types.get(fqn)?.enclosing) nested.set(simpleOf(fqn), nested.has(simpleOf(fqn)) ? null : fqn);
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
    for (const m of members) byOwner.set(m.owner, [...(byOwner.get(m.owner) ?? []), m]);
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
        recv: { type: 'a.Port', how: 'field' }, targets: ['a.Port#save()'], origin: 'java', args: [],
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
    kind: 'call', name: 'save', line: 5, args: [], recvFqn: 'a.Port', recvHow: 'field',
    targets: ['a.Port#save()'], how: 'direct', origin: 'java',
  });
  assert.deepStrictEqual(model.implsOf.get('a.Port'), ['a.Impl']);
  assert.equal(model.resolveIn('src/a/Impl.java', 'Port'), 'a.Port');
}
