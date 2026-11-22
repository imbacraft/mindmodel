// L3: call resolution. Every call site in the model gets a receiver type, the method(s) it targets and how sure we
// are: direct, on a supertype, through an implementation, ambiguous overloads, an external type, or unresolved.
// No compiler: types come from declarations, imports, locals, fields, parameters, one level of chaining and the JDK
// signature catalog. §5.1a is the bet; coverage's two rates (§6.1) are how it is judged.
import assert from 'node:assert';
import { typeNameOf } from './model.mjs';

// `List<Order>` -> ['Order']; `Map<String, List<Order>>` -> ['String', 'List<Order>'] (top-level commas only).
export function typeArgsOf(text) {
  if (!text || text.indexOf('<') < 0) return [];
  const m = /<([\s\S]+)>/.exec(text);
  if (!m) return [];
  const out = [];
  let depth = 0,
    cur = '';
  for (const ch of m[1]) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// A resolved type: the FQN (project or external, null when unresolved), the text it came from, and its arguments.
const typeRef = (model, file, text) => {
  const raw = String(text ?? '').replace(/\[\]/g, '').trim();
  const base = typeNameOf(raw);
  return {
    fqn: base ? model.resolveIn(file, base) : null,
    text: base,
    args: typeArgsOf(raw).map((a) => typeRef(model, file, a)),
  };
};

export function bindCalls(model, signatures = new Map()) {
  const { types, implsOf } = model;
  const EMPTY = [];
  const refOf = (file, text) => typeRef(model, file, text);

  // Members the compiler or Lombok writes without a declaration: a record's accessors and canonical constructor, and
  // the logger `@Slf4j` adds. They are marked generated; a fact that rests on one is `inferred`.
  for (const t of types.values()) {
    const anns = (t.ann ?? []).map((a) => a.fqn ?? a.name);
    if (
      anns.some(
        (a) =>
          /^lombok\.(Log|Log4j|Log4j2|Slf4j|XSlf4j|CommonsLog|JBossLog|Flogger)$/.test(a) ||
          /^lombok\.extern\.(slf4j|log4j|log4j2|apachecommonslog|jbosslog|flogger)\./.test(a),
      ) &&
      !t.fields.some((f) => f.name === 'log')
    )
      t.fields.push({ name: 'log', type: 'org.slf4j.Logger', static: true, generated: 'lombok' });
    if (t.kind === 'record' && t.components?.length) {
      for (const c of t.components)
        if (!t.methods.some((m) => m.name === c.name && !m.params.length))
          t.methods.push({ name: c.name, arity: 0, params: [], ann: [], returnText: c.type, generated: 'record' });
      if (!t.methods.some((m) => m.name === t.name && m.params.length === t.components.length))
        t.methods.push({
          name: t.name,
          arity: t.components.length,
          params: t.components.map((c) => ({ name: c.name, type: c.type })),
          ann: [],
          returnText: 'void',
          generated: 'record',
        });
    }
  }

  // Nested maps, not composite string keys: resolution asks these on every call, and building a key string per lookup
  // was the largest source of short-lived garbage in a 166k-call scan.
  const byName = new Map(); // typeFqn -> name -> [method]
  const fields = new Map(); // typeFqn -> name -> field
  for (const t of types.values()) {
    const at = new Map(),
      fieldAt = new Map();
    for (const m of t.methods) {
      m.id = `${t.fqn}#${m.name}(${m.params.map((p) => (p.type ?? '').replace(/\s+/g, '')).join(',')})`;
      if (!at.has(m.name)) at.set(m.name, []);
      at.get(m.name).push(m);
    }
    for (const f of t.fields) fieldAt.set(f.name, f);
    byName.set(t.fqn, at);
    fields.set(t.fqn, fieldAt);
  }

  // A type's supertype chain is immutable during a scan and asked for on every call: compute each once. Without the
  // cache, resolution allocated a fresh array and Set per call, which drove fineract's peak RSS past its budget.
  const chainCache = new Map(),
    sigCache = new Map();
  const projectChain = (fqn) => {
    if (!fqn) return EMPTY;
    if (chainCache.has(fqn)) return chainCache.get(fqn);
    const t = types.get(fqn);
    const out = t ? [{ fqn, type: t }, ...(t.supers ?? []).flatMap((s) => (s.fqn ? projectChain(s.fqn) : []))] : EMPTY;
    // A cyclic hierarchy (malformed source) would recurse forever; the memo is still being built, so guard it.
    chainCache.set(fqn, out);
    return out;
  };
  const sigChain = (fqn) => {
    if (!fqn) return EMPTY;
    if (sigCache.has(fqn)) return sigCache.get(fqn);
    const s = signatures.get(fqn);
    const out = s ? [{ fqn, sig: s }, ...(s.supers ?? []).flatMap((x) => sigChain(x))] : EMPTY;
    sigCache.set(fqn, out);
    return out;
  };
  const isInterfaceLike = (t) => t && (t.kind === 'interface' || t.abstract);
  const arityOk = (m, argc) =>
    argc == null || m.arity === argc || (m.params ?? []).some((p) => p.varargs);

  function fieldOf(typeFqn, name) {
    for (const { type } of projectChain(typeFqn)) {
      const f = fields.get(type.fqn)?.get(name);
      if (f) return { field: f, file: type.file };
    }
    return null;
  }

  // Lombok generates accessors; there is no declaration to cite, so facts built on them are `inferred`.
  function lombokAccessor(typeFqn, name) {
    for (const { type } of projectChain(typeFqn)) {
      const anns = (type.ann ?? []).map((a) => a.fqn ?? a.name);
      const getter = anns.some((a) => /\.(Data|Getter|Value)$/.test(a));
      const setter = anns.some((a) => /\.(Data|Setter|Value)$/.test(a));
      const field = type.fields.find(
        (f) =>
          (getter && (name === `get${cap(f.name)}` || name === `is${cap(f.name)}`)) ||
          (setter && name === `set${cap(f.name)}`),
      );
      if (field) return { id: `${type.fqn}#${name}(${name.startsWith('set') ? field.type : ''})`, type, field };
    }
    return null;
  }

  // Project methods for a name+arity on a type, its supertypes, and (for an interface or abstract type) its impls.
  function findOn(typeFqn, name, argc) {
    const out = [];
    const chain = projectChain(typeFqn);
    for (const [i, { type }] of chain.entries())
      for (const m of byName.get(type.fqn)?.get(name) ?? EMPTY)
        if (arityOk(m, argc)) out.push({ m, type, how: i === 0 ? 'direct' : 'super' });
    if (!out.length && isInterfaceLike(types.get(typeFqn)))
      for (const impl of implsOf.get(typeFqn) ?? EMPTY)
        for (const m of byName.get(impl)?.get(name) ?? EMPTY)
          if (arityOk(m, argc)) out.push({ m, type: types.get(impl), how: 'impl' });
    return out;
  }

  // The receiver's type arguments substituted for the declaring type's parameters: `Repo<Order>.find() -> Order`.
  // Null when there is nothing to substitute: most types are not generic, and a fresh Map per call was pure garbage.
  const envFor = (declaring, receiverRef) => {
    if (!declaring?.typeParams?.length || !receiverRef?.args?.length) return null;
    let env = null;
    declaring.typeParams.forEach((p, i) => {
      if (receiverRef.args[i]?.fqn) {
        env ??= new Map();
        env.set(p, receiverRef.args[i]);
      }
    });
    return env;
  };
  const substitute = (ref, env) => {
    if (!env) return ref;
    if (env.has(ref.text)) return env.get(ref.text);
    return { ...ref, args: ref.args.map((a) => substitute(a, env)) };
  };

  // The type a call on `typeFqn.name(args)` returns: a project method's declaration, Lombok's accessor, or the JDK.
  function returnOf(typeFqn, name, argc, receiverRef, args) {
    const hit = findOn(typeFqn, name, argc)[0];
    if (hit) {
      const ref = refOf(hit.type.file, hit.m.returnText);
      return { ref: substitute(ref, envFor(hit.type, receiverRef)) };
    }
    const sig = sigChain(typeFqn).find(({ sig }) => sig.methods && Object.hasOwn(sig.methods, name));
    if (sig) {
      // Some JDK returns depend on the argument (`stream().collect(toList())`); the catalog states them as data.
      let text = sig.sig.methods[name];
      const rules = sig.sig.byArg && Object.hasOwn(sig.sig.byArg, name) ? sig.sig.byArg[name] : null;
      if (rules) {
        const argsText = (args ?? []).join(', ');
        text = (rules.find((r) => new RegExp(r.match || '.*').test(argsText)) ?? rules[rules.length - 1]).returns;
      }
      const ref = refOf('', text);
      return { ref: substitute(ref, envFor({ typeParams: sig.sig.typeParams }, receiverRef)) };
    }
    const lombok = lombokAccessor(typeFqn, name);
    if (lombok && /^(get|is)/.test(name)) return { ref: refOf(lombok.type.file, lombok.field.type) };
    return null;
  }

  const thisRef = (t) => ({ fqn: t.fqn, text: t.name, args: [] });

  // One receiver expression -> { fqn, ref, how } (§5.1's order of rules).
  function resolveReceiver(call, ctx) {
    if (call.kind === 'new') {
      const ref = refOf(ctx.file, call.name);
      return { fqn: ref.fqn, ref, how: ref.fqn ? 'direct' : 'unresolved' };
    }
    if (!call.recv) return { fqn: ctx.type.fqn, ref: thisRef(ctx.type), how: 'direct' };
    if (call.recv.kind === 'call') {
      const inner = resolveReceiver({ kind: 'call', name: call.recv.name, argc: call.recv.argc, args: call.recv.args, recv: call.recv.recv }, ctx);
      if (!inner.fqn) return { fqn: null, ref: null, how: 'unresolved' };
      const ret = returnOf(inner.fqn, call.recv.name, call.recv.argc, inner.ref, call.recv.args);
      return ret ? { fqn: ret.ref.fqn, ref: ret.ref, how: 'chain' } : { fqn: null, ref: null, how: 'unresolved' };
    }
    if (call.recv.kind === 'new') {
      const ref = refOf(ctx.file, call.recv.type);
      return { fqn: ref.fqn, ref, how: ref.fqn ? 'direct' : 'unresolved' };
    }
    if (call.recv.kind === 'expr') {
      // A literal receiver (`"x".equals(y)`) has a type even though nothing declares it.
      const text = call.recv.text ?? '';
      const literal = /^"/.test(text) ? 'java.lang.String' : /^'/.test(text) ? 'java.lang.Character' : /^-?\d/.test(text) ? 'java.lang.Integer' : null;
      return literal
        ? { fqn: literal, ref: { fqn: literal, text: literal.split('.').pop(), args: [] }, how: 'literal' }
        : { fqn: null, ref: null, how: 'unresolved' };
    }
    if (call.recv.kind !== 'name') return { fqn: null, ref: null, how: 'unresolved' };
    const r = resolveName(call.recv.text, ctx, call.line);
    return r ?? { fqn: null, ref: null, how: 'unresolved' };
  }

  function resolveName(text, ctx, line) {
    if (text === 'this') return { fqn: ctx.type.fqn, ref: thisRef(ctx.type), how: 'direct' };
    if (text === 'super') {
      const sup = (ctx.type.supers ?? []).find((s) => s.fqn && types.has(s.fqn));
      return sup ? { fqn: sup.fqn, ref: refOf(ctx.file, sup.text), how: 'super' } : null;
    }
    const stripped = text.indexOf('.') === 0 ? text : text.replace(/^this\./, '');
    const dotted = stripped.indexOf('.') >= 0;
    const parts = dotted ? stripped.split('.') : null;
    const head = dotted ? parts[0] : stripped,
      tail = dotted ? parts.slice(1) : null;
    const lambda = ctx.lambdaVars.find((v) => v.name === head && v.from <= line && line <= v.to);
    if (lambda) {
      let ref = lambda.ref;
      for (const seg of tail ?? EMPTY) {
        const declared = fieldOf(ref.fqn, seg);
        if (!declared) return null;
        ref = refOf(declared.file, declared.field.type);
      }
      return { fqn: ref.fqn, ref, how: 'lambda' };
    }
    // A qualified name: the last segment is a field of the owner of the rest (`a.b.repo` -> field repo of b).
    if (tail) {
      const owner = resolveName(parts.slice(0, -1).join('.'), ctx, line);
      if (owner) {
        const declared = fieldOf(owner.fqn, parts[parts.length - 1]);
        if (declared) {
          const ref = refOf(declared.file, declared.field.type);
          return { fqn: ref.fqn, ref, how: 'field' };
        }
      }
      const staticOwner = model.resolveIn(ctx.file, parts.slice(0, -1).join('.'));
      if (staticOwner) return { fqn: staticOwner, ref: { fqn: staticOwner, text: head, args: [] }, how: 'static' };
      return null;
    }
    const local = ctx.locals(head, line);
    if (local) return { fqn: local.fqn, ref: local, how: 'local' };
    const param = (ctx.method.params ?? []).find((p) => p.name === head);
    if (param) return { fqn: param.ref.fqn, ref: param.ref, how: 'param' };
    const declared = fieldOf(ctx.type.fqn, head);
    if (declared) {
      const ref = refOf(declared.file, declared.field.type);
      return { fqn: ref.fqn, ref, how: 'field' };
    }
    const asType = model.resolveIn(ctx.file, head);
    if (asType) return { fqn: asType, ref: { fqn: asType, text: head, args: [] }, how: 'static' };
    return null;
  }

  // Resolve every call of one method; `lambdaVars` are the scopes known from the previous pass.
  function resolveMethod(t, m, lambdaVars) {
    const ctx = {
      type: t,
      method: m,
      file: t.file,
      lambdaVars,
      locals: (name, line) => {
        const declared = (m.locals ?? []).filter((l) => l.name === name && l.line <= (line ?? m.end));
        const l = declared[declared.length - 1];
        if (!l) return null;
        if (l.type && l.type !== 'var') return refOf(ctx.file, l.type);
        if (l.init?.kind === 'new') return refOf(ctx.file, l.init.type);
        if (l.init?.kind === 'call') {
          const inner = resolveReceiver({ kind: 'call', ...l.init.call, recv: l.init.call.recv }, ctx);
          const ret = inner.fqn ? returnOf(inner.fqn, l.init.call.name, l.init.call.argc, inner.ref, l.init.call.args) : null;
          return ret?.ref ?? null;
        }
        return null;
      },
    };
    const scopes = [];
    for (const call of m.calls ?? []) {
      const recv = resolveReceiver(call, ctx);
      const ids = [];
      let firstHow = null;
      if (recv.fqn && types.has(recv.fqn))
        for (const x of findOn(recv.fqn, call.name, call.argc)) {
          ids.push(x.m.id);
          firstHow ??= x.how;
        }
      let how;
      if (!recv.fqn) how = 'unresolved';
      else if (!types.has(recv.fqn)) how = 'external';
      else if (!ids.length) {
        // Lombok writes the accessor: a target by convention, not a declaration.
        const lombok = call.kind !== 'new' ? lombokAccessor(recv.fqn, call.name) : null;
        if (lombok) {
          ids.push(lombok.id);
          how = 'convention';
        } else how = call.kind === 'new' ? 'external' : 'unresolved';
      } else how = firstHow;
      if (ids.length > 1 && new Set(ids).size > 1) how = 'ambiguous';
      call.recvFqn = recv.fqn ?? null;
      call.recvHow = recv.how;
      call.how = how;
      call.targets = [...new Set(ids)];
      // A lambda's parameter has the receiver's element type; the call that takes it introduces the scope.
      if (call.lambdas?.length) {
        const element = recv.ref?.args?.[0] ?? null;
        if (element?.fqn)
          for (const l of call.lambdas)
            for (const p of l.params) scopes.push({ name: p, ref: element, from: l.line, to: l.endLine });
      }
    }
    return scopes;
  }

  for (const t of types.values())
    for (const m of t.methods) {
      m.params = (m.params ?? []).map((p) => ({ ...p, ref: refOf(t.file, p.type) }));
      const scopes = resolveMethod(t, m, []);
      // Second pass only when a lambda introduced a scope: same calls, now with those names typed.
      if (scopes.length) resolveMethod(t, m, scopes);
      // The body digests were needed only to resolve; the resolved calls are what facts read. Freeing them keeps a
      // 5,000-file scan inside its memory budget.
      m.locals = null;
      m.assigns = null;
      m.catches = null;
    }

  // The two rates of §6.1, over call sites (constructors have no receiver and are not in either rate).
  const rate = { calls: 0, typed: 0, project: 0, targeted: 0 };
  for (const t of types.values())
    for (const m of t.methods)
      for (const call of m.calls ?? []) {
        if (call.kind === 'new') continue;
        rate.calls++;
        if (call.recvFqn) rate.typed++;
        if (call.recvFqn && types.has(call.recvFqn)) {
          rate.project++;
          if (call.targets?.length) rate.targeted++;
        }
      }
  model.bindings = rate;
  return model;
}

// ---------------------------------------------------------------------------------------------------------------
// A small project, parsed from source: locals, parameters, fields, `var`, chains, lambda parameters, Lombok, static
// calls, interfaces, and the JDK signature catalog. Every rate the coverage check reports starts here.
{
  const { index } = await import('../syntax/java.mjs');
  const { buildModel } = await import('./model.mjs');
  const src = {
    'a/Order.java': 'package a;\npublic class Order {\n  private Status status;\n  public Status getStatus() { return status; }\n  public void mark() { }\n}',
    'a/OrderRepository.java': 'package a;\npublic interface OrderRepository {\n  Order findOne(Long id);\n  java.util.List<Order> findAll();\n  Order save(Order o);\n}',
    'a/Data.java': 'package a;\nimport lombok.Data;\nimport lombok.RequiredArgsConstructor;\n@Data\n@RequiredArgsConstructor\npublic class Data {\n  private final OrderRepository repo;\n  private String name;\n}',
    'a/Svc.java':
      'package a;\nimport java.util.List;\npublic class Svc {\n  private final OrderRepository repo;\n  List<Order> orders() { return repo.findAll(); }\n  void run(List<Order> list, Order one) {\n    list.forEach(o -> o.mark());\n    var found = repo.findOne(1L);\n    found.mark();\n    this.repo.save(one);\n    Math.max(1, 2);\n    orders().get(0).mark();\n    name().length();\n  }\n  String name() { return ""; }\n}',
  };
  const files = Object.entries(src).map(([p, text]) => ({ p, text, ix: index(text) }));
  const model = buildModel(files);
  const signatures = new Map([
    [
      'java.util.List',
      {
        typeParams: ['E'],
        supers: ['java.util.Collection'],
        methods: { get: 'E', forEach: 'void', stream: 'java.util.stream.Stream<E>', of: 'java.util.List<E>', size: 'int' },
      },
    ],
  ]);
  bindCalls(model, signatures);
  const svc = model.types.get('a.Svc');
  const run = svc.methods.find((m) => m.name === 'run');
  const by = (name) => run.calls.filter((c) => c.name === name);
  assert.deepStrictEqual(
    by('mark').map((c) => [c.recvFqn, c.recvHow, c.targets]),
    [
      ['a.Order', 'lambda', ['a.Order#mark()']],
      ['a.Order', 'local', ['a.Order#mark()']],
      ['a.Order', 'chain', ['a.Order#mark()']],
    ],
  );
  // `var found = repo.findOne(1L)` takes the return type of the interface method.
  assert.deepStrictEqual(by('mark')[1].recvFqn, 'a.Order');
  assert.deepStrictEqual(by('save').map((c) => [c.recvFqn, c.recvHow, c.targets]), [
    ['a.OrderRepository', 'field', ['a.OrderRepository#save(Order)']],
  ]);
  // A static call on a JDK type is resolved, and has no project target (that is correct, not a failure).
  assert.deepStrictEqual(by('max').map((c) => [c.recvFqn, c.recvHow, c.how]), [['java.lang.Math', 'static', 'external']]);
  // A chain goes one level deep through a project method's return type, then the JDK signature's element type.
  assert.deepStrictEqual(by('get').map((c) => [c.recvFqn, c.recvHow, c.how]), [['java.util.List', 'chain', 'external']]);
  // An external receiver whose type is known is a resolution; a call on String.length() is external too.
  assert.deepStrictEqual(by('length').map((c) => [c.recvFqn, c.recvHow, c.how]), [['java.lang.String', 'chain', 'external']]);
  // Lombok's generated accessor: a target by convention, marked as such.
  const data = model.types.get('a.Data');
  assert.ok(data, 'the Lombok class is in the model');
  assert.equal(model.bindings.calls > 6, true);
  assert.ok(model.bindings.typed >= model.bindings.project);
}
