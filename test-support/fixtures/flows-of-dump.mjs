// The flow facts, built from a real dump the way scan.mjs builds them: dump -> model -> catalogs -> the real
// extractors -> the rank. The Java sources live on disk under test-support/fixtures/; `dump-dir.mjs` dumps them once.
// Nothing here parses Java, and no declaration is named by hand.
import { loadCatalogs, selectCatalogs } from '../../engine/catalogs/catalog.mjs';
import { extractEndpoints } from '../../engine/extract/endpoints.mjs';
import { extractState } from '../../engine/extract/state.mjs';
import { extractOutside } from '../../engine/extract/outside.mjs';
import { javaFacts } from '../../engine/extract/lifecycle.mjs';
import { buildFlows, flowEntries } from '../../engine/extract/flows.mjs';
import { dumpOfLayers } from './dump-dir.mjs';

/** scan.mjs's own count, so a fixture asks for depth 5 exactly when an app would. */
function callStatsOf(model, dump) {
  let sites = 0,
    ambiguous = 0,
    unanswered = 0;
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const call of m.calls ?? []) {
        sites++;
        if (call.how === 'ambiguous') ambiguous++;
        if (call.how === 'unresolved') unanswered++;
      }
  const answered = dump.calls.reduce((n, row) => n + (row.origin === 'error' ? 0 : 1), 0);
  return { sites, answered, ambiguous, unanswered };
}

/**
 * `layers` are fixture dir names under test-support/fixtures, applied in order. Returns the model, the dump, the
 * lifecycle facts, the flows and `flowOf(path)`.
 */
export function flowsOfLayers(layers, { frontendPaths = [] } = {}) {
  const { db, model } = dumpOfLayers(layers);
  const stats = callStatsOf(model, db);
  const exactTargets = !!stats.answered && stats.ambiguous === 0 && stats.unanswered < stats.sites * 0.02;
  const imports = [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  const selected = selectCatalogs(loadCatalogs(), { imports });
  const endpoints = extractEndpoints(model, selected);
  const stateWrites = extractState(model, selected).filter((f) => f.family === 'state-write');
  const outsideCalls = extractOutside(model, selected);
  const types = [...model.types.values()];
  const entities = types
    .filter((t) => (t.ann ?? []).some((a) => /(?:^|\.)Entity$/.test(a.fqn ?? '')))
    .map((t) => ({ name: t.name, type: t, fields: t.fields ?? [] }));
  const enums = types
    .filter((t) => t.kind === 'enum')
    .map((t) => ({ name: t.name, file: t.file, line: t.start, values: t.enumValues ?? [] }));
  const entries = types.map((t) => ({
    p: t.file,
    name: t.name,
    kind: t.kind,
    methods: t.methods,
    fields: t.fields ?? [],
  }));
  const deep = javaFacts({ dump: db, model, java: entries, repoEntity: new Map(), enums, entities, shortlist: null });
  // Centrality counts the types that refer to an entity, as entities.mjs does; a fixture is far below the threshold.
  const refs = (name) =>
    types.filter((t) => (t.fields ?? []).some((f) => String(f.typeFqn ?? '').split('.').pop() === name)).length;
  const flows = buildFlows(model, {
    entries: flowEntries(model, endpoints, selected),
    stateWrites,
    outsideCalls,
    statusSets: deep.statusSets,
    entities: entities.map((e) => ({ name: e.name, refs: refs(e.name) })),
    activityOf: () => 0,
    selected,
    exactTargets,
    frontendPaths,
  });
  return { db, model, endpoints, deep, flows, flowOf: (path) => flows.find((f) => f.entry.path === path) };
}
