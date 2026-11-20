#!/usr/bin/env node
// Phase 0 of the generation rules: collect the mechanical facts so the writer reads code only to judge, not to search.
// Usage: node scan.mjs <projectRoot> [outFile]   (default out: <root>/mindmodel/.work/facts.json)
// Never copies config values (only keys) so secrets cannot leak into facts or the map.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

const IGNORE = new Set(['.git', 'node_modules', 'target', 'build', 'bin', 'dist', 'out', '.gradle', '.idea', '.vscode', '.settings', '.ua', 'mindmodel', 'uploads', 'coverage', '.next', 'android', 'ios', '.mvn', 'vendor', '.claude', '.cursor', '.agent']);
// Compiled and binary files are never read, so don't even list them (wherever a build tool put them).
const SKIP_EXT = /\.(class|jar|war|ear|so|dll|dylib|exe|o|pyc|png|jpe?g|gif|webp|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|mov|avi|zip|gz|tgz|rar|7z|pdf|psd|map)$/i;
const lc = (s) => s[0].toLowerCase() + s.slice(1);
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && !['.github'].includes(e.name) && e.isDirectory()) continue;
    if (IGNORE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (!SKIP_EXT.test(e.name)) out.push(p);
  }
  return out;
}

// --- Java -------------------------------------------------------------------
const ANN = (name) => new RegExp(`@${name}\\b`);
const mappingPath = (args) => { const m = /(?:value|path)?\s*=?\s*\{?\s*"([^"]*)"/.exec(args ?? ''); return m ? m[1] : ''; };
const VERBS = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'ANY', MessageMapping: 'STOMP' };

