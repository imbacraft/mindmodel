// The dump's own contract, checked on a hand-written fixture: every case here is a thing Spoon does that the Node side
// will rely on. Runs only when the engine jar has been built (mvn -f engine-java/pom.xml package).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from '../engine/dump.mjs';

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
  execFileSync('java', ['-jar', jar, 'dump', '--contract', '1', fixture, list, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return { out, types: read(out, 'types.ndjson'), members: read(out, 'members.ndjson'), files: read(out, 'files.ndjson'), meta: JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')) };
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
  assert.equal(info.recv.type, 'org.slf4j.Logger', 'log is typed, not an invented package');
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
  assert.equal(db.meta.contract, 1);
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

  // Determinism: a second run is byte-identical except the timestamp.
  const again = dumpInto(tmp());
  for (const name of ['types.ndjson', 'members.ndjson', 'files.ndjson']) {
    assert.equal(fs.readFileSync(path.join(d.out, name), 'utf8'), fs.readFileSync(path.join(again.out, name), 'utf8'), name);
  }
});
