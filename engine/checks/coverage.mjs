// L6: what the engine understood, and what it did not. Coverage is computed from the model (not from the facts), so
// it reports the engine's own blind spots and not just the claims it managed to make.
import { annotationIndex, simpleMeans, typeIndex } from '../catalogs/catalog.mjs';
import { simple } from '../core/names.mjs';

const rate = (id, num, den) => ({ id, numerator: num, denominator: den, percent: den ? Math.round((num / den) * 100) : 0 });

// Annotations that carry no fact and are not worth reporting as unknowns even when nothing resolved their name.
const HARMLESS = new Set([
  'Override',
  'SuppressWarnings',
  'Deprecated',
  'FunctionalInterface',
  'SafeVarargs',
  'Generated',
  'Serial',
]);

// Supertypes the engine treats as known without a catalog: JDK and Jakarta/Java EE types are generic API, and
// extending them hides nothing project-specific.
const KNOWN_PLATFORM = /^(java|jakarta|javax)\./;

// Top-level package segments that name a vendor domain, never a library.
const PACKAGE_TLDS = new Set(['org', 'com', 'net', 'io', 'cn', 'edu', 'dev', 'app', 'co', 'me', 'us', 'uk', 'info']);

// Words in an artifact id that name the build system, the framework or a packaging convention, never a package a
// project imports. Filtering them leaves the words that identify the library (`commons-lang3` -> `lang3`).
const GENERIC_ARTIFACT_WORDS = new Set(
  (
    'starter starters spring boot boot2 boot3 core common commons api apis plugin plugins processor annotation ' +
    'annotations test tests testing runtime client clients java jdk impl implementation module modules parent bom ' +
    'autoconfigure autoconfiguration integration platform dependencies base support util utils lib library sdk ' +
    'server servers agent jakarta javax'
  ).split(' '),
);

// Every annotation in the model, with the placement that gives it meaning and the type that carries it.
function annotationsOf(model) {
  const anns = [];
  for (const t of model.types.values()) {
    const add = (a, on) => anns.push({ ...a, file: t.file, on, owner: t.fqn });
    for (const a of t.ann ?? []) add(a, 'type');
    for (const m of t.methods) {
      for (const a of m.ann ?? []) add(a, 'method');
      for (const p of m.params ?? []) for (const a of p.ann ?? []) add(a, 'parameter');
    }
    for (const f of t.fields) for (const a of f.ann ?? []) add(a, 'field');
  }
  return anns;
}

