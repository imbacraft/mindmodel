import { javaFacts } from '../extract/lifecycle.mjs';

/** Repository simple name → entity simple name, from the resolved type arguments. */
function repoEntityMap(entFacts) {
  return new Map([...entFacts.repos].map(([fqn, e]) => [fqn.split('.').pop(), e.split('.').pop()]));
}

/** `@Modifying` on a repository method: the annotation row the dump wrote, on the method that carries it. */
function modifyingWrites(repos, repoEntity) {
  return repos.flatMap((r) =>
    (r.methods ?? []).flatMap((m) =>
      (m.ann ?? [])
        .filter((a) => a.name === 'Modifying')
        .map((a) => ({ file: r.p, line: a.line ?? m.nameLine, entity: repoEntity.get(r.name) })),
    ),
  );
}

/** Lifecycles, schedules and status sets from the dump, and the writes the repositories with @Modifying make. */
export function javaFactsOf(ctx, types, entFacts, endpoints) {
  const repoEntity = repoEntityMap(entFacts);
  const deep = javaFacts({
    // Statuses are read from the dump's typed arguments and returns: the source text is not consulted.
    dump: ctx.dump,
    model: ctx.model,
    java: types.appEntries,
    repoEntity,
    enums: types.enums,
    entities: types.entities,
    shortlist: new Set(
      [...entFacts.entities].sort((a, b) => b.relations.length - a.relations.length).slice(0, 15).map((e) => e.name),
    ),
    endpoints,
  });
  return { deep, modifying: modifyingWrites(types.repos, repoEntity) };
}
