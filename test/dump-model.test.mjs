// The model built from real Java, for the rows the dump writes outside a declared method: calls in a field initializer
// or an initializer block (owned by the pseudo-members `T#<clinit>()` and `T#<init>()`), and method references (a call
// row with kind `methodRef`, which names a method that runs). The rates count real call sites, not references.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_ENGINE, dumpOf } from '../test-support/fixtures/dump-dir.mjs';
import { bindingRates } from '../engine/model/calls.mjs';

const L = (...x) => x.join('\n');
const MAPPER = L(
  'package shop;',
  'import java.time.format.DateTimeFormatter;',
  'import java.util.Optional;',
  'public class Mapper {',
  '  private static final DateTimeFormatter F = DateTimeFormatter.ofPattern("HH:mm");',
  '  private final String label = String.valueOf(1);',
  '  public String toDto(Mapper m) { return F.format(null); }',
  '  public static String first(String... xs) { return xs[0]; }',
  '  public String run(Optional<Mapper> o) {',
  '    Mapper.first("a", "b");',
  '    return o.map(this::toDto).orElse("");',
  '  }',
  '}',
);
const SERVICE = L(
  'package shop;',
  'import java.util.Optional;',
  'public class Service {',
  '  private final Mapper mapper;',
  '  public Service(Mapper mapper) {',
  '    this.mapper = mapper;',
  '  }',
  '  public Optional<String> one(Optional<Mapper> o) {',
  '    return o.map(mapper::toDto).map(String::trim);',
  '  }',
  '}',
);

const build = () =>
  dumpOf({ 'src/main/java/shop/Mapper.java': MAPPER, 'src/main/java/shop/Service.java': SERVICE }).model;

test('initializer calls are kept on the pseudo-members that own them', { skip: NO_ENGINE }, () => {
  const mapper = build().types.get('shop.Mapper');
  const clinit = mapper.methods.find((m) => m.id === 'shop.Mapper#<clinit>()');
  assert.ok(clinit, 'the static field initializer has a member to own its calls');
  assert.deepEqual(clinit.calls.map((c) => c.name), ['ofPattern']);
  assert.equal(clinit.calls[0].recvFqn, 'java.time.format.DateTimeFormatter');
  const init = mapper.methods.find((m) => m.id === 'shop.Mapper#<init>()');
  assert.ok(init, 'the instance field initializer has a member to own its calls');
  assert.deepEqual(init.calls.map((c) => c.name), ['valueOf']);
});

test('a method reference is a call of its own, naming the method it refers to', { skip: NO_ENGINE }, () => {
  const model = build();
  const one = model.types.get('shop.Service').methods.find((m) => m.name === 'one');
  const ref = one.calls.find((c) => c.name === 'toDto');
  assert.ok(ref, 'mapper::toDto is a call row in Service#one');
  assert.equal(ref.kind, 'methodRef');
  assert.equal(ref.how, 'direct', 'resolved like any call: the declaration on the receiver type');
  assert.deepEqual(ref.targets, ['shop.Mapper#toDto(Mapper)']);
  assert.deepEqual(ref.recv, { kind: 'name', text: 'mapper' }, 'the receiver is the expression before ::');
  assert.equal(ref.line, 9);
});

test('the rates do not count method references as call sites', { skip: NO_ENGINE }, () => {
  const model = build();
  const all = [...model.types.values()].flatMap((t) => t.methods).flatMap((m) => m.calls);
  const refs = all.filter((c) => c.kind === 'methodRef');
  assert.ok(refs.length >= 3, 'the fixture has method references to count');
  const expected = all.filter((c) => c.kind !== 'new' && c.kind !== 'methodRef').length;
  assert.equal(bindingRates(model).calls, expected);
});

test('a varargs call joins the declaration it reaches', { skip: NO_ENGINE }, () => {
  const mapper = build().types.get('shop.Mapper');
  const call = mapper.methods.find((m) => m.name === 'run').calls.find((c) => c.name === 'first');
  assert.deepEqual(call.targets, ['shop.Mapper#first(String[])']);
  assert.ok(mapper.methods.some((m) => m.id === call.targets[0]), 'the target is the member the dump declares');
});
