// facts.md: the compact digest the writer reads first. facts.json keeps the details. Each section is one function;
// summarize() calls them in the order the digest prints them.
import assert from 'node:assert';
import path from 'node:path';
import { checkSummary } from '../extract/security.mjs';
import { budgetLine, DIGEST_WARN_CHARS } from '../budget.mjs';

// The budget line is built in budget.mjs; scan.mjs imports it from here.
export { budgetLine };

// --- Digest caps: how many items each section lists. A list over its cap prints "+N more in facts.json" -------------
// These are not writer budgets (budget.mjs owns those). A digest lists more than the writer keeps, so it can choose.
const DIGEST_CAPS = {
  // Line lengths, in characters. Transaction lines are cut between steps, never inside one. Effects come before the
  // steps, so a flow cut never hides an outside call's name.
  SEAM_CHARS: 300,
  FLOW_CHARS: 340,
  ARGS_CHARS: 50,
  FRONTEND_LINE_CHARS: 80,

  // Build, classpath, docs and packages.
  UNRESOLVED_MODULES: 4,
  UNKNOWN_ANNOTATIONS: 6,
  UNKNOWN_BASE_CLASSES: 8,
  UNCATALOGUED_DEPS: 10,
  GENERATED_PACKAGES: 2,
  BUILD_FILES: 8,
  BUILD_DEPS: 20,
  DOCS: 40,
  PACKAGE_MODULES: 30,
  FOLDERS_SHOWN: 8,

  // Entities, enums, controllers and frontend.
  ENTITIES_SHOWN: 15, // also how many entities the State section shortlists
  RELATIONS_SHOWN: 6,
  KEYS_SHOWN: 8,
  ENUMS: 40,
  CONTROLLER_LINES: 60, // above this many controllers, the endpoints are grouped by path
  ENDPOINT_GROUPS: 50,
  PATH_PREFIXES: 3,
  EXAMPLE_CONTROLLERS: 2,
  ROUTES: 60,

  // Request machinery and runtime.
  SECURITY_RULES: 20,
  SECURITY_WARNINGS: 12,
  TENANT_SOURCES: 8,
  INTERCEPTORS: 30,
  CONTEXT_SCOPES: 20,
  SESSION_STATE: 20,

  // Tenancy, security model and boot.
  TENANCY_NAMES: 10,
  REQUEST_KEY_SOURCES: 3,
  GLOBAL_LOOKUPS: 4,
  UNSCOPED_REPOS: 8,
  TENANT_CANDIDATES: 3,
  NO_REQUEST_PATHS: 8,
  PREFIXES: 14,
  DEVELOPER_RULES: 6,
  FRONTEND_ENTRIES: 6,
  FRONTEND_LINES: 4,
  SWITCHES: 12,

  // State, transactions, flows and work that runs on its own.
  STATE_SITES: 8,
  CACHE_EXAMPLES: 5,
  SEAMS: 12,
  TX_CLASSES: 5,
  FLOWS: 12,
  LIFECYCLE: 80,
  SCHEDULES: 30,
  RECURRING: 12,
  BACKGROUND: 30,
};
const PREFIX_ALIAS_MIN = 8; // a path prefix longer than this is written as J/ or F/

// --- Helpers ---------------------------------------------------------------------------------------------------------

// A section: a blank line, its heading, then its lines. The heading prints even when the list is empty.
const sec = (heading, lines = []) => ['', `## ${heading}`, ...lines];

const cap = (list, n, where) =>
  list.length > n ? [...list.slice(0, n), `- +${list.length - n} more in facts.json (${where})`] : list;

// A digest line is read, not parsed: a long line is cut with a marker and the rest stays in facts.json.
// Transaction lines are lists of steps, so they are cut only between steps.
const ellSteps = (list, n) =>
  list.map((l) => {
    if (l.length <= n) return l;
    const cut = l.slice(0, n - 1);
    const at = cut.lastIndexOf('; ');
    return at > n * 0.5 ? `${cut.slice(0, at + 1)}…` : l;
  });

const ell = (list, n) =>
  list.map((l) => {
    if (l.length <= n) return l;
    // Cut at a boundary: a line that ends inside `RestTemplate.postForEntity(` reads like a different call.
    const cut = l.slice(0, n - 1);
    const at = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(' '));
    return `${cut.slice(0, at > n * 0.6 ? at : cut.length)}…`;
  });

// The directory prefix that every path starts with.
const prefix = (list) => {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, p.lastIndexOf('/', p.length - 2) + 1);
  return p;
};

