// The JSON Schema subset the engine's schemas use, checked without a dependency.
import assert from 'node:assert';

// The subset: type, required, additionalProperties, enum, const, pattern, items, min/maxItems, maxLength, $ref. That is
// enough to catch a misspelled field or a wrong enum. Each problem goes to `err` with the path it sits at.
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
    if (s.items) v.forEach((x, i) => checkSchema(x, s.items, defs, `${at}[${i}]`, err));
  }
  if (type === 'object' && s.properties) {
    for (const k of s.required ?? []) if (!(k in v)) err(`${at}: missing "${k}"`);
    for (const [k, x] of Object.entries(v))
      if (s.properties[k]) checkSchema(x, s.properties[k], defs, `${at}.${k}`, err);
      else if (s.additionalProperties === false) err(`${at}: unknown field "${k}"`);
  }
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
  // A list of types: either is accepted, anything else names both.
  const t = [],
    u = { type: ['object', 'null'] };
  for (const v of [{}, null, 'x']) checkSchema(v, u, {}, '$', (m) => t.push(m));
  assert.deepStrictEqual(t, ['$: expected object or null, got string']);
}
