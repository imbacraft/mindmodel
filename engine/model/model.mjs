// L3: the symbol model. Every declaration in the project, with full names and the imports needed to resolve them.
// Bodies stay in the syntax index; this layer only adds identity and the links a fact can be built on.
import assert from 'node:assert';
import { evalString } from './strings.mjs';

const simpleOf = (name) => name.split('.').pop();

// java.lang is imported implicitly. Keeping the list explicit is knowledge, not a guess: a project type of the same
// simple name in the file's own package wins first, exactly as javac would.
const JAVA_LANG = new Set([
  'String', 'Object', 'Class', 'Enum', 'Record', 'Throwable', 'Exception', 'RuntimeException', 'Error',
  'IllegalArgumentException', 'IllegalStateException', 'UnsupportedOperationException', 'NullPointerException',
  'ArithmeticException', 'InterruptedException', 'IndexOutOfBoundsException', 'ClassCastException',
  'Runnable', 'Thread', 'ThreadLocal', 'Iterable', 'Comparable', 'Cloneable', 'AutoCloseable',
  'Integer', 'Long', 'Short', 'Byte', 'Double', 'Float', 'Boolean', 'Character', 'Number', 'Math', 'StrictMath',
  'System', 'StringBuilder', 'StringBuffer', 'CharSequence', 'Void', 'Package', 'Process', 'Runtime', 'SecurityManager',
  'Deprecated', 'Override', 'SuppressWarnings', 'FunctionalInterface', 'SafeVarargs',
]);

// A type list such as "A, B<C, D>" -> ["A", "B<C, D>"]; generics carry commas of their own.
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

// "a.b.C<D>" -> "a.b.C"; "C[]" -> "C".
export const typeNameOf = (text) => (text ?? '').replace(/<.*/, '').replace(/\[\]/g, '').trim();

// Resolve names as written in one file: single-type imports first, then the same package, then nested types of the
// file's own types (`AnalysisTrigger` inside `AgentAlertAnalysisEventHandler`), then wildcard imports when exactly
// one project type matches. A single-type import of a type the project does not declare resolves to that FQN as an
// external type. Unknown names stay null, and the text is kept.
function resolverFor({ pkg, imports }, types, nested = new Map()) {
  const singles = new Map(
    imports.filter((i) => !i.wildcard && !i.isStatic).map((i) => [simpleOf(i.name), i.name]),
  );
  const wildcards = imports.filter((i) => i.wildcard && !i.isStatic).map((i) => i.name);
  return (name) => {
    const text = typeNameOf(name);
    if (!text) return null;
    // A nested type written as `Outer.Inner` (Lombok's `Builder.Default`, a project's `Foo.Mode`): resolve the owner,
    // keep the rest. A written-out FQN's first segment is not a type the file can see, so it stays as written.
    if (text.includes('.')) {
      const [head, ...rest] = text.split('.');
      const owner = singles.get(head) ?? (types.has(`${pkg}.${head}`) ? `${pkg}.${head}` : null) ?? nested.get(head);
      return owner ? [owner, ...rest].join('.') : text;
    }
    if (singles.has(text)) return singles.get(text);
    if (types.has(`${pkg}.${text}`)) return `${pkg}.${text}`;
    if (nested.has(text)) return nested.get(text);
    if (JAVA_LANG.has(text)) return `java.lang.${text}`;
    const hits = wildcards.map((w) => `${w}.${text}`).filter((fqn) => types.has(fqn));
    return hits.length === 1 ? hits[0] : null;
  };
}