// The path aliases of one digest: J is the project prefix, F the frontend prefix, I the folder inside each module.
function pathAliases(f) {
  const J = prefix(f.packages.map((p) => p.dir + '/'));
  const F = prefix(
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
    J.length > PREFIX_ALIAS_MIN
      ? ''
      : (Object.entries(innerCount)
          .filter(([, n]) => n >= total * 0.6)
          .sort((a, b) => b[0].length - a[0].length)[0]?.[0] ?? '');
  const ab = (s) => {
    const t = String(s)
      .split(J)
      .join(J.length > PREFIX_ALIAS_MIN ? 'J/' : J)
      .split(F)
      .join(F.length > PREFIX_ALIAS_MIN ? 'F/' : F);
    return I ? t.split(I).join('~/') : t;
  };
  return { J, F, I, ab };
}

// One digest line for the run's classpath: `maven offline, 412 jars, 2 modules unresolved (x, y)`, or
// `none (no mvn on PATH)`. Null when the facts carry no classpath section at all.
function classpathLine(cp) {
  if (!cp) return null;
  const modules = (cp.failedModules ?? []).map((m) => m.module);
  if (cp.mode === 'none')
    return `- classpath: none${cp.reason ? ` — ${cp.reason}` : ''} — library types unresolved`;
  const parts = [`- classpath: ${cp.mode.replace('-offline', ' offline')}`, `${cp.jars} jar(s)`];
  if (cp.generatedSources) parts.push(`${cp.generatedSources} generated source root(s)`);
  if (modules.length) {
    const shown = modules.slice(0, DIGEST_CAPS.UNRESOLVED_MODULES).join(', ');
    const more = modules.length > DIGEST_CAPS.UNRESOLVED_MODULES
      ? `, +${modules.length - DIGEST_CAPS.UNRESOLVED_MODULES}`
      : '';
    parts.push(`${modules.length} module(s) unresolved (${shown}${more})`);
  }
  return parts.join(', ');
}

// --- Sections --------------------------------------------------------------------------------------------------------

// The first lines: the title, the path note, coverage and the budget.
function header(f) {
  return [
    `# facts for ${path.basename(f.root)} (scanned ${f.scannedAt})`,
    "Paths are relative to the project root. Details: facts.json (search it, don't read it whole).",
    ...(f.coverage?.line ? [`**Coverage:** ${f.coverage.line}`] : []),
    budgetLine(f.endpoints.length),
  ];
}

// The blind spots by name: a writer checks the code behind anything listed here before claiming it (rule P4a).
// The classpath is always listed, so a "no store found" note can be told from a limit of the run.
function understoodSection(f, cx) {
  const blind = [];
  const cp = classpathLine(f.classpath);
  if (cp) blind.push(cp);
  const c = f.coverage;
  if (c) {
    if (c.unknownAnnotations?.length) {
      const shown = c.unknownAnnotations.slice(0, DIGEST_CAPS.UNKNOWN_ANNOTATIONS);
      const top = shown.map((u) => `${u.name}×${u.count} (${cx.ab(u.samples[0])})`);
      const more = c.unknownAnnotations.length > DIGEST_CAPS.UNKNOWN_ANNOTATIONS
        ? `; +${c.unknownAnnotations.length - DIGEST_CAPS.UNKNOWN_ANNOTATIONS} more in facts.json`
        : '';
      blind.push(`- unknown annotations: ${top.join('; ')}${more}`);
    }
    if (c.unknownBaseClasses?.length) {
      const top = c.unknownBaseClasses.slice(0, DIGEST_CAPS.UNKNOWN_BASE_CLASSES).map((b) => `${b.name}×${b.count}`);
      const more = c.unknownBaseClasses.length > DIGEST_CAPS.UNKNOWN_BASE_CLASSES
        ? `, +${c.unknownBaseClasses.length - DIGEST_CAPS.UNKNOWN_BASE_CLASSES}`
        : '';
      blind.push(`- base classes no catalog explains: ${top.join(', ')}${more}`);
    }
    if (c.uncataloguedDependencies?.length) {
      const deps = c.uncataloguedDependencies;
      const shown = Math.min(DIGEST_CAPS.UNCATALOGUED_DEPS, deps.length);
      const top = deps.slice(0, DIGEST_CAPS.UNCATALOGUED_DEPS).map((d) => `${d.coordinate} ${d.files}`);
      const more = c.uncataloguedDependenciesTotal > shown
        ? `, +${c.uncataloguedDependenciesTotal - shown} more in facts.json`
        : '';
      blind.push(`- uncatalogued dependencies (by files importing them): ${top.join(', ')}${more}`);
    }
    const langs = Object.entries(c.unparsedLanguages ?? {}).filter(([, n]) => n > 0);
    if (langs.length) {
      const shown = langs.map(([k, n]) => `${k} ${n}`).join(', ');
      blind.push(`- source files the model cannot read: ${shown}`);
    }
    if (c.generatedSources?.length) {
      const gen = c.generatedSources.map((g) => {
        const pkgs = g.packages.length ? ` -> ${g.packages.slice(0, DIGEST_CAPS.GENERATED_PACKAGES).join(', ')}` : '';
        return `${g.file}: ${g.plugin}${pkgs}`;
      });
      blind.push(`- generated code (not hand-written): ${gen.join('; ')}`);
    }
    if (c.degradedFiles?.length) blind.push(`- files that failed to parse: ${c.degradedFiles.length}`);
  }
  return blind.length ? sec('What the engine did not understand', blind) : [];
}

// The path aliases, explained only when used.
function aliasLegend({ J, F, I }) {
  const lines = [];
  if (J.length > PREFIX_ALIAS_MIN) lines.push('**J/ = @@J@@**');
  if (I) lines.push('**~/ = @@I@@** (inside each module: "mod/~/x" means "mod/@@I@@x")');
  if (F.length > PREFIX_ALIAS_MIN) lines.push('**F/ = @@F@@**');
  lines.push('Expand J/, F/ and ~/ to the full path in every citation.');
  return lines;
}

function gitSection(f) {
  if (!f.git) return sec('Git', ['no git history']);
  const { head, dirty, totalCommits, window: w } = f.git;
  const span = w ? `${w.since} (${w.commits} commits)` : 'none (too few commits)';
  const state = `HEAD ${head}${dirty ? ' + local changes' : ''}`;
  return sec('Git', [`${state}; ${totalCommits} commits; activity window: ${span}`]);
}

function buildSection(f) {
  const builds = f.build.map((b) => {
    const deps = b.deps ?? [];
    const shown = deps.slice(0, DIGEST_CAPS.BUILD_DEPS).map((d) => `${d.group}:${d.artifact}`).join(', ');
    const more = deps.length > DIGEST_CAPS.BUILD_DEPS ? `, +${deps.length - DIGEST_CAPS.BUILD_DEPS}` : '';
    const plugins = b.plugins?.length ? ` (plugins: ${b.plugins.map((p) => p.id).join(', ')})` : '';
    return `- ${b.file}: ${shown}${more}${plugins}`;
  });
  const externals = Object.entries(f.externals.sdkImports).map(([k, v]) => `- ${k}: ${v.join(', ')}`);
  const configs = f.externals.config.map(
    (c) => `- config ${c.file}${c.db ? ` (db: ${c.db})` : ''}: ${c.keys.length} keys (names only in facts.json)`,
  );
  return sec('Build & externals', [...cap(builds, DIGEST_CAPS.BUILD_FILES, 'build'), ...externals, ...configs]);
}

function docsSection(f) {
  const docs = f.docs.map((d) => `- ${d.file} (${d.kb} KB)${d.title ? ' · ' + d.title : ''}`);
  return sec(`Docs (${f.docs.length})`, cap(docs, DIGEST_CAPS.DOCS, 'docs'));
}

function packagesSection(f, cx) {
  const mods = {};
  for (const p of f.packages) {
    const r = p.dir.startsWith(cx.J) ? p.dir.slice(cx.J.length) : p.dir;
    const [m, ...sub] = r.split('/');
    (mods[m || '.'] ??= []).push(`${sub.join('/') || '.'} ${p.javaFiles}`);
  }
  const lines = Object.entries(mods).map(([m, subs]) => {
    const top = subs.map((x) => [x, Number(x.split(' ').pop())]).sort((a, b) => b[1] - a[1]);
    const folders = top.slice(0, DIGEST_CAPS.FOLDERS_SHOWN).map(([x]) => x).join(', ');
    const more = top.length > DIGEST_CAPS.FOLDERS_SHOWN ? `, +${top.length - DIGEST_CAPS.FOLDERS_SHOWN} folders` : '';
    return `- ${m}: ${top.reduce((n, [, c]) => n + c, 0)} files; ${folders}${more}`;
  });
  return sec('Packages (java files per module/subfolder)', cap(lines, DIGEST_CAPS.PACKAGE_MODULES, 'packages'));
}

const entityLine = (e, cx) => {
  const rels = e.relations.length ? ': ' + e.relations.slice(0, DIGEST_CAPS.RELATIONS_SHOWN).join('; ') : '';
  const unique = e.unique?.length ? ` · unique ${e.unique.join(', ')}` : '';
  const keys = e.keys.slice(0, DIGEST_CAPS.KEYS_SHOWN).join(', ');
  return (
    `- ${e.name} ${cx.ab(`${e.file}:${e.line}`)} table ${e.table} · ${e.relations.length} relation(s)${rels}` +
    ` · keys ${keys}${unique}`
  );
};

function entitiesSection(f, cx) {
  const models = f.entities.model;
  const lines = [...models]
    .sort((a, b) => b.relations.length - a.relations.length)
    .slice(0, DIGEST_CAPS.ENTITIES_SHOWN)
    .map((e) => entityLine(e, cx));
  const hidden = models.length - DIGEST_CAPS.ENTITIES_SHOWN;
  const more = hidden > 0 ? [`- +${hidden} more in facts.json`] : [];
  return sec(`Entities (${models.length}; from the model: table, relations, keys)`, [...lines, ...more]);
}

function enumsSection(f) {
  const enums = f.entities.enums.map((e) => `- ${e.name} ${e.file}:${e.line}: ${e.values.join(' ')}`);
  return sec('Enums', cap(enums, DIGEST_CAPS.ENUMS, 'entities.enums'));
}

function controllersSection(f) {
  const byCtl = {};
  for (const e of f.endpoints) {
    const k = e.inheritedBy ?? e.file;
    (byCtl[k] ??= []).push(e);
  }
  const ctl = Object.entries(byCtl).map(([file, eps]) => {
    const verbs = [...new Set(eps.map((e) => e.verb))].join('/');
    const paths = [...new Set(eps.map((e) => e.path.split('/').slice(0, 4).join('/')))];
    return `- ${file}: ${eps.length} (${verbs}) ${paths.slice(0, DIGEST_CAPS.PATH_PREFIXES).join(' ')}`;
  });
  const heading = `Controllers (${f.endpoints.length} endpoints)`;
  if (ctl.length <= DIGEST_CAPS.CONTROLLER_LINES) return sec(heading, ctl);
  const byBase = {};
  for (const e of f.endpoints) {
    const k = e.path.split('/').slice(0, 3).join('/') || '/';
    (byBase[k] ??= new Set()).add(e.inheritedBy ?? e.file);
  }
  const groups = Object.entries(byBase)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([k, files]) => {
      const examples = [...files].slice(0, DIGEST_CAPS.EXAMPLE_CONTROLLERS).join(', ');
      return `- ${k}/**: ${files.size} controller(s), e.g. ${examples}`;
    });
  return sec(heading, cap(groups, DIGEST_CAPS.ENDPOINT_GROUPS, 'endpoints'));
}

