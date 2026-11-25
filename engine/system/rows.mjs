// Readers of the dump's rows: a call's arguments, a type's and a member's rows, and the strings an annotation value
// folds to. The dump is the only reader of the modules' Java; these only read what it wrote.
export const dumpArgs = (db, call) => (db && call?.id ? db.argsOf(call.id) : []);
export const stringArg = (a) => (typeof a?.value === 'string' ? a.value : null);

// An annotation as the dump wrote it: its arguments are values, not the source text the model keeps for display.
export const typeRow = (module, t) => module?.db?.type(t.fqn) ?? null;
export const memberRow = (module, m) => (m.id ? (module.db.members.get(m.id) ?? null) : null);

/** Every string an annotation value folds to, arrays included; a nested annotation names no channel. */
export const flatStrings = (value) => {
  if (!value) return [];
  if (value.kind === 'array') return (value.value ?? []).flatMap((v) => flatStrings(v));
  if (value.kind === 'annotation' || value.kind === 'unresolved' || value.value == null) return [];
  return typeof value.value === 'string' ? [value.value] : [];
};
