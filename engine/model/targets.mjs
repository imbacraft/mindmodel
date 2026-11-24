// A call row's targets, in the two spellings the dump has written: contract 3 writes `{id, kind}`, where `declared` is
// the member Spoon resolved and `override` an implementation of it in a subtype; an earlier dump wrote the bare id of
// both. One place so no reader has to know which dump produced the row, and so "which target is the declaration" is a
// single answer instead of an assumption about order.

/** One target in the contract-3 shape, whatever the row carried. */
export const targetOf = (t) => (typeof t === 'string' ? { id: t, kind: 'declared' } : t ?? { id: null, kind: 'declared' });

/** The ids a row reaches, declaration first: the order the dump writes, never sorted. */
export const targetIds = (row) => (row?.targets ?? []).map(targetOf).map((t) => t.id).filter(Boolean);

/** The overrides only: the implementations, without the declaration. */
export const overrideIds = (row) =>
  (row?.targets ?? [])
    .map(targetOf)
    .filter((t) => t.kind === 'override' && t.id)
    .map((t) => t.id);

/** The declaration a row resolved to, or null when Spoon found none. */
export const declaredId = (row) => (row?.targets ?? []).map(targetOf).find((t) => t.kind === 'declared')?.id ?? null;

/** True only when the dump says the row reaches one implementation of a bodiless declaration. */
export const uniqueImplOf = (row) => row?.uniqueImpl === true;

// ---------------------------------------------------------------------------------------------------------------
// Self-check on the two shapes, and on the one rule a reader must not get wrong: an override is not a declaration.
{
  const two = { targets: [{ id: 'a.Port#go()', kind: 'declared' }, { id: 'a.Impl#go()', kind: 'override' }] };
  const old = { targets: ['a.Port#go()'] };
  if (targetIds(two).join() !== 'a.Port#go(),a.Impl#go()') throw new Error('targets keep their order');
  if (declaredId(two) !== 'a.Port#go()') throw new Error('the declaration is the declared target');
  if (overrideIds(two).join() !== 'a.Impl#go()') throw new Error('an override is not a declaration');
  if (targetIds(old).join() !== 'a.Port#go()' || declaredId(old) !== 'a.Port#go()')
    throw new Error('a bare id reads as a declaration');
  if (targetIds({}).length || declaredId({}) !== null) throw new Error('a row with no target reaches nothing');
  if (uniqueImplOf(two) || !uniqueImplOf({ uniqueImpl: true })) throw new Error('uniqueImpl is the dump’s answer');
}
