// A quiet fallback, made loud. A caller that cannot get the answer and uses a default instead says so here: the reason
// is recorded, and the scan writes it into facts.json (runtime.degraded), the digest, validate and render print it.
// MINDMODEL_STRICT=1 (the test suite sets it) turns the same fallback into an error, so a path that degrades by
// accident fails the test that hit it. A test that asserts a degraded path opts out with withDegradation().
import assert from 'node:assert';

const recorded = [];

export const isStrict = () => process.env.MINDMODEL_STRICT === '1';

/** Returns `fallback` and records `reason`; under MINDMODEL_STRICT=1 it throws instead. */
export function degraded(reason, fallback) {
  if (isStrict()) throw new Error(`degraded (MINDMODEL_STRICT=1): ${reason}`);
  recorded.push(reason);
  return fallback;
}

/** A position in the record; pass it to degradedSince to read what was recorded after it. */
export const degradedMark = () => recorded.length;

/** The distinct reasons recorded after `mark`, in the order they were first recorded. */
export const degradedSince = (mark) => [...new Set(recorded.slice(mark))];

/** Runs `fn` with strict mode off; returns `{ value, reasons }`. For a test that asserts a degradation on purpose. */
export function withDegradation(fn) {
  const saved = process.env.MINDMODEL_STRICT;
  const mark = degradedMark();
  process.env.MINDMODEL_STRICT = '0';
  try {
    const value = fn();
    return { value, reasons: degradedSince(mark) };
  } finally {
    if (saved === undefined) delete process.env.MINDMODEL_STRICT;
    else process.env.MINDMODEL_STRICT = saved;
  }
}

{
  const saved = process.env.MINDMODEL_STRICT;
  process.env.MINDMODEL_STRICT = '1';
  assert.throws(() => degraded('no jar', null), /degraded .*no jar/, 'strict mode throws');
  process.env.MINDMODEL_STRICT = '0';
  const mark = degradedMark();
  assert.equal(degraded('no jar', 7), 7, 'the fallback is returned');
  assert.equal(degraded('no jar', 7), 7);
  assert.deepStrictEqual(degradedSince(mark), ['no jar'], 'a repeated reason is listed once');
  const { value, reasons } = withDegradation(() => degraded('no mvn', 'none'));
  assert.equal(value, 'none');
  assert.deepStrictEqual(reasons, ['no mvn']);
  process.env.MINDMODEL_STRICT = '1';
  assert.equal(withDegradation(() => isStrict()).value, false, 'withDegradation turns strict off for its call');
  assert.equal(isStrict(), true, 'and restores it afterwards');
  if (saved === undefined) delete process.env.MINDMODEL_STRICT;
  else process.env.MINDMODEL_STRICT = saved;
}
