// A status a method chooses rather than receives: the switch expression's arms, or a helper that returns constants
// and supplies the initial status. The type decides (the enum an entity's status field is declared with), never a
// method's name, so `resolveInitialBookingStatus` needs no special case. Fixtures are source only, run through the
// real extractor exactly as an app is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { index } from './fixtures/syntax-java.mjs';
import { buildModel } from './fixtures/model-from-source.mjs';
import { javaFacts } from '../engine/extract/lifecycle.mjs';

const L = (...x) => x.join('\n');

const SWITCH = {
  'src/main/java/shop/OrderStatus.java': L(
    'package shop;',
    'public enum OrderStatus {',
    '  PENDING,',
    '  PAID,',
    '  REFUNDED',
    '}',
  ),
  'src/main/java/shop/OtherStatus.java': L('package shop;', 'public enum OtherStatus {', '  OPEN,', '  CLOSED', '}'),
  'src/main/java/shop/Pricing.java': L('package shop;', 'public enum Pricing {', '  FIXED,', '  FREE', '}'),
  'src/main/java/shop/Order.java': L(
    'package shop;',
    'import jakarta.persistence.Entity;',
    'import jakarta.persistence.Enumerated;',
    'import jakarta.persistence.Id;',
    '@Entity',
    'public class Order {',
    '  @Id',
    '  private Long id;',
    '  @Enumerated(EnumType.STRING)',
    '  private OrderStatus status = OrderStatus.PENDING;',
    '  public void setStatus(OrderStatus s) {',
    '    this.status = s;',
    '  }',
    '  public OrderStatus getStatus() {',
    '    return status;',
    '  }',
    '}',
  ),
  'src/main/java/shop/OrderService.java': L(
    'package shop;',
    'public class OrderService {',
    '  // The switch assigns the entity status: its arms are the values set here.',
    '  public Order create(Pricing pricing) {',
    '    Order row = new Order();',
    '    OrderStatus initial = switch (pricing) {',
    '      case FIXED -> OrderStatus.PAID;',
    '      case FREE -> OrderStatus.PENDING;',
    '    };',
    '    row.setStatus(initial);',
    '    return row;',
    '  }',
    '  // A helper returns the enum; the constant is chosen here even though the builder names no literal.',
    '  private OrderStatus resolveInitial(Pricing pricing) {',
    '    return switch (pricing) {',
    '      case FIXED -> OrderStatus.PAID;',
    '      default -> OrderStatus.PENDING;',
    '    };',
    '  }',
    '  public Order createWithHelper(Pricing pricing) {',
    '    return Order.builder().status(resolveInitial(pricing)).build();',
    '  }',
    '  // A reader names no constant: it must not become a set site.',
    '  public OrderStatus current(Order order) {',
    '    return order.getStatus();',
    '  }',
    '  // Another status enum is another lifecycle, whatever this method returns.',
    '  public OtherStatus other() {',
    '    return OtherStatus.OPEN;',
    '  }',
    '}',
  ),
};

// Source -> model -> the real lifecycle facts, the order scan.mjs uses. `tweak` lets a test reshape the model the way
// the Java dump does (a Lombok accessor carries the position of the field it reads).
function lifecycleOf(files, tweak) {
  const model = buildModel(Object.entries(files).map(([p, text]) => ({ p, text, ix: index(text) })));
  tweak?.(model);
  const types = [...model.types.values()];
  const entities = types
    .filter((t) => (t.ann ?? []).some((a) => /(?:^|\.)Entity$/.test(a.fqn ?? '')))
    .map((t) => ({
      name: t.name,
      fields: (t.fields ?? []).map((f) => ({
        name: f.name,
        type: String(f.type ?? '').replace(/<.*/, '').split('.').pop(),
      })),
    }));
  const enums = types
    .filter((t) => t.kind === 'enum')
    .map((t) => ({ name: t.name, file: t.file, line: t.start, values: t.enumValues ?? t.constants ?? [] }));
  const entries = types.map((t) => ({
    p: t.file,
    name: t.name,
    kind: t.kind,
    methods: t.methods,
    fields: t.fields ?? [],
    ix: {},
    text: files[t.file],
  }));
  return javaFacts({
    java: entries,
    repoEntity: new Map(),
    enums,
    entities,
    shortlist: new Set(entities.map((e) => e.name)),
  }).lifecycle;
}

const lineOf = (lifecycle, value) => lifecycle.find((x) => new RegExp(`^  ${value}:`).test(x)) ?? '';

