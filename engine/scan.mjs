#!/usr/bin/env node
// Phase 1 of the generation rules: collect the mechanical facts so the writer reads code only to judge, not to search.
// Usage: node scan.mjs <projectRoot> [outFile]   (default out: <root>/mindmodel/.work/facts.json)
// Never copies config values (only keys) so secrets cannot leak into facts or the map.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { javaFacts, bootFacts, deployables } from './deep.mjs';
import { git, gitWindow } from './activity.mjs';

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
const ANN = (name) => new RegExp(`@${name}\\b`);
const mappingPath = (args) => {
  const m = /(?:value|path)?\s*=?\s*\{?\s*"([^"]*)"/.exec(args ?? '');
  return m ? m[1] : '';
};
const VERBS = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'ANY',
  MessageMapping: 'STOMP',
};

export function parseJava(text) {
  const lines = text.split('\n');
  const cls =
    /^\s*(?:public\s+|abstract\s+|final\s+)*(class|interface|enum|record)\s+(\w+)(?:<[^>{]*>)?(?:\s+extends\s+([\w.<>, ]+?))?(?:\s+implements\s+([\w.<>, ]+?))?\s*[({]/m.exec(
      text,
    );
  const r = {
    name: cls?.[2],
    kind: cls?.[1],
    extends: cls?.[3]?.trim(),
    implements: cls?.[4]?.trim(),
    classLine: cls ? text.slice(0, cls.index).split('\n').length + (cls[0].startsWith('\n') ? 1 : 0) : null,
    annotations: [],
  };
  const head = cls ? text.slice(0, cls.index) : '';
  for (const a of [
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
  ])
    if (ANN(a).test(head)) r.annotations.push(a);
  const table = /@Table\s*\(\s*name\s*=\s*"([^"]+)"/.exec(head);
  if (table) r.table = table[1];
  const base = /@RequestMapping\s*\(([^)]*)\)/.exec(head) ?? /@Path\s*\(([^)]*)\)/.exec(head);
  r.basePath = base ? mappingPath(base[1]) : '';
  const appPath = /@ApplicationPath\s*\(([^)]*)\)/.exec(head);
  if (appPath) r.appPath = mappingPath(appPath[1]);
  r.mappings = [];
  r.fields = [];
  r.scheduled = [];
  r.views = [];
  // The event type a CDI observer takes; @Initialized(ApplicationScoped.class) means it runs at startup.
  const observed = (rest) =>
    /@Initialized\s*\(\s*ApplicationScoped/.test(rest)
      ? 'application start'
      : rest
          .replace(/^\s*\([^)]*\)/, '')
          .replace(/@\w+(\([^)]*\))?/g, '')
          .trim()
          .split(/[\s),]/)[0];
  // The method declared within a few lines after an annotation: its name and line index.
  const methodAfter = (i) => {
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const mm = /\b(\w+)\s*\(/.exec(lines[j].replace(/@\w+(\([^)]*\))?/g, ''));
      if (
        mm &&
        !/^(if|for|while|return)$/.test(mm[1]) &&
        /\)\s*(throws [\w., ]+)?\s*\{?\s*$|\(/.test(lines[j]) &&
        /(public|private|protected|ResponseEntity|String|void|\w+>?)\s+\w+\s*\(/.test(lines[j])
      )
        return { name: mm[1], at: j };
    }
    return { name: '', at: i };
  };
  // JAX-RS methods are public and often sit under long @Operation/@ApiResponse blocks: scan to the first line that
  // starts with a modifier, stopping at the next verb annotation.
  const jaxrsMethod = (i) => {
    for (let j = i + 1; j < Math.min(lines.length, i + 80); j++) {
      if (/^\s*@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/.test(lines[j])) break;
      const d =
        /^\s*(?:(?:public|protected|private|static|final|synchronized|default)\s+)+(?:<[^>]+>\s*)?[\w<>[\],.? ]+?\s+(\w+)\s*\(/.exec(
          lines[j],
        );
      if (d) return { name: d[1], at: j };
    }
    return { name: '', at: i };
  };
  lines.forEach((ln, i) => {
    // JAX-RS: a verb annotation, with the method's own @Path among the annotations around it.
    const jx = /^\s*@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b(?!\s*\()/.exec(ln);
    if (jx && i + 1 > (r.classLine ?? 0)) {
      const { name, at } = jaxrsMethod(i);
      let s = i;
      while (s > (r.classLine ?? 0) && i - s < 4 && /^\s*@/.test(lines[s - 1])) s--;
      const p = lines
        .slice(s, at + 1)
        .join(' ')
        .match(/@Path\s*\(([^)]*)\)/);
      r.mappings.push({ verb: jx[1], path: p ? mappingPath(p[1]) : '', line: i + 1, method: name });
    }
    const m = /@(Get|Post|Put|Delete|Patch|Request|Message)Mapping\b(?:\s*\(([^)]*)\))?/.exec(ln);
    if (m && i + 1 > (r.classLine ?? 0)) {
      const method = methodAfter(i).name;
      const verb = VERBS[m[1] + 'Mapping'];
      const vm = /RequestMethod\.(\w+)/.exec(m[2] ?? '');
      r.mappings.push({ verb: vm ? vm[1] : verb, path: mappingPath(m[2]), line: i + 1, method });
    }
    const sch =
      /@(Scheduled|Async|EventListener|TransactionalEventListener|KafkaListener|RabbitListener|JmsListener|SqsListener|Schedule|Asynchronous|Timeout|ObservesAsync|Observes)\b(\s*\(.*)?/.exec(
        ln,
      );
    // A CDI observer's args are the event it observes (the parameter after the annotation).
    if (sch)
      r.scheduled.push({
        kind: sch[1],
        args: (/^Observes/.test(sch[1])
          ? observed(ln.slice(sch.index + sch[0].length - (sch[2] ?? '').length))
          : (sch[2] ?? '')
        )
          .trim()
          .slice(0, 120),
        line: i + 1,
      });
    const rv = /return\s+"((?:redirect:|forward:)?[\w\-/{}.]+)"/.exec(ln);
    if (rv) r.views.push({ view: rv[1], line: i + 1 });
  });
  // A message-driven bean listens on the destination in its activation config (or mappedName).
  if (r.annotations.includes('MessageDriven')) {
    const dest =
      /propertyName\s*=\s*"destination(?:Lookup)?"\s*,\s*propertyValue\s*=\s*"([^"]+)"/.exec(head) ??
      /mappedName\s*=\s*"([^"]+)"/.exec(head);
    const on = lines.findIndex((l) => /\bvoid\s+onMessage\s*\(/.test(l));
    r.scheduled.push({ kind: 'MessageDriven', args: dest?.[1] ?? '', line: on >= 0 ? on + 1 : r.classLine });
  }
  if (
    r.annotations.includes('Entity') ||
    r.annotations.includes('Embeddable') ||
    r.annotations.includes('MappedSuperclass')
  ) {
    lines.forEach((ln, i) => {
      const f = /^\s*(?:private|protected|public)\s+([\w.<>, ?]+?)\s+(\w+)\s*(?:=[^;]*)?;/.exec(ln);
      if (!f || /static/.test(ln)) return;
      let s = i - 1;
      while (s >= 0 && !/[;{}]\s*$/.test(lines[s]) && i - s < 12) s--; // annotations belong to this field only: stop at the previous statement
      const ctx = lines.slice(s + 1, i).join(' ');
      const relm = /@(ManyToOne|OneToMany|OneToOne|ManyToMany)\b/.exec(ctx);
      const type = f[1].replace(/^(List|Set|Collection)<(.+)>$/, '$2').trim();
      const enumerated = /@Enumerated/.test(ctx);
      if (
        relm ||
        enumerated ||
        /^(status|state)$/i.test(f[2]) ||
        /(subscription|tenant|customer|owner)_?id$/i.test(f[2])
      )
        r.fields.push({ name: f[2], type, rel: relm?.[1], enumerated: enumerated || undefined, line: i + 1 });
    });
  }
  return r;
}
{
  const r = parseJava(
    '@Path("/handling")\n@Stateless\npublic class H {\n  @POST\n  @Path("/reports")\n  @Consumes("application/json")\n  public void submit(Report r) {}\n  @GET\n  public List<X> all() {}\n  public void on(@Observes(during = TransactionPhase.AFTER_SUCCESS) CargoInspected e) {}\n  @Schedule(minute = "*/2", hour = "*")\n  public void scan() {}\n}',
  );
  assert.deepStrictEqual([r.basePath, r.annotations], ['/handling', ['Path', 'Stateless']]);
  assert.deepStrictEqual(r.mappings, [
    { verb: 'POST', path: '/reports', line: 4, method: 'submit' },
    { verb: 'GET', path: '', line: 8, method: 'all' },
  ]);
  const long = parseJava(
    '@Path("/t")\npublic class T {\n  @GET\n  @Path("template")\n  @Operation(summary = "x", description = "List loans (paged)"\n      + "a"\n      + "b"\n      + "c")\n  @ApiResponse(responseCode = "200")\n  public Page<Data> template(@BeanParam P p) {}\n}',
  );
  assert.deepStrictEqual(long.mappings, [{ verb: 'GET', path: 'template', line: 3, method: 'template' }]);
  assert.deepStrictEqual(
    r.scheduled.map((s) => [s.kind, s.args]),
    [
      ['Observes', 'CargoInspected'],
      ['Schedule', '(minute = "*/2", hour = "*")'],
    ],
  );
  const mdb = parseJava(
    '@MessageDriven(activationConfig = {\n  @ActivationConfigProperty(propertyName = "destinationLookup", propertyValue = "java:app/jms/CargoHandledQueue")})\npublic class C implements MessageListener {\n  public void onMessage(Message m) {}\n}',
  );
  assert.deepStrictEqual(mdb.scheduled, [{ kind: 'MessageDriven', args: 'java:app/jms/CargoHandledQueue', line: 4 }]);
}
assert.deepStrictEqual(
  parseJava(
    '@RestController\n@RequestMapping("/api/x")\npublic class A {\n  @GetMapping("/{id}")\n  public Foo get(Long id) {\n    return null; }\n}',
  ).mappings,
  [{ verb: 'GET', path: '/{id}', line: 4, method: 'get' }],
);

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
assert.equal(routePath('<Route path="/orders/:id" element={<Order/>} />'), '/orders/:id');
assert.equal(routePath("  { path: '/cart', component: Cart },"), '/cart');
assert.equal(routePath("  { path: 'users/:id', component: UserComponent },", true), '/users/:id');
assert.equal(routePath("  { path: '', component: HomeComponent },", true), '/');
assert.equal(routePath("  { path: 'users', component: X },"), null);

