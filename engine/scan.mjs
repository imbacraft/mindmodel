#!/usr/bin/env node
// Collects the mechanical facts so the writer reads code only to judge, not to search.
// Usage: node scan.mjs <projectRoot> [outFile]   (default out: <root>/mindmodel/.work/facts.json)
// Never copies config values (only keys) so secrets cannot leak into facts or the map.
import fs from 'node:fs';
import { retuneHeap } from './heap.mjs';
import path from 'node:path';
import { javaFacts } from './extract/lifecycle.mjs';
import { bootFacts, deployables } from './extract/boot.mjs';
import { activityByFile, forgetActivity, git, gitWindow } from './activity.mjs';
import { bindingRates } from './model/calls.mjs';
import { buildModelFromDump } from './model/from-dump-model.mjs';
import { dumpFor } from './run.mjs';
import { resolve as resolveClasspath, tildify } from './classpath.mjs';
import { open as openDump } from './dump.mjs';
import { isSrcTestOrItPath, isSrcTestPath } from './model/names.mjs';
import { annotationFqns, annotationIndex, loadCatalogs, meanOf, selectCatalogs, typeIndex } from './catalogs/catalog.mjs';
import { extractEndpoints } from './extract/endpoints.mjs';
import { buildFlows, flowEntries } from './extract/flows.mjs';
import { channelFacts } from './extract/channels.mjs';
import { extractSchedules } from './extract/schedules.mjs';
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
import { coordinatesOf, readBuild } from './evidence/build.mjs';
import { budgetLine, summarize } from './digest/facts-md.mjs';

// The digest moved to digest/facts-md.mjs; the names stay importable from here.
export { budgetLine, summarize };

// The shipped catalogs are read once per process; a project catalog is merged here when it lands.
const CATALOGS = loadCatalogs();

const IGNORE = new Set([
  '.git',
  'node_modules',
  'target',
  'build',
  'bin',
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.vscode',
  '.settings',
  '.ua',
  'mindmodel',
  'uploads',
  'coverage',
  '.next',
  'android',
  'ios',
  '.mvn',
  'vendor',
  '.claude',
  '.cursor',
  '.agent',
]);
// Compiled and binary files are never read, so don't even list them (wherever a build tool put them).
const SKIP_EXT =
  /\.(class|jar|war|ear|so|dll|dylib|exe|o|pyc|png|jpe?g|gif|webp|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|mov|avi|zip|gz|tgz|rar|7z|pdf|psd|map)$/i;
const lc = (s) => s[0].toLowerCase() + s.slice(1);
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && !['.github'].includes(e.name) && e.isDirectory()) continue;
    if (IGNORE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (!SKIP_EXT.test(e.name)) out.push(p);
  }
  return out;
}

// --- Java -------------------------------------------------------------------
// The type-level annotations the scanner reports, in the order the facts list them.
const TYPE_ANNOTATIONS = [
  'Entity',
  'Table',
  'RestController',
  'Controller',
  'Service',
  'Component',
  'Configuration',
  'Repository',
  'ControllerAdvice',
  'EnableWebSecurity',
  'EnableMethodSecurity',
  'Embeddable',
  'MappedSuperclass',
  // Jakarta EE: REST resources, EJBs, message-driven beans and CDI beans
  'Path',
  'ApplicationPath',
  'Stateless',
  'Stateful',
  'Singleton',
  'MessageDriven',
  'Named',
  'ViewScoped',
  'RequestScoped',
  'SessionScoped',
  'ConversationScoped',
  'Startup',
];
// Work that runs without a request: schedules, async, listeners and CDI observers.
const JOB = new RegExp(
  `^(${[
    'Scheduled',
    'Async',
    'EventListener',
    'TransactionalEventListener',
    'KafkaListener',
    'RabbitListener',
    'JmsListener',
    'SqsListener',
    'Schedule',
    'Asynchronous',
    'Timeout',
    'ObservesAsync',
    'Observes',
  ].join('|')})$`,
);

// The event a CDI observer takes; @Initialized(ApplicationScoped.class) means it runs at startup.
const observerType = (param) =>
  param.ann.some((a) => a.name === 'Initialized' && /ApplicationScoped/.test(a.args))
    ? 'application start'
    : param.type;

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

// --- end-to-end test code -------------------------------------------------------
// A Cypress/Playwright spec runs in a browser against a *running* application, so the calls it makes belong to
// whoever wrote the test, not to this app's frontend: in one run 31 of 48 "unmatched frontend API calls" were helpers in
// `cypress/cypress/integration/utils/`. The rule mirrors the Java scan's `src/test/` exclusion: a test folder — or the
// Cypress `*.cy.*` naming — says the file is a test, wherever it sits.
const E2E_DIRS = new Set([
  'cypress',
  'e2e',
  'e2e-tests',
  'playwright',
  'playwright-tests',
  'playwright-e2e',
  '__e2e__',
  '__tests__',
  'test',
  'tests',
]);
export const isE2ePath = (p) => {
  const rel = p ?? '';
  if (/\.cy\.[cm]?[jt]sx?$/i.test(rel)) return true;
  // The folder, not the file: `src/App.tsx` is the app, `cypress/e2e/App.tsx` is a test.
  return rel.split('/').slice(0, -1).some((s) => E2E_DIRS.has(s.toLowerCase()));
};

