// Shared building blocks for the fact families: citations to a method, confidence arithmetic, and
// the envelope every fact wears. Extractors never read files; they answer from the model and the catalogs.
import assert from 'node:assert';
import { formatCite } from '../core/cite.mjs';

// A citation that the validator can resolve: overloaded names carry the range, so two overloads don't read as one.
export function citeOf(type, method) {
  if (!method || method.start == null) return `${type.file}#${type.name}`;
  const overloaded = (type.methods ?? []).some((m) => m !== method && m.name === method.name);
  const where = overloaded ? { start: method.start, end: method.end } : {};
  return formatCite({ file: type.file, ...where, symbol: method.name });
}

// One fact, with the envelope fields in the same order everywhere.
export const factOf = ({ id, family, confidence, evidence, why, ...rest }) => ({
  id,
  family,
  confidence,
  evidence,
  why,
  ...rest,
});

// Two identical calls in one method (`persist(a); persist(b)`) are two facts with the same subject. Ids must be
// unique; the second and later occurrences carry an ordinal, which only moves if the method itself changes.
export function withUniqueIds(facts) {
  const seen = new Map();
  return facts.map((f) => {
    const n = (seen.get(f.id) ?? 0) + 1;
    seen.set(f.id, n);
    return n === 1 ? f : { ...f, id: `${f.id}~${n}` };
  });
}

// A type's FQN is the fact's subject when the method id would be unstable across overload edits.
export const methodIdOf = (type, method) => method.id ?? `${type.fqn}#${method.name}`;

{
  const type = { file: 'a/A.java', name: 'A', fqn: 'a.A', methods: [{ name: 'x', start: 2, end: 3 }, { name: 'x', start: 5, end: 6 }] };
  assert.equal(citeOf(type, type.methods[0]), 'a/A.java:2-3#x');
  const single = { ...type, methods: [{ name: 'y', start: 8, end: 9 }] };
  assert.equal(citeOf(single, single.methods[0]), 'a/A.java#y');
}
