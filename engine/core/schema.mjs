// The JSON Schema subset the engine's schemas use, checked without a dependency.
import assert from 'node:assert';

// Whether v passes schema s with no problems: the test `contains` applies to each item.
const passes = (v, s, defs) => {
  const problems = [];
  checkSchema(v, s, defs, '', (m) => problems.push(m));
  return problems.length === 0;
};

// The subset: type, required, additionalProperties, enum, const, pattern, items, min/maxItems, contains and
// min/maxContains, maxLength, $ref. That is enough to catch a misspelled field or a wrong enum. Each problem goes to
// `err` with the path it sits at.
export function checkSchema(v, s, defs, at, err) {
  if (s.$ref) return checkSchema(v, defs[s.$ref.split('/').pop()], defs, at, err);
  const type = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v;
  const types = s.type == null ? null : [].concat(s.type); // JSON Schema allows a list: ["object", "null"]
  if (types && !types.includes(type) && !(types.includes('number') && type === 'integer'))
    return err(`${at}: expected ${types.join(' or ')}, got ${type}`);
  if (s.const !== undefined && v !== s.const) err(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) err(`${at}: "${v}" is not one of ${s.enum.join(', ')}`);
  if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v))
    err(`${at}: "${v}" does not match ${s.pattern}`);
  if (s.maxLength && typeof v === 'string' && v.length > s.maxLength) err(`${at}: longer than ${s.maxLength} chars`);
  if (type === 'array') {
    if (s.maxItems != null && v.length > s.maxItems) err(`${at}: ${v.length} items > ${s.maxItems}`);
    if (s.minItems != null && v.length < s.minItems) err(`${at}: ${v.length} items < ${s.minItems}`);
    if (s.contains) {
      // Only the items that match `contains` count; the default minimum is one, as in JSON Schema.
      const n = v.filter((x) => passes(x, s.contains, defs)).length;
      if (n < (s.minContains ?? 1)) err(`${at}: ${n} items match contains < ${s.minContains ?? 1}`);
      if (s.maxContains != null && n > s.maxContains) err(`${at}: ${n} items match contains > ${s.maxContains}`);
    }
    if (s.items) v.forEach((x, i) => checkSchema(x, s.items, defs, `${at}[${i}]`, err));
  }
  if (type === 'object' && s.properties) {
    for (const k of s.required ?? []) if (!(k in v)) err(`${at}: missing "${k}"`);
    for (const [k, x] of Object.entries(v))
      if (s.properties[k]) checkSchema(x, s.properties[k], defs, `${at}.${k}`, err);
      else if (s.additionalProperties === false) err(`${at}: unknown field "${k}"`);
  }
  // A schema for every key of a map (`additionalProperties: {…}`): each value is checked against it.
  if (type === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object')
    for (const [k, x] of Object.entries(v))
      if (!s.properties?.[k]) checkSchema(x, s.additionalProperties, defs, `${at}.${k}`, err);
}

{
  const e = [],
    s = {
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      properties: { a: { enum: ['x'] }, b: { type: 'array', maxItems: 1, items: { type: 'string' } } },
    };
  checkSchema({ a: 'y', b: ['p', 2], c: 1 }, s, {}, '$', (m) => e.push(m));
  assert.deepStrictEqual(e, [
    '$.a: "y" is not one of x',
    '$.b: 2 items > 1',
    '$.b[1]: expected string, got integer',
    '$: unknown field "c"',
  ]);
  // A map's keys each take the schema of its values.
  const m = [],
    n = { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } };
  checkSchema({ ok: ['a'], bad: ['a', 2] }, n, {}, '$', (x) => m.push(x));
  assert.deepStrictEqual(m, ['$.bad[1]: expected string, got integer']);
  // A list of types: either is accepted, anything else names both.
  const t = [],
    u = { type: ['object', 'null'] };
  for (const v of [{}, null, 'x']) checkSchema(v, u, {}, '$', (m) => t.push(m));
  assert.deepStrictEqual(t, ['$: expected object or null, got string']);
}

{
  // `contains` counts the matching items: at least one by default, and at most `maxContains` when given.
  const e = [],
    s = { type: 'array', contains: { properties: { tier: { const: 'core' } } }, maxContains: 1 };
  const tiers = (...xs) => xs.map((tier) => ({ tier }));
  checkSchema(tiers('core', 'peripheral'), s, {}, '$', (m) => e.push(m));
  checkSchema(tiers('core', 'core'), s, {}, '$', (m) => e.push(m));
  checkSchema(tiers('peripheral'), s, {}, '$', (m) => e.push(m));
  checkSchema(tiers('peripheral'), { ...s, minContains: 0 }, {}, '$', (m) => e.push(m));
  assert.deepStrictEqual(e, ['$: 2 items match contains > 1', '$: 0 items match contains < 1']);
}