// --- helpers ------------------------------------------------------------------
export const normPath = (p) =>
  ('/' + p)
    .replace(/\/+/g, '/')
    .replace(/\$\{[^}]*\}|\{[^}]*\}|:\w+/g, '{}')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '') || '/';
const linesMatching = (text, re) =>
  text.split('\n').flatMap((l, i) => (re.test(l) ? [{ line: i + 1, text: l.trim().slice(0, 160) }] : []));

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

const simpleName = (text) => String(text ?? '').replace(/<[\s\S]*/, '').split('.').pop().trim();
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
      if ((tSpec.ann ?? []).some((re) => re.test(a.name))) out.push({ file: t.file, line: a.line ?? t.nameLine, text: describeAnn(a) });
    for (const sp of t.supers ?? []) {
      const name = simpleName(sp.fqn ?? sp.text ?? '');
      if (!tSpec.supers || !tSpec.supers.test(name)) continue;
      out.push({ file: t.file, line: t.nameLine, text: `${sp.kind === 'interface' ? 'implements' : 'extends'} ${name}` });
    }
    for (const f of t.fields ?? [])
      if (fSpec.type && (fSpec.type.test(f.type ?? '') || fSpec.type.test(f.typeFqn ?? '')))
        out.push({ file: t.file, line: f.line, text: `${f.type || f.typeFqn} ${f.name}` });
    for (const m of t.methods ?? []) {
      for (const a of m.ann ?? [])
        if ((mSpec.ann ?? []).some((re) => re.test(a.name))) out.push({ file: t.file, line: a.line ?? m.nameLine, text: describeAnn(a) });
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

export function scan(root, { withModel = false, extraConstants = new Map() } = {}) {
  const started = Date.now();
  const files = walk(root);
  const R = (p) => rel(root, p);
  const read = (p) => fs.readFileSync(p, 'utf8');
  const byExt = {};
  for (const f of files) {
    const e = path.extname(f).slice(1) || '(none)';
    byExt[e] = (byExt[e] ?? 0) + 1;
  }

  // The Java files, by path: the dump is the only reader of them; the scan itself never opens one.
  const javaAll = files.filter((f) => f.endsWith('.java') && !isSrcTestPath(f)).map((p) => ({ p: R(p) }));
  // A repo can hold several apps: map the primary one only (other deployables are named in Boot).
  const app = deployables({ java: javaAll, files, rel: R, read });
  const java = javaAll.filter((j) => !app.isExcluded(j.p));
  // The build, read as data: modules, coordinates, properties, plugins (evidence/build.mjs). Read once, used for
  // catalog selection (which frameworks are installed) and as a fact family of its own.
  const buildFiles = readBuild(root, files.map(R));
  // The model comes first: one base (the dump) answers identity, members, calls and each file's package and imports.
  // Everything below is a query over it — the app's own files, annotations, supertypes and enum values — never a
  // second parse.
  // The project's own dependency jars, when the machine already has them (offline, nothing built): Spoon then resolves
  // library types, and the library stubs say what their members are. Optional and never blocking.
  const cpStart = Date.now();
  const classpath = resolveClasspath(root, { files: files.map(R) });
  const classpathMs = Date.now() - cpStart;
  const dumpStart = Date.now();
  const dumpRun = dumpFor(root, javaAll.map((j) => j.p), { classpath });
  const dumpMs = Date.now() - dumpStart;
  const dump = dumpRun.ok ? openDump(dumpRun.dir) : null;
  const sources = new Map(
    [...(dump?.files?.entries() ?? [])].map(([p, f]) => [
      p,
      {
        pkg: f.package ?? '',
        imports: (f.imports ?? []).map((i) => ({ name: i.name, wildcard: !!i.wildcard, isStatic: !!i.static })),
        // A file the engine could not read at all is degraded: the dump says so rather than leaving a silent empty list.
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
  const callStats = dump ? callStatsOf(model, dump) : { answered: 0, targets: 0, ambiguous: 0, unanswered: 0, sites: 0 };
  bindingRates(model);

  // This deployable's types: the app excludes other modules, and a test fixture is not part of its schema.
  const appTypes = [...model.types.values()].filter((t) => !app.isExcluded(t.file) && !isSrcTestPath(t.file));
  // By the annotation as written, or by the FQN it resolved to.
  const carriesAnn = (t, name) =>
    (t.ann ?? []).some((a) => a.name === name || String(a.fqn ?? '').endsWith(`.${name}`));
  // A model type in the shape the later passes already read: identity (name, kind, annotations, supertypes, enum
  // values) and members are the model's.
  const asEntry = (t) => {
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
      fields: (t.fields ?? []).map((f) => ({ name: f.name, type: f.type, typeFqn: f.typeFqn, ann: f.ann, line: f.line })),
      methods: t.methods ?? [],
      type: t,
    };
  };

// A job, an observer or a message listener: the annotation is on the method (or its parameter), the model has both.
function scheduledOf(t) {
  const jobs = [];
  for (const m of t.methods ?? []) {
    for (const a of m.ann ?? [])
      if (JOB.test(a.name) && a.name !== 'MessageDriven')
        jobs.push({
          kind: a.name,
          args: (a.args ? `(${a.args})` : '').trim().slice(0, 120),
          line: a.line ?? m.nameLine,
          method: m.name,
        });
    // A CDI observer names its event on the parameter, and an MDB names its destination on the class.
    for (const p of m.params ?? [])
      for (const a of p.ann ?? [])
        if (/^Observes(Async)?$/.test(a.name))
          jobs.push({ kind: a.name, args: String(p.type ?? '').slice(0, 120), line: a.line ?? m.nameLine });
  }
  const mdb = (t.ann ?? []).find((a) => a.name === 'MessageDriven');
  if (mdb) {
    const dest =
      /propertyName\s*=\s*"destination(?:Lookup)?"\s*,\s*propertyValue\s*=\s*"([^"]+)"/.exec(mdb.args ?? '') ??
      /mappedName\s*=\s*"([^"]+)"/.exec(mdb.args ?? '');
    const on = (t.methods ?? []).find((m) => m.name === 'onMessage');
    jobs.push({ kind: 'MessageDriven', args: dest?.[1] ?? '', line: on?.nameLine ?? t.start });
  }
  return jobs.sort((a, b) => a.line - b.line);
}

const tableOf = (t) => /name\s*=\s*"([^"]+)"/.exec((t.ann ?? []).find((a) => a.name === 'Table')?.args ?? '')?.[1];

  const entities = appTypes.filter((t) => carriesAnn(t, 'Entity')).map(asEntry);
  // Controllers: Spring MVC, JAX-RS resources, and JSF backing beans (@Named with a UI scope).
  const UI_SCOPES = ['ViewScoped', 'RequestScoped', 'SessionScoped', 'ConversationScoped'];
  // The view names a controller returns: the string values its methods hand back, as the dump wrote them.
  // shortcut: switch arms that return a view are not read yet, a view named only there counts as dead; upgrade when one shows up.
  const viewsReturnedBy = (t) =>
    (t.methods ?? []).filter((m) => !carriesAnn(m, 'ResponseBody')).flatMap((m) =>
      (dump?.returnsOf(m.id) ?? [])
        .filter((r) => r.kind === 'return' && typeof r.value?.value === 'string')
        .map((r) => ({ view: r.value.value, line: r.line })),
    );
  const controllers = appTypes
    .filter(
      (t) =>
        carriesAnn(t, 'RestController') ||
        carriesAnn(t, 'Controller') ||
        carriesAnn(t, 'Path') ||
        (carriesAnn(t, 'Named') && UI_SCOPES.some((s) => carriesAnn(t, s))),
    )
    // A REST or JAX-RS method's string is a response body, not a view name.
    .map((t) => ({ ...asEntry(t), views: carriesAnn(t, 'RestController') || carriesAnn(t, 'Path') ? [] : viewsReturnedBy(t) }));
  const repos = appTypes
    .filter((t) => (t.supers ?? []).some((s) => /\b(Jpa|Crud|PagingAndSorting)?Repository\s*</.test(s.text ?? '')))
    .map(asEntry);

  // depth-5 walks need answers that are exact across the app, not partly filled by a fallback.
  const exactTargets =
    !!callStats.answered && callStats.ambiguous === 0 && callStats.unanswered < callStats.sites * 0.02;
  // frontend: React/TS and server-rendered views
  const built = (f) =>
    /\/static\/assets\/|-[\w]{8,}\.(js|css)$|\.min\.js$/.test(f) ||
    read(f)
      .split('\n')
      .some((l) => l.length > 3000);
  const fe = files
    .filter(
      (f) =>
        /\.(tsx?|jsx?|vue|svelte)$/.test(f) &&
        !/\.(test|spec|d)\.[tj]sx?$/.test(f) &&
        !/vendor|slick|jquery|bootstrap/i.test(f) &&
        !built(f) &&
        // End-to-end test code: Cypress/Playwright helpers call *another* application's API, so a spec is not this
        // app's frontend — the same rule that keeps `src/test/` out of the Java model.
        !isE2ePath(R(f)),
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

  // status enums with values (lifecycles): the model's kinds and the enum constants the dump lists.
  const enums = appTypes
    .filter((t) => t.kind === 'enum' && /(Status|State|Type|Mode|Tier|Role|Source)$/.test(t.name ?? ''))
    .map((t) => ({ name: t.name, file: t.file, line: t.start, values: t.enumValues ?? [] }));

  // Facts belong to the app, not the repository: the model spans every module (calls cross them), but a module the
  // app excludes from its component scan is another deployable and its handlers are not this app's API.
  const endpoints = extractEndpoints(model, selected, { include: (p) => !app.isExcluded(p) });
  // The families below, all on resolved calls: outside clients, repository writes and cache state, then the
  // transaction boundary that those together can leak through.
  const outsideCalls = extractOutside(model, selected);
  const stateFacts = extractState(model, selected);
  const tx = extractTransactions(model, selected, {
    outside: outsideCalls,
    writes: stateFacts.filter((f) => f.family === 'state-write'),
  });
  const transactions = tx.facts;
  // Recurring work that is not @Scheduled, and the paths that skip authentication: both are read from the model and
  // from resource files (sureness.yml, Spring Security config), not inferred by the writer.
  const recurring = extractSchedules(model, selected);
  // Configured values by property key (application*.yml/.properties): topic and queue names come from here.
  const channelConfig = new Map();
  for (const f of files.filter((x) => /application[\w.-]*\.(ya?ml|properties)$/.test(x) && !isSrcTestPath(x))) {
    const text = read(f);
    if (/\.properties$/.test(f)) {
      for (const m of text.matchAll(/^([\w.-]+)\s*[=:]\s*(.+)$/gm)) channelConfig.set(m[1].trim(), m[2].trim());
    } else {
      const stack = [];
      for (const line of text.split('\n')) {
        const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(line);
        if (!m || /^\s*#/.test(line)) continue;
        const indent = m[1].length;
        while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
        const key = [...stack.map((x) => x[1]), m[2]].join('.');
        if (m[3].trim() && !/^[|>]/.test(m[3].trim())) channelConfig.set(key, m[3].trim().replace(/^["']|["']$/g, ''));
        else stack.push([indent, m[2]]);
      }
    }
  }
  const resourceFiles = files
    .filter((f) => /\.(?:ya?ml|properties)$/.test(f) && /sureness|application|security/i.test(f))
    .map((f) => ({ p: R(f), text: read(f) }));
  // Security as facts: one rule per chain prefix (Spring Security chains + sureness.yml), the anonymous writes those
  // rules expose without a method-level check, and where the tenant comes from.
  const msIndex = annotationIndex(selected);
  const methodSec = methodSecurityFacts(model, (fqn, on) => meanOf(msIndex, fqn, on)?.means ?? null);
  const methodSecurityIndex = methodSec.index;
  // The same rule appears in several copies of a config (startup, manager, e2e); one fact per prefix and access.
  const ruleSeen = new Set();
  const securityRules = [
    ...springChains(model),
    ...resourceFiles.filter((r) => /sureness\.ya?ml$/i.test(r.p) && !isSrcTestPath(r.p)).flatMap((r) => surenessRules(r.text, r.p)),
    ...files
      .filter((f) => /shiro\.(ini|properties)$/i.test(f) && !isSrcTestPath(f))
      .flatMap((f) => shiroRules(read(f), R(f))),
    ...shiroCodeRules(model),
    ...files
      .filter((f) => /web\.xml$/.test(f) && !isSrcTestPath(f))
      .flatMap((f) => webXmlRules(read(f), R(f))),
  ].filter((r) => !ruleSeen.has(r.id) && ruleSeen.add(r.id));
  // Two warning kinds in one family: an anonymous prefix that exposes writes, and an identity the client asserts
  // (a filter takes a header/cookie value as the caller with no verification call between).
  const securityWarnings = [
    ...anonymousWrites(securityRules, endpoints, methodSecurityIndex),
    ...identityWarnings(model, isSrcTestOrItPath),
  ];
  const tenantFacts = tenantSources(model, isSrcTestOrItPath);
  // Entities and tenancy on the model: fields (inherited too), relations and their owning side,
  // repository → entity from resolved type arguments; the tenant key decided by counts.
  // Flow entries are needed both by tenancy (worker callers) and by the flows themselves: compute once.
  const flowEntryList = flowEntries(model, endpoints, selected);
  const catalogIndex = annotationIndex(selected);
  resolveWildcardAnnotations(model, catalogIndex);
  const entFacts = entityFacts(model, catalogIndex, typeIndex(selected));
  // Callers that are no-request code: jobs, listeners, async methods and worker loops.
  const entryMethods = [
    ...flowEntryList.filter((e) => e.kind === 'worker').map((e) => `${e.t.fqn}#${e.m.name}`),
    ...[...model.types.values()].flatMap((t) =>
      (t.methods ?? [])
        .filter((m) => (m.ann ?? []).some((a) => /(Scheduled|Schedule|JmsListener|KafkaListener|RabbitListener|EventListener|Async)$/.test(a.name ?? '')))
        .map((m) => `${t.fqn}#${m.name}`),
    ),
  ];
  // Webhook endpoints are request handlers, but nothing behind them has a logged-in tenant: reads they alone call are
  // judged like jobs (cross-tenant by design), not as unscoped request reads.
  // The id names the method that runs, which for an inherited endpoint is the declaring class's method.
  const methodIdOf = (e) => `${e.declaredIn ?? e.handlerFqn}#${String(e.handler).split('.').pop()}`;
  const webhookIds = endpoints
    .filter((e) => /webhook|callback|\bhooks?\b/i.test(e.path ?? ''))
    .map(methodIdOf);
  const requestMethods = endpoints.map(methodIdOf).filter((id) => !webhookIds.includes(id));
  entryMethods.push(...webhookIds);
  const tenancy = tenancyFacts(entFacts, { tenantSources: tenantFacts, model, entryMethods, requestMethods });
  // Where the user comes from, from what the code configures: the security chain's own calls (httpBasic(),
  // oauth2ResourceServer().jwt(), formLogin()/sessionManagement()) and filters that authenticate from a header by
  // setting the security context. Structural, not text matching.
  // The citation is the call's own line, which the dump wrote: the source text is not consulted for it.
  const citeOf = (t, c) => `${t.file}:${c.line}`;
  const userSources = [];
  const addUser = (kind, cite, why) => {
    if (cite && !userSources.some((u) => u.kind === kind)) userSources.push({ kind, cites: [cite], why });
  };
  for (const t of model.types.values())
    for (const m of t.methods ?? [])
      for (const c of m.calls ?? []) {
        if (c.name === 'httpBasic') addUser('basic auth', citeOf(t, c), `${t.name} configures httpBasic()`);
        if (c.name === 'oauth2ResourceServer' || c.name === 'jwt')
          addUser('JWT bearer token', citeOf(t, c), `${t.name} configures ${c.name}()`);
        if (c.name === 'formLogin') addUser('HTTP session', citeOf(t, c), `${t.name} configures formLogin()`);
        if (c.name === 'setAttribute' && (m.calls ?? []).some((x) => x.name === 'getSession'))
          addUser('HTTP session', citeOf(t, c), `${t.name}#${m.name} stores the caller in the HttpSession`);
        // `sessionCreationPolicy(STATELESS)` is a call whose argument names the policy: a stateless app has no session.
        if (
          c.name === 'sessionManagement' &&
          !(m.calls ?? []).some((x) => /STATELESS|NEVER/.test((x.args ?? []).join(' ')))
        )
          addUser('HTTP session', citeOf(t, c), `${t.name} configures a stateful sessionManagement()`);
        if (/^(setAuthentication|setContext)$/.test(c.name ?? '') && (/Filter$/.test(t.name) || (m.calls ?? []).some((x) => ['getHeader', 'getCookies'].includes(x.name))))
          addUser('API token', citeOf(t, c), `${t.name}#${m.name} sets the authentication from the request`);
        // A filter that reads the Authorization header and stores the caller (attribute, ThreadLocal, SecurityContext).
        if (
          /Filter$/.test(t.name) &&
          (m.calls ?? []).some((x) => x.name === 'getHeader') &&
          (m.calls ?? []).some((x) => ['setAttribute', 'set', 'setAuthentication'].includes(x.name)) &&
          // The header the filter reads names the token: the dump folded the argument, no source text is read.
          (m.calls ?? []).some((x) => (x.args ?? []).some((a) => /Authorization|Bearer|token/i.test(a)))
        )
          addUser('API token', citeOf(t, c), `${t.name}#${m.name} reads the token header and stores the caller`);
      }

  // Sureness declares its authentication types as processors; the catalog names them.
  for (const { catalog } of selected)
    for (const t of catalog.types ?? [])
      if (t.means === 'auth-type' && [...model.types.values()].some((x) => (x.supers ?? []).some((sp) => (sp.fqn ?? '').split('<')[0] === t.fqn) || x.fqn === t.fqn)) {
        const holder = [...model.types.values()].find((x) => (x.supers ?? []).some((sp) => (sp.fqn ?? '').split('<')[0] === t.fqn) || x.fqn === t.fqn);
        addUser(t.authType, `${holder.file}:${holder.nameLine}`, `${holder.name} is a Sureness ${t.authType} processor`);
      }
  for (const a of authSources(model, isSrcTestOrItPath))
    if (!userSources.some((u) => u.kind === a.kind)) userSources.push({ kind: a.kind, cites: a.evidence, why: a.why?.[0] });
  const baseControllers = new Set([...model.implsOf.keys()].filter((fqn) => model.types.get(fqn)?.methods?.length && /Controller$/.test(model.types.get(fqn)?.name ?? '')));
  const securityModelFact = buildSecurityModel({ rules: securityRules, endpoints, methodSecurity: methodSec.facts, tenancy, userSources, baseControllers });
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
    extra: tenancy.key ? flowEntryList.filter((e) => e.kind === 'worker').map((e) => ({ kind: 'worker', t: e.t, m: e.m })) : [],
  });
  const cov = coverage(model, endpoints, selected, { build: buildFiles, rels: files.map(R) });
  const feCalls = fe.flatMap((f) =>
    f.source.split('\n').flatMap((l, i) => {
      const m = /["'`](\/api\/[^"'`\s]*)["'`]/.exec(l);
      if (!m) return [];
      const around = f.source
        .split('\n')
        .slice(Math.max(0, i - 3), i + 4)
        .join(' ');
      const vm = /method:\s*["'](GET|POST|PUT|DELETE|PATCH)["']/i.exec(around);
      return [{ path: normPath(m[1]), verb: vm?.[1]?.toUpperCase(), file: f.p, line: i + 1 }];
    }),
  );
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
  const joined = feCalls.map((c) => {
    const cands = epByPath.get(c.path) ?? endpoints.filter((e) => segMatch(e.path, c.path));
    const hit = cands.find((e) => !c.verb || e.verb === c.verb || e.verb === 'ANY') ?? cands[0];
    return { ...c, handler: hit ? `${hit.file}:${hit.line}` : null };
  });
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
    .filter((v) => !Object.keys(viewUse).some((k) => k === v.name || k.endsWith('/' + v.name)) && !included.has(v.name))
    .map((v) => v.file);

  // runtime machinery, from the model: an annotation, a supertype, a call or a field's type — never a line of source.
  const interceptors = modelEntries(appTypes, {
    types: { ann: [/^(WebFilter|Interceptor)$/], supers: /(ContainerRequestFilter|ContainerResponseFilter|OncePerRequestFilter|HandlerInterceptor|Filter)$/ },
    methods: { ann: [/^AroundInvoke$/], returns: /FilterRegistrationBean/, calls: /^(addInterceptor|addPathPatterns|excludePathPatterns)$/ },
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
          (t) => (t.supers ?? []).some((s) => /ExceptionMapper$/.test(s.fqn ?? s.text ?? '')) ||
            (t.methods ?? []).some((m) => (m.ann ?? []).some((a) => a.name === 'ExceptionHandler')),
        )
        .map((t) => t.file),
    ),
  ];
  const background = appTypes.flatMap((t) => scheduledOf(t).map((s) => ({ ...s, file: t.file, cls: t.name })));
  const sockets = endpoints
    .filter((e) => e.verb === 'STOMP')
    .map((e) => ({ file: e.file, line: e.line, path: e.path }))
    .concat(modelEntries(appTypes, { methods: { calls: /^(registerStompEndpoints|enableSimpleBroker)$/ } }));
  const runners = appTypes
    .filter(
      (t) =>
        (t.supers ?? []).some((s) => /(CommandLineRunner|ApplicationRunner)/.test(s.text ?? '')) || carriesAnn(t, 'Startup'),
    )
    .map((t) => ({ file: t.file, line: t.start }));
  // Jakarta Batch: jobs are XML files under META-INF/batch-jobs; JobOperator.start("name") starts them.
  const batchJobs = files
    .filter((f) => /META-INF\/batch-jobs\/[\w.-]+\.xml$/.test(f))
    .map((f) => {
      const t = read(f),
        id = /<job\b[^>]*\bid="([^"]+)"/.exec(t)?.[1] ?? path.basename(f, '.xml');
      // `JobOperator.start("name")`: the dump's call row, with the job id as its folded argument.
      const starts = appTypes.flatMap((t) =>
        (t.methods ?? [])
          .flatMap((m) => (m.calls ?? []).filter((c) => c.name === 'start' && (c.args ?? []).includes(`"${id}"`)))
          .map((c) => `${t.file}:${c.line}`),
      );
      return {
        kind: 'Batch job',
        args: `${id}: ${[...t.matchAll(/<(batchlet|reader|processor|writer)\b[^>]*\bref="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`).join(', ')}${starts.length ? `; started at ${starts.join(', ')}` : ''}`,
        file: R(f),
        line: 1,
      };
    });
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
  const baseClasses = Object.entries(
    appTypes.reduce((acc, t) => {
      const b = String((t.supers ?? []).find((s) => s.kind !== 'interface')?.text ?? '').replace(/<.*/, '');
      if (b && !/Repository$|Exception$|^Object$/.test(b)) acc[b] = (acc[b] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .filter(([, n]) => n >= 3)
    .map(([b, n]) => ({ base: b, subclasses: n }));

  // externals: SDK imports + config keys (keys only, never values)
  const EXT = {
    'com.stripe': 'Stripe',
    'com.google.api': 'Google APIs',
    'com.google.cloud': 'Google Cloud',
    'software.amazon': 'AWS',
    'com.amazonaws': 'AWS',
    'com.sendgrid': 'SendGrid',
    brevo: 'Brevo',
    sendinblue: 'Brevo',
    'jakarta.mail': 'SMTP mail',
    'javax.mail': 'SMTP mail',
    'org.springframework.mail': 'SMTP mail',
    'org.springframework.kafka': 'Kafka',
    'org.springframework.amqp': 'RabbitMQ',
    redis: 'Redis',
    'com.twilio': 'Twilio',
    'io.minio': 'S3-compatible storage',
    'com.openai': 'OpenAI',
    okhttp3: '(HTTP client)',
    'org.springframework.web.reactive.function.client': '(HTTP client: WebClient)',
    'org.springframework.web.client.RestTemplate': '(HTTP client: RestTemplate)',
    feign: '(HTTP client: Feign)',
    'org.springframework.web.client.RestClient': '(HTTP client: RestClient)',
    'java.net.http': '(HTTP client: java.net.http)',
    'jakarta.jms': 'JMS',
    'javax.jms': 'JMS',
    'jakarta.ws.rs.client': '(HTTP client: JAX-RS)',
    'javax.ws.rs.client': '(HTTP client: JAX-RS)',
    'org.eclipse.microprofile.rest.client': '(HTTP client: MicroProfile)',
  };
  // The file's imports, as the dump's header reader wrote them: an SDK is installed when one of its packages is imported.
  const importsOf = (relPath) => (sources.get(relPath)?.imports ?? []).map((i) => i.name);
  const externals = {};
  for (const j of java)
    for (const [k, v] of Object.entries(EXT))
      if (importsOf(j.p).some((name) => name.includes(k))) (externals[v] ??= []).push(j.p);
  const configFiles = files.filter(
    (f) =>
      /(application|bootstrap)[\w-]*\.(properties|ya?ml)$/.test(f) &&
      /resources/.test(f) &&
      !/\/src\/test\/|[-_]e2e\b|\/e2e\//.test(f),
  );
  const configKeys = configFiles.map((f) => {
    const t = read(f);
    const keys = f.endsWith('.properties')
      ? t
          .split('\n')
          .map((l, i) => [l.replace(/^#\s*/, ''), i + 1, /^\s*#/.test(l)])
          .filter(([l]) => /^[\w.\-\[\]]+\s*[=:]/.test(l))
          .map(([l, n, c]) => `${l.split(/[=:]/)[0].trim()}:${n}${c ? ' (commented)' : ''}`)
      : t
          .split('\n')
          .map((l, i) => [l, i + 1])
          .filter(([l]) => /^\s*[\w-]+:/.test(l))
          .map(([l, n]) => `${l.trim().split(':')[0]}:${n}`);
    const db = /jdbc:(\w+)/.exec(t);
    return { file: R(f), db: db?.[1], keys };
  });
  // state: who writes each entity (repository mutations per caller), copies of state
  // The repository → entity map comes from the model's resolved type arguments (entities.mjs); no name patterns.
  const repoEntity = new Map([...entFacts.repos].map(([fqn, e]) => [fqn.split('.').pop(), e.split('.').pop()]));
  // `@Modifying` on a repository method: the annotation row the dump wrote, on the method that carries it.
  const modifying = repos.flatMap((r) =>
    (r.methods ?? []).flatMap((m) =>
      (m.ann ?? []).filter((a) => a.name === 'Modifying').map((a) => ({ file: r.p, line: a.line ?? m.nameLine, entity: repoEntity.get(r.name) })),
    ),
  );
  const deep = javaFacts({
    // Statuses are read from the dump's typed arguments and returns: the source text is not consulted.
    dump,
    model,
    java: appTypes.map(asEntry),
    repoEntity,
    EXT,
    enums,
    entities,
    shortlist: new Set([...entFacts.entities].sort((a, b) => b.relations.length - a.relations.length).slice(0, 15).map((e) => e.name)),
    endpoints,
  });
  const bootComputed = bootFacts({ root, files, rel: R, git, app });

  // boot: entry points, profile switches, how to run locally
  // A runnable entry point: a `main` method (the dump's `isMain`) whose class is a Spring Boot app or whose body runs
  // `SpringApplication`.
  const mains = [...model.types.values()]
    .filter((t) => !isSrcTestPath(t.file))
    .filter(
      (t) =>
        t.methods.some(
          (m) =>
            m.isMain &&
            (carriesAnn(t, 'SpringBootApplication') ||
              carriesAnn(t, 'SpringBootConfiguration') ||
              (m.calls ?? []).some((c) => /(^|\.)SpringApplication(Builder)?$/.test(c.recvFqn ?? ''))),
        ),
    )
    .flatMap((t) =>
      t.methods.filter((m) => m.isMain).map((m) => ({ file: t.file, line: m.nameLine })),
    );
  const switches = modelEntries(appTypes, {
    types: { ann: [/^(Profile|ConditionalOnProperty|ConditionalOnMissingBean)$/] },
    methods: { ann: [/^(Profile|ConditionalOnProperty|ConditionalOnMissingBean)$/] },
  }).concat(
    configFiles.flatMap((f) =>
      linesMatching(read(f), /profiles?\.active|on-profile/).map((m) => ({ file: R(f), ...m })),
    ),
  );
  const feEntries = files
    .filter(
      (f) =>
        /(^|\/)(vite\.config\.\w+|index\.html|src\/main\.[jt]sx?|src\/index\.[jt]sx?|angular\.json|proxy\.conf\.json)$/.test(
          R(f),
        ) && !/node_modules|resources\/(static|templates)/.test(R(f)),
    )
    .map((f) => ({
      file: R(f),
      lines: linesMatching(
        read(f),
        /port|proxy|target|createRoot|render\(|type="module"|bootstrapApplication|bootstrapModule|createApp|new App\(|mount\(|"main":|"browser":/,
      ).slice(0, 8),
    }));
  const compose = files
    .filter((f) => /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/.test(R(f)))
    .map((f) => ({
      file: R(f),
      services: linesMatching(read(f), /^  [\w-]+:\s*$/).map((m) => `${m.text.replace(':', '')}:${m.line}`),
    }));
  const scripts = files
    .filter((f) => /(^|\/)package\.json$/.test(R(f)) && R(f).split('/').length <= 3)
    .map((f) => {
      try {
        return { file: R(f), scripts: JSON.parse(read(f)).scripts ?? {} };
      } catch {
        return { file: R(f), scripts: {} };
      }
    });
  const profiles = configFiles.map((f) => R(f)).filter((f) => /application-[\w]+\./.test(f));

  // frontend routes
  const routes = fe.flatMap((f) => {
    const ng = isAngularRoutes(f.source);
    return f.source.split('\n').flatMap((l, i) => {
      const p = routePath(l, ng);
      return p == null ? [] : [{ path: p, file: f.p, line: i + 1 }];
    });
  });

  // docs
  const docs = files
    .filter((f) => /\.(md|adoc|rst)$/i.test(f))
    .map((f) => {
      const t = read(f);
      return {
        file: R(f),
        kb: Math.round(t.length / 102.4) / 10,
        title: (/^#\s+(.+)$/m.exec(t)?.[1] ?? '').slice(0, 90),
      };
    });

  // git
  const gitInfo = (() => {
    const head = git(root, ['rev-parse', '--short', 'HEAD']);
    if (!head) return null;
    const dirty = !!git(root, ['status', '--porcelain', '--untracked-files=no']);
    const headDate = git(root, ['log', '-1', '--format=%cI']);
    const total = Number(git(root, ['rev-list', '--count', 'HEAD']));
    return { head, dirty, headDate, totalCommits: total, window: gitWindow(root, headDate, total) };
  })();

  // Flow ranking reads activity: how many commits in the window touched the entry's file. One git log, counted per
  // file on demand (validate.mjs computes the same numbers for the map's regions).
  const activityOf = (() => {
    const win = gitInfo?.window;
    if (!win) return () => 0;
    // Path-limited history, in chunks: one git call per 25 entry files keeps the largest name-status page small, and
    // the shared log is dropped between chunks.
    // An inherited entry runs the declaring class's code, so that is the file whose churn matters.
    const paths = [...new Set(flowEntryList.map((e) => (e.owner ?? e.t).file))];
    const counts = new Map();
    for (let i = 0; i < paths.length; i += 25) {
      for (const [p, n] of activityByFile(root, win.since, paths.slice(i, i + 25)))
        counts.set(p, (counts.get(p) ?? 0) + n);
      forgetActivity();
    }
    return (file) => counts.get(file) ?? 0;
  })();

  const flows = buildFlows(model, {
    entries: flowEntryList,
    exactTargets,
    stateWrites: stateFacts.filter((x) => x.family === 'state-write'),
    statusSets: deep.statusSets,
    outsideCalls,
    transactions,
    entities: entFacts.entities,
    activityOf,
    selected,
    securityRules,
    frontendPaths: joined.filter((j) => j.path).map((j) => ({ path: j.path, file: j.file })),
  });
  // The flow rank needs git activity for entry files only; the history text is not needed after it.
  forgetActivity();

  const factsOut = {
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
    git: gitInfo,
    docs,
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
      enums,
      repositories: repos.map((r) => ({ file: r.p, extends: r.extends })),
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
        ownRelations: e.fields.filter((f) => f.owner === e.name && f.relation).map((f) => `${f.relation.kind} ${f.relation.target?.split('.').pop() ?? f.type} ${f.name}:${f.line}`),
      })),
    },
    tenancy: {
      key: tenancy.key,
      confidence: tenancy.confidence,
      counts: tenancy.counts,
      candidates: tenancy.candidates.slice(0, 6),
      coverage: tenancy.coverage,
      unscoped: tenancy.unscoped,
      unscopedWrites: tenancy.unscopedWrites,
      globalLookups: tenancy.globalLookups,
      crossTenant: tenancy.crossTenant,
      unscopedByRepo: tenancy.unscopedByRepo,
      bridged: tenancy.bridged,
      bases: tenancy.bases,
      thresholds: tenancyThresholds,
      sources: tenancy.sources,
    },
    noRequestPaths: withoutRequest,
    endpoints,
    coverage: cov,
    frontend: {
      files: fe.length,
      routes,
      apiCalls: joined.length,
      unmatchedApiCalls: joined.filter((j) => !j.handler).map((j) => `${j.verb ?? ''} ${j.path} ${j.file}:${j.line}`),
      apiJoin: joined
        .filter((j) => j.handler)
        .map((j) => `${j.verb ?? ''} ${j.path} ${j.file}:${j.line} -> ${j.handler}`),
    },
    views: { count: views.length, returnedBy: viewUse, deadViews },
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
            dump: dumpRun.dir,
          }
        : { spoon: false, reason: dumpRun.reason },
      interceptors,
      contextScopes,
      exceptionHandlers,
      baseClasses,
      sessionState,
    },
    methodSecurity: methodSec.facts,
    securityModel: securityModelFact,
    channels: channelFacts(model, { config: channelConfig, extraConstants }),
    background: { scheduledAsyncListeners: [...background, ...batchJobs], sockets, runners },
    state: { modifying },
    boot: { computed: bootComputed, mains, switches, profiles, frontend: feEntries, compose, scripts },
    transactions,
    transactionCounts: tx.counts,
    outsideCalls,
    stateWrites: stateFacts.filter((f) => f.family === 'state-write'),
    stateCaches: stateFacts.filter((f) => f.family === 'state-cache'),
    lifecycle: deep.lifecycle,
    schedules: deep.schedules,
    recurring,
    securityRules,
    securityWarnings,
    tenantSources: tenantFacts,
    ...(tenantFacts.length ? {} : { tenantSourcesNote: 'no tenant source found within depth 2 (no ThreadLocal/request-attribute store reached from doFilter/preHandle)' }),
    flows,
    externals: {
      sdkImports: Object.fromEntries(Object.entries(externals).map(([k, v]) => [k, [...new Set(v)].slice(0, 6)])),
      config: configKeys,
    },
  };
  // Tests that check resolution against hand-verified calls need the model; facts alone cannot show a receiver type.
  if (withModel) Object.defineProperty(factsOut, 'model', { value: model, enumerable: false });
  // The lifecycle set sites: the same rows the flows rank reads, kept for the excerpt file (the writer's flow steps and
  // setter context). Not part of facts.json — the digest already carries the sentence form of every one.
  Object.defineProperty(factsOut, 'statusSets', { value: deep.statusSets, enumerable: false });
  return factsOut;
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
  const f = facts;
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  console.log(
    `wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB): ${f.entities.count} entities, ${f.endpoints.length} endpoints, ${f.frontend.apiCalls} frontend API calls (${f.frontend.unmatchedApiCalls.length} unmatched), ${f.views.count} views, ${f.background.scheduledAsyncListeners.length} scheduled/async/listeners, ${f.schedules.length} scheduled job(s), ${f.securityRules.length} security rule(s), ${f.securityWarnings.length} security warning(s), ${f.docs.length} docs, git ${f.git ? f.git.head + (f.git.dirty ? '+dirty' : '') + ' window=' + (f.git.window?.since ?? 'none') : 'none'} · ${Object.entries(f.timings).map(([k, v]) => `${k} ${seconds(v)}`).join(' ')}`,
  );
  if (retired) console.log(`previous map kept at ${retired}`);
}