function frontendSection(f) {
  const unmatched = f.frontend.unmatchedApiCalls;
  const lines = [
    `${f.frontend.files} files; ${f.frontend.apiCalls} API call sites matched to endpoints in facts.json ` +
      `(frontend.apiJoin); unmatched: ${unmatched.length ? unmatched.join(' | ') : 'none'}`,
    ...cap(
      f.frontend.routes.map((r) => `- route ${r.path} ${r.file}:${r.line}`),
      DIGEST_CAPS.ROUTES,
      'frontend.routes',
    ),
  ];
  if (f.views.count) {
    const returned = Object.keys(f.views.returnedBy).length;
    lines.push(
      `${f.views.count} server-rendered views; returned by controllers: ${returned}; ` +
        `never returned or included (dead?): ${f.views.deadViews.join(', ') || 'none'}`,
    );
  }
  return sec('Frontend', lines);
}

function requestMachinerySection(f) {
  const rules = f.securityRules.map(
    (r) =>
      `- ${r.pattern}: ${r.access === 'anonymous' ? 'anonymous allowed' : r.access} ` +
      `(${r.source} ${r.chain} ${r.evidence[0]})`,
  );
  return sec('Request machinery', cap(rules, DIGEST_CAPS.SECURITY_RULES, 'securityRules'));
}

