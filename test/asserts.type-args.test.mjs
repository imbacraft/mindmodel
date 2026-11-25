// Import-time self-checks moved out of engine/model/type-args.mjs (Task 9); the assertions are unchanged.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import { typeArgsOf, superBindings } from '../engine/model/type-args.mjs';

test('typeArgsOf: depth-aware split of a written type', () => {
  assert.deepStrictEqual(typeArgsOf('JpaRepository<Order, Long>'), ['Order', 'Long']);
  assert.deepStrictEqual(typeArgsOf('Map<String, List<Order>>'), ['String', 'List<Order>']);
  assert.deepStrictEqual(typeArgsOf('Order'), []);
});

test('superBindings: the subtype arguments bind the supertype parameters', () => {
  // Two files, no dump: the binding is the subtype's written supertype, resolved through the model.
  const model = {
    types: new Map([
      [
        'a.VoucherService',
        {
          fqn: 'a.VoucherService',
          file: 'src/a/VoucherService.java',
          supers: [{ text: 'Base<Voucher>', fqn: 'a.Base' }],
        },
      ],
      ['a.Base', { fqn: 'a.Base', file: 'src/a/Base.java', typeParams: ['T'], supers: [] }],
      ['a.Voucher', { fqn: 'a.Voucher', file: 'src/a/Voucher.java', supers: [] }],
    ]),
    resolveIn: (file, name) => (name === 'Voucher' && file === 'src/a/VoucherService.java' ? 'a.Voucher' : null),
  };
  assert.deepStrictEqual([...superBindings(model, 'a.VoucherService', 'a.Base')], [['T', 'a.Voucher']]);
  // Not a supertype of the subclass: no binding is invented.
  assert.equal(superBindings(model, 'a.VoucherService', 'a.Voucher').size, 0);
  // An argument that names nothing this scan declares does not bind.
  model.types.get('a.VoucherService').supers[0].text = 'Base<Gone>';
  assert.equal(superBindings(model, 'a.VoucherService', 'a.Base').size, 0);
});
