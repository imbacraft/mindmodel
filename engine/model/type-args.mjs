// The type arguments of a written type: "JpaRepository<Order, Long>" -> ["Order", "Long"]. Generics nest, so the split
// is depth-aware; no model, no resolution — a text helper the facts use where the source is already a string.

export function typeArgsOf(text) {
  if (!text || text.indexOf('<') < 0) return [];
  const m = /<([\s\S]+)>/.exec(text);
  if (!m) return [];
  const out = [];
  let depth = 0,
    cur = '';
  for (const ch of m[1]) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// A supertype's type parameters, bound to the arguments the subtype writes: `VoucherService extends
// AbstractVersionService<Voucher>` binds `T` to `a.Voucher`. The argument resolves through the subtype's own file, so a
// written simple name becomes the project's type; a parameter bound to another parameter composes through `outer`
// (the bindings already opened by an earlier hop). A parameter that binds to nothing this scan declares is left out —
// an entity the model cannot name is not an entity.
export function superBindings(model, subFqn, superFqn, outer = new Map()) {
  const sub = model.types.get(subFqn),
    sup = model.types.get(superFqn);
  if (!sub || !sup) return new Map();
  const written = (sub.supers ?? []).find((s) => s.fqn === superFqn)?.text;
  const args = typeArgsOf(written);
  const out = new Map();
  (sup.typeParams ?? []).forEach((param, i) => {
    const arg = String(args[i] ?? '').trim();
    if (!arg) return;
    const bound = model.resolveIn(sub.file, arg) ?? outer.get(subFqn)?.get(arg);
    if (bound && model.types.has(bound)) out.set(param, bound);
  });
  return out;
}