function anonymousWarningsSection(f, cx) {
  const warnings = f.securityWarnings.filter((w) => w.kind !== 'client-asserted-identity');
  if (!warnings.length) return [];
  const byRule = new Map();
  for (const w of warnings) {
    if (!byRule.has(w.rule)) byRule.set(w.rule, []);
    byRule.get(w.rule).push(w);
  }
  const lines = [...byRule.entries()].map(([rule, list]) => {
    const example = list[0];
    const where = example.evidence?.[0] ? ` (${cx.ab(example.evidence[0])})` : '';
    return (
      `- ${rule.split(' is ')[0]} allows anonymous writes: ${list.length} endpoint(s), ` +
      `e.g. ${example.verb} ${example.path} (${example.handler})${where} — no @PreAuthorize/@Secured/@RolesAllowed`
    );
  });
  return sec(
    'Security warnings, computed (a prefix allows anonymous access and exposes writes with no method-level check)',
    cap(lines, DIGEST_CAPS.SECURITY_WARNINGS, 'securityWarnings'),
  );
}

function identityWarningsSection(f) {
  const warnings = f.securityWarnings.filter((w) => w.kind === 'client-asserted-identity');
  if (!warnings.length) return [];
  const lines = warnings.map(
    (w) =>
      `- ${w.method} takes the caller from ${w.source} (${w.evidence[0]}) and ${w.holder} stores it unverified — ` +
      'any client can claim that identity',
  );
  return sec(
    'Security warnings, computed (a request value becomes the caller with no verification call)',
    cap(lines, DIGEST_CAPS.SECURITY_WARNINGS, 'securityWarnings'),
  );
}

// Carries no heading of its own: it lists under the security heading above.
function tenantSourceLines(f) {
  const lines = f.tenantSources.length
    ? f.tenantSources.map((t) => `- tenant from ${t.kind} ${t.name} (${t.method} ${t.evidence[0]})`)
    : [`- ${f.tenantSourcesNote}`];
  return cap(lines, DIGEST_CAPS.TENANT_SOURCES, 'tenantSources');
}

