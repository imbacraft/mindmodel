// A status a method chooses rather than receives: the switch arms a helper returns, a constant handed to a setter, and
// the field's own default. Every fixture here is Java source under test/dump-fixture/src/shop, run through the real
// engine and read back as a dump — the same path an app takes. Nothing is built from inline source text.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTRACT, open } from '../engine/dump.mjs';
import { buildModelFromDump } from '../engine/model/from-dump-model.mjs';
import { javaFacts } from '../engine/extract/lifecycle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const jar = process.env.MINDMODEL_ENGINE_JAR ?? path.join(repo, 'engine-java/target/mindmodel-engine.jar');
const fixture = path.join(here, 'dump-fixture');
const skip = !fs.existsSync(jar) ? 'engine jar not built (mvn -f engine-java/pom.xml package)' : false;

/** One dump of the whole fixture, opened once: every case below is a query over it. */
let once = null;
function opened() {
  if (once) return once;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmodel-lifecycle-'));
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
  const dump = open(out);
  const model = buildModelFromDump(dump);
  const types = [...model.types.values()];
  const entities = types
    .filter((t) => (t.ann ?? []).some((a) => a.name === 'Entity' || /(?:^|\.)Entity$/.test(a.fqn ?? '')))
    .map((t) => ({ name: t.name, type: t, fields: t.fields ?? [] }));
  const enums = types.filter((t) => t.kind === 'enum').map((t) => ({ name: t.name, file: t.file, line: t.start, values: t.enumValues ?? [] }));
  const entries = types.map((t) => ({ p: t.file, name: t.name, kind: t.kind, methods: t.methods, fields: t.fields ?? [] }));
  once = { facts: javaFacts({ java: entries, dump, enums, entities, repoEntity: new Map(), shortlist: null }) };
  return once;
}

const facts = () => opened().facts;
/** The line of one value under one lifecycle header: PAID is a value of two lifecycles and must not be confused. */
function lineOf(header, value) {
  const lifecycle = facts().lifecycle;
  const start = lifecycle.indexOf(header);
  assert.ok(start >= 0, `no lifecycle for ${header}: ${lifecycle.join('\n')}`);
  const end = lifecycle.findIndex((l, i) => i > start && !l.startsWith('  '));
  const block = lifecycle.slice(start + 1, end < 0 ? undefined : end);
  return block.find((l) => l.startsWith(`  ${value}:`)) ?? '';
}

test('a switch assigned into the status reports every arm', { skip }, () => {
  const lifecycle = facts().lifecycle;
  const paid = lineOf('Order.OrderStatus', 'PAID');
  // The switch's arms reach the setter through the local the dump names as the switch's target.
  assert.match(paid, /OrderService\.java#create \(chosen by a switch\/return\)/, paid);
  assert.doesNotMatch(paid, /no setter found/, paid);
  assert.match(lineOf('Order.OrderStatus', 'PENDING'), /OrderService\.java#create \(chosen by a switch\/return\)/, lineOf('Order.OrderStatus', 'PENDING'));
  // A value nothing writes still says so.
  assert.match(lineOf('Order.OrderStatus', 'REFUNDED'), /no setter found/, lineOf('Order.OrderStatus', 'REFUNDED'));
});

test('a helper method returning the enum is the cite for the initial status', { skip }, () => {
  // The constant is chosen in the helper and handed to the setter: the cite is the helper's method.
  assert.match(lineOf('Order.OrderStatus', 'PAID'), /OrderService\.java#resolveInitial \(chosen by a switch\/return\)/, lineOf('Order.OrderStatus', 'PAID'));
  assert.match(lineOf('Order.OrderStatus', 'PENDING'), /resolveInitial/, lineOf('Order.OrderStatus', 'PENDING'));
});

test('a setter parameter is followed to the constant its caller passes', { skip }, () => {
  // `change(order, PAID)` is the site; the setter body writes the parameter it received.
  const paid = lineOf('Order.OrderStatus', 'PAID');
  assert.match(paid, /OrderService\.java#promote \(set by the callee from the argument\)/, paid);
  assert.ok(
    facts().statusSets.some((s) => s.value === 'PAID' && s.method === 'shop.OrderService#promote(Order)'),
    'the flow rank reads the site at the caller',
  );
});

test('the entity constructor that assigns the field is a set site', { skip }, () => {
  // A field write in a body carries its value (1c); a declaration initialiser does not, and is not invented.
  assert.match(lineOf('Order.OrderStatus', 'PENDING'), /Order\.java#Order/, lineOf('Order.OrderStatus', 'PENDING'));
});

test('a reader and another enum are not status sets', { skip }, () => {
  const all = facts().lifecycle.join('\n');
  assert.doesNotMatch(all, /#current\b/, 'a method returning the field reads it');
  assert.doesNotMatch(all, /#getStatus\b/, 'an accessor reads the field');
  assert.doesNotMatch(all, /OtherStatus/, 'a different status type is a different lifecycle');
});

test('a value chosen by a method is cited there; a field initialiser is not invented', { skip }, () => {
  const all = facts().lifecycle.join('\n');
  assert.ok(all.includes('Item.StageStatus'), all);
  // ItemService#launch writes LIVE into the field; OrderService#stage only chooses DRAFT/LIVE and returns them.
  assert.match(lineOf('Item.StageStatus', 'LIVE'), /ItemService\.java#launch/, lineOf('Item.StageStatus', 'LIVE'));
  assert.match(lineOf('Item.StageStatus', 'DRAFT'), /OrderService\.java#stage \(chosen by a switch\/return\)/, lineOf('Item.StageStatus', 'DRAFT'));
  // `private StageStatus state = StageStatus.DRAFT` is a declaration initialiser: the dump carries no write for it, so
  // the field is never named as a site — the old text pass read that line and this one does not.
  assert.doesNotMatch(lineOf('Item.StageStatus', 'DRAFT'), /Item\.java#Item/, lineOf('Item.StageStatus', 'DRAFT'));
});

test('two entities that share one enum are two lifecycles', { skip }, () => {
  // The old per-line pass keyed owners by the enum's simple name and merged them; the dump names the receiver.
  const lifecycle = facts().lifecycle;
  assert.ok(lifecycle.includes('Order.OrderStatus') && lifecycle.includes('Invoice.OrderStatus'), lifecycle.join('\n'));
  const headers = lifecycle.filter((l) => !l.startsWith('  '));
  assert.equal(new Set(headers).size, headers.length, `one header per (entity, enum): ${headers.join(', ')}`);
  // Invoice's only write is the setter in InvoiceService; Order's PAID has no such site.
  assert.match(lineOf('Invoice.OrderStatus', 'PAID'), /InvoiceService\.java#activate/, lineOf('Invoice.OrderStatus', 'PAID'));
  assert.doesNotMatch(lineOf('Order.OrderStatus', 'PAID'), /#activate/, lineOf('Order.OrderStatus', 'PAID'));
});

test('a status set through a Lombok builder is a set of the entity the builder belongs to', { skip }, () => {
  // Lombok names the builder `<Type>Builder` and nests it in the type: `shop.Booking.BookingBuilder`.
  assert.match(lineOf('Booking.OrderStatus', 'PAID'), /BookingService\.java#book\b/, lineOf('Booking.OrderStatus', 'PAID'));
  assert.doesNotMatch(lineOf('Booking.OrderStatus', 'PAID'), /no setter found/, lineOf('Booking.OrderStatus', 'PAID'));
});