export function buildModel(files) {
  const types = new Map(),
    byFile = new Map(),
    importsOf = new Map(),
    external = new Set(),
    implsOf = new Map(),
    degraded = new Set(),
    // Paths are often built from `static final String` constants; the model resolves them here, once.
    constants = new Map(),
    rawConst = new Map(),
    staticOf = new Map(),
    resolvers = new Map();

  // Pass 1: identity. Types are in source order, so a nested type's owner is already known when it appears.
  for (const { p, ix } of files) {
    if (ix.degraded) degraded.add(p);
    importsOf.set(p, { pkg: ix.pkg, imports: ix.imports });
    const named = new Map();
    byFile.set(p, []);
    for (const t of ix.types) {
      const ownerFqn = t.owner ? named.get(t.owner) : null;
      const fqn = ownerFqn ? `${ownerFqn}.${t.name}` : ix.pkg ? `${ix.pkg}.${t.name}` : t.name;
      named.set(t.name, fqn);
      types.set(fqn, { ...t, fqn, pkg: ix.pkg, file: p, methods: [], fields: [], supers: [] });
      byFile.get(p).push(fqn);
      for (const i of ix.imports)
        if (!i.wildcard && !i.isStatic && !types.has(i.name)) external.add(i.name);
    }
  }

  // Pass 2: links. Annotations and supertypes get their FQN; methods and fields join their innermost type.
  for (const { p, ix } of files) {
    // Nested types of this file, by simple name; two same-named nested types make the name ambiguous (null).
    const nested = new Map();
    for (const fqn of byFile.get(p)) {
      const t = types.get(fqn);
      if (t.owner) nested.set(t.name, nested.has(t.name) ? null : fqn);
    }
    const resolve = resolverFor(importsOf.get(p), types, nested);
    resolvers.set(p, resolve);
    staticOf.set(
      p,
      new Map(
        ix.imports.filter((i) => i.isStatic && !i.wildcard).map((i) => [i.name.split('.').pop(), i.name]),
      ),
    );
    const fileTypes = byFile.get(p).map((fqn) => types.get(fqn)),
      innermost = (line) =>
        fileTypes
          .filter((t) => t.start <= line && line <= t.end)
          .sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null;
    for (const fqn of byFile.get(p)) {
      const t = types.get(fqn);
      t.ann = (t.ann ?? []).map((a) => ({ ...a, fqn: resolve(a.name) }));
      t.supers = [...splitTypes(t.extends), ...splitTypes(t.implements)].map((text) => ({
        text,
        fqn: resolve(typeNameOf(text)),
      }));
      for (const s of t.supers) if (s.fqn) implsOf.set(s.fqn, [...(implsOf.get(s.fqn) ?? []), fqn]);
    }
    for (const m of ix.methods) {
      const t = innermost(m.nameLine);
      if (!t) continue;
      // Parameter annotations carry meaning too (@PathParam, @RequestBody, @NotNull): resolve them with the method.
      t.methods.push({
        ...m,
        ann: m.ann.map((a) => ({ ...a, fqn: resolve(a.name) })),
        params: (m.params ?? []).map((p) => ({
          ...p,
          ann: (p.ann ?? []).map((a) => ({ ...a, fqn: resolve(a.name) })),
        })),
      });
    }
    for (const f of ix.fields) {
      const t = innermost(f.line);
      if (!t) continue;
      t.fields.push({
        ...f,
        typeFqn: resolve(f.type),
        ann: (f.ann ?? []).map((a) => ({ ...a, fqn: resolve(a.name) })),
      });
    }
    for (const c of ix.constants ?? []) {
      const t = innermost(c.line);
      if (!t) continue;
      rawConst.set(`${t.fqn}.${c.name}`, { value: c.value, file: p, owner: t.fqn });
    }
  }

  // A constant reference, as written in a file: qualified (`Consts.ID`) or bare (`ID`, from the same type or a static
  // import). Values resolve in passes, because one constant may be built from another.
  const constantOf = (file, owner, name) => {
    if (name.includes('.')) {
      const at = name.lastIndexOf('.');
      const qual = name.slice(0, at),
        field = name.slice(at + 1);
      const tfqn = resolvers.get(file)?.(qual);
      return tfqn ? (constants.get(`${tfqn}.${field}`) ?? null) : null;
    }
    const own = constants.get(`${owner}.${name}`);
    if (own != null) return own;
    const viaStatic = staticOf.get(file)?.get(name); // `import static a.b.C.ID;` names the field, not its value
    return viaStatic ? (constants.get(viaStatic) ?? null) : null;
  };
  for (let pass = 0; pass < 4; pass++) {
    let added = 0;
    for (const [key, c] of rawConst)
      if (!constants.has(key)) {
        const { text, unresolved } = evalString(c.value, (n) => constantOf(c.file, c.owner, n));
        if (!unresolved.length) {
          constants.set(key, text);
          added++;
        }
      }
    if (!added) break;
  }

  const resolveIn = (file, name) => resolverFor(importsOf.get(file) ?? { pkg: '', imports: [] }, types)(name);
  return { types, byFile, importsOf, external, implsOf, degraded, resolveIn, constants, resolveConst: constantOf };
}