// Carries no heading of its own: it lists under the security heading above.
function runtimeLines(f) {
  const r = f.runtime;
  return [
    ...cap(
      r.interceptors.map((s) => `- interceptor/filter ${s.file}:${s.line} ${s.text}`),
      DIGEST_CAPS.INTERCEPTORS,
      'runtime.interceptors',
    ),
    ...cap(
      r.contextScopes.map((s) => `- context ${s.file}:${s.line} ${s.text}`),
      DIGEST_CAPS.CONTEXT_SCOPES,
      'runtime.contextScopes',
    ),
    ...(r.exceptionHandlers.length
      ? [`- @ExceptionHandler in ${r.exceptionHandlers.length} files (list in facts.json)`]
      : []),
    ...r.baseClasses.map((b) => `- base class ${b.base}: ${b.subclasses} subclasses`),
    ...r.sessionState.slice(0, DIGEST_CAPS.SESSION_STATE).map((s) => `- session ${s.file}:${s.line} ${s.text}`),
  ];
}

// The key decided by counts, its coverage, the reads that skip it, and the code without a request.
function tenantKeyLines(t) {
  const lines = [
    `- key ${t.key}: ${t.counts.entities} of ${t.counts.of} entities (${t.counts.percent}%), ` +
      `${t.counts.filteredMethods} of ${t.counts.repoMethods} repository reads filter by it ` +
      `(${t.counts.filteredPercent}%) — inferred`,
  ];
  const src = t.sources.slice(0, DIGEST_CAPS.REQUEST_KEY_SOURCES).map((s) => `${s.kind} ${s.name} (${s.method})`);
  if (src.length) lines.push(`- the request carries it: ${src.join(', ')}`);
  const withKey = t.coverage.withKey;
  const withMore = withKey.length > DIGEST_CAPS.TENANCY_NAMES ? ` +${withKey.length - DIGEST_CAPS.TENANCY_NAMES}` : '';
  lines.push(`- with the key: ${withKey.slice(0, DIGEST_CAPS.TENANCY_NAMES).join(', ')}${withMore}`);
  const no = t.coverage.withoutKey.filter((n) => /Monitor|Alert|Group|Dashboard|Metric|Collect|Job|Task|Agent/.test(n));
  const noMore = no.length > DIGEST_CAPS.TENANCY_NAMES ? ` +${no.length - DIGEST_CAPS.TENANCY_NAMES}` : '';
  if (no.length)
    lines.push(
      `- without it: ${no.slice(0, DIGEST_CAPS.TENANCY_NAMES).join(', ')}${noMore} ` +
        `— reads of these are not scoped by ${t.key}`,
    );
  if (t.globalLookups?.length) {
    const shown = t.globalLookups
      .slice(0, DIGEST_CAPS.GLOBAL_LOOKUPS)
      .map((g) => `${g.repo}#${g.method} (${g.uniqueField})`);
    lines.push(`- global lookups by unique key (not unscoped): ${t.globalLookups.length}, e.g. ${shown.join('; ')}`);
  }
  if (t.unscopedByRepo.length) {
    const shown = t.unscopedByRepo.slice(0, DIGEST_CAPS.UNSCOPED_REPOS).map((r) => {
      const first = t.unscoped.find((u) => u.repo === r.repo);
      return `${r.repo} ×${r.n} (e.g. ${first.query})`;
    });
    const more = t.unscopedByRepo.length > DIGEST_CAPS.UNSCOPED_REPOS
      ? `; +${t.unscopedByRepo.length - DIGEST_CAPS.UNSCOPED_REPOS} repositories in facts.json`
      : '';
    lines.push(`- unscoped reads, by repository: ${shown.join('; ')}${more}`);
  }
  return lines;
}

function noTenantKeyLines(t) {
  const near = t.candidates
    .slice(0, DIGEST_CAPS.TENANT_CANDIDATES)
    .map((c) => `${c.key} ${c.counts.entities}/${c.counts.of}`);
  return [
    '- no tenant key: no identifier field reaches 3 entities and 10% with a request source ' +
      `(closest: ${near.join(', ') || 'none'})`,
  ];
}

function noRequestPathLines(paths) {
  const lines = paths
    .slice(0, DIGEST_CAPS.NO_REQUEST_PATHS)
    .map((p) => `- ${p.kind} ${p.method} reaches ${p.reaches}; tenant context ${p.setsContext ? 'set' : 'NOT set'}`);
  if (paths.length > DIGEST_CAPS.NO_REQUEST_PATHS)
    lines.push(`- +${paths.length - DIGEST_CAPS.NO_REQUEST_PATHS} more no-request paths in facts.json`);
  return lines;
}

function tenancySection(f) {
  const t = f.tenancy;
  const lines = t.key ? tenantKeyLines(t) : noTenantKeyLines(t);
  return sec(
    'Tenancy (the key is inferred from counts, never from the name)',
    [...lines, ...noRequestPathLines(f.noRequestPaths)],
  );
}

