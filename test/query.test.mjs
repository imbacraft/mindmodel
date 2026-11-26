// The query layer on the engine's own fixture: every primitive of engine/model/query.mjs, once per shape it will be
// asked about in Phase 3 (a holder written through a project type, a cookie name compared in a helper, an entity
// setter reached through a repository, a value handed down two calls). The dump is built once per run.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTRACT, open } from '../engine/dump.mjs';
import { queries } from '../engine/model/query.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const jar = process.env.MINDMODEL_ENGINE_JAR ?? path.join(repo, 'engine-java/target/mindmodel-engine.jar');
const fixture = path.join(here, 'dump-fixture');
const skip = !fs.existsSync(jar) ? 'engine jar not built (mvn -f engine-java/pom.xml package)' : false;

/** One dump of the fixture, opened once; every test below queries the same one. */
let once = null;
function opened() {
  if (once) return once;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmodel-query-'));
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.java')) files.push(path.relative(fixture, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(fixture, 'src'));
  const list = path.join(dir, 'files.txt');
  fs.writeFileSync(list, files.sort().join('\n') + '\n');
  const out = path.join(dir, 'dump');
  execFileSync('java', ['-jar', jar, 'dump', '--contract', String(CONTRACT), fixture, list, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  once = open(out);
  return once;
}

const q = () => queries(opened());
const callTo = (method, name) => opened().callsOf(method).find((c) => c.name === name);

test('query: reach follows resolved targets, the entry method included, and says where it lost a step', { skip }, () => {
  assert.deepStrictEqual(q().reach('contract.Chain#entry()', 1).methods, [
    { id: 'contract.Chain#entry()', depth: 0 },
    { id: 'contract.Chain#middle(String)', depth: 1 },
  ]);
  assert.deepStrictEqual(q().reach('contract.Chain#entry()', 2).methods.map((m) => [m.id, m.depth]), [
    ['contract.Chain#entry()', 0],
    ['contract.Chain#middle(String)', 1],
    ['contract.Chain#inner(String)', 2],
  ]);
  assert.deepStrictEqual(q().reach('contract.Chain#entry()', 0).methods, [{ id: 'contract.Chain#entry()', depth: 0 }],
    'no depth, no callees');
  // The project holder's setter is two hops from the filter that calls it — the doc's own case.
  assert.deepStrictEqual(q().reach('contract.Stores#holder(String)', 2).methods.map((m) => m.id).sort(), [
    'contract.RequestHolder#set(String)',
    'contract.Stores#holder(String)',
  ]);
  // A call the dump never resolved is a gap in the reach, not a silently missing step.
  const lost = q().reach('contract.Stores#session(jakarta.servlet.http.HttpServletRequest,String)', 0);
  assert.deepStrictEqual(lost.unresolved.map((u) => [u.name, typeof u.reason]), [['setAttribute', 'string']]);
});

test('query: argValue follows a parameter one hop by default and keeps every call site', { skip }, () => {
  const inner = callTo('contract.Chain#middle(String)', 'inner');
  // Two call sites hand `middle` its argument: one a literal, one a parameter of a method nobody calls.
  const one = q().argValue(inner, 0);
  assert.deepStrictEqual(one.values.map((v) => [v.value.kind, v.stopped]), [['literal', undefined], ['param', 'depth']]);
  assert.deepStrictEqual(one.unresolved, []);
  assert.equal(one.values[0].at.call, 'contract.Chain#entry()@6:9', 'the value carries the site it came from');
  assert.equal(one.values[0].at.arg, 0);
  // At no depth the value stays a parameter and says the hops ran out.
  const none = q().argValue(inner, 0, 0);
  assert.deepStrictEqual(none.values.map((v) => [v.value.kind, v.stopped]), [['param', 'depth']]);
  // One path is a literal, the other a parameter whose own caller does not exist: every path is reported.
  const both = q().argValue(inner, 0, 2);
  assert.deepStrictEqual(both.values.map((v) => v.value.value.value), ['literal']);
  assert.deepStrictEqual(both.unresolved.map((u) => u.reason), ['no-caller']);
  assert.equal(both.unresolved[0].at.method, 'contract.Chain#unknown(String)');
  // An argument the call does not have is unresolved.
  assert.deepStrictEqual(q().argValue(inner, 3).unresolved.map((u) => u.reason), ['no-argument']);
  // A static field of a library type (`BigDecimal.ONE`) is a read the dump names, not a value it folds.
  const setter = callTo('orders.OrderService#mark(Long)', 'setTotal');
  assert.deepStrictEqual(
    q().argValue(setter, 0).values.map((v) => [v.value.kind, v.value.field]),
    [['field', 'java.math.BigDecimal#ONE']],
  );
  assert.deepStrictEqual(q().argValue(setter, 0).unresolved, []);
});

test('query: holders are the static ThreadLocal fields, with the method that writes and the one that clears', { skip }, () => {
  const { holders, unresolved } = q().holders();
  assert.deepStrictEqual(holders.map((h) => h.field).sort(), [
    'contract.Fields#HOLDER',
    'contract.RequestHolder#CURRENT',
    'contract.ScopedHolder#INSTANCE',
    'contract.Stores#SLOT',
  ]);
  assert.deepStrictEqual(unresolved, [], 'every static field of the fixture is typed');
  const current = holders.find((h) => h.field === 'contract.RequestHolder#CURRENT');
  assert.equal(current.type, 'java.lang.ThreadLocal');
  assert.equal(current.base, 'java.lang.ThreadLocal');
  assert.equal(current.element, 'String', 'the element type as written');
  assert.deepStrictEqual(current.writes.map((w) => [w.method, w.name]), [['contract.RequestHolder#set(String)', 'set']]);
  assert.deepStrictEqual(current.clears.map((w) => [w.method, w.name]), [['contract.RequestHolder#remove()', 'remove']]);
  // A holder of the project's own type: the JDK base comes through the supertype, the element type too.
  const scoped = holders.find((h) => h.field === 'contract.ScopedHolder#INSTANCE');
  assert.deepStrictEqual([scoped.type, scoped.base, scoped.element], ['contract.ScopedHolder', 'java.lang.InheritableThreadLocal', 'String']);
  assert.deepStrictEqual(scoped.writes.map((w) => w.method), ['contract.ScopedHolder#store(String)']);
  assert.deepStrictEqual(scoped.clears.map((w) => w.method), ['contract.ScopedHolder#clear()']);
  const slot = holders.find((h) => h.field === 'contract.Stores#SLOT');
  assert.deepStrictEqual(slot.writes.map((w) => w.call), ['contract.Stores#holder(String)@9:14'], 'a set is not a clear');
  assert.deepStrictEqual(slot.clears.map((w) => w.call), ['contract.Stores#holder(String)@10:14']);
});

test('query: stores are holder writes, the security context and request attributes, in reach', { skip }, () => {
  const own = q().stores('contract.Fields#write(String)');
  assert.deepStrictEqual(own.stores.map((s) => [s.kind, s.field, s.op, s.depth]), [['holder', 'contract.Fields#HOLDER', 'write', 0]]);
  // The filter stores through the project's holder: the write is inside the holder's own setter, one hop away.
  const through = q().stores('contract.Stores#holder(String)', 2).stores.map((s) => [s.kind, s.field ?? s.holder, s.depth]);
  assert.deepStrictEqual(through, [
    ['holder', 'contract.Stores#SLOT', 0],
    ['holder', 'contract.Stores#SLOT', 0],
    ['holder', 'contract.RequestHolder#CURRENT', 1],
  ]);
  assert.deepStrictEqual(through.filter((s) => s[0] === 'holder').length, 3, 'two writes of SLOT and one of CURRENT');
  const own0 = q().stores('contract.Stores#holder(String)', 0);
  assert.ok(!own0.stores.some((s) => s.field === 'contract.RequestHolder#CURRENT'), 'no hop, no store in the setter');
  const attr = q().stores('contract.Stores#attribute(jakarta.servlet.http.HttpServletRequest,String)', 0);
  assert.deepStrictEqual(attr.stores.map((s) => [s.kind, s.holder]), [['request-attribute', 'jakarta.servlet.http.HttpServletRequest']]);
  const context = q().stores('contract.Stores#context(org.springframework.security.core.context.SecurityContext,Object)', 0);
  assert.deepStrictEqual(context.stores.map((s) => [s.kind, s.how]), [['security-context', 'setAuthentication']]);
  // A session attribute reached through a library call whose return type the dump does not know: unresolved, not no.
  const session = q().stores('contract.Stores#session(jakarta.servlet.http.HttpServletRequest,String)', 0);
  assert.deepStrictEqual(session.stores, []);
  assert.ok(session.unresolved.some((u) => u.reason === 'receiver-untyped'));
});

test('query: receiverEntity names the instance a call writes, or says why it cannot', { skip }, () => {
  const setTotal = callTo('orders.OrderService#mark(Long)', 'setTotal');
  assert.deepStrictEqual(q().receiverEntity(setTotal), { type: 'orders.Order', how: 'local', unresolved: null });
  const setId = callTo('orders.OrderService#rename(Long,String)', 'setId');
  assert.equal(q().receiverEntity(setId).type, 'orders.Order', 'reached through the repository call');
  assert.equal(q().receiverEntity(setId).how, 'chain');
  // A library receiver, a static call and an untyped receiver each say which they are.
  assert.deepStrictEqual(q().receiverEntity(callTo('contract.Args#run(String,int)', 'trim')).unresolved, 'library-receiver');
  assert.deepStrictEqual(q().receiverEntity(callTo('orders.PortImpl#findAll()', 'of')).unresolved, 'static-call');
  assert.deepStrictEqual(q().receiverEntity(callTo('contract.Stores#session(jakarta.servlet.http.HttpServletRequest,String)', 'setAttribute')).unresolved,
    'receiver-untyped');
});

test('query: comparedTo finds the comparison of a parameter, and the value that reaches it', { skip }, () => {
  const read = 'contract.CookieFilter#read(String)';
  const found = q().comparedTo({ method: read, index: 0 });
  assert.deepStrictEqual(found.comparisons.map((c) => [c.name, c.side, c.arg]), [['equals', 'argument', 0]]);
  assert.deepStrictEqual(found.unresolved, []);
  // The helper compares its parameter; the filter that calls it passes a literal: the two primitives together.
  const equals = callTo(read, 'equals');
  assert.deepStrictEqual(q().argValue(equals, 0).values.map((v) => v.value.value.value), ['session']);
  assert.equal(q().argValue(equals, 0).values[0].at.method, 'contract.CookieFilter#handle()');
  assert.deepStrictEqual(q().comparedTo({ method: read, index: 1 }).comparisons, [], 'no such parameter');
  assert.deepStrictEqual(q().comparedTo({ method: 'contract.CookieFilter#missing()' }).unresolved.map((u) => u.reason),
    ['no-method-in-dump']);
  assert.deepStrictEqual(q().comparedTo({}).unresolved.map((u) => u.reason), ['no-method']);
  // A local is nameable only through what it was assigned from; one built from a literal has no id.
  const from = 'contract.Compare#fromCall(Object)@8:31';
  assert.deepStrictEqual(q().comparedTo({ method: 'contract.Compare#fromCall(Object)', from }).comparisons.map((c) => [c.name, c.arg]),
    [['equals', 0]]);
  assert.deepStrictEqual(q().comparedTo({ method: 'contract.Compare#fromLiteral()' }).unresolved.map((u) => u.reason),
    ['no-target-id']);
});

test('query: scopedStores reads a request-scoped store off the try/finally shape, two hops away', { skip }, () => {
  const filter = 'contract.ScopedFilter#doFilterInternal(boolean)';
  const { stores, unresolved } = q().scopedStores(filter);
  assert.deepStrictEqual(unresolved, []);
  assert.equal(stores.length, 1, 'one store: one type, one try');
  const [store] = stores;
  // The library type is named by its written text (no classpath), the call is the one inside the helper it reaches,
  // the clear is the finalizer's, and the answer is inferred, never resolved.
  assert.deepStrictEqual(
    [store.kind, store.holder, store.op, store.via, store.conditional],
    ['holder', 'library.ContextHolder', 'write', 'try-finally-pattern', true],
  );
  assert.equal(store.method, 'contract.ScopedFilter#remember(String)', 'the call that writes it, not the filter');
  assert.deepStrictEqual([store.file, store.line], ['src/contract/ScopedFilter.java', 18]);
  assert.deepStrictEqual([store.clearedAt.file, store.clearedAt.line], ['src/contract/ScopedFilter.java', 13]);
  // A method with no try at all has no such store, and one with a try whose finalizer calls no type does not either.
  assert.deepStrictEqual(q().scopedStores('contract.Stores#holder(String)').stores, []);
  assert.deepStrictEqual(q().scopedStores('contract.RequestHolder#set(String)').stores, []);
  assert.deepStrictEqual(q().scopedStores('contract.Missing#none()').unresolved.map((u) => u.reason), ['no-method']);
});
