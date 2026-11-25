import assert from 'node:assert/strict';
import { simple } from '../../../core/names.mjs';

// The extractors read code only through the dump, via `engine/model/query.mjs`. Everything here is a plain read of one
// dump row or one model type: a value the dump folded, a type as written, a member's position.

export const dumpArgs = (db, call) => (db && call?.id ? db.argsOf(call.id) : []);
// The string values an argument list folds to: a literal's or a constant's value, never a variable's name.
export const stringValues = (rows) =>
  rows.map((a) => (typeof a?.value?.value === 'string' ? a.value.value : null)).filter((v) => v !== null);
// An argument as a rule's reason displays it: a string in quotes, anything else by the name the dump wrote.
export const shownArg = (a) => (typeof a?.value?.value === 'string' ? `"${a.value.value}"` : String(a?.text ?? ''));

// --- the dump door: shared by everything below ------------------------------------------------------------
// The extractors read code only through `engine/model/query.mjs`. `model.dump` is the handle the model was built from
// (one dump per scan); a test may hand the dump in instead. Without one every primitive answers `no-dump` and the
// facts below come out empty with a reason — never filled in from source text.
export const baseType = (text) => String(text ?? '').replace(/<[\s\S]*/, '').replace(/\[\]/g, '').trim();
export const simpleType = (text) => simple(baseType(text));

/** The constant name an argument carries, or null: the dump folded it, so this never reads a written expression. */
export const nameOfValue = (value) =>
  value && ['constant', 'literal', 'string'].includes(value.kind) && typeof value.value?.value === 'string'
    ? value.value.value
    : null;

/** Every value of one argument across its call sites, with the values the dump could not resolve kept apart. */
export const argValues = (q, call, i) => q.argValue(call, i);

/** The one constant an argument resolves to, or null when the dump answers none (or several disagree). */
export const constantArg = (q, call, i) => {
  const names = argValues(q, call, i).values.map((v) => nameOfValue(v.value)).filter(Boolean);
  return names.length && new Set(names).size === 1 ? names[0] : null;
};

/** A project type's FQN from a type as written (a holder's element, an argument's created type), or null. */
export const projectType = (model, written) => {
  const text = baseType(written);
  if (!text) return null;
  if (model.types?.has(text)) return text;
  const hits = [...(model.types?.keys() ?? [])].filter((k) => simple(k) === simple(text));
  return hits.length === 1 ? hits[0] : null;
};

/** A member's file and declaration line, so a store can be cited where it is written. */
export const memberAt = (db, id) => db?.members?.get(id) ?? null;
export const memberFile = (db, id) => memberAt(db, id)?.pos?.file ?? null;
export const memberLine = (db, id) => memberAt(db, id)?.pos?.line ?? null;

// One call row by id: an argument names the call it came from.
export const callById = (db, id) => (id ? db.callById(id) : null);

export const siteOf = (c) => ({
  method: c.method ?? null,
  call: c.id ?? null,
  file: c.file ?? null,
  line: c.line ?? null,
});

/** A constant written as a call's receiver (`NAME.equals(x)`): the dump names the field, its row carries the value. */
export const constantNameAt = (db, owner, row) => {
  const written = simpleType(row.recv?.text ?? '');
  if (!written || !/^[A-Z]/.test(written)) return null;
  const value = db.constant(owner, written);
  return typeof value?.value === 'string' ? value.value : null;
};

/** The name an annotation argument carries: the resolved `value` when the dump has it, else its own written text. */
export function annotationName(a) {
  const resolved = a?.args?.value;
  if (typeof resolved === 'string' && resolved) return resolved;
  const raw = String(a?.raw ?? a?.args ?? '');
  const named = /(?:^|,)\s*value\s*=\s*"([^"]*)"/.exec(raw)?.[1];
  if (named) return named;
  const first = /^\s*"([^"]*)"/.exec(raw)?.[1];
  return first || null;
}

{
  assert.equal(simpleType('java.util.Map<String, Object>'), 'Map');
  // The name an annotation argument carries: the resolved value, else the written text.
  assert.equal(annotationName({ raw: 'value = "X-Tenant", required = false' }), 'X-Tenant');
  assert.equal(annotationName({ raw: '"actAs"' }), 'actAs');
  assert.equal(annotationName({ raw: '' }), null);
}