function securityModelSection(f) {
  const m = f.securityModel;
  const prefixes = m?.prefixes ?? [];
  const lines = prefixes.slice(0, DIGEST_CAPS.PREFIXES).map(
    (p) =>
      `- ${p.prefix}: ${p.access} — ${p.endpoints} endpoint(s)${p.checked ? `, ${checkSummary(p)}` : ''} ` +
      `(e.g. ${p.example})`,
  );
  if (prefixes.length > DIGEST_CAPS.PREFIXES)
    lines.push(`- +${prefixes.length - DIGEST_CAPS.PREFIXES} more prefixes in facts.json`);
  if (m?.userSources.length)
    lines.push(`- the user comes from: ${m.userSources.map((u) => `${u.kind} (${u.cites[0]})`).join('; ')}`);
  if (m?.tenant) lines.push(`- the tenant is ${m.tenant.key} (linked in the Tenancy section)`);
  for (const d of (m?.developerRule ?? []).slice(0, DIGEST_CAPS.DEVELOPER_RULES)) lines.push(`- ${d.text}`);
  return sec('Security model (prefixes, user sources, tenant; copy into "How security works")', lines);
}

function bootComputedSection(f) {
  return sec(
    'Boot, computed (copy into the map; open files only if a line looks wrong)',
    f.boot.computed.map((l) => `- ${l}`),
  );
}

const scriptsLine = (s) => {
  const picked = Object.entries(s.scripts)
    .filter(([k]) => /^(dev|start|serve|build)$/.test(k))
    .map(([k, v]) => `${k}=${v}`);
  return `- scripts ${s.file}: ${picked.join('; ')}`;
};

function bootDetailsSection(f) {
  const b = f.boot;
  const frontend = b.frontend.slice(0, DIGEST_CAPS.FRONTEND_ENTRIES).map((e) => {
    const lines = e.lines
      .slice(0, DIGEST_CAPS.FRONTEND_LINES)
      .map((l) => `${l.line} ${l.text.slice(0, DIGEST_CAPS.FRONTEND_LINE_CHARS)}`);
    return `- frontend ${e.file}: ${lines.join(' | ')}`;
  });
  return sec('Boot details (entry points, profile switches)', [
    ...b.mains.map((m) => `- main ${m.file}:${m.line ?? ''}`),
    ...frontend,
    ...(b.profiles.length ? [`- profile configs: ${b.profiles.join(', ')}`] : []),
    ...b.switches.slice(0, DIGEST_CAPS.SWITCHES).map((s) => `- switch ${s.file}:${s.line} ${s.text}`),
    ...b.compose.map((c) => `- compose ${c.file}: ${c.services.join(', ')}`),
    ...b.scripts.filter((s) => Object.keys(s.scripts).length).map(scriptsLine),
  ]);
}

