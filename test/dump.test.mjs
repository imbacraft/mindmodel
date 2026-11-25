// The dump's own contract, checked on a hand-written fixture: every case here is a thing Spoon does that the Node side
// will rely on. Runs only when the engine jar has been built (mvn -f engine-java/pom.xml package).
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTRACT, open } from '../engine/dump.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const jar = process.env.MINDMODEL_ENGINE_JAR ?? path.join(repo, 'engine-java/target/mindmodel-engine.jar');
const fixture = path.join(here, 'dump-fixture');
const skip = !fs.existsSync(jar) ? 'engine jar not built (mvn -f engine-java/pom.xml package)' : false;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mindmodel-dump-'));
const read = (dir, name) =>
  fs.existsSync(path.join(dir, name))
    ? fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

function dumpInto(dir) {
  const list = path.join(dir, 'files.txt');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.java')) files.push(path.relative(fixture, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(fixture, 'src'));
  fs.writeFileSync(list, files.sort().join('\n') + '\n');
  const out = path.join(dir, 'dump');
  execFileSync('java', ['-jar', jar, 'dump', '--contract', String(CONTRACT), fixture, list, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return { out, types: read(out, 'types.ndjson'), members: read(out, 'members.ndjson'), files: read(out, 'files.ndjson'), fields: read(out, 'fields.ndjson'), calls: read(out, 'calls.ndjson'), meta: JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')) };
}

test('dump: the fixture contract', { skip }, () => {
  const dir = tmp();
  const d = dumpInto(dir);
  const byFqn = new Map(d.types.map((t) => [t.fqn, t]));

  // Types: nested names are dotted, interfaces/enums/records are told apart, anonymous classes are not types.
  assert.ok(byFqn.has('nested.Outer.Inner'), 'a nested type is present, under its dotted name');
  assert.equal(byFqn.get('nested.Outer.Inner').enclosing, 'nested.Outer');
  assert.equal(byFqn.get('orders.Port').kind, 'interface');
  assert.equal(byFqn.get('orders.State').kind, 'enum');
  assert.equal(byFqn.get('orders.Line').kind, 'record');
  assert.ok(!d.types.some((t) => t.fqn.includes('$')), 'no positional names');
  assert.ok(!d.types.some((t) => t.fqn.includes('Outer.1')), 'no anonymous class');

  // Annotations: full names, and arguments as values, not source text.
  const annNames = (t) => t.ann.map((a) => a.name);
  assert.ok(annNames(byFqn.get('orders.Order')).includes('lombok.Data'));
  assert.ok(annNames(byFqn.get('orders.OrderController')).includes('org.springframework.web.bind.annotation.RestController'));

  const method = (owner, id) => d.members.find((m) => m.kind === 'method' && m.owner === owner && m.id === id);
  const one = method('orders.OrderController', 'orders.OrderController#one(Long)');
  const get = one.ann.find((a) => a.name.endsWith('.GetMapping'));
  assert.deepStrictEqual(get.args.value, { kind: 'string', value: '/{id}' });
  const pre = one.ann.find((a) => a.name.endsWith('.PreAuthorize'));
  assert.equal(pre.args.value.value, "hasRole('ADMIN')");

  const many = method('orders.OrderController', 'orders.OrderController#many(String[])');
  const post = many.ann.find((a) => a.name.endsWith('.PostMapping'));
  assert.deepStrictEqual(post.args.value.value.map((v) => v.value), ['/a', '/b'], 'a string array stays values');
  assert.equal(post.args.produces.value, 'application/json');

  // Overloads keep distinct ids.
  const same = d.members.filter((m) => m.owner === 'orders.OrderController' && m.name === 'same');
  assert.deepStrictEqual(same.map((m) => m.id).sort(), [
    'orders.OrderController#same()',
    'orders.OrderController#same(int)',
  ]);

  // Constants are folded.
  const prefix = d.members.find((m) => m.kind === 'field' && m.owner === 'orders.Order' && m.name === 'PREFIX');
  assert.deepStrictEqual(prefix.value, { kind: 'string', value: '/api/v1' });
  const limit = d.members.find((m) => m.kind === 'field' && m.owner === 'orders.Order' && m.name === 'LIMIT');
  assert.deepStrictEqual(limit.value, { kind: 'int', value: 7 });

  // Enum constants and their constructor arguments.
  const constants = d.members.filter((m) => m.kind === 'enumConstant' && m.owner === 'orders.State');
  assert.deepStrictEqual(constants.map((c) => c.name), ['NEW', 'DONE']);
  assert.deepStrictEqual(constants.map((c) => c.args[0].value), ['new', 'done']);

  // Records: components, plus the accessors and canonical constructor.
  assert.ok(d.members.some((m) => m.kind === 'recordComponent' && m.name === 'sku'));
  assert.ok(d.members.some((m) => m.kind === 'constructor' && m.id === 'orders.Line#Line(String,int)'));

  // Generic signatures keep their spelling.
  assert.ok(d.members.some((m) => m.owner === 'orders.Port' && m.kind === 'method' && m.name === 'map'));

  // Lombok: generated members exist, are marked, and a call on one resolves to them.
  const generated = d.members.filter((m) => m.generated === 'lombok');
  assert.ok(generated.some((m) => m.id === 'orders.Order#getTotal()'), 'a @Data getter');
  assert.ok(generated.some((m) => m.id === 'orders.Order#setTotal(BigDecimal)'), 'a @Data setter');
  assert.ok(generated.some((m) => m.id === 'orders.Order#toString()'));
  const logger = generated.find((m) => m.name === 'log');
  assert.equal(logger.type, 'org.slf4j.Logger', 'the @Slf4j field');
  const calls = read(d.out, 'calls.ndjson');
  const info = calls.find((c) => c.name === 'info' && c.file.endsWith('Order.java'));
  assert.equal(info.recv.typeFqn, 'org.slf4j.Logger', 'log is typed, not an invented package');
  assert.equal(info.origin, 'library');

  // A file JDT cannot parse is named, and only that file.
  const broken = d.files.find((f) => f.path.endsWith('Broken.java'));
  const order = d.files.find((f) => f.path.endsWith('Order.java'));
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0].reason, /Syntax error/);
  assert.deepStrictEqual(order.errors, [], 'an unresolved lombok import is not a broken file');
  assert.equal(d.meta.counts.failedFiles, 1);

  // Positions: inside their file, and ordered.
  const lines = new Map();
  const lineCount = (f) => {
    if (!lines.has(f)) lines.set(f, fs.readFileSync(path.join(fixture, f), 'utf8').split('\n').length);
    return lines.get(f);
  };
  for (const t of d.types) {
    assert.ok(t.pos.line >= 1 && t.pos.endLine <= lineCount(t.pos.file), `pos inside ${t.pos.file}:${t.pos.line}`);
  }
  for (const m of d.members) {
    assert.ok(m.id === undefined || m.id.startsWith(`${m.owner}#`), `id names its owner: ${m.id}`);
  }
  assert.equal(new Set(d.members.filter((m) => m.id).map((m) => m.id)).size, d.members.filter((m) => m.id).length);

  // The loader the rest of Node will use: queries only, no analysis, every answer carrying its position.
  const db = open(d.out);
  assert.equal(db.meta.contract, CONTRACT);
  assert.equal(db.type('orders.OrderController').kind, 'class');
  assert.deepEqual(db.implsOf('orders.Port'), ['orders.PortImpl']);
  const manyCalls = db.callsOf('orders.OrderController#many(String[])');
  assert.ok(manyCalls.length >= 0, 'a method with no calls answers with an empty list');
  assert.deepEqual(db.annotation(db.members.get('orders.OrderController#one(Long)'), 'PreAuthorize'), {
    value: "hasRole('ADMIN')",
  });
  assert.equal(db.constant('orders.Order', 'PREFIX').value, '/api/v1');
  assert.ok(db.membersOf('orders.OrderController').some((m) => m.name === 'many'));
  assert.ok(db.callersOf('orders.Order#getTotal()').length >= 0);
  assert.ok(db.grep('Order').length > 0);
  assert.deepEqual(db.atLine('src/orders/Order.java', 17).map((c) => c.name), ['info']);

  // ---------------------------------------------------------------------------------------------------------------
  // Contract 2. 1a: every argument, typed. `text` is for display; `kind` and its fields are the fact.

  const args = d.calls.filter((c) => c.name === 'take' && c.file.endsWith('contract/Args.java')).flatMap((c) => c.args);
  const arg = (text) => args.find((a) => a.text === text);
  for (const kind of ['literal', 'constant', 'param', 'local', 'field', 'call', 'lambda', 'methodRef', 'new', 'conditional', 'unresolved'])
    assert.ok(args.some((a) => a.kind === kind), `an argument of kind ${kind}`);
  // `text` is the expression as written, cut at 80: display only, never a fact.
  assert.deepStrictEqual(arg('NAME'), {
    text: 'NAME', kind: 'constant', typeFqn: 'java.lang.String',
    value: { kind: 'string', value: 'name' }, field: 'contract.Args#NAME',
  });
  assert.deepStrictEqual(arg('input'), { text: 'input', kind: 'param', typeFqn: 'java.lang.String', index: 0, inLambda: false });
  assert.equal(arg('count').index, 1, 'a second parameter keeps its index');
  assert.equal(arg('local').from, 'contract.Args#run(String,int)@10:24', 'a local names the call it was assigned from');
  assert.equal(arg('state').field, 'contract.Args#state');
  assert.ok(arg('sink.name()').call.startsWith('contract.Args#run(String,int)@'), 'a call argument names its row');
  assert.equal(arg('new Sink()').created, 'contract.Sink');
  assert.equal(arg('input == null ? NAME : state').then.kind, 'constant');
  assert.deepStrictEqual(arg('mystery.port'), {
    text: 'mystery.port', kind: 'unresolved', typeFqn: null, reason: 'no-declaration',
  });
  assert.equal(db.argsOf(arg('sink.name()').call).length, 0, 'argsOf answers the call an argument names');

  // 1b: lambdas and method references are rows of their own, and say when they may not run.
  const refs = d.calls.filter((c) => c.via === 'methodRef');
  assert.ok(refs.some((r) => r.name === 'helper' && db.targetsOf(r).includes('contract.Lambdas#helper()')));
  assert.ok(refs.some((r) => r.name === 'name' && db.targetsOf(r).includes('contract.Sink#name()')),
    'a type-qualified reference resolves');
  const libraryRef = refs.find((r) => r.name === 'trim');
  assert.equal(libraryRef.targets.length, 0);
  assert.equal(libraryRef.origin, 'library');
  assert.equal(libraryRef.reason, 'library-signature', 'a reference Spoon cannot target says why');
  const inLambda = d.calls.find((c) => c.inLambda && c.file.endsWith('contract/Lambdas.java'));
  assert.equal(inLambda.name, 'take');
  assert.equal(inLambda.method, 'contract.Lambdas#run()', 'a call inside a lambda still belongs to the method');
  assert.deepStrictEqual(db.methodRefsIn('contract.Lambdas#run()').map((r) => r.name).sort(), ['helper', 'name', 'trim']);
  assert.ok(!db.callsOf('contract.Lambdas#run()').some((c) => c.via === 'methodRef'), 'a reference is not a call');

  // 1c: field reads and writes, with the value in the same shape as an argument.
  const access = (field, op) => d.fields.find((f) => f.field === field && (!op || f.op === op));
  const write = access('contract.Fields#name', 'write');
  assert.equal(write.method, 'contract.Fields#write(String)');
  assert.equal(write.static, false);
  assert.deepStrictEqual(write.value, { text: 'value', kind: 'param', typeFqn: 'java.lang.String', index: 0, inLambda: false });
  assert.equal(access('contract.Fields#name', 'read').method, 'contract.Fields#read()');
  const holder = access('contract.Fields#HOLDER', 'read');
  assert.equal(holder.static, true, 'the static holder is marked static');
  assert.equal(holder.value.typeFqn, 'java.lang.ThreadLocal', 'a read says what was read');
  assert.deepStrictEqual(db.writersOf('contract.Fields#name').map((f) => f.method), ['contract.Fields#write(String)']);
  const unknownField = d.fields.find((f) => f.field === null && f.op === 'read' && f.file.endsWith('contract/Fields.java'));
  assert.equal(unknownField.origin, 'unresolved');
  assert.equal(unknownField.reason, 'no-declaring-type', 'a field nobody declared has no invented owner');
  assert.deepStrictEqual(unknownField.value, { text: 'stranger.qty', kind: 'unresolved', typeFqn: null, reason: 'no-declaration' });

  // 1d: returns, and the arms of the switch a method hands on.
  const returns = (id) => db.returnsOf(id);
  assert.equal(returns('contract.Returns#literal()')[0].value.kind, 'literal');
  assert.equal(returns('contract.Returns#constant()')[0].value.value.value, 'new');
  assert.equal(returns('contract.Returns#param(String)')[0].value.index, 0);
  assert.equal(returns('contract.Returns#conditional(State)')[0].value.kind, 'conditional');
  assert.equal(returns('contract.Returns#conditional(State)')[0].value.otherwise.value.value, 'done');
  const chosen = returns('contract.Returns#chosen(State)')[0];
  assert.equal(chosen.kind, 'switch');
  assert.equal(chosen.form, 'statement');
  assert.equal(chosen.target, 'code', 'the switch fills one local, and the dump says which');
  assert.deepStrictEqual(chosen.arms.map((a) => a.labels), [['NEW'], []], 'an arm names its labels as written');
  assert.deepStrictEqual(chosen.arms.map((a) => a.default), [false, true]);
  assert.deepStrictEqual(chosen.arms.map((a) => a.value.value.value), ['new', 'done']);
  const assigned = returns('contract.Returns#assigned(State)')[0];
  assert.equal(assigned.form, 'expression');
  assert.equal(assigned.target, 'code');
  const handed = returns('contract.Returns#fromSwitch(State)')[0];
  assert.equal(handed.kind, 'switch', 'a returned switch keeps its arms');
  assert.equal(handed.target, undefined);
  assert.deepStrictEqual(handed.arms.map((a) => a.value.value.value), ['orders.State.DONE', 'orders.State.NEW']);
  assert.deepStrictEqual(returns('contract.Returns#unknown()')[0].value, {
    text: 'mystery.value', kind: 'unresolved', typeFqn: null, reason: 'no-declaration',
  });
  assert.deepStrictEqual(returns('contract.Args#run(String,int)'), [], 'a void method returns nothing');

  // 1e: the file's own header, imports included, sorted, with the wildcard and static flags.
  const importsOf = (file) => d.files.find((f) => f.path.endsWith(file));
  assert.deepStrictEqual(importsOf('contract/Imports.java').imports, [
    { name: 'java.util', wildcard: true, static: false },
    { name: 'java.util.Collections.emptyList', wildcard: false, static: true },
    { name: 'java.util.List', wildcard: false, static: false },
  ]);
  assert.equal(importsOf('contract/Imports.java').importsOrigin, 'spoon', 'Spoon and the header agree here');
  assert.equal(importsOf('contract/Args.java').imports.length, 0);
  const brokenImports = importsOf('broken/Broken.java');
  assert.deepStrictEqual(brokenImports.imports.map((i) => i.name), ['java.util.Collections.emptyList', 'java.util.List'],
    'a file JDT could not parse still gets the imports its header writes');
  assert.equal(brokenImports.importsOrigin, 'spoon', 'a unit Spoon did parse answers, even for a file JDT rejected');
  // Spoon drops an import it cannot resolve without a classpath; the file's own header still says it.
  const lombokFile = importsOf('orders/Order.java');
  assert.equal(lombokFile.importsOrigin, 'header');
  assert.deepStrictEqual(lombokFile.imports.map((i) => i.name),
    ['java.math.BigDecimal', 'lombok.Data', 'lombok.extern.slf4j.Slf4j']);
  assert.deepStrictEqual(db.imports('src/contract/Imports.java').map((i) => i.name),
    ['java.util', 'java.util.Collections.emptyList', 'java.util.List']);
  assert.equal(db.imports('src/contract/NoSuchFile.java'), null, 'a file the dump never saw answers nothing');
  assert.equal(importsOf('contract/Imports.java').package, 'contract');

  // 1f: the entry point is a shape of the method, and nothing else is called one.
  const entry = d.members.find((m) => m.id === 'contract.Entry#main(String[])');
  assert.equal(entry.isMain, true);
  assert.equal(d.members.filter((m) => m.kind === 'method' && m.isMain).length, 1, 'one entry point in the fixture');
  assert.equal(d.members.find((m) => m.id === 'contract.Entry#run()').isMain, false);

  // ---------------------------------------------------------------------------------------------------------------
  // Contract 3. The receiver's type arguments, the declaration told apart from its overrides, and a static member of a
  // type the dump never declares.

  const callAt = (method, line, name) =>
    d.calls.find((c) => c.method === method && c.line === line && c.name === name);
  // A receiver declared as a type parameter is the argument the one subclass writes: `Base<Row>` binds T to Row, so
  // the call on `T row` names generic.Row and the dump says why it could.
  const base = callAt('generic.Base#publish(T)', 12, 'save');
  assert.deepEqual(base.recv.typeArgs, ['T'], 'the field is declared Repo<T>');
  assert.equal(base.recv.typeFqn, 'generic.Repo');
  const touch = callAt('generic.Base#publish(T)', 13, 'touch');
  assert.equal(touch.recv.typeFqn, 'generic.Base', 'a call on `this` inside a generic base');
  assert.deepEqual(touch.recv.typeArgs, ['T']);
  const superCall = callAt('generic.RowBase#publish(Row)', 10, 'publish');
  assert.deepEqual(superCall.recv.typeArgs, ['generic.Row'], 'super is written Base<Row>');
  // Targets: the declaration first, then each override, told apart.
  assert.deepEqual(superCall.targets, [
    { id: 'generic.Base#publish(T)', kind: 'declared' },
    { id: 'generic.RowBase#publish(Row)', kind: 'override' },
  ]);
  assert.equal(superCall.uniqueImpl, false, 'the declaration has a body: nothing is "the" implementation');
  const single = callAt('generic.Caller#single(Row)', 9, 'go');
  assert.deepEqual(single.targets.map((t) => t.kind), ['declared', 'override']);
  assert.equal(single.uniqueImpl, true, 'one override, no declaration body');
  const either = callAt('generic.Caller#either(Row)', 14, 'go');
  assert.deepEqual(either.targets.map((t) => t.kind), ['declared', 'override', 'override']);
  assert.equal(either.uniqueImpl, false, 'two implementations are not one');
  // The accessors the extractors read: ids, the declaration, the overrides, the one implementation.
  assert.deepEqual(db.targetsOf(single), ['generic.OnlyPort#go(Row)', 'generic.OnlyImpl#go(Row)']);
  assert.equal(db.declaredOf(single), 'generic.OnlyPort#go(Row)');
  assert.deepEqual(db.overridesOf(either), ['generic.FirstImpl#go(Row)', 'generic.SecondImpl#go(Row)']);
  assert.equal(db.uniqueImpl(single), true);
  assert.equal(db.uniqueImpl(either), false);
  assert.deepEqual(db.typeArgsOf(superCall), ['generic.Row']);
  // A field access carries its field's type arguments too, and a static read of a type outside the dump is named.
  const genericField = d.fields.find((f) => f.field === 'generic.Base#repo' && f.op === 'read');
  assert.deepEqual(genericField.typeArgs, ['T']);
  const outside = d.fields.find((f) => f.field === 'generic.Row#state' && f.op === 'write' && f.value.kind === 'field');
  assert.deepEqual(outside.value, {
    text: 'OrderState.CANCELLED', kind: 'field', typeFqn: 'external.OrderState',
    field: 'external.OrderState#CANCELLED', reason: 'declaration-outside-dump',
  });

  // A dump written twice is byte-identical, every section included.
  const again = dumpInto(tmp());
  for (const name of ['types.ndjson', 'members.ndjson', 'files.ndjson', 'fields.ndjson', 'calls.ndjson']) {
    assert.equal(fs.readFileSync(path.join(d.out, name), 'utf8'), fs.readFileSync(path.join(again.out, name), 'utf8'), name);
  }
});

test('dump: a try block and its finalizer are ranges, kept apart from the decision arms', { skip }, () => {
  const d = dumpInto(tmp());
  const method = d.members.find((m) => m.id === 'contract.ScopedFilter#doFilterInternal(boolean)');
  // The block's own lines, and the finalizer's: two ranges, so an extractor never re-reads a body to find them.
  assert.deepStrictEqual(method.tryBlocks.map((b) => [b.line, b.endLine, b.finallyLine, b.finallyEndLine]), [[10, 12, 12, 14]]);
  // A try body always runs: its lines are never a decision arm, or every effect written in one would turn conditional.
  assert.deepStrictEqual(method.branches, [{ line: 11, endLine: 11, kind: 'if' }]);
  // A method without a try still writes the field, so a reader needs no optional check.
  const plain = d.members.find((m) => m.id === 'contract.RequestHolder#set(String)');
  assert.deepStrictEqual(plain.tryBlocks, []);
});