export function coverage(model, facts, selected, { build = [], rels = [] } = {}) {
  const index = annotationIndex(selected);
  const types = typeIndex(selected);
  const anns = annotationsOf(model);

  // An annotation is understood when a catalog names its resolved FQN, or — for a name the model could not resolve
  // (a wildcard import, a simple name it kept as written) — when at least one selected catalog knows that simple name
  // at that placement. The match is then `inferred`; what matters for the blind-spot list is that the name is
  // not a mystery.
  const understood = (a) => {
    if (a.fqn && (index.byFqn.has(a.fqn) || HARMLESS.has(simple(a.fqn)))) return true;
    return HARMLESS.has(a.name) || simpleMeans(index, simple(a.name), a.on).length >= 1;
  };

  const meaningful = anns.filter((a) => !HARMLESS.has(simple(a.name)));
  const supers = [...model.types.values()].flatMap((t) => t.supers ?? []);
  const fields = [...model.types.values()].flatMap((t) => t.fields ?? []).filter((f) => /^[A-Z]/.test(f.type));
  const endpoints = facts.filter((f) => f.family === 'endpoint');

  // A rate that can fail. "annotations resolved" measured nothing, since an imported name always resolves;
  // "endpoints with a handler" and "endpoints with a path" are 100% by construction, since the extractor only emits a
  // fact when it has both. They are gone. The rates left can each drop on real code.
  const b = model.bindings ?? { calls: 0, typed: 0, project: 0, targeted: 0, ambiguous: 0 };
  const rates = [
    rate('supertypes resolved', supers.filter((s) => s.fqn).length, supers.length),
    rate('fields with a resolved type', fields.filter((f) => f.typeFqn).length, fields.length),
    rate('receiver typing', b.typed, b.calls),
    rate('project targets', b.targeted, b.project),
    // Overloads we cannot separate by name and arity are counted here, not in the numerator above: they are a
    // different kind of miss from "no such method", and collapsing them hides which one is growing.
    rate('ambiguous targets', b.ambiguous, b.project),
    rate(
      'endpoints with a fully resolved path',
      endpoints.filter((e) => e.confidence !== 'unresolved').length,
      endpoints.length,
    ),
    rate('annotations understood', meaningful.filter(understood).length, meaningful.length),
  ];

  // Annotations nobody has a meaning for: the first line of the blind-spot report. Grouped by the name as written
  // when it did not resolve, so a company annotation shows up under its own name instead of hiding. Reported when it
  // is used at least 5 times or on at least 3 types: one-off annotations are noise.
  const unknown = new Map();
  for (const a of meaningful) {
    if (understood(a)) continue;
    const key = a.fqn ?? a.name;
    if (!unknown.has(key)) unknown.set(key, { name: key, count: 0, owners: new Set(), samples: [] });
    const u = unknown.get(key);
    u.count++;
    u.owners.add(a.owner);
    if (u.samples.length < 2) u.samples.push(`${a.file}:${a.line}`);
  }

  // Base classes nobody explains: inheritance the facts cannot see into. Library bases matter as much as project
  // ones, so both are listed; JDK/Jakarta bases are generic API, not blind spots.
  const bases = new Map();
  for (const t of model.types.values())
    for (const s of t.supers ?? []) {
      if (!s.fqn || types.has(s.fqn) || KNOWN_PLATFORM.test(s.fqn)) continue;
      if (!bases.has(s.fqn)) bases.set(s.fqn, { name: s.fqn, count: 0, samples: [] });
      const b = bases.get(s.fqn);
      b.count++;
      if (b.samples.length < 2) b.samples.push(`${t.file}:${t.nameLine}`);
    }

  // Dependencies the build declares that no catalog knows, ranked by use. Packages are attributed to the dependency
  // that owns them: the longest group whose package prefix matches, tie-broken by the artifact's distinctive words
  // (`spring-jdbc` owns `org.springframework.jdbc`; `commons-lang3` owns `org.apache.commons.lang3`). A package no
  // dependency claims is left out, so a guess never becomes a blind spot. Project modules, test-scope deps and
  // optional/build-only artifacts are not runtime dependencies of the code; a dep nothing imports is counted, not
  // listed.
  const ownGroups = new Set(build.map((b) => b.group).filter(Boolean));
  const knownDeps = new Set(selected.flatMap(({ catalog }) => catalog.when?.deps ?? []));
  const declared = new Map();
  for (const b of build)
    for (const d of b.deps ?? []) {
      const coordinate = `${d.group}:${d.artifact}`;
      if (!d.artifact || ownGroups.has(d.group) || d.optional) continue;
      if (d.scope === 'test' || d.scope === 'system') continue;
      // Annotation processors, code generators and build plugins run at build time; nothing imports them at runtime.
      if (/(^|-)(processor|plugin|codegen|compiler|maven-plugin|gradle-plugin)$/.test(d.artifact)) continue;
      if (!declared.has(coordinate))
        declared.set(coordinate, {
          coordinate,
          group: d.group,
          words: (d.artifact ?? '')
            .toLowerCase()
            .split(/[-.]/)
            .filter((w) => w.length > 2 && !GENERIC_ARTIFACT_WORDS.has(w) && !PACKAGE_TLDS.has(w)),
        });
    }
  const packageFiles = new Map();
  for (const [file, { imports }] of model.importsOf)
    for (const { name, wildcard } of imports) {
      const pkg = wildcard ? name : name.slice(0, name.lastIndexOf('.'));
      if (!pkg) continue;
      if (!packageFiles.has(pkg)) packageFiles.set(pkg, new Set());
      packageFiles.get(pkg).add(file);
    }
  const deps = new Map(
    [...declared.values()]
      .filter((d) => !knownDeps.has(d.coordinate))
      .map((d) => [d.coordinate, { coordinate: d.coordinate, files: 0 }]),
  );
  for (const [pkg, files] of packageFiles) {
    const segs = pkg.toLowerCase().split('.');
    const candidates = [...declared.values()]
      .filter((d) => pkg === d.group || pkg.startsWith(`${d.group}.`))
      .map((d) => ({ d, matched: d.words.filter((w) => segs.includes(w)).length }))
      .filter((c) => c.matched > 0)
      .sort(
        (a, b) =>
          b.matched - a.matched ||
          b.d.group.length - a.d.group.length ||
          a.d.coordinate.localeCompare(b.d.coordinate),
      );
    const owner = candidates[0]?.d;
    if (!owner || knownDeps.has(owner.coordinate)) continue;
    deps.get(owner.coordinate).files += files.size;
  }

  // Source files the model cannot read at all. Counting them is the honest answer to "why is this flow truncated".
  const unparsed = { kotlin: 0, groovy: 0, scala: 0 };
  for (const rel of rels) {
    if (/\.kt$/.test(rel)) unparsed.kotlin++;
    else if (/\.groovy$/.test(rel)) unparsed.groovy++;
    else if (/\.scala$/.test(rel)) unparsed.scala++;
  }

  // Code-generation plugins: their output is not hand-written code, and its packages tell the reader where the
  // generated types live. Counted here; the writer never has to guess.
  const generatedSources = build.flatMap((b) =>
    (b.plugins ?? [])
      .filter((p) => p.config && /generator|openapi|protobuf|grpc|jooq|querydsl/.test(p.id))
      .map((p) => ({
        file: b.file,
        plugin: p.id,
        packages: [p.config.packageName, p.config.modelPackage, p.config.apiPackage, p.config.invokerPackage].filter(
          Boolean,
        ),
      })),
  );

  const cov = {
    rates,
    unknownAnnotations: [...unknown.values()]
      .map((u) => ({ name: u.name, count: u.count, types: u.owners.size, samples: u.samples }))
      .filter((u) => u.count >= 5 || u.types >= 3)
      .sort((a, b) => b.count - a.count),
    unknownBaseClasses: [...bases.values()].filter((b) => b.count >= 3).sort((a, b) => b.count - a.count),
    uncataloguedDependencies: [...deps.values()]
      .filter((d) => d.files > 0)
      .sort((a, b) => b.files - a.files || a.coordinate.localeCompare(b.coordinate))
      .slice(0, 15),
    uncataloguedDependenciesTotal: deps.size,
    unparsedLanguages: unparsed,
    generatedSources,
    degradedFiles: [...(model.degraded ?? [])],
  };
  return { ...cov, line: coverageLine(cov) };
}

