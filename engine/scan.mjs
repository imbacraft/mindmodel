#!/usr/bin/env node
// Collects the mechanical facts so the writer reads code only to judge, not to search.
// Usage: node scan.mjs <projectRoot> [outFile]   (default out: <root>/mindmodel/.work/facts.json)
// Never copies config values (only keys) so secrets cannot leak into facts or the map.
import fs from 'node:fs';
import { retuneHeap } from './io/heap.mjs';
import path from 'node:path';
import { javaFacts } from './extract/lifecycle.mjs';
import { bootEntries, bootFacts, deployables, mainIndex } from './extract/boot.mjs';
import { activityByFile, forgetActivity, gitWindow } from './io/activity.mjs';
import { git } from './io/git.mjs';
import { bindingRates } from './model/calls.mjs';
import { buildModelFromDump } from './model/from-dump-model.mjs';
import { dumpFor } from './io/dump-run.mjs';
import { resolve as resolveClasspath, summaryHash, tildify } from './io/classpath.mjs';
import { readBuild } from './io/build.mjs';
import { open as openDump } from './dump.mjs';
import { simple } from './core/names.mjs';
import { annotationOn, hasAnnotation } from './core/annotations.mjs';
import { IGNORED_DIRS, isE2e, isTestCode, normalizePath, relPosix } from './core/paths.mjs';
import { linesMatching } from './core/strings.mjs';
import {
  annotationFqns,
  annotationIndex,
  listOf,
  loadCatalogs,
  mapOf,
  meanOf,
  selectCatalogs,
  typeIndex,
} from './catalogs/catalog.mjs';
import { extractEndpoints } from './extract/endpoints.mjs';
import { buildFlows, flowEntries } from './extract/flows.mjs';
import { channelFacts } from './extract/channels.mjs';
import { extractSchedules } from './extract/schedules.mjs';
import { channelConfigOf, configFilesOf, configKeyFacts } from './extract/config.mjs';
import {
  anonymousWrites,
  authSources,
  identityWarnings,
  methodSecurityFacts,
  securityModel as buildSecurityModel,
  shiroCodeRules,
  shiroRules,
  springChains,
  surenessRules,
  tenantSources,
  webXmlRules,
} from './extract/security.mjs';
import { entityFacts } from './extract/entities.mjs';
import { noRequestPaths, tenancyFacts } from './extract/tenancy.mjs';
import { extractOutside } from './extract/outside.mjs';
import { extractState } from './extract/state.mjs';
import { extractTransactions } from './extract/transactions.mjs';
import { coverage } from './checks/coverage.mjs';
import { coordinatesOf } from './evidence/build.mjs';
import { budgetLine } from './budget.mjs';
import { summarize } from './digest/facts-md.mjs';

// The digest moved to digest/facts-md.mjs and the budget to budget.mjs; the names stay importable from here.
export { budgetLine, summarize };

// The shipped catalogs are read once per process; a project catalog is merged here when it lands.
const CATALOGS = loadCatalogs();

// Compiled and binary files are never read, so don't even list them (wherever a build tool put them).
const SKIP_EXT = new RegExp(
  [
    '\\.(class|jar|war|ear|so|dll|dylib|exe|o|pyc|png|jpe?g|gif|webp|ico|bmp|tiff?|woff2?|ttf|otf|eot|',
    'mp[34]|mov|avi|zip|gz|tgz|rar|7z|pdf|psd|map)$',
  ].join(''),
  'i',
);
const lc = (s) => s[0].toLowerCase() + s.slice(1);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && !['.github'].includes(e.name) && e.isDirectory()) continue;
    if (IGNORED_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (!SKIP_EXT.test(e.name)) out.push(p);
  }
  return out;
}

// --- Java -------------------------------------------------------------------