function stateSection(f) {
  // Shortlisted entities only: the full write sites stay in facts.json (stateWrites).
  const top = new Set(
    [...f.entities.model]
      .sort((a, b) => b.relations.length - a.relations.length)
      .slice(0, DIGEST_CAPS.ENTITIES_SHOWN)
      .map((e) => e.name),
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
  const lines = [];
  for (const [e, sites] of [...byEntity.entries()].sort((a, b) => b[1].size - a[1].size)) {
    const files = [...sites.entries()].map(([file, n]) => `${file}${n > 1 ? ` (+${n - 1})` : ''}`);
    const more = files.length > DIGEST_CAPS.STATE_SITES
      ? ` ; +${files.length - DIGEST_CAPS.STATE_SITES} more in facts.json`
      : '';
    const shown = files.slice(0, DIGEST_CAPS.STATE_SITES).join(' ; ');
    lines.push(`- ${e} written from ${sites.size} site(s): ${shown}${more}`);
  }
  const mod = {};
  for (const m of f.state.modifying) (mod[m.entity] ??= []).push(m.line);
  for (const [e, ls] of Object.entries(mod).filter(([e]) => top.has(e))) {
    const file = f.state.modifying.find((m) => m.entity === e).file;
    lines.push(`- ${e}: ${ls.length} @Modifying quer${ls.length > 1 ? 'ies' : 'y'} in ${file}:${ls.join(',')}`);
  }
  if (f.stateCaches.length) {
    const examples = f.stateCaches.slice(0, DIGEST_CAPS.CACHE_EXAMPLES).map((c) => `${c.action} ${c.method}`);
    lines.push(`- caches: ${f.stateCaches.length} cache annotation(s), e.g. ${examples.join(', ')}`);
  }
  return sec('State (which methods write each shortlisted entity; caches)', lines);
}

// Ranked: half-done outside effects first, then the rest; money-related methods float up.
const seamRank = (t) =>
  (t.kind === 'outside-then-save' ? 4 : t.kind === 'outside-in-transaction' ? 3 : 2) +
  (/Stripe|[Cc]harge|[Rr]efund|[Pp]ayment|[Ii]nvoice|[Oo]rder/.test(t.method) ? 2 : 0) -
  // A read that runs in a transaction with an outside call is a smaller seam than a write: rank it below.
  (/^[a-z0-9]+#(?:get|list|find|read|count|exists|search)/i.test(t.method ?? '') ? 2 : 0);

// One seam as a sentence. Lead with the nouns that matter: the line is cut, and the project service that made the
// call is the first thing a reader needs.
const seamText = (t) => {
  const at = t.evidence?.[0]?.replace(/#.*$/, '') ?? t.method;
  const short = (t.method ?? '').split('.').pop();
  if (t.kind === 'outside-in-transaction')
    return (
      `OUTSIDE CALL IN TRANSACTION ${short} (${at}): ${(t.outside ?? []).join('; ')}. ` +
      'A rollback does not undo the outside side.'
    );
  if (t.kind === 'outside-then-save')
    return (
      `OUTSIDE CALL THEN SAVE, NO TRANSACTION ${short} (${at}): ${(t.outside ?? []).join('; ')}; ` +
      `then ${(t.saves ?? []).join('; ')}.`
    );
  if (t.kind === 'requires-new')
    return `NEW TRANSACTION ${short} (${at}): commits on its own, even if the caller rolls back.`;
  if (t.kind === 'after-commit') {
    const runs = t.mechanism === 'synchronization' ? (t.runs ?? []).join(', ') || 'code' : t.mechanism;
    return `AFTER COMMIT ${short} (${at}): ${runs} runs once the transaction commits; a failure is not rolled back.`;
  }
  return `${t.kind} ${short} (${at})`;
};

function transactionsSection(f) {
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
    const more = kinds.length > 1 ? ` (${kinds.join(', ')})` : '';
    return `- ${cls} ×${list.length}${more}: ${seamText(list[0])}`;
  });
  const txTotal = f.transactionCounts.reduce((n, x) => n + x.count, 0);
  const outside = new Set(f.outsideCalls.map((c) => c.method)).size;
  const lines = [
    ...cap(ellSteps(seamLines, DIGEST_CAPS.SEAM_CHARS), DIGEST_CAPS.SEAMS, 'transactions'),
    `- ${txTotal} transactional method(s) in ${f.transactionCounts.length} class(es); ` +
      `${f.outsideCalls.length} outside call(s) across ${outside} method(s)`,
  ];
  if (f.transactionCounts.length) {
    const top = f.transactionCounts
      .slice(0, DIGEST_CAPS.TX_CLASSES)
      .map((x) => `${x.type.split('.').pop()} ${x.count}`);
    const more = f.transactionCounts.length > DIGEST_CAPS.TX_CLASSES
      ? `, +${f.transactionCounts.length - DIGEST_CAPS.TX_CLASSES} more in facts.json`
      : '';
    lines.push(`- most transactional classes: ${top.join(', ')}${more}`);
  }
  if (!seams.length) lines.push('- no transaction seam found');
  return sec('Transaction boundaries, computed (each must be listed in the map or dismissed on purpose)', lines);
}

function flowsSection(f) {
  // Flows grouped by entry class, like the seams: the class, its count, the best flow in full.
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
    const best = list.length > 1 ? ` (best ${x.score})` : '';
    // Effects before the parts: the line is cut, and an outside call's name must survive the cut.
    return (
      `- ${cls} ×${list.length}${best}: [${x.score}] ${head} ${x.entry.cite} effects: ${effects || 'none'} ` +
      `(${parts}) | ${x.steps.join('; ')}`
    );
  });
  return sec(
    'Flows, computed and ranked (entry point → every effect it reaches; ' +
      'the bracket is the rank, the parentheses are its parts)',
    cap(ell(flowLines, DIGEST_CAPS.FLOW_CHARS), DIGEST_CAPS.FLOWS, 'flows'),
  );
}

function lifecyclesSection(f) {
  const lines = f.lifecycle.map((x) => (x.startsWith('  ') ? `  -${x.slice(1)}` : `- ${x}`));
  return sec(
    'Lifecycles, computed (every place each status is set; cite these instead of searching)',
    cap(lines, DIGEST_CAPS.LIFECYCLE, 'lifecycle'),
  );
}

function schedulesSection(f) {
  return sec(
    'Schedules and retries, computed (plain-language timing; copy into "What runs on its own")',
    cap(f.schedules.map((x) => `- ${x}`), DIGEST_CAPS.SCHEDULES, 'schedules'),
  );
}

function recurringSection(f) {
  const lines = f.recurring.map(
    (r) => `- ${r.mechanism} in ${r.method} (${r.evidence[0]})${r.confidence === 'inferred' ? ' [shape]' : ''}`,
  );
  return sec(
    'Recurring work that is not @Scheduled (fixed rate/delay submissions, wheel timers, project schedulers)',
    cap(lines, DIGEST_CAPS.RECURRING, 'recurring'),
  );
}

