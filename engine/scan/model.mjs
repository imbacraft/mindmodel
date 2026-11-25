import { bindingRates } from '../model/calls.mjs';
import { buildModelFromDump } from '../model/from-dump-model.mjs';
import { dumpFor } from '../io/dump-run.mjs';
import { resolve as resolveClasspath, summaryHash } from '../io/classpath.mjs';
import { open as openDump } from '../dump.mjs';
import { annotationFqns, annotationIndex, loadCatalogs, selectCatalogs } from '../catalogs/catalog.mjs';
import { deployables, mainIndex } from '../extract/boot.mjs';
import { coordinatesOf } from '../evidence/build.mjs';

// The dump, the classpath and the model built from them: the one base every family queries.

// The shipped catalogs are read once per process; a project catalog is merged here when it lands.
const CATALOGS = loadCatalogs();

// `import jakarta.persistence.*;` then `@Entity`: an annotation with no explicit import is resolved through the
// catalog, not guessed. Only names a catalog knows resolve; everything else stays unknown and shows up in coverage.
export function resolveWildcardAnnotations(model, index) {
  const known = new Map();
  for (const [fqn, hits] of index.byFqn) known.set(fqn, hits);
  let fixed = 0;
  const apply = (anns, imports) => {
    for (const a of anns ?? []) {
      if (a.fqn) continue;
      for (const i of imports) {
        if (!i.wildcard) continue;
        const cand = `${i.name}.${a.name}`;
        if (known.has(cand)) {
          a.fqn = cand;
          fixed++;
          break;
        }
      }
    }
  };
  for (const t of model.types.values()) {
    const imports = model.importsOf.get(t.file)?.imports ?? [];
    apply(t.ann, imports);
    for (const m of t.methods ?? []) {
      apply(m.ann, imports);
      for (const p of m.params ?? []) apply(p.ann, imports);
    }
    for (const f of t.fields ?? []) apply(f.ann, imports);
  }
  return fixed;
}

/** What the dump answered, counted over the model the facts are built from. No joins: the model *is* the dump. */
function callStatsOf(model, dump) {
  let sites = 0,
    targets = 0,
    ambiguous = 0,
    unanswered = 0;
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const call of m.calls ?? []) {
        sites++;
        targets += call.targets?.length ?? 0;
        if (call.how === 'ambiguous') ambiguous++;
        if (call.how === 'unresolved') unanswered++;
      }
  const answered = dump.calls.reduce((n, row) => n + (row.origin === 'error' ? 0 : 1), 0);
  return { sites, answered, targets, ambiguous, unanswered, droppedTargets: 0 };
}

/**
 * The dump, the classpath and the model built from them: the one base every family queries. The binding rates are
 * written onto the model here, before any family reads it.
 */
export function loadModel({ root, files, R, read, javaAll, buildFiles }) {
  // The project's own dependency jars, when the machine already has them (offline, nothing built): Spoon then resolves
  // library types, and the library stubs say what their members are. Optional and never blocking.
  const cpStart = Date.now();
  const classpath = resolveClasspath(root, { files: files.map(R) });
  const classpathMs = Date.now() - cpStart;
  const dumpStart = Date.now();
  const classpathHash = summaryHash(classpath, root);
  const dumpRun = dumpFor(root, javaAll.map((j) => j.p), { classpath, classpathHash });
  const dumpMs = Date.now() - dumpStart;
  const dump = dumpRun.ok ? openDump(dumpRun.dir) : null;
  // A repo can hold several apps: map the primary one only (other deployables are named in Boot). The entry points come
  // from the dump just run, so the engine runs once per scan.
  const app = deployables({ java: javaAll, files, rel: R, read, dump: dumpRun.ok ? mainIndex(dumpRun.dir) : null });
  const java = javaAll.filter((j) => !app.isExcluded(j.p));
  const sources = new Map(
    [...(dump?.files?.entries() ?? [])].map(([p, f]) => [
      p,
      {
        pkg: f.package ?? '',
        imports: (f.imports ?? []).map((i) => ({ name: i.name, wildcard: !!i.wildcard, isStatic: !!i.static })),
        // A file the engine could not read at all is degraded: the dump says so rather than a silent empty list.
        degraded: (f.errors ?? []).length > 0,
      },
    ]),
  );
  // Which frameworks are installed decides how a wildcard import of a name the project does not declare resolves
  // (`jakarta.persistence.*` with `@Entity`), so the catalogs are selected before the model is built.
  const imports = [...sources.values()].flatMap((s) => s.imports.map((x) => x.name));
  const selected = selectCatalogs(CATALOGS, { deps: coordinatesOf(buildFiles), imports });
  const model = buildModelFromDump(
    dump ?? { types: new Map(), calls: [], membersOf: () => [] },
    sources,
    annotationFqns(selected),
  );
  if (!dump && javaAll.length)
    throw new Error(`mindmodel: no engine dump for ${javaAll.length} Java file(s) (${dumpRun.reason})`);
  const callStats = dump
    ? callStatsOf(model, dump)
    : { answered: 0, targets: 0, ambiguous: 0, unanswered: 0, sites: 0 };
  bindingRates(model);
  return {
    dump,
    dumpRun,
    dumpMs,
    classpath,
    classpathMs,
    sources,
    selected,
    model,
    callStats,
    app,
    java,
    // Built once: the method-security and the wildcard-annotation passes both read this index.
    annIndex: annotationIndex(selected),
  };
}

// Depth-5 walks need answers that are exact across the app, not partly filled by a fallback.
export function exactTargetsOf({ answered, ambiguous, unanswered, sites }) {
  return !!answered && ambiguous === 0 && unanswered < sites * 0.02;
}