// A one-paragraph digest line for the writer: what is solid, and how much is blind. The names live in the section
// below it ("What the engine did not understand"), so they are not repeated here.
export function coverageLine(cov) {
  const r = (id) => cov.rates.find((x) => x.id === id);
  const pct = (id) => `${r(id).percent}% (${r(id).numerator}/${r(id).denominator})`;
  const langs = Object.entries(cov.unparsedLanguages).filter(([, n]) => n > 0);
  const amb = cov.rates.find((r) => r.id === 'ambiguous targets');
  return [
    `supertypes ${pct('supertypes resolved')}`,
    `fields ${pct('fields with a resolved type')}`,
    `receiver typing ${pct('receiver typing')}`,
    `project targets ${pct('project targets')}`,
    amb?.numerator ? `ambiguous targets ${pct('ambiguous targets')}` : null,
    `paths fully resolved ${pct('endpoints with a fully resolved path')}`,
    `annotations understood ${pct('annotations understood')}`,
    `unknown annotations ${cov.unknownAnnotations.length}`,
    cov.unknownBaseClasses.length ? `unknown base classes ${cov.unknownBaseClasses.length}` : null,
    cov.uncataloguedDependenciesTotal ? `uncatalogued deps ${cov.uncataloguedDependenciesTotal}` : null,
    langs.length ? `unparsed sources ${langs.map(([k, n]) => `${k} ${n}`).join(', ')}` : null,
    cov.generatedSources.length ? `generated sources ${cov.generatedSources.length} plugin(s)` : null,
    cov.degradedFiles.length ? `degraded files ${cov.degradedFiles.length}` : null,
  ]
    .filter(Boolean)
    .join('; ');
}