function backgroundSection(f) {
  const jobs = f.background.scheduledAsyncListeners.filter((b) => b.kind !== 'Scheduled' && b.kind !== 'Schedule');
  const lines = jobs.map((b) => {
    if (b.kind === 'Batch job') return `- batch job ${b.args} ${b.file}`;
    const args = b.args ? ' ' + b.args.slice(0, DIGEST_CAPS.ARGS_CHARS) : '';
    return `- @${b.kind}${args} ${b.file}:${b.line}`;
  });
  return sec('Runs on its own (async, listeners, sockets; scheduled jobs are listed above)', [
    ...cap(lines, DIGEST_CAPS.BACKGROUND, 'background'),
    ...f.background.sockets.map((s) => `- socket ${s.file}:${s.line} ${s.path ?? s.text}`),
    ...f.background.runners.map((r) => `- startup runner ${r.file}:${r.line}`),
  ]);
}

// Compact digest the writer reads first; facts.json keeps the details for targeted lookup.
export function summarize(f) {
  const cx = pathAliases(f);
  const L = [
    ...header(f),
    ...understoodSection(f, cx),
    ...aliasLegend(cx),
    ...gitSection(f),
    ...buildSection(f),
    ...docsSection(f),
    ...packagesSection(f, cx),
    ...entitiesSection(f, cx),
    ...enumsSection(f),
    ...controllersSection(f),
    ...frontendSection(f),
    ...requestMachinerySection(f),
    ...anonymousWarningsSection(f, cx),
    ...identityWarningsSection(f),
    ...tenantSourceLines(f),
    ...runtimeLines(f),
    ...tenancySection(f),
    ...securityModelSection(f),
    ...bootComputedSection(f),
    ...bootDetailsSection(f),
    ...stateSection(f),
    ...transactionsSection(f),
    ...flowsSection(f),
    ...lifecyclesSection(f),
    ...schedulesSection(f),
    ...recurringSection(f),
    ...backgroundSection(f),
  ];
  const out = cx.ab(L.join('\n')).replace('@@J@@', cx.J).replace('@@F@@', cx.F).split('@@I@@').join(cx.I) + '\n';
  return out.length > DIGEST_WARN_CHARS
    ? out.replace(
        '\n',
        `\n**Over the ${DIGEST_WARN_CHARS.toLocaleString('en-US')}-character digest budget ` +
          `(${out.length} characters): read sections selectively.**\n`,
      )
    : out;
}

// --- Self-checks, run on import --------------------------------------------------------------------------------------

// The smallest facts object summarize() accepts: every list empty, no git, no coverage.
const tinyFacts = (over = {}) => ({
  root: '/work/demo',
  scannedAt: 'DATE',
  endpoints: [],
  packages: [],
  frontend: { files: 0, apiCalls: 0, unmatchedApiCalls: [], routes: [], apiJoin: [] },
  build: [],
  docs: [],
  externals: { sdkImports: {}, config: [] },
  entities: { model: [], enums: [] },
  git: null,
  securityRules: [],
  securityWarnings: [],
  tenantSources: [],
  tenantSourcesNote: 'none',
  runtime: { interceptors: [], contextScopes: [], exceptionHandlers: [], baseClasses: [], sessionState: [] },
  tenancy: { key: null, candidates: [] },
  noRequestPaths: [],
  boot: { computed: [], mains: [], frontend: [], profiles: [], switches: [], compose: [], scripts: [] },
  stateWrites: [],
  stateCaches: [],
  state: { modifying: [] },
  transactions: [],
  transactionCounts: [],
  outsideCalls: [],
  flows: [],
  lifecycle: [],
  schedules: [],
  recurring: [],
  background: { scheduledAsyncListeners: [], sockets: [], runners: [] },
  views: { count: 0, returnedBy: {}, deadViews: [] },
  ...over,
});

{
  // An empty section is left out (coverage and security warnings are both absent here).
  const digest = summarize(tinyFacts());
  assert.ok(!digest.includes('## What the engine did not understand'), 'no coverage, so no blind-spot section');
  assert.ok(!digest.includes('## Security warnings'), 'no warnings, so no warnings section');
  assert.ok(digest.includes('## Git\nno git history'), 'a section that always prints keeps its heading');
}

{
  // A cap prints how many lines it hid, and the heading still counts every item.
  const docs = Array.from({ length: DIGEST_CAPS.DOCS + 5 }, (_, i) => ({ file: `d${i}.md`, kb: 1, title: null }));
  const digest = summarize(tinyFacts({ docs }));
  assert.ok(digest.includes(`- +5 more in facts.json (docs)`), 'the cap names the lines it hid');
  assert.equal(digest.split('\n').filter((l) => l.startsWith('- d')).length, DIGEST_CAPS.DOCS);
  assert.ok(digest.includes(`## Docs (${DIGEST_CAPS.DOCS + 5})`), 'the heading counts all docs, not the listed ones');
}

{
  // The header carries the title and the budget line on every digest.
  const digest = summarize(tinyFacts());
  assert.ok(digest.startsWith('# facts for demo (scanned DATE)\n'), 'the title names the project folder');
  assert.ok(digest.includes('**budget: tier '), 'the budget line is always present');
}