test('a switch assigned into the status reports every arm', () => {
  const lifecycle = lifecycleOf(SWITCH);
  // The entity whose status field is the enum owns the lifecycle, and the values follow the constant's spelling.
  assert.ok(lifecycle.includes('Order.OrderStatus'), lifecycle.join('\n'));
  const paid = lineOf(lifecycle, 'PAID');
  assert.match(paid, /OrderService\.java(:\d+-\d+)?#create \(chosen by a switch\/return\)/, paid);
  assert.doesNotMatch(paid, /no setter found/, paid);
  const pending = lineOf(lifecycle, 'PENDING');
  assert.match(pending, /#create \(chosen by a switch\/return\)/, pending);
  // A value nothing writes still says so.
  assert.match(lineOf(lifecycle, 'REFUNDED'), /no setter found/, lineOf(lifecycle, 'REFUNDED'));
});

test('a helper method that returns the enum constant is the cite for the initial status', () => {
  const lifecycle = lifecycleOf(SWITCH);
  const paid = lineOf(lifecycle, 'PAID');
  // The helper's cite, not the builder call's: the constant is written there.
  assert.match(paid, /OrderService\.java(:\d+-\d+)?#resolveInitial \(chosen by a switch\/return\)/, paid);
  const pending = lineOf(lifecycle, 'PENDING');
  assert.match(pending, /#resolveInitial \(chosen by a switch\/return\)/, pending);
});

test('a reader and another enum are not status sets', () => {
  const lifecycle = lifecycleOf(SWITCH);
  const all = lifecycle.join('\n');
  assert.doesNotMatch(all, /#current\b/, 'a method returning the field reads it');
  assert.doesNotMatch(all, /OtherStatus/, 'a different status type is a different lifecycle');
  assert.ok(!lifecycle.some((x) => /^Other\./.test(x)), all);
});

// An accessor of the entity's status field reads it: only the method that chooses the constant is a site.
const ACCESSOR = {
  'src/main/java/shop/StageStatus.java': L(
    'package shop;',
    'public enum StageStatus {',
    '  DRAFT,',
    '  LIVE',
    '}',
  ),
  'src/main/java/shop/Item.java': L(
    'package shop;',
    'import jakarta.persistence.Entity;',
    '@Entity',
    'public class Item {',
    '  private StageStatus state = StageStatus.DRAFT;',
    '  public void setState(StageStatus s) {',
    '    this.state = s;',
    '  }',
    '  public StageStatus getState() {',
    '    return state;',
    '  }',
    '}',
  ),
  'src/main/java/shop/ItemService.java': L(
    'package shop;',
    'public class ItemService {',
    '  public StageStatus resolve(boolean live) {',
    '    return switch (Boolean.toString(live)) {',
    "      case \"true\" -> StageStatus.LIVE;",
    '      default -> StageStatus.DRAFT;',
    '    };',
    '  }',
    '}',
  ),
};

test('an entity accessor is not a status site: only the method choosing the constant is', () => {
  const lifecycle = lifecycleOf(ACCESSOR);
  const all = lifecycle.join('\n');
  const live = lineOf(lifecycle, 'LIVE');
  assert.match(live, /ItemService\.java(:\d+-\d+)?#resolve \(chosen by a switch\/return\)/, live);
  assert.doesNotMatch(all, /#getState\b/, 'getState returns the field; it chooses no constant');
  // The field's own default is still a set, cited as the field line rather than the accessor that covers it.
  assert.match(lineOf(lifecycle, 'DRAFT'), /Item\.java:\d+/, lineOf(lifecycle, 'DRAFT'));
});

test('a Lombok accessor pinned to the field line does not become the site', () => {
  // The dump gives a generated getter the field's position, so it covers `private StageStatus state = ...`.
  const lifecycle = lifecycleOf(ACCESSOR, (model) => {
    const item = [...model.types.values()].find((t) => t.name === 'Item');
    const line = ACCESSOR['src/main/java/shop/Item.java'].split('\n').findIndex((l) => l.includes('private StageStatus state')) + 1;
    for (const m of item.methods) if (m.name === 'getState') Object.assign(m, { start: line, end: line });
  });
  const all = lifecycle.join('\n');
  assert.doesNotMatch(all, /#getState\b/, all);
  assert.match(lineOf(lifecycle, 'DRAFT'), new RegExp(`Item\\.java:5\\b`), lineOf(lifecycle, 'DRAFT'));
});