// --- helpers ------------------------------------------------------------------
const norm = (p) =>
  ('/' + p)
    .replace(/\/+/g, '/')
    .replace(/\$\{[^}]*\}|\{[^}]*\}|:\w+/g, '{}')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '') || '/';
assert.strictEqual(norm('/api/orders/${o.id}/items?x=1'), '/api/orders/{}/items');
const linesMatching = (text, re) =>
  text.split('\n').flatMap((l, i) => (re.test(l) ? [{ line: i + 1, text: l.trim().slice(0, 160) }] : []));

// --- main ---------------------------------------------------------------------
export function scan(root) {
  const files = walk(root);
  const R = (p) => rel(root, p);
  const read = (p) => fs.readFileSync(p, 'utf8');
  const byExt = {};
  for (const f of files) {
    const e = path.extname(f).slice(1) || '(none)';
    byExt[e] = (byExt[e] ?? 0) + 1;
  }

  // Java model
  const javaAll = files
    .filter((f) => f.endsWith('.java') && !/\/src\/test\//.test(f))
    .map((p) => {
      const text = read(p);
      return { p: R(p), text, ...parseJava(text) };
    });
  // A repo can hold several apps: map the primary one only (other deployables are named in Boot).
  const app = deployables({ java: javaAll, files, rel: R, read });
  const java = javaAll.filter((j) => !app.isExcluded(j.p));
  const entities = java.filter((j) => j.annotations.includes('Entity'));
  const entityNames = new Set(entities.map((e) => e.name));
  // Controllers: Spring MVC, JAX-RS resources, and JSF backing beans (@Named with a UI scope).
  const controllers = java.filter(
    (j) =>
      j.annotations.includes('RestController') ||
      j.annotations.includes('Controller') ||
      j.annotations.includes('Path') ||
      (j.annotations.includes('Named') &&
        ['ViewScoped', 'RequestScoped', 'SessionScoped', 'ConversationScoped'].some((s) => j.annotations.includes(s))),
  );
  const nonEntity = java.filter((j) => !j.annotations.includes('Entity'));
  const repos = java.filter(
    (j) =>
      /\b(Jpa|Crud|PagingAndSorting)Repository\s*</.test(j.extends ?? '') || /Repository\s*</.test(j.extends ?? ''),
  );
  const repoFor = (n) => repos.find((r) => new RegExp(`Repository\\s*<\\s*${n}\\b`).test(r.extends));
  // Jakarta EE repositories hold an EntityManager: their entity is the one they name most (X.class, TypedQuery<X>, "X.query").
  const emRepos = java
    .filter(
      (j) => /\bEntityManager\s+\w+\s*;/.test(j.text) && /(Repository|Dao)\b/.test(`${j.name} ${j.implements ?? ''}`),
    )
    .map((j) => {
      const n = {};
      for (const m of j.text.matchAll(/\b(\w+)\.class\b|TypedQuery<(\w+)>|createNamedQuery\(\s*"(\w+)\./g)) {
        const e = m[1] ?? m[2] ?? m[3];
        if (entityNames.has(e)) n[e] = (n[e] ?? 0) + 1;
      }
      return { j, entity: Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] };
    })
    .filter((x) => x.entity);

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
        !built(f),
    )
    .map((p) => ({ p: R(p), text: read(p) }));
  const views = files
    .filter(
      (f) =>
        ((/\.(jsp|jspf|html|ftl|mustache)$/.test(f) && /(WEB-INF|templates|views)\//.test(f)) ||
          (/\.xhtml$/.test(f) && /src\/main\/webapp\//.test(f))) &&
        !/templates\/(emails?|library)\//.test(f),
    )
    .map((p) => ({ p: R(p), text: read(p) }));

  // entity funnel (R12): score + family flags
  const suffix = (n) => (n.match(/[A-Z][a-z0-9]*$/) ?? [n])[0];
  const famCount = {};
  for (const e of entities) famCount[suffix(e.name)] = (famCount[suffix(e.name)] ?? 0) + 1;
  const INFRA = /(Log|Event|Token|Audit|History|PageView|Pending\w*|Failed\w*|Join\w*|Joined\w*|Variant|Mapping)$/;
  const LINE_ITEM = /(Item|Line|Detail|Details)$/;
  // Each file's identifiers, collected once: a set lookup per entity instead of a regex over every file. Not after @
  // or a dot, so an entity named Component doesn't count every @Component annotation or stereotype import.
  const wordSets = new Map(),
    words = (text) => {
      let s = wordSets.get(text);
      if (!s) wordSets.set(text, (s = new Set(text.match(/(?<![@.\w])[A-Za-z_]\w*/g))));
      return s;
    };
  const funnel = entities
    .map((e) => {
      const named = (x) => words(x.text).has(e.name);
      const relIn = entities.filter((o) => o !== e && named(o)).length;
      const refs = nonEntity.filter(named).length;
      const ctrl = controllers.filter(named).length;
      const svc = nonEntity.filter((j) => /Service(Impl)?$/.test(j.name ?? '') && named(j)).length;
      const feRefs = fe.filter(named).length;
      const vre = new RegExp(
        `[$#]\\{\\s*${lc(e.name)}(s|List)?[.\\s}]|var\\s*=\\s*"${lc(e.name)}"|modelAttribute\\s*=\\s*"${lc(e.name)}"`,
      );
      const viewRefs = views.filter((v) => vre.test(v.text)).length;
      const status = e.fields.some(
        (f) => /^(status|state)$/i.test(f.name) || (f.enumerated && /status|state/i.test(f.type)),
      );
      const family = famCount[suffix(e.name)] >= 3 ? suffix(e.name) : undefined;
      const used = !!repoFor(e.name) || refs > 0;
      const flags = [
        family && `family:*${family}`,
        INFRA.test(e.name) && 'infrastructure',
        LINE_ITEM.test(e.name) && 'line-item?',
        !used && 'dead?',
      ].filter(Boolean);
      const score =
        Math.round(
          (relIn * 3 + Math.log2(1 + refs) * 4 + ctrl + Math.log2(1 + feRefs + viewRefs) * 3 + (status ? 2 : 0)) * 10,
        ) / 10;
      return {
        name: e.name,
        file: e.p,
        line: e.classLine,
        table: e.table,
        score,
        relIn,
        refs,
        controllers: ctrl,
        services: svc,
        frontendFiles: feRefs,
        viewFiles: viewRefs,
        status,
        flags,
        relations: e.fields.filter((f) => f.rel).map((f) => `${f.rel} ${f.type} ${f.name}:${f.line}`),
        keyFields: e.fields.filter((f) => !f.rel).map((f) => `${f.name}:${f.type}:${f.line}`),
      };
    })
    .sort((a, b) => b.score - a.score);

  // status enums with values (lifecycles)
  const enums = java
    .filter((j) => j.kind === 'enum' && /(Status|State|Type|Mode|Tier|Role|Source)$/.test(j.name ?? ''))
    .map((j) => ({
      name: j.name,
      file: j.p,
      line: j.classLine,
      values: (/\{([^;}]*)/.exec(j.text.slice(j.text.indexOf('enum')))?.[1] ?? '')
        .split(',')
        .map((s) => s.trim().split(/[\s(]/)[0])
        .filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s)),
    }));

  // endpoints + API join (R11)
  const byName = new Map(java.map((j) => [j.name, j]));
  const inherited = (c, depth = 0) => {
    const b = byName.get((c.extends ?? '').replace(/<.*/, '').trim());
    return b && depth < 3 ? [...b.mappings.map((m) => ({ ...m, from: b })), ...inherited(b, depth + 1)] : [];
  };
  const restRoot = java.find((j) => j.appPath != null)?.appPath ?? ''; // JAX-RS @ApplicationPath prefixes every resource
  const endpoints = controllers.flatMap((c) =>
    [...c.mappings, ...inherited(c)].map((m) => ({
      verb: m.verb,
      path: norm((c.annotations.includes('Path') ? restRoot + '/' : '') + (c.basePath || '') + '/' + (m.path || '')),
      line: m.line,
      handler: `${c.name}.${m.method}`,
      file: m.from ? m.from.p : c.p,
      inheritedBy: m.from ? c.p : undefined,
      rest: c.annotations.includes('RestController') || c.annotations.includes('Path'),
    })),
  );
  const feCalls = fe.flatMap((f) =>
    f.text.split('\n').flatMap((l, i) => {
      const m = /["'`](\/api\/[^"'`\s]*)["'`]/.exec(l);
      if (!m) return [];
      const around = f.text
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

  // runtime machinery
  const pick = (re, list = java) => list.flatMap((j) => linesMatching(j.text, re).map((m) => ({ file: j.p, ...m })));
  const security = pick(
    /securityMatcher|requestMatchers|antMatchers|mvcMatchers|authorizeHttpRequests|authorizeRequests|permitAll|authenticated\(\)|hasRole|hasAnyRole|hasAuthority|csrf|formLogin|httpBasic|oauth2ResourceServer|sessionCreationPolicy|logout\(|@Order\(/,
    java.filter((j) => /HttpSecurity|SecurityFilterChain|WebSecurityConfigurerAdapter/.test(j.text)),
  );
  // Jakarta EE: URL security declared in web.xml.
  for (const f of files.filter((f) => /WEB-INF\/web\.xml$/.test(f))) {
    const t = read(f);
    if (/<security-constraint>/.test(t))
      security.push(
        ...linesMatching(
          t,
          /<(security-constraint|url-pattern|http-method|role-name|auth-method|transport-guarantee)>/,
        ).map((m) => ({ file: R(f), ...m })),
      );
  }
  const methodSecurity = java
    .map((j) => ({ file: j.p, n: (j.text.match(/@(PreAuthorize|Secured|RolesAllowed)\b/g) ?? []).length }))
    .filter((x) => x.n);
  // Registrations and filter classes only: imports, `x = new FilterRegistrationBean<>()` lines and record accessors like item.order() are noise.
  const interceptors = pick(
    /ContainerRequestFilter|ContainerResponseFilter|@WebFilter|@AroundInvoke|@Interceptor\b|addInterceptor|addPathPatterns|excludePathPatterns|(?:public|protected)\s+FilterRegistrationBean|FilterRegistrationBean(?:<[^>]*>)?\s+\w+\s*\(|instanceof FilterRegistrationBean|extends OncePerRequestFilter|implements (HandlerInterceptor|Filter)\b/,
  ).filter((m) => !/^import\s/.test(m.text));
  const contextScopes = pick(
    /@RequestScoped?\b|@SessionScoped?\b|@ConversationScoped|@ViewScoped|@Scope\(|ThreadLocal<|@ControllerAdvice/,
  );
  const exceptionHandlers = java
    .filter((j) => /@ExceptionHandler|implements\s+ExceptionMapper/.test(j.text))
    .map((j) => j.p);
  const background = java.flatMap((j) => j.scheduled.map((s) => ({ ...s, file: j.p, cls: j.name })));
  const sockets = java
    .flatMap((j) =>
      j.mappings.filter((m) => m.verb === 'STOMP').map((m) => ({ file: j.p, line: m.line, path: m.path })),
    )
    .concat(pick(/SessionDisconnectEvent|SessionConnectedEvent|registerStompEndpoints|enableSimpleBroker/));
  const runners = java
    .filter(
      (j) => /(CommandLineRunner|ApplicationRunner)/.test(j.implements ?? '') || j.annotations.includes('Startup'),
    )
    .map((j) => ({ file: j.p, line: j.classLine }));
  // Jakarta Batch: jobs are XML files under META-INF/batch-jobs; JobOperator.start("name") starts them.
  const batchJobs = files
    .filter((f) => /META-INF\/batch-jobs\/[\w.-]+\.xml$/.test(f))
    .map((f) => {
      const t = read(f),
        id = /<job\b[^>]*\bid="([^"]+)"/.exec(t)?.[1] ?? path.basename(f, '.xml');
      const starts = pick(new RegExp(`\\.start\\(\\s*"${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)).map(
        (s) => `${s.file}:${s.line}`,
      );
      return {
        kind: 'Batch job',
        args: `${id}: ${[...t.matchAll(/<(batchlet|reader|processor|writer)\b[^>]*\bref="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`).join(', ')}${starts.length ? `; started at ${starts.join(', ')}` : ''}`,
        file: R(f),
        line: 1,
      };
    });
  const sessionState = pick(/(session|getSession\(\))\.(set|get)Attribute\(\s*"|@SessionAttributes/)
    .concat(
      views.flatMap((v) =>
        linesMatching(v.text, /sessionScope\.|session\.getAttribute/).map((m) => ({ file: v.p, ...m })),
      ),
    )
    .slice(0, 80);
  const baseClasses = Object.entries(
    java.reduce((acc, j) => {
      const b = (j.extends ?? '').replace(/<.*/, '');
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
  const externals = {};
  for (const j of java)
    for (const [k, v] of Object.entries(EXT))
      if (new RegExp(`import\\s+[\\w.]*${k.replace(/\./g, '\\.')}`).test(j.text)) (externals[v] ??= []).push(j.p);
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
  // The project's own modules (named after their folders) and build plugins are not dependencies.
  const own = new Set([
    path.basename(root),
    ...files.filter((f) => /(^|\/)pom\.xml$/.test(f)).map((f) => path.basename(path.dirname(f))),
  ]);
  const buildFiles = files
    .filter((f) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?|package\.json)$/.test(R(f)) && R(f).split('/').length <= 3)
    .map((f) => ({
      file: R(f),
      deps: (
        read(f).match(
          /(org\.springframework\.boot:spring-boot-starter-[\w-]+|spring-boot-starter-[\w-]+|com\.stripe[:\w.-]*|"(react|react-dom|react-router-dom|@tanstack\/react-query|axios|vite|next|@angular\/core|@angular\/router|vue|vue-router|svelte|@sveltejs\/kit)"|<artifactId>[\w.-]+<\/artifactId>)/g,
        ) ?? []
      )
        .map((s) => s.replace(/<\/?artifactId>|"/g, ''))
        .filter((s, i, a) => a.indexOf(s) === i && !own.has(s) && !/^maven-.*-plugin$|-maven-plugin$/.test(s))
        .slice(0, 60),
    }));

  // state: who writes each entity (repository mutations per caller), copies of state
  const repoEntity = new Map([
    ...repos.map((r) => [r.name, /Repository\s*<\s*(\w+)/.exec(r.extends)?.[1]]),
    ...emRepos.flatMap(({ j, entity }) =>
      [
        j.name,
        ...(j.implements ?? '')
          .split(/\s*,\s*/)
          .map((s) => s.replace(/<.*/, ''))
          .filter((n) => /(Repository|Dao)$/.test(n)),
      ].map((n) => [n, entity]),
    ),
  ]);
  const writes = {};
  for (const j of nonEntity) {
    if (repoEntity.has(j.name)) continue;
    const vars = new Map(
      [...j.text.matchAll(/\b(\w+(?:Repository|Repo|Dao))\s+(\w+)\s*[;,)=]/g)]
        .filter((m) => repoEntity.has(m[1]))
        .map((m) => [m[2], repoEntity.get(m[1])]),
    );
    for (const [v, ent] of vars)
      for (const m of linesMatching(
        j.text,
        new RegExp(`\\b${v}\\.((?:save|delete|update|insert|store|persist|merge|remove)\\w*)\\(`),
      ))
        ((writes[ent] ??= {})[j.p] ??= []).push(m.line);
  }
  const modifying = repos.flatMap((r) =>
    linesMatching(r.text, /@Modifying/).map((m) => ({ file: r.p, line: m.line, entity: repoEntity.get(r.name) })),
  );
  const caches = pick(/@Cacheable|@CacheEvict|@CachePut|@EnableCaching|expireAfter|\.ttl\(|entryTtl/)
    .concat(
      fe.flatMap((f) =>
        linesMatching(
          f.text,
          /localStorage\.|sessionStorage\.|staleTime|invalidateQueries|configureStore|\bcreate\(\s*\(set|persist\(/,
        ).map((m) => ({ file: f.p, ...m })),
      ),
    )
    .slice(0, 80);
  const sdkFiles = new Set(
    java
      .filter((j) =>
        Object.keys(EXT).some((k) => new RegExp(`import\\s+[\\w.]*${k.replace(/\./g, '\\.')}`).test(j.text)),
      )
      .map((j) => j.p),
  );
  const seams = pick(
    /@Transactional\b|@TransactionalEventListener|publishEvent\(|TransactionSynchronization|kafkaTemplate\.send|rabbitTemplate\.convertAndSend/,
    java.filter(
      (j) => sdkFiles.has(j.p) || /publishEvent\(|@TransactionalEventListener|TransactionSynchronization/.test(j.text),
    ),
  ).slice(0, 60);

  const deep = javaFacts({
    java,
    repoEntity,
    EXT,
    enums,
    entities,
    shortlist: new Set(funnel.slice(0, 15).map((e) => e.name)),
    endpoints,
  });
  const bootComputed = bootFacts({ root, files, rel: R, git, app });

  // boot: entry points, profile switches, how to run locally
  const mains = javaAll
    .filter(
      (j) =>
        /static\s+void\s+main\s*\(/.test(j.text) &&
        /SpringApplication(Builder)?\b|@SpringBootApplication|@SpringBootConfiguration/.test(j.text),
    )
    .map((j) => ({ file: j.p, line: linesMatching(j.text, /static\s+void\s+main\s*\(/)[0]?.line }));
  const switches = pick(
    /@Profile\(|@ConditionalOnProperty\(|@ConditionalOnMissingBean|spring\.profiles\.active/,
  ).concat(
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
    const ng = isAngularRoutes(f.text);
    return f.text.split('\n').flatMap((l, i) => {
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

  return {
    version: 1,
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
      count: entities.length,
      funnel,
      enums,
      repositories: repos.map((r) => ({ file: r.p, extends: r.extends })),
    },
    endpoints,
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
    runtime: { security, methodSecurity, interceptors, contextScopes, exceptionHandlers, baseClasses, sessionState },
    background: { scheduledAsyncListeners: [...background, ...batchJobs], sockets, runners },
    state: {
      writes: Object.fromEntries(
        Object.entries(writes).map(([e, byFile]) => [
          e,
          Object.entries(byFile).map(([file, lines]) => `${file}:${lines.join(',')}`),
        ]),
      ),
      modifying,
      caches,
      seams,
    },
    boot: { computed: bootComputed, mains, switches, profiles, frontend: feEntries, compose, scripts },
    seams: deep.seams,
    lifecycle: deep.lifecycle,
    schedules: deep.schedules,
    flows: deep.flows,
    externals: {
      sdkImports: Object.fromEntries(Object.entries(externals).map(([k, v]) => [k, [...new Set(v)].slice(0, 6)])),
      config: configKeys,
    },
  };
}

// Compact digest the writer reads first; facts.json keeps the details for targeted lookup.
export function summarize(f) {
  const L = [];
  const sec = (h) => L.push('', `## ${h}`);
  // Every list is capped so the digest stays the same size on a 300k-line app; the rest stays in facts.json.
  const cap = (list, n, where) =>
    list.length > n ? [...list.slice(0, n), `- +${list.length - n} more in facts.json (${where})`] : list;
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
        (b) => `- ${b.file}: ${b.deps.slice(0, 20).join(', ')}${b.deps.length > 20 ? `, +${b.deps.length - 20}` : ''}`,
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
  sec(
    `Entity funnel (${f.entities.count} entities; score = relIn·3 + log refs·4 + controllers + log frontend/views·3 + status·2)`,
  );
  f.entities.funnel
    .slice(0, 20)
    .forEach((e, i) =>
      L.push(
        `${i + 1}. ${e.name} ${e.score} · ${e.file}:${e.line}${e.table ? ' table ' + e.table : ''} · relIn ${e.relIn}, refs ${e.refs}, ctrl ${e.controllers}, svc ${e.services}, fe ${e.frontendFiles}, views ${e.viewFiles}${e.status ? ', status' : ''}${e.flags.length ? ' · ' + e.flags.join(' ') : ''}${e.relations.length ? '\n   rel: ' + e.relations.slice(0, 8).join('; ') + (e.relations.length > 8 ? `; +${e.relations.length - 8} more in facts.json` : '') : ''}`,
      ),
    );
  if (f.entities.funnel.length > 20)
    L.push(
      `rest: ${f.entities.funnel
        .slice(20)
        .map((e) => `${e.name}(${e.score}${e.flags.length ? ' ' + e.flags.join(' ') : ''})`)
        .join(', ')}`,
    );
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
      f.runtime.security.map((s) => `- security ${s.file}:${s.line} ${s.text}`),
      40,
      'runtime.security',
    ),
  );
  L.push(
    `- method security annotations: ${f.runtime.methodSecurity.map((m) => `${m.file} ×${m.n}`).join(', ') || 'none'}`,
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
  // Shortlisted entities only, files without line lists: the full write sites stay in facts.json (state.writes).
  sec('State (which files write each shortlisted entity; copies)');
  const top = new Set(f.entities.funnel.slice(0, 15).map((e) => e.name));
  for (const [e, byFile] of Object.entries(f.state.writes)
    .filter(([e]) => top.has(e))
    .sort((a, b) => b[1].length - a[1].length)) {
    const files = byFile.map((x) => {
      const [p, l] = x.split(/:(?=[\d,]+$)/);
      return `${p}:${l.split(',')[0]}${l.includes(',') ? ` (+${l.split(',').length - 1})` : ''}`;
    });
    L.push(
      `- ${e} written from ${byFile.length} file(s): ${files.slice(0, 8).join(' ; ')}${files.length > 8 ? ` ; +${files.length - 8} more in facts.json` : ''}`,
    );
  }
  const mod = {};
  for (const m of f.state.modifying) (mod[m.entity] ??= []).push(m.line);
  for (const [e, ls] of Object.entries(mod).filter(([e]) => top.has(e)))
    L.push(
      `- ${e}: ${ls.length} @Modifying quer${ls.length > 1 ? 'ies' : 'y'} in ${f.state.modifying.find((m) => m.entity === e).file}:${ls.join(',')}`,
    );
  for (const c of f.state.caches.slice(0, 25)) L.push(`- copy/cache ${c.file}:${c.line} ${c.text}`);
  sec('Seams, computed (each must be listed in the map or dismissed on purpose)');
  // Ranked: half-done outside effects on money first, then other outside effects, then the rest.
  const seamRank = (x) =>
    (/NO TRANSACTION/.test(x) ? 4 : /^OUTSIDE CALL IN/.test(x) ? 3 : /^JOB DELETES|^AFTER COMMIT/.test(x) ? 2 : 1) +
    (/Stripe|[Cc]harge|[Rr]efund|[Pp]ayment|[Ii]nvoice|[Oo]rder/.test(x) ? 2 : 0);
  push(
    cap(
      [...f.seams].sort((a, b) => seamRank(b) - seamRank(a)).map((x) => `- ${x}`),
      30,
      'seams',
    ),
  );
  if (!f.seams.length) L.push('- none found');
  sec(
    'Flow skeletons, computed (entry point → what happens, in order; start stories here and open only the methods you need)',
  );
  push(
    cap(
      f.flows.map((x) => `- ${x}`),
      12,
      'flows',
    ),
  );
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
  const root = path.resolve(process.argv[2] ?? '.');
  const out = path.resolve(process.argv[3] ?? path.join(root, 'mindmodel', '.work', 'facts.json'));
  const facts = scan(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(facts, null, 1));
  fs.writeFileSync(out.replace(/\.json$/, '.md'), summarize(facts));
  const f = facts;
  console.log(
    `wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB): ${f.entities.count} entities, ${f.endpoints.length} endpoints, ${f.frontend.apiCalls} frontend API calls (${f.frontend.unmatchedApiCalls.length} unmatched), ${f.views.count} views, ${f.background.scheduledAsyncListeners.length} scheduled/async/listeners, ${f.runtime.security.length} security lines, ${f.docs.length} docs, git ${f.git ? f.git.head + (f.git.dirty ? '+dirty' : '') + ' window=' + (f.git.window?.since ?? 'none') : 'none'}`,
  );
}