{
  const files = [
    {
      p: 'src/a/Outer.java',
      ix: {
        pkg: 'a',
        imports: [
          { name: 'a.repo.OrderRepository', wildcard: false, isStatic: false },
          { name: 'org.springframework.web.bind.annotation.GetMapping', wildcard: false, isStatic: false },
          { name: 'java.util.List', wildcard: false, isStatic: false },
          { name: 'lombok.Builder', wildcard: false, isStatic: false },
          { name: 'jakarta.ws.rs.PathParam', wildcard: false, isStatic: false },
          { name: 'jakarta.ws.rs', wildcard: true, isStatic: false },
        ],
        types: [
          { kind: 'class', name: 'Outer', owner: undefined, start: 1, end: 20, nameLine: 1, ann: [] },
          { kind: 'class', name: 'Inner', owner: 'Outer', start: 5, end: 10, nameLine: 5, ann: [] },
        ],
        methods: [
          {
            name: 'inner',
            nameLine: 6,
            start: 6,
            end: 9,
            ann: [
              { name: 'Builder.Default', args: '', line: 6 },
              { name: 'Outer.Mode', args: '', line: 7 },
            ],
          },
          {
            name: 'outer',
            nameLine: 14,
            start: 14,
            end: 18,
            ann: [{ name: 'GetMapping', args: '"/x"', line: 13 }],
            params: [{ name: 'id', type: 'String', ann: [{ name: 'PathParam', args: '"id"', line: 14 }] }],
          },
        ],
        fields: [
          { name: 'repo', type: 'OrderRepository', line: 15, owner: 'Outer', ann: [] },
          { name: 'items', type: 'List<String>', line: 16, owner: 'Outer', ann: [] },
        ],
      },
    },
    {
      p: 'src/a/repo/OrderRepository.java',
      ix: {
        pkg: 'a.repo',
        imports: [],
        types: [
          {
            kind: 'interface',
            name: 'OrderRepository',
            owner: undefined,
            start: 1,
            end: 3,
            nameLine: 1,
            extends: 'JpaRepository<Order, Long>',
            ann: [],
          },
        ],
        methods: [],
        fields: [],
      },
    },
  ];
  const model = buildModel(files);
  assert.deepStrictEqual(
    [...model.types.keys()].sort(),
    ['a.Outer', 'a.Outer.Inner', 'a.repo.OrderRepository'],
  );
  const outer = model.types.get('a.Outer');
  assert.deepStrictEqual(
    outer.methods.map((m) => m.name),
    ['outer'],
  );
  assert.deepStrictEqual(
    model.types.get('a.Outer.Inner').methods.map((m) => m.name),
    ['inner'],
  );
  assert.equal(outer.methods[0].ann[0].fqn, 'org.springframework.web.bind.annotation.GetMapping');
  // A nested annotation type written `Outer.Inner` resolves through its owner: Lombok's `Builder.Default`, a
  // project's `Outer.Mode`. Nothing else about annotations changes.
  assert.deepStrictEqual(
    model.types.get('a.Outer.Inner').methods[0].ann.map((a) => a.fqn),
    ['lombok.Builder.Default', 'a.Outer.Mode'],
  );
  assert.equal(outer.fields[0].typeFqn, 'a.repo.OrderRepository');
  assert.equal(outer.methods[0].params[0].ann[0].fqn, 'jakarta.ws.rs.PathParam');
  assert.equal(outer.fields[1].typeFqn, 'java.util.List');
  assert.deepStrictEqual(
    model.types.get('a.repo.OrderRepository').supers.map((s) => s.fqn),
    [null],
  );
  assert.equal(model.resolveIn('src/a/Outer.java', 'Order'), null); // not imported: unresolved, never guessed
  assert.equal(model.resolveIn('src/a/Outer.java', 'Inner'), null); // nested types resolve by owner, not here
  assert.ok(model.external.has('java.util.List'));
}

// Constants: `static final String`s resolve through the model, including one built from another, and through a
// static import. Something the model cannot resolve stays absent instead of being guessed.
{
  const model = buildModel([
    {
      p: 'src/a/Consts.java',
      ix: {
        pkg: 'a',
        imports: [],
        types: [{ kind: 'class', name: 'Consts', start: 1, end: 8, nameLine: 1, ann: [] }],
        methods: [],
        fields: [],
        constants: [
          { name: 'ID', value: '"jobId"', line: 3 },
          { name: 'BASE', value: '"/v1/jobs"', line: 4 },
          { name: 'ONE', value: 'BASE + "/{" + ID + "}"', line: 5 },
          { name: 'LOOP', value: 'LOOP + "/x"', line: 6 },
        ],
      },
    },
    {
      p: 'src/a/Use.java',
      ix: {
        pkg: 'a',
        imports: [
          { name: 'a.Consts.ID', wildcard: false, isStatic: true },
          { name: 'a.Consts', wildcard: false, isStatic: false },
        ],
        types: [{ kind: 'class', name: 'Use', start: 1, end: 6, nameLine: 1, ann: [] }],
        methods: [],
        fields: [],
        constants: [],
      },
    },
  ]);
  assert.equal(model.constants.get('a.Consts.ONE'), '/v1/jobs/{jobId}');
  assert.equal(model.constants.get('a.Consts.LOOP'), undefined); // a cycle resolves to nothing, never to garbage
  assert.equal(model.resolveConst('src/a/Use.java', 'a.Use', 'ID'), 'jobId'); // static import
  assert.equal(model.resolveConst('src/a/Use.java', 'a.Use', 'Consts.ID'), 'jobId'); // local type, qualified
  assert.equal(model.resolveConst('src/a/Use.java', 'a.Use', 'NOPE'), null);
}
