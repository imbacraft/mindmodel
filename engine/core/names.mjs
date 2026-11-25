// The names the engine compares: dotted Java names, possibly with type arguments. Every module reads a simple name
// through this one helper, so none keeps a private copy.
import assert from 'node:assert';

// The java.lang names a source uses without an import. The language's own types, not a framework's, so they stay here.
export const JAVA_LANG = new Set([
  'String', 'Object', 'Class', 'Enum', 'Record', 'Throwable', 'Exception', 'RuntimeException', 'Error',
  'IllegalArgumentException', 'IllegalStateException', 'UnsupportedOperationException', 'NullPointerException',
  'ArithmeticException', 'InterruptedException', 'IndexOutOfBoundsException', 'ClassCastException',
  'Runnable', 'Thread', 'ThreadLocal', 'Iterable', 'Comparable', 'Cloneable', 'AutoCloseable',
  'Integer', 'Long', 'Short', 'Byte', 'Double', 'Float', 'Boolean', 'Character', 'Number', 'Math', 'StrictMath',
  'System', 'StringBuilder', 'StringBuffer', 'CharSequence', 'Void', 'Package', 'Process', 'Runtime',
  'Deprecated', 'Override', 'SuppressWarnings', 'FunctionalInterface', 'SafeVarargs',
]);

// The last segment of a qualified name, without type arguments: `a.b.C<D>` -> `C`; empty for nothing.
export const simple = (name) => String(name ?? '').replace(/<[\s\S]*/, '').split('.').pop().trim();

{
  assert.equal(simple('a.b.Order'), 'Order');
  assert.equal(simple('Order'), 'Order');
  assert.equal(simple('java.util.Map<String, a.B>'), 'Map');
  assert.equal(simple(null), '');
  assert.equal(simple(undefined), '');
}