export function parseJava(text) {
  const lines = text.split('\n');
  const cls = /^\s*(?:public\s+|abstract\s+|final\s+)*(class|interface|enum|record)\s+(\w+)(?:<[^>{]*>)?(?:\s+extends\s+([\w.<>, ]+?))?(?:\s+implements\s+([\w.<>, ]+?))?\s*[({]/m.exec(text);
  const r = { name: cls?.[2], kind: cls?.[1], extends: cls?.[3]?.trim(), implements: cls?.[4]?.trim(), classLine: cls ? text.slice(0, cls.index).split('\n').length + (cls[0].startsWith('\n') ? 1 : 0) : null, annotations: [] };
  const head = cls ? text.slice(0, cls.index) : '';
  for (const a of ['Entity', 'Table', 'RestController', 'Controller', 'Service', 'Component', 'Configuration', 'Repository', 'ControllerAdvice', 'EnableWebSecurity', 'EnableMethodSecurity', 'Embeddable', 'MappedSuperclass']) if (ANN(a).test(head)) r.annotations.push(a);
  const table = /@Table\s*\(\s*name\s*=\s*"([^"]+)"/.exec(head); if (table) r.table = table[1];
  const base = /@RequestMapping\s*\(([^)]*)\)/.exec(head); r.basePath = base ? mappingPath(base[1]) : '';
  r.mappings = []; r.fields = []; r.scheduled = []; r.views = [];
  lines.forEach((ln, i) => {
    const m = /@(Get|Post|Put|Delete|Patch|Request|Message)Mapping\b(?:\s*\(([^)]*)\))?/.exec(ln);
    if (m && i + 1 > (r.classLine ?? 0)) {
      let method = ''; for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) { const mm = /\b(\w+)\s*\(/.exec(lines[j].replace(/@\w+(\([^)]*\))?/g, '')); if (mm && !/^(if|for|while|return)$/.test(mm[1]) && /\)\s*(throws [\w., ]+)?\s*\{?\s*$|\(/.test(lines[j]) && /(public|private|protected|ResponseEntity|String|void|\w+>?)\s+\w+\s*\(/.test(lines[j])) { method = mm[1]; break; } }
      const verb = VERBS[m[1] + 'Mapping']; const vm = /RequestMethod\.(\w+)/.exec(m[2] ?? '');
      r.mappings.push({ verb: vm ? vm[1] : verb, path: mappingPath(m[2]), line: i + 1, method });
    }
    const sch = /@(Scheduled|Async|EventListener|TransactionalEventListener|KafkaListener|RabbitListener|JmsListener|SqsListener)\b(\s*\(.*)?/.exec(ln);
    if (sch) r.scheduled.push({ kind: sch[1], args: (sch[2] ?? '').trim().slice(0, 120), line: i + 1 });
    const rv = /return\s+"((?:redirect:|forward:)?[\w\-/{}.]+)"/.exec(ln); if (rv) r.views.push({ view: rv[1], line: i + 1 });
  });
  if (r.annotations.includes('Entity') || r.annotations.includes('Embeddable') || r.annotations.includes('MappedSuperclass')) {
    lines.forEach((ln, i) => {
      const f = /^\s*(?:private|protected|public)\s+([\w.<>, ?]+?)\s+(\w+)\s*(?:=[^;]*)?;/.exec(ln);
      if (!f || /static/.test(ln)) return;
      let s = i - 1; while (s >= 0 && !/[;{}]\s*$/.test(lines[s]) && i - s < 12) s--; // annotations belong to this field only: stop at the previous statement
      const ctx = lines.slice(s + 1, i).join(' ');
      const relm = /@(ManyToOne|OneToMany|OneToOne|ManyToMany)\b/.exec(ctx);
      const type = f[1].replace(/^(List|Set|Collection)<(.+)>$/, '$2').trim();
      const enumerated = /@Enumerated/.test(ctx);
      if (relm || enumerated || /^(status|state)$/i.test(f[2]) || /(subscription|tenant|customer|owner)_?id$/i.test(f[2])) r.fields.push({ name: f[2], type, rel: relm?.[1], enumerated: enumerated || undefined, line: i + 1 });
    });
  }
  return r;
}
assert.deepStrictEqual(parseJava('@RestController\n@RequestMapping("/api/x")\npublic class A {\n  @GetMapping("/{id}")\n  public Foo get(Long id) {\n    return null; }\n}').mappings, [{ verb: 'GET', path: '/{id}', line: 4, method: 'get' }]);

// --- helpers ------------------------------------------------------------------
const norm = (p) => ('/' + p).replace(/\/+/g, '/').replace(/\$\{[^}]*\}|\{[^}]*\}|:\w+/g, '{}').replace(/\?.*$/, '').replace(/\/$/, '') || '/';
assert.strictEqual(norm('/api/orders/${o.id}/items?x=1'), '/api/orders/{}/items');
const linesMatching = (text, re) => text.split('\n').flatMap((l, i) => (re.test(l) ? [{ line: i + 1, text: l.trim().slice(0, 160) }] : []));
const git = (root, args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// --- main ---------------------------------------------------------------------
export function scan(root) {
  const files = walk(root);
  const R = (p) => rel(root, p);
  const read = (p) => fs.readFileSync(p, 'utf8');
  const byExt = {}; for (const f of files) { const e = path.extname(f).slice(1) || '(none)'; byExt[e] = (byExt[e] ?? 0) + 1; }

  // Java model
  const java = files.filter((f) => f.endsWith('.java') && !/\/src\/test\//.test(f)).map((p) => ({ p: R(p), text: read(p), ...parseJava(read(p)) }));
  const entities = java.filter((j) => j.annotations.includes('Entity'));
  const entityNames = new Set(entities.map((e) => e.name));
  const controllers = java.filter((j) => j.annotations.includes('RestController') || j.annotations.includes('Controller'));
  const nonEntity = java.filter((j) => !j.annotations.includes('Entity'));
  const repos = java.filter((j) => /\b(Jpa|Crud|PagingAndSorting)Repository\s*</.test(j.extends ?? '') || /Repository\s*</.test(j.extends ?? ''));
  const repoFor = (n) => repos.find((r) => new RegExp(`Repository\\s*<\\s*${n}\\b`).test(r.extends));

  // frontend: React/TS and server-rendered views
  const built = (f) => /\/static\/assets\/|-[\w]{8,}\.(js|css)$|\.min\.js$/.test(f) || read(f).split('\n').some((l) => l.length > 3000);
  const fe = files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.(test|spec|d)\.[tj]sx?$/.test(f) && !/vendor|slick|jquery|bootstrap/i.test(f) && !built(f)).map((p) => ({ p: R(p), text: read(p) }));
  const views = files.filter((f) => /\.(jsp|jspf|html|ftl|mustache)$/.test(f) && /(WEB-INF|templates|views)\//.test(f) && !/templates\/(emails?|library)\//.test(f)).map((p) => ({ p: R(p), text: read(p) }));

  // entity funnel (R12): score + family flags
  const suffix = (n) => (n.match(/[A-Z][a-z0-9]*$/) ?? [n])[0];
  const famCount = {}; for (const e of entities) famCount[suffix(e.name)] = (famCount[suffix(e.name)] ?? 0) + 1;
  const INFRA = /(Log|Event|Token|Audit|History|PageView|Pending\w*|Failed\w*|Join\w*|Joined\w*|Variant|Mapping)$/;
  const LINE_ITEM = /(Item|Line|Detail|Details)$/;
  const funnel = entities.map((e) => {
    const re = new RegExp(`\\b${e.name}\\b`);
    const relIn = entities.filter((o) => o !== e && re.test(o.text)).length;
    const refs = nonEntity.filter((j) => re.test(j.text)).length;
    const ctrl = controllers.filter((j) => re.test(j.text)).length;
    const svc = nonEntity.filter((j) => /Service(Impl)?$/.test(j.name ?? '') && re.test(j.text)).length;
    const feRefs = fe.filter((f) => re.test(f.text)).length;
    const vre = new RegExp(`\\$\\{\\s*${lc(e.name)}(s|List)?[.\\s}]|var\\s*=\\s*"${lc(e.name)}"|modelAttribute\\s*=\\s*"${lc(e.name)}"`);
    const viewRefs = views.filter((v) => vre.test(v.text)).length;
    const status = e.fields.some((f) => /^(status|state)$/i.test(f.name) || (f.enumerated && /status|state/i.test(f.type)));
    const family = famCount[suffix(e.name)] >= 3 ? suffix(e.name) : undefined;
    const used = !!repoFor(e.name) || refs > 0;
    const flags = [family && `family:*${family}`, INFRA.test(e.name) && 'infrastructure', LINE_ITEM.test(e.name) && 'line-item?', !used && 'dead?'].filter(Boolean);
    const score = Math.round((relIn * 3 + Math.log2(1 + refs) * 4 + ctrl + Math.log2(1 + feRefs + viewRefs) * 3 + (status ? 2 : 0)) * 10) / 10;
    return { name: e.name, file: e.p, line: e.classLine, table: e.table, score, relIn, refs, controllers: ctrl, services: svc, frontendFiles: feRefs, viewFiles: viewRefs, status, flags, relations: e.fields.filter((f) => f.rel).map((f) => `${f.rel} ${f.type} ${f.name}:${f.line}`), keyFields: e.fields.filter((f) => !f.rel).map((f) => `${f.name}:${f.type}:${f.line}`) };
  }).sort((a, b) => b.score - a.score);

  // status enums with values (lifecycles)
  const enums = java.filter((j) => j.kind === 'enum' && /(Status|State|Type|Mode|Tier|Role|Source)$/.test(j.name ?? '')).map((j) => ({ name: j.name, file: j.p, line: j.classLine, values: (/\{([^;}]*)/.exec(j.text.slice(j.text.indexOf('enum')))?.[1] ?? '').split(',').map((s) => s.trim().split(/[\s(]/)[0]).filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s)) }));

  // endpoints + API join (R11)
  const byName = new Map(java.map((j) => [j.name, j]));
  const inherited = (c, depth = 0) => { const b = byName.get((c.extends ?? '').replace(/<.*/, '').trim()); return b && depth < 3 ? [...b.mappings.map((m) => ({ ...m, from: b })), ...inherited(b, depth + 1)] : []; };
  const endpoints = controllers.flatMap((c) => [...c.mappings, ...inherited(c)].map((m) => ({ verb: m.verb, path: norm((c.basePath || '') + '/' + (m.path || '')), line: m.line, handler: `${c.name}.${m.method}`, file: m.from ? m.from.p : c.p, inheritedBy: m.from ? c.p : undefined, rest: c.annotations.includes('RestController') })));
  const feCalls = fe.flatMap((f) => f.text.split('\n').flatMap((l, i) => { const m = /["'`](\/api\/[^"'`\s]*)["'`]/.exec(l); if (!m) return []; const around = f.text.split('\n').slice(Math.max(0, i - 3), i + 4).join(' '); const vm = /method:\s*["'](GET|POST|PUT|DELETE|PATCH)["']/i.exec(around); return [{ path: norm(m[1]), verb: vm?.[1]?.toUpperCase(), file: f.p, line: i + 1 }]; }));
  const epByPath = new Map(); for (const e of endpoints) { if (!epByPath.has(e.path)) epByPath.set(e.path, []); epByPath.get(e.path).push(e); }
  const segMatch = (ep, call) => { const a = ep.split('/'), b = call.split('/'); return a.length === b.length && a.every((s, i) => s === '{}' || b[i] === '{}' || s === b[i]); };
  const joined = feCalls.map((c) => { const cands = epByPath.get(c.path) ?? endpoints.filter((e) => segMatch(e.path, c.path)); const hit = cands.find((e) => !c.verb || e.verb === c.verb || e.verb === 'ANY') ?? cands[0]; return { ...c, handler: hit ? `${hit.file}:${hit.line}` : null }; });
  const viewUse = {}; for (const c of controllers) for (const v of c.views) if (!/^(redirect|forward):/.test(v.view)) (viewUse[v.view] ??= []).push(`${c.p}:${v.line}`);
  const viewNames = views.map((v) => ({ file: v.p, name: path.basename(v.p).replace(/\.\w+$/, '') }));
  const included = new Set(views.flatMap((v) => [...v.text.matchAll(/(?:include\s+file|page)\s*=\s*"([^"]+)"/g)].map((m) => path.basename(m[1]).replace(/\.\w+$/, ''))));
  const deadViews = viewNames.filter((v) => !Object.keys(viewUse).some((k) => k === v.name || k.endsWith('/' + v.name)) && !included.has(v.name)).map((v) => v.file);

  // runtime machinery
  const pick = (re, list = java) => list.flatMap((j) => linesMatching(j.text, re).map((m) => ({ file: j.p, ...m })));
  const security = pick(/securityMatcher|requestMatchers|antMatchers|mvcMatchers|authorizeHttpRequests|authorizeRequests|permitAll|authenticated\(\)|hasRole|hasAnyRole|hasAuthority|csrf|formLogin|httpBasic|oauth2ResourceServer|sessionCreationPolicy|logout\(|@Order\(/, java.filter((j) => /HttpSecurity|SecurityFilterChain|WebSecurityConfigurerAdapter/.test(j.text)));
  const methodSecurity = java.map((j) => ({ file: j.p, n: (j.text.match(/@(PreAuthorize|Secured|RolesAllowed)\b/g) ?? []).length })).filter((x) => x.n);
  const interceptors = pick(/addInterceptor|addPathPatterns|excludePathPatterns|\.order\(|FilterRegistrationBean|extends OncePerRequestFilter|implements (HandlerInterceptor|Filter)\b/);
  const contextScopes = pick(/@RequestScope|@SessionScope|@Scope\(|ThreadLocal<|@ControllerAdvice/);
  const exceptionHandlers = java.filter((j) => /@ExceptionHandler/.test(j.text)).map((j) => j.p);
  const background = java.flatMap((j) => j.scheduled.map((s) => ({ ...s, file: j.p, cls: j.name })));
  const sockets = java.flatMap((j) => j.mappings.filter((m) => m.verb === 'STOMP').map((m) => ({ file: j.p, line: m.line, path: m.path }))).concat(pick(/SessionDisconnectEvent|SessionConnectedEvent|registerStompEndpoints|enableSimpleBroker/));
  const runners = java.filter((j) => /(CommandLineRunner|ApplicationRunner)/.test(j.implements ?? '')).map((j) => ({ file: j.p, line: j.classLine }));
  const sessionState = pick(/(session|getSession\(\))\.(set|get)Attribute\(\s*"|@SessionAttributes/).concat(views.flatMap((v) => linesMatching(v.text, /sessionScope\.|session\.getAttribute/).map((m) => ({ file: v.p, ...m })))).slice(0, 80);
  const baseClasses = Object.entries(java.reduce((acc, j) => { const b = (j.extends ?? '').replace(/<.*/, ''); if (b && !/Repository$|Exception$|^Object$/.test(b)) acc[b] = (acc[b] ?? 0) + 1; return acc; }, {})).filter(([, n]) => n >= 3).map(([b, n]) => ({ base: b, subclasses: n }));

  // externals: SDK imports + config keys (keys only, never values)
  const EXT = { 'com.stripe': 'Stripe', 'com.google.api': 'Google APIs', 'com.google.cloud': 'Google Cloud', 'software.amazon': 'AWS', 'com.amazonaws': 'AWS', 'com.sendgrid': 'SendGrid', 'brevo': 'Brevo', 'sendinblue': 'Brevo', 'jakarta.mail': 'SMTP mail', 'javax.mail': 'SMTP mail', 'org.springframework.mail': 'SMTP mail', 'org.springframework.kafka': 'Kafka', 'org.springframework.amqp': 'RabbitMQ', 'redis': 'Redis', 'com.twilio': 'Twilio', 'io.minio': 'S3-compatible storage', 'com.openai': 'OpenAI', 'okhttp3': '(HTTP client)', 'org.springframework.web.reactive.function.client': '(HTTP client: WebClient)', 'org.springframework.web.client.RestTemplate': '(HTTP client: RestTemplate)', 'feign': '(HTTP client: Feign)', 'org.springframework.web.client.RestClient': '(HTTP client: RestClient)', 'java.net.http': '(HTTP client: java.net.http)' };
  const externals = {}; for (const j of java) for (const [k, v] of Object.entries(EXT)) if (new RegExp(`import\\s+[\\w.]*${k.replace(/\./g, '\\.')}`).test(j.text)) (externals[v] ??= []).push(j.p);
  const configFiles = files.filter((f) => /(application|bootstrap)[\w-]*\.(properties|ya?ml)$/.test(f) && /resources/.test(f));
  const configKeys = configFiles.map((f) => { const t = read(f); const keys = f.endsWith('.properties') ? t.split('\n').map((l, i) => [l.replace(/^#\s*/, ''), i + 1, /^\s*#/.test(l)]).filter(([l]) => /^[\w.\-\[\]]+\s*[=:]/.test(l)).map(([l, n, c]) => `${l.split(/[=:]/)[0].trim()}:${n}${c ? ' (commented)' : ''}`) : t.split('\n').map((l, i) => [l, i + 1]).filter(([l]) => /^\s*[\w-]+:/.test(l)).map(([l, n]) => `${l.trim().split(':')[0]}:${n}`); const db = /jdbc:(\w+)/.exec(t); return { file: R(f), db: db?.[1], keys }; });
  const buildFiles = files.filter((f) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?|package\.json)$/.test(R(f)) && R(f).split('/').length <= 3).map((f) => ({ file: R(f), deps: (read(f).match(/(org\.springframework\.boot:spring-boot-starter-[\w-]+|spring-boot-starter-[\w-]+|com\.stripe[:\w.-]*|"(react|react-dom|react-router-dom|@tanstack\/react-query|axios|vite|next|@angular\/core|vue)"|<artifactId>[\w.-]+<\/artifactId>)/g) ?? []).map((s) => s.replace(/<\/?artifactId>|"/g, '')).filter((s, i, a) => a.indexOf(s) === i).slice(0, 60) }));

  // state: who writes each entity (repository mutations per caller), copies of state, transaction seams
  const repoEntity = new Map(repos.map((r) => [r.name, /Repository\s*<\s*(\w+)/.exec(r.extends)?.[1]]));
  const writes = {};
  for (const j of nonEntity) {
    if (repoEntity.has(j.name)) continue;
    const vars = new Map([...j.text.matchAll(/\b(\w+(?:Repository|Repo))\s+(\w+)\s*[;,)=]/g)].filter((m) => repoEntity.has(m[1])).map((m) => [m[2], repoEntity.get(m[1])]));
    for (const [v, ent] of vars) for (const m of linesMatching(j.text, new RegExp(`\\b${v}\\.(save\\w*|delete\\w*|update\\w*|insert\\w*)\\(`))) ((writes[ent] ??= {})[j.p] ??= []).push(m.line);
  }
  const modifying = repos.flatMap((r) => linesMatching(r.text, /@Modifying/).map((m) => ({ file: r.p, line: m.line, entity: repoEntity.get(r.name) })));
  const caches = pick(/@Cacheable|@CacheEvict|@CachePut|@EnableCaching|expireAfter|\.ttl\(|entryTtl/).concat(fe.flatMap((f) => linesMatching(f.text, /localStorage\.|sessionStorage\.|staleTime|invalidateQueries|configureStore|\bcreate\(\s*\(set|persist\(/).map((m) => ({ file: f.p, ...m })))).slice(0, 80);
  const sdkFiles = new Set(java.filter((j) => Object.keys(EXT).some((k) => new RegExp(`import\\s+[\\w.]*${k.replace(/\./g, '\\.')}`).test(j.text))).map((j) => j.p));
  const seams = pick(/@Transactional\b|@TransactionalEventListener|publishEvent\(|TransactionSynchronization|kafkaTemplate\.send|rabbitTemplate\.convertAndSend/, java.filter((j) => sdkFiles.has(j.p) || /publishEvent\(|@TransactionalEventListener|TransactionSynchronization/.test(j.text))).slice(0, 60);

  // boot: entry points, profile switches, how to run locally
  const mains = java.filter((j) => /@SpringBootApplication/.test(j.text)).map((j) => ({ file: j.p, line: linesMatching(j.text, /static\s+void\s+main\s*\(/)[0]?.line }));
  const switches = pick(/@Profile\(|@ConditionalOnProperty\(|@ConditionalOnMissingBean|spring\.profiles\.active/).concat(configFiles.flatMap((f) => linesMatching(read(f), /profiles?\.active|on-profile/).map((m) => ({ file: R(f), ...m }))));
  const feEntries = files.filter((f) => /(^|\/)(vite\.config\.\w+|index\.html|src\/main\.[jt]sx?|src\/index\.[jt]sx?)$/.test(R(f)) && !/node_modules|resources\/(static|templates)/.test(R(f))).map((f) => ({ file: R(f), lines: linesMatching(read(f), /port|proxy|target|createRoot|render\(|type="module"/).slice(0, 8) }));
  const compose = files.filter((f) => /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/.test(R(f))).map((f) => ({ file: R(f), services: linesMatching(read(f), /^  [\w-]+:\s*$/).map((m) => `${m.text.replace(':', '')}:${m.line}`) }));
  const scripts = files.filter((f) => /(^|\/)package\.json$/.test(R(f)) && R(f).split('/').length <= 3).map((f) => { try { return { file: R(f), scripts: JSON.parse(read(f)).scripts ?? {} }; } catch { return { file: R(f), scripts: {} }; } });
  const profiles = configFiles.map((f) => R(f)).filter((f) => /application-[\w]+\./.test(f));

  // frontend routes
  const routes = fe.flatMap((f) => f.text.split('\n').flatMap((l, i) => { const m = /<Route[^>]*\bpath=["'{`]+([^"'}`]+)/.exec(l) ?? /\bpath:\s*["'](\/[^"']*)["']/.exec(l); return m ? [{ path: m[1], file: f.p, line: i + 1 }] : []; }));

  // docs
  const docs = files.filter((f) => /\.(md|adoc|rst)$/i.test(f)).map((f) => { const t = read(f); return { file: R(f), kb: Math.round(t.length / 102.4) / 10, title: (/^#\s+(.+)$/m.exec(t)?.[1] ?? '').slice(0, 90) }; });

  // git
  const gitInfo = (() => {
    const head = git(root, ['rev-parse', '--short', 'HEAD']); if (!head) return null;
    const dirty = !!git(root, ['status', '--porcelain', '--untracked-files=no']);
    const headDate = git(root, ['log', '-1', '--format=%cI']);
    const since = new Date(new Date(headDate).getTime() - 182.5 * 864e5).toISOString().slice(0, 10);
    const inWindow = Number(git(root, ['rev-list', '--count', `--since=${since}`, 'HEAD']));
    const total = Number(git(root, ['rev-list', '--count', 'HEAD']));
    const window = inWindow >= 20 ? { kind: '6 months', since, commits: inWindow } : total >= 10 ? { kind: 'last 50 commits', since: `last ${Math.min(50, total)} commits`, commits: Math.min(50, total) } : null;
    return { head, dirty, headDate, totalCommits: total, window };
  })();

  return {
    version: 1, root, scannedAt: new Date().toISOString().slice(0, 10),
    inventory: { byExt, topDirs: [...new Set(files.map((f) => R(f).split('/').slice(0, 2).join('/')))].slice(0, 60) },
    build: buildFiles, git: gitInfo, docs,
    packages: Object.entries(java.reduce((a, j) => { const d = path.dirname(j.p); a[d] = (a[d] ?? 0) + 1; return a; }, {})).map(([dir, n]) => ({ dir, javaFiles: n })).sort((a, b) => a.dir.localeCompare(b.dir)),
    entities: { count: entities.length, funnel, enums, repositories: repos.map((r) => ({ file: r.p, extends: r.extends })) },
    endpoints, frontend: { files: fe.length, routes, apiCalls: joined.length, unmatchedApiCalls: joined.filter((j) => !j.handler).map((j) => `${j.verb ?? ''} ${j.path} ${j.file}:${j.line}`), apiJoin: joined.filter((j) => j.handler).map((j) => `${j.verb ?? ''} ${j.path} ${j.file}:${j.line} -> ${j.handler}`) },
    views: { count: views.length, returnedBy: viewUse, deadViews },
    runtime: { security, methodSecurity, interceptors, contextScopes, exceptionHandlers, baseClasses, sessionState },
    background: { scheduledAsyncListeners: background, sockets, runners },
    state: { writes: Object.fromEntries(Object.entries(writes).map(([e, byFile]) => [e, Object.entries(byFile).map(([file, lines]) => `${file}:${lines.join(',')}`)])), modifying, caches, seams },
    boot: { mains, switches, profiles, frontend: feEntries, compose, scripts },
    externals: { sdkImports: Object.fromEntries(Object.entries(externals).map(([k, v]) => [k, [...new Set(v)].slice(0, 6)])), config: configKeys },
  };
}

// Compact digest the writer reads first; facts.json keeps the details for targeted lookup.
export function summarize(f) {
  const L = [];
  const sec = (h) => L.push('', `## ${h}`);
  const prefix = (list) => { if (!list.length) return ''; let p = list[0]; for (const s of list) while (!s.startsWith(p)) p = p.slice(0, p.lastIndexOf('/', p.length - 2) + 1); return p; };
  const J = prefix(f.packages.map((p) => p.dir + '/')), F = prefix(f.frontend.routes.map((r) => r.file).concat(f.frontend.apiJoin.map((s) => s.split(' ').find((x) => x.includes(':')) ?? '')).filter(Boolean));
  const ab = (s) => String(s).split(J).join(J.length > 8 ? 'J/' : J).split(F).join(F.length > 8 ? 'F/' : F);
  L.push(`# facts for ${path.basename(f.root)} (scanned ${f.scannedAt})`, 'Paths are relative to the project root. Details: facts.json (search it, don\'t read it whole).');
  if (J.length > 8) L.push('**J/ = @@J@@**'); if (F.length > 8) L.push('**F/ = @@F@@**'); L.push('Expand J/ and F/ to the full path in every citation.');
  sec('Git'); L.push(f.git ? `HEAD ${f.git.head}${f.git.dirty ? ' + local changes' : ''}; ${f.git.totalCommits} commits; activity window: ${f.git.window ? `${f.git.window.since} (${f.git.window.commits} commits)` : 'none (too few commits)'}` : 'no git history');
  sec('Build & externals'); for (const b of f.build) L.push(`- ${b.file}: ${b.deps.join(', ')}`);
  for (const [k, v] of Object.entries(f.externals.sdkImports)) L.push(`- ${k}: ${v.join(', ')}`);
  for (const c of f.externals.config) L.push(`- config ${c.file}${c.db ? ` (db: ${c.db})` : ''}: ${c.keys.length} keys (names only in facts.json)`);
  sec(`Docs (${f.docs.length})`); for (const d of f.docs.slice(0, 50)) L.push(`- ${d.file} (${d.kb} KB)${d.title ? ' · ' + d.title : ''}`);
  sec('Packages (java files per module/subfolder)');
  const mods = {}; for (const p of f.packages) { const r = p.dir.startsWith(J) ? p.dir.slice(J.length) : p.dir; const [m, ...sub] = r.split('/'); (mods[m || '.'] ??= []).push(`${sub.join('/') || '.'} ${p.javaFiles}`); }
  for (const [m, subs] of Object.entries(mods)) L.push(`- ${m}: ${subs.join(', ')}`);
  sec(`Entity funnel (${f.entities.count} entities; score = relIn·3 + log refs·4 + controllers + log frontend/views·3 + status·2)`);
  f.entities.funnel.slice(0, 20).forEach((e, i) => L.push(`${i + 1}. ${e.name} ${e.score} · ${e.file}:${e.line}${e.table ? ' table ' + e.table : ''} · relIn ${e.relIn}, refs ${e.refs}, ctrl ${e.controllers}, svc ${e.services}, fe ${e.frontendFiles}, views ${e.viewFiles}${e.status ? ', status' : ''}${e.flags.length ? ' · ' + e.flags.join(' ') : ''}${e.relations.length ? '\n   rel: ' + e.relations.join('; ') : ''}`));
  if (f.entities.funnel.length > 20) L.push(`rest: ${f.entities.funnel.slice(20).map((e) => `${e.name}(${e.score}${e.flags.length ? ' ' + e.flags.join(' ') : ''})`).join(', ')}`);
  sec('Enums'); for (const e of f.entities.enums) L.push(`- ${e.name} ${e.file}:${e.line}: ${e.values.join(' ')}`);
  sec(`Controllers (${f.endpoints.length} endpoints)`);
  const byCtl = {}; for (const e of f.endpoints) { const k = e.inheritedBy ?? e.file; (byCtl[k] ??= []).push(e); }
  for (const [file, eps] of Object.entries(byCtl)) { const prefixes = [...new Set(eps.map((e) => e.path.split('/').slice(0, 4).join('/')))]; L.push(`- ${file}: ${eps.length} (${[...new Set(eps.map((e) => e.verb))].join('/')}) ${prefixes.slice(0, 3).join(' ')}`); }
  sec('Frontend'); L.push(`${f.frontend.files} files; ${f.frontend.apiCalls} API call sites matched to endpoints in facts.json (frontend.apiJoin); unmatched: ${f.frontend.unmatchedApiCalls.length ? f.frontend.unmatchedApiCalls.join(' | ') : 'none'}`);
  for (const r of f.frontend.routes.slice(0, 80)) L.push(`- route ${r.path} ${r.file}:${r.line}`);
  if (f.views.count) { L.push(`${f.views.count} server-rendered views; returned by controllers: ${Object.keys(f.views.returnedBy).length}; never returned or included (dead?): ${f.views.deadViews.join(', ') || 'none'}`); }
  sec('Request machinery');
  for (const s of f.runtime.security) L.push(`- security ${s.file}:${s.line} ${s.text}`);
  L.push(`- method security annotations: ${f.runtime.methodSecurity.map((m) => `${m.file} ×${m.n}`).join(', ') || 'none'}`);
  for (const s of f.runtime.interceptors) L.push(`- interceptor/filter ${s.file}:${s.line} ${s.text}`);
  for (const s of f.runtime.contextScopes) L.push(`- context ${s.file}:${s.line} ${s.text}`);
  if (f.runtime.exceptionHandlers.length) L.push(`- @ExceptionHandler in ${f.runtime.exceptionHandlers.length} files (list in facts.json)`);
  for (const b of f.runtime.baseClasses) L.push(`- base class ${b.base}: ${b.subclasses} subclasses`);
  for (const s of f.runtime.sessionState.slice(0, 30)) L.push(`- session ${s.file}:${s.line} ${s.text}`);
  sec('Boot (entry points, profile switches, run locally)');
  for (const m of f.boot.mains) L.push(`- main ${m.file}:${m.line ?? ''}`);
  for (const e of f.boot.frontend) L.push(`- frontend ${e.file}: ${e.lines.map((l) => `${l.line} ${l.text}`).join(' | ')}`);
  if (f.boot.profiles.length) L.push(`- profile configs: ${f.boot.profiles.join(', ')}`);
  for (const s of f.boot.switches) L.push(`- switch ${s.file}:${s.line} ${s.text}`);
  for (const c of f.boot.compose) L.push(`- compose ${c.file}: ${c.services.join(', ')}`);
  for (const s of f.boot.scripts) if (Object.keys(s.scripts).length) L.push(`- scripts ${s.file}: ${Object.entries(s.scripts).filter(([k]) => /^(dev|start|serve|build)$/.test(k)).map(([k, v]) => `${k}=${v}`).join('; ')}`);
  sec('State (who writes each entity; copies; transaction seams)');
  for (const [e, byFile] of Object.entries(f.state.writes).sort((a, b) => b[1].length - a[1].length)) L.push(`- ${e} written from ${byFile.length} files: ${byFile.join(' ; ')}`);
  for (const m of f.state.modifying) L.push(`- @Modifying ${m.entity} ${m.file}:${m.line}`);
  for (const c of f.state.caches) L.push(`- copy/cache ${c.file}:${c.line} ${c.text}`);
  for (const s of f.state.seams) L.push(`- seam? ${s.file}:${s.line} ${s.text}`);
  sec('Runs on its own');
  for (const b of f.background.scheduledAsyncListeners) L.push(`- @${b.kind}${b.args ? ' ' + b.args : ''} ${b.file}:${b.line}`);
  for (const s of f.background.sockets) L.push(`- socket ${s.file}:${s.line} ${s.path ?? s.text}`);
  for (const r of f.background.runners) L.push(`- startup runner ${r.file}:${r.line}`);
  return ab(L.join('\n')).replace('@@J@@', J).replace('@@F@@', F) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(process.argv[2] ?? '.');
  const out = path.resolve(process.argv[3] ?? path.join(root, 'mindmodel', '.work', 'facts.json'));
  const facts = scan(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(facts, null, 1));
  fs.writeFileSync(out.replace(/\.json$/, '.md'), summarize(facts));
  const f = facts;
  console.log(`wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB): ${f.entities.count} entities, ${f.endpoints.length} endpoints, ${f.frontend.apiCalls} frontend API calls (${f.frontend.unmatchedApiCalls.length} unmatched), ${f.views.count} views, ${f.background.scheduledAsyncListeners.length} scheduled/async/listeners, ${f.runtime.security.length} security lines, ${f.docs.length} docs, git ${f.git ? f.git.head + (f.git.dirty ? '+dirty' : '') + ' window=' + (f.git.window?.since ?? 'none') : 'none'}`);
}