// --- frontend routes ----------------------------------------------------------
// Angular route arrays use paths without a leading slash, so they're only trusted in files that declare routes.
const isAngularRoutes = (text) =>
  /\bRoutes\b|RouterModule\.for(Root|Child)|provideRouter\(/.test(text) && /@angular\/router/.test(text);
export function routePath(line, angular = false) {
  const m = /<Route[^>]*\bpath=["'{`]+([^"'}`]+)/.exec(line) ?? /\bpath:\s*["'](\/[^"']*)["']/.exec(line);
  if (m) return m[1];
  const a = angular && /\bpath:\s*["']([^"'/][^"']*|)["']/.exec(line);
  return a ? '/' + a[1] : null;
}

// --- main ---------------------------------------------------------------------
// `import jakarta.persistence.*;` then `@Entity`: an annotation with no explicit import is resolved through the
// catalog, not guessed. Only names a catalog knows resolve; everything else stays unknown and shows up in coverage.
function resolveWildcardAnnotations(model, index) {
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

// The run's scratch folder. `.work/` holds facts, the Java dump and report files (megabytes nobody should commit);
// `mindmodel.json` and `index.html` beside it are the deliverables and stay visible.
function ensureWork(root) {
  const work = path.join(root, 'mindmodel', '.work');
  fs.mkdirSync(work, { recursive: true });
  // A `.gitignore` inside `.work/` keeps the scan data out of `git status` without editing the project's own file.
  const ignore = path.join(work, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return work;
}

// An annotation as the facts state it: its name and the argument list the dump wrote, never the source line.
const describeAnn = (a) => `@${a.name}${a.args ? `(${a.args})` : ''}`.slice(0, 160);

/**
 * The places one shape appears in a set of types, as `{file, line, text}`: an annotation on the type or its methods, a
 * supertype, a field's type, a method's return type, or a call. Each `text` says what the shape is — the supertype
 * implemented, the annotation written, the argument passed — and a place is listed once.
 */
function modelEntries(types, { types: tSpec = {}, methods: mSpec = {}, fields: fSpec = {} } = {}) {
  const out = [];
  for (const t of types ?? []) {
    for (const a of t.ann ?? [])
      if ((tSpec.ann ?? []).some((re) => re.test(a.name)))
        out.push({ file: t.file, line: a.line ?? t.nameLine, text: describeAnn(a) });
    for (const sp of t.supers ?? []) {
      const name = simple(sp.fqn ?? sp.text ?? '');
      if (!tSpec.supers || !tSpec.supers.test(name)) continue;
      const verb = sp.kind === 'interface' ? 'implements' : 'extends';
      out.push({ file: t.file, line: t.nameLine, text: `${verb} ${name}` });
    }
    for (const f of t.fields ?? [])
      if (fSpec.type && (fSpec.type.test(f.type ?? '') || fSpec.type.test(f.typeFqn ?? '')))
        out.push({ file: t.file, line: f.line, text: `${f.type || f.typeFqn} ${f.name}` });
    for (const m of t.methods ?? []) {
      for (const a of m.ann ?? [])
        if ((mSpec.ann ?? []).some((re) => re.test(a.name)))
          out.push({ file: t.file, line: a.line ?? m.nameLine, text: describeAnn(a) });
      if (mSpec.returns && mSpec.returns.test(m.returns ?? ''))
        out.push({ file: t.file, line: m.nameLine, text: `${m.returns} ${m.name}()` });
      for (const c of m.calls ?? []) {
        if (!mSpec.calls || !mSpec.calls.test(c.name ?? '')) continue;
        if (mSpec.recv && !mSpec.recv.test(c.recvFqn ?? '')) continue;
        out.push({ file: t.file, line: c.line, text: `${c.name}(${(c.args ?? [])[0] ?? ''})` });
      }
    }
  }
  const seen = new Set();
  return out
    .filter((e) => {
      const k = `${e.file}:${e.line}:${e.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * A run writes a new map from the current facts, so the previous `mindmodel.json` must not sit at the path the writer
 * writes: left there, the writer patches the old map and a plugin upgrade never shows. Renaming keeps the old file
 * byte-identical inside `.work/`, where it is out of the writer's way but still there for a diff.
 */
function retirePreviousMap(root) {
  const map = path.join(root, 'mindmodel', 'mindmodel.json');
  let isFile = false;
  try {
    isFile = fs.statSync(map).isFile();
  } catch {
    // no map yet: nothing to retire
  }
  if (!isFile) return null;
  const kept = path.join(ensureWork(root), 'previous-mindmodel.json');
  fs.renameSync(map, kept); // an older copy is replaced: the latest previous map is the only useful one
  return kept;
}

// Work that runs without a request: a job annotation on the method, an observer on its parameter.
const JOB = listOf('job-annotations');
const OBSERVER = listOf('observer-annotations');
const MESSAGE_DRIVEN = [...listOf('message-driven-annotations')];

/** A job, an observer or a message listener: the annotation is on the method (or its parameter), the model has both. */
function scheduledOf(t) {
  const jobs = [];
  for (const m of t.methods ?? []) {
    for (const a of m.ann ?? [])
      if (JOB.has(a.name))
        jobs.push({
          kind: a.name,
          args: (a.args ? `(${a.args})` : '').trim().slice(0, 120),
          line: a.line ?? m.nameLine,
          method: m.name,
        });
    // A CDI observer names its event on the parameter, and an MDB names its destination on the class.
    for (const p of m.params ?? [])
      for (const a of p.ann ?? [])
        if (OBSERVER.has(a.name))
          jobs.push({ kind: a.name, args: String(p.type ?? '').slice(0, 120), line: a.line ?? m.nameLine });
  }
  const mdb = annotationOn(t, ...MESSAGE_DRIVEN);
  if (mdb) {
    const dest =
      /propertyName\s*=\s*"destination(?:Lookup)?"\s*,\s*propertyValue\s*=\s*"([^"]+)"/.exec(mdb.args ?? '') ??
      /mappedName\s*=\s*"([^"]+)"/.exec(mdb.args ?? '');
    const on = (t.methods ?? []).find((m) => m.name === 'onMessage');
    jobs.push({ kind: 'MessageDriven', args: dest?.[1] ?? '', line: on?.nameLine ?? t.start });
  }
  return jobs.sort((a, b) => a.line - b.line);
}

const tableOf = (t) =>
  /name\s*=\s*"([^"]+)"/.exec(annotationOn(t, 'Table')?.args ?? '')?.[1];

/**
 * A model type in the shape the families read: identity (name, kind, annotations, supertypes, enum values), and its
 * members.
 */
function typeEntry(t) {
  return {
    p: t.file,
    name: t.name,
    kind: t.kind,
    classLine: t.start,
    annotations: (t.ann ?? []).map((a) => a.name),
    extends: (t.supers ?? []).filter((s) => s.kind !== 'interface').map((s) => s.text).join(','),
    implements: (t.supers ?? []).filter((s) => s.kind === 'interface').map((s) => s.text).join(','),
    constants: t.enumValues ?? [],
    scheduled: scheduledOf(t),
    views: [],
    table: tableOf(t),
    fields: (t.fields ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      typeFqn: f.typeFqn,
      ann: f.ann,
      line: f.line,
    })),
    methods: t.methods ?? [],
    type: t,
  };
}

// --- inventory and the model ------------------------------------------------------

/** A reader that loads each file once per scan: several families read the same config and frontend files. */
function memoizedReader() {
  const texts = new Map();
  return (file) => {
    if (!texts.has(file)) texts.set(file, fs.readFileSync(file, 'utf8'));
    return texts.get(file);
  };
}

/** The checkout's files, the Java files the dump reads, and the build files. */
function inventory(root) {
  const files = walk(root);
  const R = (p) => relPosix(root, p);
  const read = memoizedReader();
  const byExt = {};
  for (const f of files) {
    const e = path.extname(f).slice(1) || '(none)';
    byExt[e] = (byExt[e] ?? 0) + 1;
  }
  // The Java files, by path: the dump is the only reader of them; the scan itself never opens one.
  const javaAll = files.filter((f) => f.endsWith('.java') && !isTestCode(f)).map((p) => ({ p: R(p) }));
  // The build, read as data: modules, coordinates, properties, plugins (evidence/build.mjs).
  const buildFiles = readBuild(root, files.map(R));
  return { root, files, R, read, byExt, javaAll, buildFiles };
}

/**
 * The dump, the classpath and the model built from them: the one base every family queries. The binding rates are
 * written onto the model here, before any family reads it.
 */
function loadModel({ root, files, R, read, javaAll, buildFiles }) {
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
function exactTargetsOf({ answered, ambiguous, unanswered, sites }) {
  return !!answered && ambiguous === 0 && unanswered < sites * 0.02;
}

// --- types: entities, controllers, repositories, enums ------------------------------

/** The view names a controller returns: the string values its methods hand back, as the dump wrote them. */
// shortcut: switch arms that return a view are not read yet, a view named only there counts as dead; upgrade when one
// shows up.
function viewsReturnedBy(dump, t) {
  return (t.methods ?? [])
    .filter((m) => !hasAnnotation(m, 'ResponseBody'))
    .flatMap((m) =>
      (dump?.returnsOf(m.id) ?? [])
        .filter((r) => r.kind === 'return' && typeof r.value?.value === 'string' && /^\S+$/.test(r.value.value))
        .map((r) => ({ view: r.value.value, line: r.line })),
    );
}

/**
 * The app's types, as the families read them. Entries are built once and picked for the entity, controller and
 * repository passes here, before the wildcard-annotation pass, as the facts always were.
 */
function typeFacts({ model, dump, app }) {
  const appTypes = [...model.types.values()].filter((t) => !app.isExcluded(t.file) && !isTestCode(t.file));
  const appEntries = appTypes.map(typeEntry);
  const entities = appEntries.filter((e) => hasAnnotation(e.type, 'Entity'));
  // Controllers: Spring MVC, JAX-RS resources, and JSF backing beans (@Named with a UI scope).
  const isController = (t) =>
    annotationOn(t, ...listOf('controller-annotations')) !== null ||
    (annotationOn(t, ...listOf('named-annotations')) !== null && annotationOn(t, ...listOf('ui-scopes')) !== null);
  const controllers = appEntries
    .filter((e) => isController(e.type))
    // A REST or JAX-RS method's string is a response body, not a view name.
    .map((e) => ({
      ...e,
      views:
        hasAnnotation(e.type, 'RestController') || hasAnnotation(e.type, 'Path') ? [] : viewsReturnedBy(dump, e.type),
    }));
  const repos = appEntries.filter((e) =>
    (e.type.supers ?? []).some((s) => /\b(Jpa|Crud|PagingAndSorting)?Repository\s*</.test(s.text ?? '')),
  );
  // Status enums with values (lifecycles): the model's kinds and the enum constants the dump lists.
  const enums = appTypes
    .filter((t) => t.kind === 'enum' && /(Status|State|Type|Mode|Tier|Role|Source)$/.test(t.name ?? ''))
    .map((t) => ({ name: t.name, file: t.file, line: t.start, values: t.enumValues ?? [] }));
  return { appTypes, appEntries, entities, controllers, repos, enums };
}

/** Entities and repositories on the model, after the wildcard-annotation pass has named what a catalog resolves. */
function entityFactsOf({ model, selected, annIndex }) {
  resolveWildcardAnnotations(model, annIndex);
  return entityFacts(model, annIndex, typeIndex(selected));
}

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

// --- frontend: sources, API calls and routes ------------------------------------------

/** The frontend's source files with their text, and the server-rendered view files. */
function frontendFiles({ files, R, read }) {
  // A bundle, a minified file or a one-line source is built output, not what the team wrote.
  const built = (f) =>
    /\/static\/assets\/|-[\w]{8,}\.(js|css)$|\.min\.js$/.test(f) || read(f).split('\n').some((l) => l.length > 3000);
  const fe = files
    .filter(
      (f) =>
        /\.(tsx?|jsx?|vue|svelte)$/.test(f) &&
        !/\.(test|spec|d)\.[tj]sx?$/.test(f) &&
        !/vendor|slick|jquery|bootstrap/i.test(f) &&
        !built(f) &&
        // End-to-end test code: Cypress/Playwright helpers call *another* application's API, so a spec is not this
        // app's frontend — the same rule that keeps `src/test/` out of the Java model.
        !isE2e(R(f)),
    )
    .map((p) => ({ p: R(p), source: read(p) }));
  const views = files
    .filter(
      (f) =>
        ((/\.(jsp|jspf|html|ftl|mustache)$/.test(f) && /(WEB-INF|templates|views)\//.test(f)) ||
          (/\.xhtml$/.test(f) && /src\/main\/webapp\//.test(f))) &&
        !/templates\/(emails?|library)\//.test(f),
    )
    .map((p) => ({ p: R(p), text: read(p) }));
  return { fe, views };
}

/** The `/api` calls the frontend makes, each with the verb of the request options written next to it, if any. */
function frontendApiCalls(fe) {
  return fe.flatMap((f) =>
    f.source.split('\n').flatMap((l, i) => {
      const m = /["'`](\/api\/[^"'`\s]*)["'`]/.exec(l);
      if (!m) return [];
      const around = f.source
        .split('\n')
        .slice(Math.max(0, i - 3), i + 4)
        .join(' ');
      const vm = /method:\s*["'](GET|POST|PUT|DELETE|PATCH)["']/i.exec(around);
      return [{ path: normalizePath(m[1]), verb: vm?.[1]?.toUpperCase(), file: f.p, line: i + 1 }];
    }),
  );
}

/**
 * Each frontend call joined to the endpoint it reaches: the same path (placeholders match any segment), then the verb.
 */
function joinApiCalls(calls, endpoints) {
  const epByPath = new Map();
  for (const e of endpoints) {
    if (!epByPath.has(e.path)) epByPath.set(e.path, []);
    epByPath.get(e.path).push(e);
  }
  const segMatch = (ep, call) => {
    const a = ep.split('/'),
      b = call.split('/');
    return a.length === b.length && a.every((s, i) => s === '{}' || b[i] === '{}' || s === b[i]);
  };
  return calls.map((c) => {
    const cands = epByPath.get(c.path) ?? endpoints.filter((e) => segMatch(e.path, c.path));
    const hit = cands.find((e) => !c.verb || e.verb === c.verb || e.verb === 'ANY') ?? cands[0];
    return { ...c, handler: hit ? `${hit.file}:${hit.line}` : null };
  });
}

/**
 * Frontend routes: each `<Route path>` line, or each Angular route-array `path:` line, in the files that declare them.
 */
function frontendRoutes(fe) {
  return fe.flatMap((f) => {
    const ng = isAngularRoutes(f.source);
    return f.source.split('\n').flatMap((l, i) => {
      const p = routePath(l, ng);
      return p == null ? [] : [{ path: p, file: f.p, line: i + 1 }];
    });
  });
}

/** Which views the controllers return, and which view files nothing returns or includes. */
function viewFacts(controllers, views) {
  const viewUse = {};
  for (const c of controllers)
    for (const v of c.views)
      if (!/^(redirect|forward):/.test(v.view)) (viewUse[v.view] ??= []).push(`${c.p}:${v.line}`);
  const viewNames = views.map((v) => ({ file: v.p, name: path.basename(v.p).replace(/\.\w+$/, '') }));
  const included = new Set(
    views.flatMap((v) =>
      [...v.text.matchAll(/(?:include\s+file|page)\s*=\s*"([^"]+)"/g)].map((m) =>
        path.basename(m[1]).replace(/\.\w+$/, ''),
      ),
    ),
  );
  const deadViews = viewNames
    .filter(
      (v) =>
        !Object.keys(viewUse).some((k) => k === v.name || k.endsWith('/' + v.name)) && !included.has(v.name),
    )
    .map((v) => v.file);
  return { viewUse, deadViews };
}

// --- security, tenancy and user sources -------------------------------------------------

/**
 * The rules the security configs state: Spring chains, sureness.yml, Shiro, the code's own calls and web.xml. One rule
 * per chain prefix and access, however many copies of a config repeat it.
 */
function securityRulesOf(model, files, R, read) {
  const resourceFiles = files
    .filter((f) => /\.(?:ya?ml|properties)$/.test(f) && /sureness|application|security/i.test(f))
    .map((f) => ({ p: R(f), text: read(f) }));
  const ruleSeen = new Set();
  return [
    ...springChains(model),
    ...resourceFiles
      .filter((r) => /sureness\.ya?ml$/i.test(r.p) && !isTestCode(r.p))
      .flatMap((r) => surenessRules(r.text, r.p)),
    ...files
      .filter((f) => /shiro\.(ini|properties)$/i.test(f) && !isTestCode(f))
      .flatMap((f) => shiroRules(read(f), R(f))),
    ...shiroCodeRules(model),
    ...files
      .filter((f) => /web\.xml$/.test(f) && !isTestCode(f))
      .flatMap((f) => webXmlRules(read(f), R(f))),
  ].filter((r) => !ruleSeen.has(r.id) && ruleSeen.add(r.id));
}

/** Security as facts: the rules, the method-level security index, and the warnings the rules expose. */
function securityOf({ model, files, R, read, annIndex }, endpoints) {
  const methodSec = methodSecurityFacts(model, (fqn, on) => meanOf(annIndex, fqn, on)?.means ?? null);
  const securityRules = securityRulesOf(model, files, R, read);
  // Two warning kinds in one family: an anonymous prefix that exposes writes, and an identity the client asserts
  // (a filter takes a header/cookie value as the caller with no verification call between).
  const securityWarnings = [
    ...anonymousWrites(securityRules, endpoints, methodSec.index),
    ...identityWarnings(model, isTestCode),
  ];
  return { methodSec, securityRules, securityWarnings };
}

/**
 * Where the user comes from, from what the code configures: the security chain's own calls (httpBasic(),
 * oauth2ResourceServer().jwt(), formLogin(), sessionManagement()) and filters that authenticate from a header by
 * setting the security context. Structural, not text matching; the citation is the call's own line.
 */
function userSourcesOf(model, selected) {
  const userSources = [];
  const addUser = (kind, cite, why) => {
    if (cite && !userSources.some((u) => u.kind === kind)) userSources.push({ kind, cites: [cite], why });
  };
  const citeOf = (t, c) => `${t.file}:${c.line}`;
  for (const t of model.types.values())
    for (const m of t.methods ?? []) {
      const calls = m.calls ?? [];
      for (const c of calls) {
        if (c.name === 'httpBasic') addUser('basic auth', citeOf(t, c), `${t.name} configures httpBasic()`);
        if (c.name === 'oauth2ResourceServer' || c.name === 'jwt')
          addUser('JWT bearer token', citeOf(t, c), `${t.name} configures ${c.name}()`);
        if (c.name === 'formLogin') addUser('HTTP session', citeOf(t, c), `${t.name} configures formLogin()`);
        if (c.name === 'setAttribute' && calls.some((x) => x.name === 'getSession'))
          addUser('HTTP session', citeOf(t, c), `${t.name}#${m.name} stores the caller in the HttpSession`);
        // `sessionCreationPolicy(STATELESS)` names the policy in its argument: a stateless app has no session.
        if (c.name === 'sessionManagement' && !calls.some((x) => /STATELESS|NEVER/.test((x.args ?? []).join(' '))))
          addUser('HTTP session', citeOf(t, c), `${t.name} configures a stateful sessionManagement()`);
        if (
          /^(setAuthentication|setContext)$/.test(c.name ?? '') &&
          (/Filter$/.test(t.name) || calls.some((x) => ['getHeader', 'getCookies'].includes(x.name)))
        )
          addUser('API token', citeOf(t, c), `${t.name}#${m.name} sets the authentication from the request`);
        // A filter that reads the Authorization header and stores the caller (attribute, ThreadLocal, SecurityContext).
        if (
          /Filter$/.test(t.name) &&
          calls.some((x) => x.name === 'getHeader') &&
          calls.some((x) => ['setAttribute', 'set', 'setAuthentication'].includes(x.name)) &&
          // The header the filter reads names the token: the dump folded the argument, no source text is read.
          calls.some((x) => (x.args ?? []).some((a) => /Authorization|Bearer|token/i.test(a)))
        )
          addUser('API token', citeOf(t, c), `${t.name}#${m.name} reads the token header and stores the caller`);
      }
    }
  // Sureness declares its authentication types as processors; the catalog names them.
  const types = [...model.types.values()];
  for (const { catalog } of selected)
    for (const t of catalog.types ?? []) {
      if (t.means !== 'auth-type') continue;
      const holder = types.find(
        (x) => (x.supers ?? []).some((sp) => (sp.fqn ?? '').split('<')[0] === t.fqn) || x.fqn === t.fqn,
      );
      if (holder)
        addUser(
          t.authType,
          `${holder.file}:${holder.nameLine}`,
          `${holder.name} is a Sureness ${t.authType} processor`,
        );
    }
  for (const a of authSources(model, isTestCode))
    if (!userSources.some((u) => u.kind === a.kind))
      userSources.push({ kind: a.kind, cites: a.evidence, why: a.why?.[0] });
  return userSources;
}

/**
 * The tenant key and the paths that run without a request. Callers that are no-request code (jobs, listeners, async
 * methods, worker loops, webhooks) are named as entry methods; the key is also reported at 10%, 20% and 30% shares.
 */
function tenancyOf(model, { endpoints, flowEntryList, entFacts, tenantFacts }) {
  // Callers that are no-request code: jobs, listeners, async methods and worker loops.
  const entryMethods = [
    ...flowEntryList.filter((e) => e.kind === 'worker').map((e) => `${e.t.fqn}#${e.m.name}`),
    ...[...model.types.values()].flatMap((t) =>
      (t.methods ?? [])
        .filter((m) =>
          (m.ann ?? []).some((a) =>
            /(Scheduled|Schedule|JmsListener|KafkaListener|RabbitListener|EventListener|Async)$/.test(a.name ?? ''),
          ),
        )
        .map((m) => `${t.fqn}#${m.name}`),
    ),
  ];
  // Webhook endpoints are request handlers, but nothing behind them has a logged-in tenant: reads they alone call are
  // judged like jobs (cross-tenant by design), not as unscoped request reads.
  // The id names the method that runs, which for an inherited endpoint is the declaring class's method.
  const methodIdOf = (e) => `${e.declaredIn ?? e.handlerFqn}#${String(e.handler).split('.').pop()}`;
  const webhookIds = endpoints.filter((e) => /webhook|callback|\bhooks?\b/i.test(e.path ?? '')).map(methodIdOf);
  const requestMethods = endpoints.map(methodIdOf).filter((id) => !webhookIds.includes(id));
  entryMethods.push(...webhookIds);
  const tenancy = tenancyFacts(entFacts, { tenantSources: tenantFacts, model, entryMethods, requestMethods });
  // The tenant key at 10%, 20% and 30% shares is reported side by side, and the owner decides.
  const tenancyThresholds = [0.1, 0.2, 0.3].map((share) => ({
    share,
    key: tenancyFacts(entFacts, { tenantSources: tenantFacts, model, minShare: share }).key,
  }));
  const withoutRequest = noRequestPaths({
    model,
    tenancy,
    repos: entFacts.repos,
    // Worker entries only matter when there is a key to reach; skipping the build keeps large keyless apps fast.
    extra: tenancy.key
      ? flowEntryList.filter((e) => e.kind === 'worker').map((e) => ({ kind: 'worker', t: e.t, m: e.m }))
      : [],
  });
  return { tenancy, tenancyThresholds, withoutRequest };
}

/** The security model: rules, endpoints, method security, tenancy and user sources, with the base controllers. */
function securityModelOf(model, { endpoints, sec, tenancy, userSources }) {
  const baseControllers = new Set(
    [...model.implsOf.keys()].filter((fqn) => {
      const t = model.types.get(fqn);
      return t?.methods?.length && /Controller$/.test(t.name ?? '');
    }),
  );
  return buildSecurityModel({
    rules: sec.securityRules,
    endpoints,
    methodSecurity: sec.methodSec.facts,
    tenancy,
    userSources,
    baseControllers,
  });
}

// --- runtime, background and boot-adjacent families ----------------------------------------

/** Runtime machinery, from the model: an annotation, a supertype, a call or a field's type, never a line of source. */
function runtimeMachinery(appTypes, views) {
  const interceptors = modelEntries(appTypes, {
    types: {
      ann: [/^(WebFilter|Interceptor)$/],
      supers: /(ContainerRequestFilter|ContainerResponseFilter|OncePerRequestFilter|HandlerInterceptor|Filter)$/,
    },
    methods: {
      ann: [/^AroundInvoke$/],
      returns: /FilterRegistrationBean/,
      calls: /^(addInterceptor|addPathPatterns|excludePathPatterns)$/,
    },
  });
  const contextScopes = modelEntries(appTypes, {
    types: { ann: [/^(RequestScoped|SessionScoped|ConversationScoped|ViewScoped|Scope|ControllerAdvice)$/] },
    methods: { ann: [/^Scope$/] },
    // A static ThreadLocal is the request- or caller-scoped slot the app keeps its context in.
    fields: { type: /ThreadLocal/ },
  });
  const exceptionHandlers = [
    ...new Set(
      appTypes
        .filter(
          (t) =>
            (t.supers ?? []).some((s) => /ExceptionMapper$/.test(s.fqn ?? s.text ?? '')) ||
            (t.methods ?? []).some((m) => (m.ann ?? []).some((a) => a.name === 'ExceptionHandler')),
        )
        .map((t) => t.file),
    ),
  ];
  const baseClasses = Object.entries(
    appTypes.reduce((acc, t) => {
      const b = String((t.supers ?? []).find((s) => s.kind !== 'interface')?.text ?? '').replace(/<.*/, '');
      if (b && !/Repository$|Exception$|^Object$/.test(b)) acc[b] = (acc[b] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .filter(([, n]) => n >= 3)
    .map(([b, n]) => ({ base: b, subclasses: n }));
  // Session state: an attribute written or read on the HTTP session, and the @SessionAttributes declaration. A view
  // that reads `sessionScope.x` is not Java, and stays a view-file fact, not a runtime one.
  const sessionState = modelEntries(appTypes, {
    types: { ann: [/^SessionAttributes$/] },
    methods: { calls: /^(setAttribute|getAttribute)$/, recv: /HttpSession$/ },
  })
    .concat(
      views.flatMap((v) =>
        linesMatching(v.text, /sessionScope\.|session\.getAttribute/).map((m) => ({ file: v.p, ...m })),
      ),
    )
    .slice(0, 80);
  return { interceptors, contextScopes, exceptionHandlers, baseClasses, sessionState };
}

/** Jakarta Batch: jobs are XML files under META-INF/batch-jobs; JobOperator.start("name") starts them. */
function batchJobsOf(appTypes, files, R, read) {
  return files
    .filter((f) => /META-INF\/batch-jobs\/[\w.-]+\.xml$/.test(f))
    .map((f) => {
      const xml = read(f);
      const id = /<job\b[^>]*\bid="([^"]+)"/.exec(xml)?.[1] ?? path.basename(f, '.xml');
      // `JobOperator.start("name")`: the dump's call row, with the job id as its folded argument.
      const starts = appTypes.flatMap((t) =>
        (t.methods ?? [])
          .flatMap((m) => (m.calls ?? []).filter((c) => c.name === 'start' && (c.args ?? []).includes(`"${id}"`)))
          .map((c) => `${t.file}:${c.line}`),
      );
      const steps = [...xml.matchAll(/<(batchlet|reader|processor|writer)\b[^>]*\bref="([^"]+)"/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      );
      return {
        kind: 'Batch job',
        args: `${id}: ${steps.join(', ')}${starts.length ? `; started at ${starts.join(', ')}` : ''}`,
        file: R(f),
        line: 1,
      };
    });
}

/** Work that runs without a request, the sockets the app opens and the runners it starts with. */
function backgroundOf({ files, R, read }, { appTypes, appEntries }, endpoints) {
  const background = appEntries.flatMap((e) => e.scheduled.map((s) => ({ ...s, file: e.p, cls: e.name })));
  const sockets = endpoints
    .filter((e) => e.verb === 'STOMP')
    .map((e) => ({ file: e.file, line: e.line, path: e.path }))
    .concat(modelEntries(appTypes, { methods: { calls: /^(registerStompEndpoints|enableSimpleBroker)$/ } }));
  const runners = appTypes
    .filter(
      (t) =>
        (t.supers ?? []).some((s) => /(CommandLineRunner|ApplicationRunner)/.test(s.text ?? '')) ||
        hasAnnotation(t, 'Startup'),
    )
    .map((t) => ({ file: t.file, line: t.start }));
  return {
    scheduledAsyncListeners: [...background, ...batchJobsOf(appTypes, files, R, read)],
    sockets,
    runners,
  };
}

/** Profile and conditional switches: the annotations that choose a bean or profile, and the profile lines in config. */
function switchesOf(appTypes, configFiles, R, read) {
  const switches = new RegExp(`^(${[...listOf('switch-annotations')].join('|')})$`);
  return modelEntries(appTypes, {
    types: { ann: [switches] },
    methods: { ann: [switches] },
  }).concat(
    configFiles.flatMap((f) =>
      linesMatching(read(f), /profiles?\.active|on-profile/).map((m) => ({ file: R(f), ...m })),
    ),
  );
}

/** The SDKs the app imports, each with the first six files that import it. The config keys are read elsewhere. */
function externalsOf(java, sources) {
  const importsOf = (relPath) => (sources.get(relPath)?.imports ?? []).map((i) => i.name);
  const externals = {};
  for (const j of java)
    for (const [k, v] of Object.entries(mapOf('sdk-vendors')))
      if (importsOf(j.p).some((name) => name.includes(k))) (externals[v] ??= []).push(j.p);
  return Object.fromEntries(Object.entries(externals).map(([k, v]) => [k, [...new Set(v)].slice(0, 6)]));
}

// --- docs, git and activity ---------------------------------------------------------

/** The docs in the repo: their size in KB and their first heading. */
function docsOf(files, R, read) {
  return files
    .filter((f) => /\.(md|adoc|rst)$/i.test(f))
    .map((f) => {
      const t = read(f);
      return {
        file: R(f),
        kb: Math.round(t.length / 102.4) / 10,
        title: (/^#\s+(.+)$/m.exec(t)?.[1] ?? '').slice(0, 90),
      };
    });
}

/** The checkout's git state: HEAD, whether it has uncommitted changes, and the history window activity counts use. */
function gitInfoOf(root) {
  const head = git(root, ['rev-parse', '--short', 'HEAD']).out;
  if (!head) return null;
  const dirty = !!git(root, ['status', '--porcelain', '--untracked-files=no']).out;
  const headDate = git(root, ['log', '-1', '--format=%cI']).out;
  const total = Number(git(root, ['rev-list', '--count', 'HEAD']).out);
  return { head, dirty, headDate, totalCommits: total, window: gitWindow(root, headDate, total) };
}

/**
 * Commits in the window that touched each flow entry's file, counted per file on demand. The entries are read in
 * chunks of 25 so the largest name-status page stays small; the shared log is dropped between chunks. An inherited
 * entry runs the declaring class's code, so that is the file whose churn matters.
 */
function activityCounts(root, gitInfo, flowEntryList) {
  const win = gitInfo?.window;
  if (!win) return () => 0;
  const paths = [...new Set(flowEntryList.map((e) => (e.owner ?? e.t).file))];
  const counts = new Map();
  for (let i = 0; i < paths.length; i += 25) {
    for (const [p, n] of activityByFile(root, win.since, paths.slice(i, i + 25)))
      counts.set(p, (counts.get(p) ?? 0) + n);
    forgetActivity();
  }
  return (file) => counts.get(file) ?? 0;
}

// --- persistence and state -----------------------------------------------------------

/** Outside clients, repository writes and cache state, then the transaction boundary those can leak through. */
function persistenceFacts({ model, selected }) {
  const outsideCalls = extractOutside(model, selected);
  const stateFacts = extractState(model, selected);
  const stateWrites = stateFacts.filter((f) => f.family === 'state-write');
  const tx = extractTransactions(model, selected, { outside: outsideCalls, writes: stateWrites });
  return { outsideCalls, stateFacts, stateWrites, transactions: tx.facts, transactionCounts: tx.counts };
}

// --- family groups: each returns the sections the facts document reads ----------------------

/** The frontend: sources, the API calls joined to the endpoints they reach, routes, and the view facts. */
function webFacts(ctx, types, endpoints) {
  const { fe, views } = frontendFiles(ctx);
  const joined = joinApiCalls(frontendApiCalls(fe), endpoints);
  const viewOut = viewFacts(types.controllers, views);
  return { fe, views, joined, viewOut, routes: frontendRoutes(fe) };
}

/** The tenant key, the user sources and the security model built from them. */
function tenancyAndSecurity(model, selected, { endpoints, sec, flowEntryList, tenantFacts, entFacts }) {
  const ten = tenancyOf(model, { endpoints, flowEntryList, entFacts, tenantFacts });
  const userSources = userSourcesOf(model, selected);
  const securityModelFact = securityModelOf(model, { endpoints, sec, tenancy: ten.tenancy, userSources });
  return { ten, securityModelFact };
}

/** The runtime machinery the model shows, and the work that runs without a request. */
function runtimeAndBackground(ctx, types, endpoints, views) {
  return {
    runtime: runtimeMachinery(types.appTypes, views),
    background: backgroundOf(ctx, types, endpoints),
  };
}

/** Lifecycles, schedules and status sets from the dump, and the writes the repositories with @Modifying make. */
function javaFactsOf(ctx, types, entFacts, endpoints) {
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

/** How the app runs: the build's run facts, the entry points and the profile switches. */
function bootOf(ctx, types, configFiles) {
  const { root, model, files, R, read, app } = ctx;
  return {
    computed: bootFacts({ root, files, rel: R, git, app, read }),
    ...bootEntries({ model, files, rel: R, read, configFiles }),
    switches: switchesOf(types.appTypes, configFiles, R, read),
  };
}

/** The SDK imports and the config keys (keys only, never values). */
function externalsFacts(ctx, configFiles) {
  return {
    sdkImports: externalsOf(ctx.java, ctx.sources),
    config: configKeyFacts(configFiles, ctx.R, ctx.read),
  };
}

/** The flows, ranked with the git activity of their entry files; the activity is dropped once they are ranked. */
function flowsOf({ model, selected, callStats }, { flowEntryList, persist, deep, entFacts, activityOf, sec, joined }) {
  const flows = buildFlows(model, {
    entries: flowEntryList,
    exactTargets: exactTargetsOf(callStats),
    stateWrites: persist.stateWrites,
    statusSets: deep.statusSets,
    outsideCalls: persist.outsideCalls,
    transactions: persist.transactions,
    entities: entFacts.entities,
    activityOf,
    selected,
    securityRules: sec.securityRules,
    frontendPaths: joined.filter((j) => j.path).map((j) => ({ path: j.path, file: j.file })),
  });
  // The flow rank needs git activity for entry files only; the history text is not needed after it.
  forgetActivity();
  return flows;
}

// --- facts assembly ----------------------------------------------------------------------

/** The one line the CLI prints after a scan: what was found, and where the time went. */
function summaryLine(f, out) {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const since = f.git?.window?.since ?? 'none';
  const gitText = f.git ? `${f.git.head}${f.git.dirty ? '+dirty' : ''} window=${since}` : 'none';
  const timings = Object.entries(f.timings)
    .map(([k, v]) => `${k} ${seconds(v)}`)
    .join(' ');
  const listeners = f.background.scheduledAsyncListeners.length;
  return (
    `wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB): ${f.entities.count} entities, ` +
    `${f.endpoints.length} endpoints, ${f.frontend.apiCalls} frontend API calls ` +
    `(${f.frontend.unmatchedApiCalls.length} unmatched), ${f.views.count} views, ` +
    `${listeners} scheduled/async/listeners, ${f.schedules.length} scheduled job(s), ` +
    `${f.securityRules.length} security rule(s), ${f.securityWarnings.length} security warning(s), ` +
    `${f.docs.length} docs, git ${gitText} · ${timings}`
  );
}

/**
 * The facts document. Its sections keep their order: the digest and the writer read the file by these names. `F` holds
 * the family results scan() built; `ctx` holds the inventory and the model.
 */
function assembleFacts(ctx, started, F) {
  const { root, R, files, byExt, java, buildFiles, classpath, dump, dumpRun, callStats, dumpMs, classpathMs } = ctx;
  const { types, persist, sec, ten, entFacts, web, boot, deep, runtime, background, externals } = F;
  const { joined, fe, views, viewOut, routes } = web;
  return {
    version: 2,
    root,
    scannedAt: new Date().toISOString().slice(0, 10),
    // Where the run went (B.7): millisecond stages, so a slow scan says which stage to look at. `digest` is filled by
    // the CLI, which is the only caller that renders it.
    timings: { dump: dumpMs, classpath: classpathMs, extract: Date.now() - started - dumpMs - classpathMs },
    inventory: { byExt, topDirs: [...new Set(files.map((f) => R(f).split('/').slice(0, 2).join('/')))].slice(0, 60) },
    build: buildFiles,
    // What the run could read of the project's dependencies, and what it could not: the digest says it in one line.
    classpath: {
      mode: classpath.mode,
      jars: classpath.jars.length,
      generatedSources: classpath.generatedSources.length,
      failedModules: classpath.failedModules.map((f) => ({ module: f.module, reason: tildify(f.reason) })),
      // `tool` and `reason` are omitted rather than null: the schema has no null-able fields.
      ...(classpath.tool ? { tool: classpath.tool } : {}),
      ms: classpath.ms,
      ...(classpath.reason ? { reason: tildify(classpath.reason) } : {}),
    },
    git: F.gitInfo,
    docs: F.docs,
    packages: Object.entries(
      java.reduce((a, j) => {
        const d = path.dirname(j.p);
        a[d] = (a[d] ?? 0) + 1;
        return a;
      }, {}),
    )
      .map(([dir, n]) => ({ dir, javaFiles: n }))
      .sort((a, b) => a.dir.localeCompare(b.dir)),
    entities: {
      count: entFacts.entities.length,
      enums: types.enums,
      repositories: types.repos.map((r) => ({ file: r.p, extends: r.extends })),
      model: entFacts.entities.map((e) => ({
        name: e.name,
        file: e.file,
        line: e.line,
        table: e.table,
        relations: e.relations,
        keys: e.keyFields.slice(0, 12),
        unique: e.uniqueFields,
        // Own fields only, for the invariant that a field's line sits inside its type (inherited lines live elsewhere).
        ownKeys: e.fields.filter((f) => f.owner === e.name && !f.relation).map((f) => `${f.name}:${f.type}:${f.line}`),
        ownRelations: e.fields
          .filter((f) => f.owner === e.name && f.relation)
          .map((f) => `${f.relation.kind} ${f.relation.target?.split('.').pop() ?? f.type} ${f.name}:${f.line}`),
      })),
    },
    tenancy: {
      key: ten.tenancy.key,
      confidence: ten.tenancy.confidence,
      counts: ten.tenancy.counts,
      candidates: ten.tenancy.candidates.slice(0, 6),
      coverage: ten.tenancy.coverage,
      unscoped: ten.tenancy.unscoped,
      unscopedWrites: ten.tenancy.unscopedWrites,
      globalLookups: ten.tenancy.globalLookups,
      crossTenant: ten.tenancy.crossTenant,
      unscopedByRepo: ten.tenancy.unscopedByRepo,
      bridged: ten.tenancy.bridged,
      bases: ten.tenancy.bases,
      thresholds: ten.tenancyThresholds,
      sources: ten.tenancy.sources,
    },
    noRequestPaths: ten.withoutRequest,
    endpoints: F.endpoints,
    coverage: F.cov,
    frontend: {
      files: fe.length,
      routes,
      apiCalls: joined.length,
      unmatchedApiCalls: joined.filter((j) => !j.handler).map((j) => `${j.verb ?? ''} ${j.path} ${j.file}:${j.line}`),
      apiJoin: joined
        .filter((j) => j.handler)
        .map((j) => `${j.verb ?? ''} ${j.path} ${j.file}:${j.line} -> ${j.handler}`),
    },
    views: { count: views.length, returnedBy: viewOut.viewUse, deadViews: viewOut.deadViews },
    runtime: {
      // Whether Spoon answered this run, and how much of it: a scan without a dump is a scan without types.
      engine: dump
        ? {
            spoon: true,
            answered: callStats.answered,
            targets: callStats.targets,
            droppedTargets: callStats.droppedTargets,
            unanswered: callStats.unanswered,
            droppedSamples: callStats.droppedSamples?.slice(0, 8),
            // What the engine could not answer and why; dotted keys only, the rest of counts are sizes.
            failures: Object.fromEntries(Object.entries(dump.meta?.counts ?? {}).filter(([k]) => k.includes('.'))),
            dump: dumpRun.dir,
          }
        : { spoon: false, reason: dumpRun.reason },
      ...runtime,
    },
    methodSecurity: sec.methodSec.facts,
    securityModel: F.securityModelFact,
    channels: F.channels,
    background,
    state: { modifying: F.modifying },
    boot: {
      computed: boot.computed,
      mains: boot.mains,
      switches: boot.switches,
      profiles: boot.profiles,
      frontend: boot.frontend,
      compose: boot.compose,
      scripts: boot.scripts,
    },
    transactions: persist.transactions,
    transactionCounts: persist.transactionCounts,
    outsideCalls: persist.outsideCalls,
    stateWrites: persist.stateWrites,
    stateCaches: persist.stateFacts.filter((f) => f.family === 'state-cache'),
    lifecycle: deep.lifecycle,
    schedules: deep.schedules,
    recurring: F.recurring,
    securityRules: sec.securityRules,
    securityWarnings: sec.securityWarnings,
    tenantSources: F.tenantFacts,
    ...(F.tenantFacts.length
      ? {}
      : {
          tenantSourcesNote:
            'no tenant source found within depth 2 ' +
            '(no ThreadLocal/request-attribute store reached from doFilter/preHandle)',
        }),
    flows: F.flows,
    externals,
  };
}

export function scan(root, { withModel = false, extraConstants = new Map() } = {}) {
  const started = Date.now();
  const inv = inventory(root);
  const ctx = { ...inv, ...loadModel(inv) };
  const { model, selected, app, files, R, read } = ctx;
  const types = typeFacts(ctx);
  const endpoints = extractEndpoints(model, selected, { include: (p) => !app.isExcluded(p) });
  const web = webFacts(ctx, types, endpoints);
  const persist = persistenceFacts(ctx);
  const recurring = extractSchedules(model, selected);
  const configFiles = configFilesOf(files, root);
  const sec = securityOf(ctx, endpoints);
  const tenantFacts = tenantSources(model, isTestCode);
  // Flow entries serve tenancy (worker callers) and the flows: computed once, before the wildcard-annotation pass.
  const flowEntryList = flowEntries(model, endpoints, selected);
  const entFacts = entityFactsOf(ctx);
  const { ten, securityModelFact } = tenancyAndSecurity(model, selected, {
    endpoints,
    sec,
    flowEntryList,
    tenantFacts,
    entFacts,
  });
  const { runtime, background } = runtimeAndBackground(ctx, types, endpoints, web.views);
  const externals = externalsFacts(ctx, configFiles);
  const { deep, modifying } = javaFactsOf(ctx, types, entFacts, endpoints);
  const boot = bootOf(ctx, types, configFiles);
  const gitInfo = gitInfoOf(root);
  const activityOf = activityCounts(root, gitInfo, flowEntryList);
  const flows = flowsOf(ctx, { flowEntryList, persist, deep, entFacts, activityOf, sec, joined: web.joined });
  const channels = channelFacts(model, { config: channelConfigOf(files, read), extraConstants });
  const cov = coverage(model, endpoints, selected, { build: ctx.buildFiles, rels: files.map(R) });
  const facts = assembleFacts(ctx, started, {
    types,
    endpoints,
    persist,
    recurring,
    sec,
    web,
    ten,
    securityModelFact,
    runtime,
    background,
    externals,
    deep,
    modifying,
    boot,
    gitInfo,
    docs: docsOf(files, R, read),
    flows,
    channels,
    cov,
    entFacts,
    tenantFacts,
  });
  // Tests that check resolution against hand-verified calls need the model; facts alone cannot show a receiver type.
  if (withModel) Object.defineProperty(facts, 'model', { value: model, enumerable: false });
  // The lifecycle set sites: the same rows the flows rank reads, kept for the excerpt file (the writer's flow steps and
  // setter context). Not part of facts.json — the digest already carries the sentence form of every one.
  Object.defineProperty(facts, 'statusSets', { value: deep.statusSets, enumerable: false });
  return facts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  retuneHeap();
  const root = path.resolve(process.argv[2] ?? '.');
  const out = path.resolve(process.argv[3] ?? path.join(root, 'mindmodel', '.work', 'facts.json'));
  // The model is kept for the excerpt file only: it is not part of facts.json (non-enumerable), and it is the one place
  // that knows where each method's body begins and ends.
  const facts = scan(root, { withModel: true });
  // Right before the writer: create the scratch folder (self-ignoring) and move any previous map out of its path.
  ensureWork(root);
  const retired = retirePreviousMap(root);
  const digestStart = Date.now();
  const digest = summarize(facts);
  facts.timings.digest = Date.now() - digestStart;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(facts, null, 1));
  fs.writeFileSync(out.replace(/\.json$/, '.md'), digest);
  console.log(summaryLine(facts, out));
  if (retired) console.log(`previous map kept at ${retired}`);
}
