#!/usr/bin/env node
// Phase 1 of the generation rules: collect the mechanical facts so the writer reads code only to judge, not to search.
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
import { open as openDump } from './dump.mjs';
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
export const norm = (p) =>
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

// The run's scratch folder. `.work/` holds facts, the Java dump and report files (megabytes nobody should commit);
// `mindmodel.json` and `index.html` beside it are the deliverables and stay visible.
export function ensureWork(root) {
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
export function modelEntries(types, { types: tSpec = {}, methods: mSpec = {}, fields: fSpec = {} } = {}) {
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
export function retirePreviousMap(root) {
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
  const files = walk(root);
  const R = (p) => rel(root, p);
  const read = (p) => fs.readFileSync(p, 'utf8');
  const byExt = {};
  for (const f of files) {
    const e = path.extname(f).slice(1) || '(none)';
    byExt[e] = (byExt[e] ?? 0) + 1;
  }

  // The Java files, by path: the dump is the only reader of them; the scan itself never opens one.
  const javaAll = files.filter((f) => f.endsWith('.java') && !/\/src\/test\//.test(f)).map((p) => ({ p: R(p) }));
  // A repo can hold several apps: map the primary one only (other deployables are named in Boot).
  const app = deployables({ java: javaAll, files, rel: R, read });
  const java = javaAll.filter((j) => !app.isExcluded(j.p));
  // The build, read as data: modules, coordinates, properties, plugins (evidence/build.mjs). Read once, used for
  // catalog selection (which frameworks are installed) and as a fact family of its own.
  const buildFiles = readBuild(root, files.map(R));
  // The model comes first: one base (the dump) answers identity, members, calls and each file's package and imports.
  // Everything below is a query over it — the app's own files, annotations, supertypes and enum values — never a
  // second parse.
  const dumpRun = dumpFor(root, javaAll.map((j) => j.p));
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
  const appTypes = [...model.types.values()].filter((t) => !app.isExcluded(t.file) && !/\/src\/test\//.test(t.file));
  const hasAnn = (t, simple) =>
    (t.ann ?? []).some((a) => a.name === simple || String(a.fqn ?? '').endsWith(`.${simple}`));
  // A model type in the shape the later passes already read: identity (name, kind, annotations, supertypes, enum
  // values) and members are the model's. A controller's view names are string returns the model does not resolve as
  // paths, so `views` stays empty rather than being read out of the source.
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

  const entities = appTypes.filter((t) => hasAnn(t, 'Entity')).map(asEntry);
  const entityNames = new Set(entities.map((e) => e.name));
  // Controllers: Spring MVC, JAX-RS resources, and JSF backing beans (@Named with a UI scope).
  const UI_SCOPES = ['ViewScoped', 'RequestScoped', 'SessionScoped', 'ConversationScoped'];
  const controllers = appTypes
    .filter(
      (t) =>
        hasAnn(t, 'RestController') ||
        hasAnn(t, 'Controller') ||
        hasAnn(t, 'Path') ||
        (hasAnn(t, 'Named') && UI_SCOPES.some((s) => hasAnn(t, s))),
    )
    .map(asEntry);
  const nonEntity = appTypes.filter((t) => !hasAnn(t, 'Entity')).map(asEntry);
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
  // The slice-2 families, all on resolved calls: outside clients, repository writes and cache state, then the
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
  for (const f of files.filter((x) => /application[\w.-]*\.(ya?ml|properties)$/.test(x) && !/\/src\/test\//.test(x))) {
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
    ...resourceFiles.filter((r) => /sureness\.ya?ml$/i.test(r.p) && !/\/src\/test\//.test(r.p)).flatMap((r) => surenessRules(r.text, r.p)),
    ...files
      .filter((f) => /shiro\.(ini|properties)$/i.test(f) && !/\/src\/test\//.test(f))
      .flatMap((f) => shiroRules(read(f), R(f))),
    ...shiroCodeRules(model),
    ...files
      .filter((f) => /web\.xml$/.test(f) && !/\/src\/test\//.test(f))
      .flatMap((f) => webXmlRules(read(f), R(f))),
  ].filter((r) => !ruleSeen.has(r.id) && ruleSeen.add(r.id));
  // Two warning kinds in one family: an anonymous prefix that exposes writes, and an identity the client asserts
  // (a filter takes a header/cookie value as the caller with no verification call between).
  const securityWarnings = [
    ...anonymousWrites(securityRules, endpoints, methodSecurityIndex),
    ...identityWarnings(model, (rel) => read(path.join(root, rel)), (p) => /\/src\/(test|it)\//.test(p)),
  ];
  const tenantFacts = tenantSources(model, (rel) => read(path.join(root, rel)), (p) => /\/src\/(test|it)\//.test(p));
  // Entities and tenancy on the model (§5.4, slice 3): fields (inherited too), relations and their owning side,
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
  for (const a of authSources(model, (rel) => read(path.join(root, rel)), (p) => /\/src\/(test|it)\//.test(p)))
    if (!userSources.some((u) => u.kind === a.kind)) userSources.push({ kind: a.kind, cites: a.evidence, why: a.why?.[0] });
  const baseControllers = new Set([...model.implsOf.keys()].filter((fqn) => model.types.get(fqn)?.methods?.length && /Controller$/.test(model.types.get(fqn)?.name ?? '')));
  const securityModelFact = buildSecurityModel({ rules: securityRules, endpoints, methodSecurity: methodSec.facts, tenancy, userSources, baseControllers });
  // §5.4's 30% vs the 10% this build uses: report all three and let the owner decide.
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
      return [{ path: norm(m[1]), verb: vm?.[1]?.toUpperCase(), file: f.p, line: i + 1 }];
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
        (t.supers ?? []).some((s) => /(CommandLineRunner|ApplicationRunner)/.test(s.text ?? '')) || hasAnn(t, 'Startup'),
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
  const sdkFiles = new Set(java.filter((j) => importsOf(j.p).some((name) => Object.keys(EXT).some((k) => name.includes(k)))).map((j) => j.p));
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
    .filter((t) => !/\/src\/test\//.test(t.file))
    .filter(
      (t) =>
        t.methods.some(
          (m) =>
            m.isMain &&
            (hasAnn(t, 'SpringBootApplication') ||
              hasAnn(t, 'SpringBootConfiguration') ||
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
    inventory: { byExt, topDirs: [...new Set(files.map((f) => R(f).split('/').slice(0, 2).join('/')))].slice(0, 60) },
    build: buildFiles,
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
  return factsOut;
}

// Compact digest the writer reads first; facts.json keeps the details for targeted lookup.
export function summarize(f) {
  const L = [];
  const sec = (h) => L.push('', `## ${h}`);
  // Every list is capped so the digest stays the same size on a 300k-line app; the rest stays in facts.json.
  const cap = (list, n, where) =>
    list.length > n ? [...list.slice(0, n), `- +${list.length - n} more in facts.json (${where})`] : list;
  // A digest line is read, not parsed: long flow and seam lines are cut with a marker and the rest stays in facts.json,
  // so the digest keeps its size on a 5,000-file app.
  // Transaction lines are lists of steps: cut only between steps, never inside one.
  const ellSteps = (list, n = 300) =>
    list.map((l) => {
      if (l.length <= n) return l;
      const cut = l.slice(0, n - 1);
      const at = cut.lastIndexOf('; ');
      return at > n * 0.5 ? `${cut.slice(0, at + 1)}…` : l;
    });
  const ell = (list, n = 220) =>
    list.map((l) => {
      if (l.length <= n) return l;
      // Cut at a boundary: a line that ends inside `RestTemplate.postForEntity(` reads like a different call.
      const cut = l.slice(0, n - 1);
      const at = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(' '));
      return `${cut.slice(0, at > n * 0.6 ? at : cut.length)}…`;
    });
  const push = (lines) => L.push(...lines);
  const prefix = (list) => {
    if (!list.length) return '';
    let p = list[0];
    for (const s of list) while (!s.startsWith(p)) p = p.slice(0, p.lastIndexOf('/', p.length - 2) + 1);
    return p;
  };
  const J = prefix(f.packages.map((p) => p.dir + '/')),
    F = prefix(
      f.frontend.routes
        .map((r) => r.file)
        .concat(f.frontend.apiJoin.map((s) => s.split(' ').find((x) => x.includes(':')) ?? ''))
        .filter(Boolean),
    );
  // Multi-module repos repeat "<module>/src/main/java/<org package>/" in every path: shorten that inner part to "~/".
  const innerCount = {};
  for (const p of f.packages) {
    const m = /src\/main\/java\/((?:[a-z0-9_]+\/){1,3})/.exec(p.dir + '/');
    if (m)
      for (let k = 1; k <= m[1].split('/').length - 1; k++) {
        const pre = 'src/main/java/' + m[1].split('/').slice(0, k).join('/') + '/';
        innerCount[pre] = (innerCount[pre] ?? 0) + p.javaFiles;
      }
  }
  const total = f.packages.reduce((n, p) => n + p.javaFiles, 0);
  const I =
    J.length > 8
      ? ''
      : (Object.entries(innerCount)
          .filter(([, n]) => n >= total * 0.6)
          .sort((a, b) => b[0].length - a[0].length)[0]?.[0] ?? '');
  const ab = (s) => {
    let t = String(s)
      .split(J)
      .join(J.length > 8 ? 'J/' : J)
      .split(F)
      .join(F.length > 8 ? 'F/' : F);
    return I ? t.split(I).join('~/') : t;
  };
  L.push(
    `# facts for ${path.basename(f.root)} (scanned ${f.scannedAt})`,
    "Paths are relative to the project root. Details: facts.json (search it, don't read it whole).",
  );
  if (f.coverage?.line) L.push(`**Coverage:** ${f.coverage.line}`);
  // The blind spots by name: a writer checks the code behind anything listed here before claiming it (rule P4a).
  if (f.coverage) {
    const c = f.coverage;
    const blind = [];
    if (c.unknownAnnotations?.length) {
      const top = c.unknownAnnotations.slice(0, 6).map((u) => `${u.name}×${u.count} (${ab(u.samples[0])})`);
      blind.push(
        `- unknown annotations: ${top.join('; ')}${c.unknownAnnotations.length > 6 ? `; +${c.unknownAnnotations.length - 6} more in facts.json` : ''}`,
      );
    }
    if (c.unknownBaseClasses?.length) {
      blind.push(
        `- base classes no catalog explains: ${c.unknownBaseClasses.slice(0, 8).map((b) => `${b.name}×${b.count}`).join(', ')}${c.unknownBaseClasses.length > 8 ? `, +${c.unknownBaseClasses.length - 8}` : ''}`,
      );
    }
    if (c.uncataloguedDependencies?.length) {
      blind.push(
        `- uncatalogued dependencies (by files importing them): ${c.uncataloguedDependencies.slice(0, 10).map((d) => `${d.coordinate} ${d.files}`).join(', ')}${c.uncataloguedDependenciesTotal > Math.min(10, c.uncataloguedDependencies.length) ? `, +${c.uncataloguedDependenciesTotal - Math.min(10, c.uncataloguedDependencies.length)} more in facts.json` : ''}`,
      );
    }
    const langs = Object.entries(c.unparsedLanguages ?? {}).filter(([, n]) => n > 0);
    if (langs.length) blind.push(`- source files the model cannot read: ${langs.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    if (c.generatedSources?.length)
      blind.push(
        `- generated code (not hand-written): ${c.generatedSources.map((g) => `${g.file}: ${g.plugin}${g.packages.length ? ` -> ${g.packages.slice(0, 2).join(', ')}` : ''}`).join('; ')}`,
      );
    if (c.degradedFiles?.length) blind.push(`- files that failed to parse: ${c.degradedFiles.length}`);
    if (blind.length) {
      sec('What the engine did not understand');
      push(blind);
    }
  }
  if (J.length > 8) L.push('**J/ = @@J@@**');
  if (I) L.push('**~/ = @@I@@** (inside each module: "mod/~/x" means "mod/@@I@@x")');
  if (F.length > 8) L.push('**F/ = @@F@@**');
  L.push('Expand J/, F/ and ~/ to the full path in every citation.');
  sec('Git');
  L.push(
    f.git
      ? `HEAD ${f.git.head}${f.git.dirty ? ' + local changes' : ''}; ${f.git.totalCommits} commits; activity window: ${f.git.window ? `${f.git.window.since} (${f.git.window.commits} commits)` : 'none (too few commits)'}`
      : 'no git history',
  );
  sec('Build & externals');
  push(
    cap(
      f.build.map(
        (b) =>
          `- ${b.file}: ${(b.deps ?? [])
            .slice(0, 20)
            .map((d) => `${d.group}:${d.artifact}`)
            .join(', ')}${(b.deps ?? []).length > 20 ? `, +${b.deps.length - 20}` : ''}${
            b.plugins?.length ? ` (plugins: ${b.plugins.map((p) => p.id).join(', ')})` : ''
          }`,
      ),
      8,
      'build',
    ),
  );
  for (const [k, v] of Object.entries(f.externals.sdkImports)) L.push(`- ${k}: ${v.join(', ')}`);
  for (const c of f.externals.config)
    L.push(`- config ${c.file}${c.db ? ` (db: ${c.db})` : ''}: ${c.keys.length} keys (names only in facts.json)`);
  sec(`Docs (${f.docs.length})`);
  push(
    cap(
      f.docs.map((d) => `- ${d.file} (${d.kb} KB)${d.title ? ' · ' + d.title : ''}`),
      40,
      'docs',
    ),
  );
  sec('Packages (java files per module/subfolder)');
  const mods = {};
  for (const p of f.packages) {
    const r = p.dir.startsWith(J) ? p.dir.slice(J.length) : p.dir;
    const [m, ...sub] = r.split('/');
    (mods[m || '.'] ??= []).push(`${sub.join('/') || '.'} ${p.javaFiles}`);
  }
  push(
    cap(
      Object.entries(mods).map(([m, subs]) => {
        const top = subs.map((x) => [x, Number(x.split(' ').pop())]).sort((a, b) => b[1] - a[1]);
        return `- ${m}: ${top.reduce((n, [, c]) => n + c, 0)} files; ${top
          .slice(0, 8)
          .map(([x]) => x)
          .join(', ')}${top.length > 8 ? `, +${top.length - 8} folders` : ''}`;
      }),
      30,
      'packages',
    ),
  );
  sec(`Entities (${f.entities.model.length}; from the model: table, relations, keys)`);
  for (const e of [...f.entities.model].sort((a, b) => b.relations.length - a.relations.length).slice(0, 15))
    L.push(
      `- ${e.name} table ${e.table} · ${e.relations.length} relation(s)${e.relations.length ? ': ' + e.relations.slice(0, 6).join('; ') : ''} · keys ${e.keys.slice(0, 8).join(', ')}${e.unique?.length ? ` · unique ${e.unique.join(', ')}` : ''}`,
    );
  if (f.entities.model.length > 15) L.push(`- +${f.entities.model.length - 15} more in facts.json`);

  sec('Enums');
  push(
    cap(
      f.entities.enums.map((e) => `- ${e.name} ${e.file}:${e.line}: ${e.values.join(' ')}`),
      40,
      'entities.enums',
    ),
  );
  sec(`Controllers (${f.endpoints.length} endpoints)`);
  const byCtl = {};
  for (const e of f.endpoints) {
    const k = e.inheritedBy ?? e.file;
    (byCtl[k] ??= []).push(e);
  }
  const ctl = Object.entries(byCtl).map(
    ([file, eps]) =>
      `- ${file}: ${eps.length} (${[...new Set(eps.map((e) => e.verb))].join('/')}) ${[...new Set(eps.map((e) => e.path.split('/').slice(0, 4).join('/')))].slice(0, 3).join(' ')}`,
  );
  if (ctl.length <= 60) push(ctl);
  else {
    const byBase = {};
    for (const e of f.endpoints) {
      const k = e.path.split('/').slice(0, 3).join('/') || '/';
      (byBase[k] ??= new Set()).add(e.inheritedBy ?? e.file);
    }
    push(
      cap(
        Object.entries(byBase)
          .sort((a, b) => b[1].size - a[1].size)
          .map(([k, files]) => `- ${k}/**: ${files.size} controller(s), e.g. ${[...files].slice(0, 2).join(', ')}`),
        50,
        'endpoints',
      ),
    );
  }
  sec('Frontend');
  L.push(
    `${f.frontend.files} files; ${f.frontend.apiCalls} API call sites matched to endpoints in facts.json (frontend.apiJoin); unmatched: ${f.frontend.unmatchedApiCalls.length ? f.frontend.unmatchedApiCalls.join(' | ') : 'none'}`,
  );
  push(
    cap(
      f.frontend.routes.map((r) => `- route ${r.path} ${r.file}:${r.line}`),
      60,
      'frontend.routes',
    ),
  );
  if (f.views.count) {
    L.push(
      `${f.views.count} server-rendered views; returned by controllers: ${Object.keys(f.views.returnedBy).length}; never returned or included (dead?): ${f.views.deadViews.join(', ') || 'none'}`,
    );
  }
  sec('Request machinery');

  push(
    cap(
      f.securityRules.map(
        (r) => `- ${r.pattern}: ${r.access === 'anonymous' ? 'anonymous allowed' : r.access} (${r.source} ${r.chain} ${r.evidence[0]})`,
      ),
      20,
      'securityRules',
    ),
  );
  const anonymousWarnings = f.securityWarnings.filter((w) => w.kind !== 'client-asserted-identity');
  const identityWarningsOut = f.securityWarnings.filter((w) => w.kind === 'client-asserted-identity');
  if (anonymousWarnings.length) {
    sec('Security warnings, computed (a prefix allows anonymous access and exposes writes with no method-level check)');
    const byRule = new Map();
    for (const w of anonymousWarnings) {
      if (!byRule.has(w.rule)) byRule.set(w.rule, []);
      byRule.get(w.rule).push(w);
    }
    push(
      cap(
        [...byRule.entries()].map(([rule, list]) => {
          const example = list[0];
          return `- ${rule.split(' is ')[0]} allows anonymous writes: ${list.length} endpoint(s), e.g. ${example.verb} ${example.path} (${example.handler}) — no @PreAuthorize/@Secured/@RolesAllowed`;
        }),
        12,
        'securityWarnings',
      ),
    );
  }
  if (identityWarningsOut.length) {
    sec('Security warnings, computed (a request value becomes the caller with no verification call)');
    push(
      cap(
        identityWarningsOut.map(
          (w) =>
            `- ${w.method} takes the caller from ${w.source} (${w.evidence[0]}) and ${w.holder} stores it unverified — any client can claim that identity`,
        ),
        12,
        'securityWarnings',
      ),
    );
  }
  push(
    cap(
      f.tenantSources.length
        ? f.tenantSources.map((t) => `- tenant from ${t.kind} ${t.name} (${t.method} ${t.evidence[0]})`)
        : [`- ${f.tenantSourcesNote}`],
      8,
      'tenantSources',
    ),
  );
  L.push(
  );
  push(
    cap(
      f.runtime.interceptors.map((s) => `- interceptor/filter ${s.file}:${s.line} ${s.text}`),
      30,
      'runtime.interceptors',
    ),
  );
  push(
    cap(
      f.runtime.contextScopes.map((s) => `- context ${s.file}:${s.line} ${s.text}`),
      20,
      'runtime.contextScopes',
    ),
  );
  if (f.runtime.exceptionHandlers.length)
    L.push(`- @ExceptionHandler in ${f.runtime.exceptionHandlers.length} files (list in facts.json)`);
  for (const b of f.runtime.baseClasses) L.push(`- base class ${b.base}: ${b.subclasses} subclasses`);
  for (const s of f.runtime.sessionState.slice(0, 20)) L.push(`- session ${s.file}:${s.line} ${s.text}`);
  // Tenancy (§5.4): the key decided by counts, its coverage, the reads that skip it, and code without a request.
  sec('Tenancy (the key is inferred from counts, never from the name)');
  if (f.tenancy.key) {
    const t = f.tenancy;
    L.push(
      `- key ${t.key}: ${t.counts.entities} of ${t.counts.of} entities (${t.counts.percent}%), ` +
        `${t.counts.filteredMethods} of ${t.counts.repoMethods} repository reads filter by it (${t.counts.filteredPercent}%) — inferred`,
    );
    const src = t.sources.slice(0, 3).map((s) => `${s.kind} ${s.name} (${s.method})`);
    if (src.length) L.push(`- the request carries it: ${src.join(', ')}`);
    L.push(`- with the key: ${t.coverage.withKey.slice(0, 10).join(', ')}${t.coverage.withKey.length > 10 ? ` +${t.coverage.withKey.length - 10}` : ''}`);
    const no = t.coverage.withoutKey.filter((n) => /Monitor|Alert|Group|Dashboard|Metric|Collect|Job|Task|Agent/.test(n));
    if (no.length)
      L.push(
        `- without it: ${no.slice(0, 10).join(', ')}${no.length > 10 ? ` +${no.length - 10}` : ''} — reads of these are not scoped by ${t.key}`,
      );
    if (t.globalLookups?.length)
      L.push(
        `- global lookups by unique key (not unscoped): ${t.globalLookups.length}, e.g. ${t.globalLookups
          .slice(0, 4)
          .map((g) => `${g.repo}#${g.method} (${g.uniqueField})`)
          .join('; ')}`,
      );
    if (t.unscopedByRepo.length)
      L.push(
        `- unscoped reads, by repository: ${t.unscopedByRepo
          .slice(0, 8)
          .map((r) => {
            const first = t.unscoped.find((u) => u.repo === r.repo);
            return `${r.repo} ×${r.n} (e.g. ${first.query})`;
          })
          .join('; ')}${t.unscopedByRepo.length > 8 ? `; +${t.unscopedByRepo.length - 8} repositories in facts.json` : ''}`,
      );
  } else {
    const near = f.tenancy.candidates.slice(0, 3).map((c) => `${c.key} ${c.counts.entities}/${c.counts.of}`);
    L.push(`- no tenant key: no identifier field reaches 3 entities and 10% with a request source (closest: ${near.join(', ') || 'none'})`);
  }
  for (const p of f.noRequestPaths.slice(0, 8))
    L.push(`- ${p.kind} ${p.method} reaches ${p.reaches}; tenant context ${p.setsContext ? 'set' : 'NOT set'}`);
  if (f.noRequestPaths.length > 8) L.push(`- +${f.noRequestPaths.length - 8} more no-request paths in facts.json`);

  sec('Security model (prefixes, user sources, tenant; copy into "How security works")');
  for (const p of (f.securityModel?.prefixes ?? []).slice(0, 14))
    L.push(`- ${p.prefix}: ${p.access} — ${p.endpoints} endpoint(s)${p.checked ? `, ${p.checked} use ${p.checks[0]}` : ''} (e.g. ${p.example})`);
  if ((f.securityModel?.prefixes ?? []).length > 14) L.push(`- +${f.securityModel.prefixes.length - 14} more prefixes in facts.json`);
  if (f.securityModel?.userSources.length)
    L.push(`- the user comes from: ${f.securityModel.userSources.map((u) => `${u.kind} (${u.cites[0]})`).join('; ')}`);
  if (f.securityModel?.tenant) L.push(`- the tenant is ${f.securityModel.tenant.key} (linked in the Tenancy section)`);
  for (const d of (f.securityModel?.developerRule ?? []).slice(0, 6)) L.push(`- ${d.text}`);

  sec('Boot, computed (copy into the map; open files only if a line looks wrong)');
  for (const l of f.boot.computed) L.push(`- ${l}`);
  sec('Boot details (entry points, profile switches)');
  for (const m of f.boot.mains) L.push(`- main ${m.file}:${m.line ?? ''}`);
  for (const e of f.boot.frontend.slice(0, 6))
    L.push(
      `- frontend ${e.file}: ${e.lines
        .slice(0, 4)
        .map((l) => `${l.line} ${l.text.slice(0, 80)}`)
        .join(' | ')}`,
    );
  if (f.boot.profiles.length) L.push(`- profile configs: ${f.boot.profiles.join(', ')}`);
  for (const s of f.boot.switches.slice(0, 12)) L.push(`- switch ${s.file}:${s.line} ${s.text}`);
  for (const c of f.boot.compose) L.push(`- compose ${c.file}: ${c.services.join(', ')}`);
  for (const s of f.boot.scripts)
    if (Object.keys(s.scripts).length)
      L.push(
        `- scripts ${s.file}: ${Object.entries(s.scripts)
          .filter(([k]) => /^(dev|start|serve|build)$/.test(k))
          .map(([k, v]) => `${k}=${v}`)
          .join('; ')}`,
      );
  // Shortlisted entities only: the full write sites stay in facts.json (stateWrites).
  sec('State (which methods write each shortlisted entity; caches)');
  const top = new Set(
    [...f.entities.model].sort((a, b) => b.relations.length - a.relations.length).slice(0, 15).map((e) => e.name),
  );
  const byEntity = new Map();
  for (const w of f.stateWrites) {
    const short = (w.entity ?? 'no entity').split('.').pop();
    if (!top.has(short)) continue;
    const cite = (w.evidence?.[0] ?? '').replace(/#.*$/, '');
    if (!byEntity.has(short)) byEntity.set(short, new Map());
    const files = byEntity.get(short);
    files.set(cite, (files.get(cite) ?? 0) + 1);
  }
  for (const [e, sites] of [...byEntity.entries()].sort((a, b) => b[1].size - a[1].size)) {
    const files = [...sites.entries()].map(([f, n]) => `${f}${n > 1 ? ` (+${n - 1})` : ''}`);
    L.push(
      `- ${e} written from ${sites.size} site(s): ${files.slice(0, 8).join(' ; ')}${files.length > 8 ? ` ; +${files.length - 8} more in facts.json` : ''}`,
    );
  }
  const mod = {};
  for (const m of f.state.modifying) (mod[m.entity] ??= []).push(m.line);
  for (const [e, ls] of Object.entries(mod).filter(([e]) => top.has(e)))
    L.push(
      `- ${e}: ${ls.length} @Modifying quer${ls.length > 1 ? 'ies' : 'y'} in ${f.state.modifying.find((m) => m.entity === e).file}:${ls.join(',')}`,
    );
  if (f.stateCaches.length)
    L.push(
      `- caches: ${f.stateCaches.length} cache annotation(s), e.g. ${f.stateCaches.slice(0, 5).map((c) => `${c.action} ${c.method}`).join(', ')}`,
    );
  sec('Transaction boundaries, computed (each must be listed in the map or dismissed on purpose)');
  // Ranked: half-done outside effects first, then the rest; money-related methods float up.
  const seamRank = (t) =>
    (t.kind === 'outside-then-save' ? 4 : t.kind === 'outside-in-transaction' ? 3 : 2) +
    (/Stripe|[Cc]harge|[Rr]efund|[Pp]ayment|[Ii]nvoice|[Oo]rder/.test(t.method) ? 2 : 0) -
    // A read that runs in a transaction with an outside call is a smaller seam than a write: rank it below.
    (/^[a-z0-9]+#(?:get|list|find|read|count|exists|search)/i.test(t.method ?? '') ? 2 : 0);
  const seamText = (t) => {
    const at = t.evidence?.[0]?.replace(/#.*$/, '') ?? t.method;
    const short = (t.method ?? '').split('.').pop();
    // Lead with the nouns that matter and keep the sentence short: this line is cut at 300 characters, and the
    // project service that made the call is the first thing a reader needs.
    if (t.kind === 'outside-in-transaction')
      return `OUTSIDE CALL IN TRANSACTION ${short} (${at}): ${(t.outside ?? []).join('; ')}. A rollback does not undo the outside side.`;
    if (t.kind === 'outside-then-save')
      return `OUTSIDE CALL THEN SAVE, NO TRANSACTION ${short} (${at}): ${(t.outside ?? []).join('; ')}; then ${(t.saves ?? []).join('; ')}.`;
    if (t.kind === 'requires-new') return `NEW TRANSACTION ${short} (${at}): commits on its own, even if the caller rolls back.`;
    if (t.kind === 'after-commit')
      return `AFTER COMMIT ${short} (${at}): ${t.mechanism === 'synchronization' ? (t.runs ?? []).join(', ') || 'code' : t.mechanism} runs once the transaction commits; a failure is not rolled back.`;
    return null;
  };
  const seams = f.transactions.filter((t) => t.kind !== 'transactional').sort((a, b) => seamRank(b) - seamRank(a));
  // Group by class: a service with seven boundary methods is one line naming the class, the count, the kinds, and the
  // strongest method as the example. Every method stays in facts.json.
  const seamGroups = new Map();
  for (const t of seams) {
    const cls = (t.method ?? '').split('#')[0].split('.').pop();
    if (!seamGroups.has(cls)) seamGroups.set(cls, []);
    seamGroups.get(cls).push(t);
  }
  const seamLines = [...seamGroups.entries()].map(([cls, list]) => {
    const kinds = [...new Set(list.map((t) => t.kind))];
    const best = list[0];
    return `- ${cls} ×${list.length}${kinds.length > 1 ? ` (${kinds.join(', ')})` : ''}: ${seamText(best)}`;
  });
  push(cap(ellSteps(seamLines, 300), 12, 'transactions'));
  const txTotal = f.transactionCounts.reduce((n, x) => n + x.count, 0);
  L.push(
    `- ${txTotal} transactional method(s) in ${f.transactionCounts.length} class(es); ${f.outsideCalls.length} outside call(s) across ${new Set(f.outsideCalls.map((c) => c.method)).size} method(s)`,
  );
  if (f.transactionCounts.length)
    L.push(
      `- most transactional classes: ${f.transactionCounts
        .slice(0, 5)
        .map((x) => `${x.type.split('.').pop()} ${x.count}`)
        .join(', ')}${f.transactionCounts.length > 5 ? `, +${f.transactionCounts.length - 5} more in facts.json` : ''}`,
    );
  if (!seams.length) L.push('- no transaction seam found');
  sec(
    'Flows, computed and ranked (entry point → every effect it reaches; the bracket is the rank, the parentheses are its parts)',
  );
  // Flows grouped by entry class, like the seams: the class, its count, the best flow in full. The effects (and so any
  // outside call's name) come before the steps, because the line is cut and a trimmed tail must not hide them.
  const flowGroups = new Map();
  for (const x of f.flows) {
    const cls = (x.entry.cite.split('/').pop() ?? '').split(':')[0];
    if (!flowGroups.has(cls)) flowGroups.set(cls, []);
    flowGroups.get(cls).push(x);
  }
  const flowLines = [...flowGroups.entries()].map(([cls, list]) => {
    const x = list[0];
    const head = x.entry.verb ? `${x.entry.verb} ${x.entry.path}` : x.entry.kind;
    const parts = x.why.map((w) => w.replace(/\s*\([^)]*\)/, '')).join(', ');
    const effects = [...new Set(x.effects.map((e) => e.label))].join(', ');
    // Effects before the parts: the line is cut, and an outside call's name must survive the cut.
    return `- ${cls} ×${list.length}${list.length > 1 ? ` (best ${x.score})` : ''}: [${x.score}] ${head} ${x.entry.cite} effects: ${effects || 'none'} (${parts}) | ${x.steps.join('; ')}`;
  });
  push(cap(ell(flowLines, 340), 12, 'flows'));
  sec('Lifecycles, computed (every place each status is set; cite these instead of searching)');
  push(
    cap(
      f.lifecycle.map((x) => (x.startsWith('  ') ? `  -${x.slice(1)}` : `- ${x}`)),
      80,
      'lifecycle',
    ),
  );
  sec('Schedules and retries, computed (plain-language timing; copy into "What runs on its own")');
  push(
    cap(
      f.schedules.map((x) => `- ${x}`),
      30,
      'schedules',
    ),
  );
  sec('Recurring work that is not @Scheduled (fixed rate/delay submissions, wheel timers, project schedulers)');
  push(
    cap(
      f.recurring.map((r) => `- ${r.mechanism} in ${r.method} (${r.evidence[0]})${r.confidence === 'inferred' ? ' [shape]' : ''}`),
      12,
      'recurring',
    ),
  );
  sec('Runs on its own (async, listeners, sockets; scheduled jobs are listed above)');
  push(
    cap(
      f.background.scheduledAsyncListeners
        .filter((b) => b.kind !== 'Scheduled' && b.kind !== 'Schedule')
        .map((b) =>
          b.kind === 'Batch job'
            ? `- batch job ${b.args} ${b.file}`
            : `- @${b.kind}${b.args ? ' ' + b.args.slice(0, 50) : ''} ${b.file}:${b.line}`,
        ),
      30,
      'background',
    ),
  );
  for (const s of f.background.sockets) L.push(`- socket ${s.file}:${s.line} ${s.path ?? s.text}`);
  for (const r of f.background.runners) L.push(`- startup runner ${r.file}:${r.line}`);
  const out = ab(L.join('\n')).replace('@@J@@', J).replace('@@F@@', F).split('@@I@@').join(I) + '\n';
  return out.length > 70_000
    ? out.replace(
        '\n',
        `\n**Over the 70 KB digest budget (${Math.round(out.length / 1024)} KB): read sections selectively.**\n`,
      )
    : out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  retuneHeap();
  const root = path.resolve(process.argv[2] ?? '.');
  const out = path.resolve(process.argv[3] ?? path.join(root, 'mindmodel', '.work', 'facts.json'));
  const facts = scan(root);
  // Right before the writer: create the scratch folder (self-ignoring) and move any previous map out of its path.
  ensureWork(root);
  const retired = retirePreviousMap(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(facts, null, 1));
  fs.writeFileSync(out.replace(/\.json$/, '.md'), summarize(facts));
  const f = facts;
  console.log(
    `wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB): ${f.entities.count} entities, ${f.endpoints.length} endpoints, ${f.frontend.apiCalls} frontend API calls (${f.frontend.unmatchedApiCalls.length} unmatched), ${f.views.count} views, ${f.background.scheduledAsyncListeners.length} scheduled/async/listeners, ${f.securityRules.length} security rules, ${f.recurring.length} recurring job(s), ${f.securityRules.length} security rule(s), ${f.securityWarnings.length} security warning(s), ${f.docs.length} docs, git ${f.git ? f.git.head + (f.git.dirty ? '+dirty' : '') + ' window=' + (f.git.window?.since ?? 'none') : 'none'}`,
  );
  if (retired) console.log(`previous map kept at ${retired}`);
}
