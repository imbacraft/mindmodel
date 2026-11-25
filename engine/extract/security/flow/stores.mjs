import { callById, simpleType } from './dump.mjs';

/**
 * The stores a method performs: `stores()`'s own list, plus the store-shaped calls it could not tie to a receiver — a
 * chained library call (`SecurityContextHolder.getContext().setAuthentication(x)`) arrives with no receiver type, so
 * the dump calls it `receiver-untyped` instead of naming the holder. An unknown never clears a warning: those gaps are
 * kept, marked `unresolved`, and only for the calls that store an identity.
 */
export function identityStores(q, id, db) {
  const { stores, unresolved } = q.stores(id, 0);
  const kept = stores.filter((s) => s.op !== 'clear');
  // The request-scoped shape (set in a try, cleared in its finalizer) when no classpath was there to type the holder.
  // One store is one site: a store the reach already found as a typed holder is not counted twice.
  const seen = new Set(kept.map((s) => `${s.file}:${s.line}`));
  for (const s of q.scopedStores(id).stores)
    if (s.op !== 'clear' && !seen.has(`${s.file}:${s.line}`)) kept.push({ ...s, element: null });
  for (const gap of unresolved)
    if (/%?(setAuthentication|setContext)$/.test(gap.name ?? '') && /receiver-untyped$/.test(gap.reason ?? ''))
      kept.push({
        kind: 'security-context',
        holder: null,
        how: gap.name,
        unresolved: true,
        method: gap.method,
        call: gap.call,
        file: gap.file,
        line: gap.line,
        args: callById(db, gap.call)?.args ?? [],
      });
  return kept;
}

/** A store as one short phrase, for the `why` line a writer reads. */
export const storeLabel = (store, db) => {
  const row = callById(db, store.call);
  // A store found by shape names its type as written: the call's receiver type is the enclosing class when Spoon
  // could not resolve the library type, and naming that would name the filter instead of the holder.
  const recv = store.via === 'try-finally-pattern' ? store.holder : row?.recv?.typeFqn;
  const owner = recv ? `${simpleType(recv)}.` : '';
  return `${owner}${row?.name ?? store.kind}(${row?.args?.map((a) => a.text).join(', ') ?? ''})`;
};
