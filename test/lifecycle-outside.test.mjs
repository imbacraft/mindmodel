// A status enum another module declares: the dump names no FQN for it, so the entity whose field holds it is found from
// the type the source writes. The shape of the entity rows is the one entityFacts hands the lifecycle pass.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dumpOf, NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';
import { javaFacts } from '../engine/extract/lifecycle.mjs';

const ORDER = `package shop;
import javax.persistence.Entity;
@Entity
public class Order {
  private OrderState state;
  public void pay() { this.state = OrderState.PAID; }
}
`;

const fieldRow = (f) => ({ name: f.name, type: f.type, typeFqn: f.typeFqn });

test('a status enum the dump does not declare still names the entity that holds it', { skip: NO_ENGINE }, () => {
  const { db, model } = dumpOf({ 'src/main/java/shop/Order.java': ORDER });
  const types = [...model.types.values()];
  const entities = types
    .filter((t) => (t.ann ?? []).some((a) => a.name === 'Entity'))
    .map((t) => ({ name: t.name, type: t, fields: (t.fields ?? []).map(fieldRow) }));
  // The dump gives OrderState no FQN: the field's type is the written name only.
  assert.equal(entities[0].fields[0].typeFqn, null);
  const entries = types.map((t) => ({ p: t.file, name: t.name, kind: t.kind, methods: t.methods, fields: (t.fields ?? []).map(fieldRow) }));
  const facts = javaFacts({ java: entries, dump: db, model, enums: [], entities, repoEntity: new Map(), shortlist: null });
  assert.deepEqual(
    facts.statusSets.map((s) => [s.entity, s.value]),
    [['Order', 'PAID']],
    `the owner is the entity, not unattributed: ${JSON.stringify(facts.statusSets)}`,
  );
  assert.ok(facts.lifecycle.includes('OrderState (declared outside this repo)'), facts.lifecycle.join('\n'));
});
