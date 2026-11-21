#!/usr/bin/env node
// System scan: the services in a folder and the proven connections between them (REST, Kafka, JMS).
// Each service is scanned with the single-app scanner; this adds what crosses service boundaries and joins it.
// Usage: node system.mjs <folder> [outDir]   (default out: <folder>/mindmodel-system/.work/)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { scan, summarize } from './scan.mjs';
import { configKeys } from './deep.mjs';

// --- per-service extraction --------------------------------------------------------
// Placeholders like "${app.topics.orders:orders}" resolve from the service's own config, else their default.
export function resolve(value, keys) {
  const m = /^\$\{([^}:]+)(?::([^}]*))?\}$/.exec(value);
  if (!m) return { name: value };
  const k = keys.get(m[1]);
  if (k && !/^\$\{/.test(k.value)) return { name: k.value, via: `${m[1]}` };
  return m[2] != null && m[2] !== '' ? { name: m[2], via: `${m[1]} default` } : { name: null, unresolved: m[1] };
}
assert.deepStrictEqual(resolve('${t.orders:orders}', new Map()), { name: 'orders', via: 't.orders default' });
assert.deepStrictEqual(resolve('${t.orders}', new Map([['t.orders', { value: 'orders-v2' }]])), { name: 'orders-v2', via: 't.orders' });
assert.deepStrictEqual(resolve('${t.x}', new Map()), { name: null, unresolved: 't.x' });

// Messaging is detected by patterns: built-ins for Spring Kafka, Kafka Streams, Spring Cloud Stream, JMS and
// Eventuate Tram, plus a company's own wrapper patterns from <folder>/mindmodel-system.json. EXPR captures the
// channel argument: a string literal, a constant (Topics.ORDERS), an Entity.class or a variable.
const EXPR = '("[^"]*"|[A-Z]\\w*(?:\\.\\w+)+|[a-z]\\w*(?:\\.\\w+)*)', NAMED = '("[^"]*"|[A-Z]\\w*\\.[A-Z_][A-Z0-9_]*)';
export const BUILTIN = [
  { kind: 'kafka', dir: 'in', re: '@KafkaListener\\s*\\([^)]*?topics\\s*=\\s*\\{?\\s*EXPR' },
  { kind: 'kafka', dir: 'out', re: '\\b\\w*(?:[kK]afka\\w*|template)\\.send\\s*\\(\\s*EXPR' },
  // Kafka Streams only with a named topic: a variable here is almost always Java's own Stream API.
  { kind: 'kafka', dir: 'in', re: '\\.stream\\s*\\(\\s*NAMED' },
  { kind: 'kafka', dir: 'out', re: '\\.to\\s*\\(\\s*NAMED' },
  { kind: 'kafka', dir: 'out', re: '[sS]treamBridge\\.send\\s*\\(\\s*EXPR' },
  { kind: 'jms', dir: 'in', re: '@JmsListener\\s*\\([^)]*destination\\s*=\\s*EXPR' },
  { kind: 'jms', dir: 'out', re: '\\b\\w*[jJ]ms\\w*\\.(?:convertAndSend|send)\\s*\\(\\s*EXPR' },
  // Eventuate Tram (domain events and saga commands, carried by Kafka)
  { kind: 'kafka', dir: 'out', re: '\\b\\w*[pP]ublisher\\.publish\\s*\\(\\s*EXPR', publisher: true },
  { kind: 'kafka', dir: 'out', re: '\\.withChannel\\s*\\(\\s*EXPR' },
  { kind: 'kafka', dir: 'in', re: '\\.fromChannel\\s*\\(\\s*EXPR' },
  { kind: 'kafka', dir: 'in', re: '\\.(?:and)?[fF]orAggregateType\\s*\\(\\s*EXPR' },
];
export function messaging(text, patterns = BUILTIN) {
  const out = [], compiled = patterns.map((p) => ({ ...p, rx: new RegExp(p.re.replace('EXPR', EXPR).replace('NAMED', NAMED), 'g') }));
  text.split('\n').forEach((l, i) => { for (const p of compiled) for (const m of l.matchAll(p.rx)) out.push({ kind: p.kind, dir: p.dir, expr: m[1], line: i + 1, publisher: p.publisher, recv: /(\w+)\.publish/.exec(m[0])?.[1] }); });
  return out;
}
{
  const t = '@KafkaListener(id = "o", topics = "orders", groupId = "p")\ntemplate.send("payment-orders", id, o);\nbuilder.stream("stock-orders").to("orders");\n@JmsListener(destination = "${q.audit:audit}")\njmsTemplate.convertAndSend("invoices", x);\n.fromChannel(KitchenServiceChannels.COMMAND_CHANNEL)\ndomainEventPublisher.publish(Consumer.class, id, events);\n.andForAggregateType(K.CH)';
  assert.deepStrictEqual(messaging('StreamSupport.stream(result.spliterator(), false)\nlist.stream().map(x).collect(toList())').length, 0);
  assert.deepStrictEqual(messaging(t).map((x) => `${x.kind}:${x.dir}:${x.expr}`), ['kafka:in:"orders"', 'kafka:out:"payment-orders"', 'kafka:in:"stock-orders"', 'kafka:out:"orders"', 'jms:in:"${q.audit:audit}"', 'jms:out:"invoices"', 'kafka:in:KitchenServiceChannels.COMMAND_CHANNEL', 'kafka:out:Consumer.class', 'kafka:in:K.CH']);
}

// Folder-wide index for resolving channel expressions: string constants (Class.NAME) and class names to FQNs.
export function codeIndex(files) {
  const constants = new Map(), fqn = new Map(), aggregateOf = new Map();
  for (const { path: p, text } of files) {
    const cls = path.basename(p, '.java'), pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
    if (pkg) fqn.set(cls, `${pkg}.${cls}`);
    for (const m of text.matchAll(/\bstatic\s+(?:final\s+)?String\s+(\w+)\s*=\s*"([^"]*)"/g)) { constants.set(`${cls}.${m[1]}`, m[2]); if (!constants.has(m[1])) constants.set(m[1], m[2]); }
    const agg = /class\s+\w+\s+extends\s+\w*Aggregate\w*Publisher\w*\s*<\s*(\w+)/.exec(text); if (agg) aggregateOf.set(cls, agg[1]);
  }
  return { constants, fqn, aggregateOf };
}

// Resolve a channel expression to a name. Unresolvable names stay visible as unresolved, never guessed.
export function channelName(x, text, keys, ix) {
  const e = x.expr;
  if (/^".*"$/.test(e)) return resolve(e.slice(1, -1), keys);
  if (/\.class$/.test(e)) { const c = e.replace(/\.class$/, '').split('.').pop(); return ix.fqn.has(c) ? { name: ix.fqn.get(c), via: `${c}.class` } : { name: null, unresolved: e }; }
  if (ix.constants.has(e)) return { name: ix.constants.get(e), via: e };
  // A field or parameter injected from config: @Value("${key}") ... String var
  const inj = new RegExp(`@Value\\(\\s*"(\\$\\{[^}]+\\})"\\s*\\)\\s*(?:private\\s+|protected\\s+|public\\s+)?(?:final\\s+)?String\\s+${e.replace(/^this\./, '')}\\b`).exec(text);
  if (inj) return resolve(inj[1], keys);
  // An aggregate publisher (FooDomainEventPublisher extends Abstract...Publisher<Foo>) publishes to Foo's channel.
  if (x.publisher && x.recv) { const t = new RegExp(`\\b(\\w+)\\s+${x.recv}\\s*[;=)]`).exec(text)?.[1]; const agg = t && ix.aggregateOf.get(t); if (agg && ix.fqn.has(agg)) return { name: ix.fqn.get(agg), via: `${t} → ${agg}` }; }
  return { name: null, unresolved: e };
}
{
  const ix = { constants: new Map([['K.CH', 'kitchenService']]), fqn: new Map([['Ticket', 'a.b.Ticket']]), aggregateOf: new Map([['TicketPub', 'Ticket']]) };
  assert.equal(channelName({ expr: 'K.CH' }, '', new Map(), ix).name, 'kitchenService');
  assert.equal(channelName({ expr: 'ticket', publisher: true, recv: 'pub' }, 'private TicketPub pub;', new Map(), ix).name, 'a.b.Ticket');
  assert.equal(channelName({ expr: 'Ticket.class' }, '', new Map(), ix).name, 'a.b.Ticket');
  assert.equal(channelName({ expr: 'queueName' }, '@Value("${risk.queueName}")\n\tprivate String queueName;', new Map([['risk.queueName', { value: 'risk-q' }]]), ix).name, 'risk-q');
}

// REST calls to other services: Feign clients, URLs with a host name, lb:// gateway routes.
export function restCalls(text) {
  const out = [];
  // A dotted host (github.com) is outside the system: the host stops at the dot, so the closing quote never follows.
  text.split('\n').forEach((l, i) => {
    let m;
    if ((m = /@FeignClient\s*\(([^)]*)/.exec(l))) { const n = /(?:name|value)\s*=\s*"([^"]+)"/.exec(m[1]) ?? /^\s*"([^"]+)"/.exec(m[1]); if (n) out.push({ host: n[1], path: '', line: i + 1, via: 'feign' }); }
    for (const d of l.matchAll(/\b(?:getInstances|choose|getInstance)\s*\(\s*"([a-z][a-z0-9-]*)"/g)) out.push({ host: d[1], path: '', line: i + 1, via: 'discovery' });
    for (const u of l.matchAll(/"(?:https?|lb):\/\/([a-z][a-z0-9-]*)(?::\d+)?(\/[^"]*)?"/g)) if (!/^(localhost|www)$/.test(u[1])) out.push({ host: u[1], path: (u[2] ?? '').split('?')[0], line: i + 1, via: 'url' });
  });
  return out;
}
assert.deepStrictEqual(restCalls('.uri("http://customers-service/owners/{id}")\n@FeignClient(name = "billing")\ndiscoveryClient.getInstances("customers-service").get(0)').map((x) => `${x.host}${x.path}`), ['customers-service/owners/{id}', 'billing', 'customers-service']);

// Gateway routes in YAML: "uri: lb://vets-service" followed by "- Path=/api/vet/**".
export function gatewayRoutes(yml) {
  const out = []; let cur = null;
  yml.split('\n').forEach((l, i) => {
    const u = /uri:\s*(?:lb|https?):\/\/([a-z][a-z0-9-]*)(?=[:/\s"']|$)/.exec(l); if (u) { cur = { host: u[1], line: i + 1, paths: [] }; out.push(cur); }
    const p = /-\s*Path=([^\s#]+)/.exec(l); if (p && cur) cur.paths.push(...p[1].split(','));
  });
  return out;
}
assert.deepStrictEqual(gatewayRoutes('uri: lb://vets-service\n  predicates:\n    - Path=/api/vet/**'), [{ host: 'vets-service', line: 1, paths: ['/api/vet/**'] }]);

// --- discovery -----------------------------------------------------------------------
const IGNORE = /(^|\/)(node_modules|target|build|\.git|mindmodel|mindmodel-system|docs|docker|scripts)(\/|$)/;
export function findServices(folder) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > 2 || IGNORE.test(dir)) return;
    const has = (f) => fs.existsSync(path.join(dir, f));
    if ((has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) && fs.existsSync(path.join(dir, 'src/main'))) { out.push(dir); return; }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) visit(path.join(dir, e.name), depth + 1);
  };
  visit(folder, 0);
  return out;
}

// --- the system scan ---------------------------------------------------------------
const javaFiles = (dir) => { const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(test|target|build)$/.test(e.name)) walk(p); } else if (e.name.endsWith('.java')) out.push(p); } }; walk(path.join(dir, 'src/main')); return out; };
const isApp = (dir) => javaFiles(dir).some((f) => { const t = fs.readFileSync(f, 'utf8'); return /static\s+void\s+main\s*\(/.test(t) && /SpringApplication|@SpringBootApplication|@SpringBootConfiguration/.test(t); });

export function systemScan(folder) {
  const modules = findServices(folder);
  // Company wrappers around Kafka/JMS: extra patterns from <folder>/mindmodel-system.json ({"messaging":[{"kind","dir","re"}]}).
  const custom = fs.existsSync(path.join(folder, 'mindmodel-system.json')) ? JSON.parse(fs.readFileSync(path.join(folder, 'mindmodel-system.json'), 'utf8')).messaging ?? [] : [];
  const patterns = [...BUILTIN, ...custom];
  const ix = codeIndex(modules.flatMap((d) => javaFiles(d).map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }))));
  // Modules without a Spring entry point are shared libraries (DTOs, events), not services.
  const libraries = modules.filter((d) => !isApp(d)).map((d) => path.relative(folder, d));
  const services = modules.filter(isApp).map((dir) => {
    const facts = scan(dir);
    const res = path.join(dir, 'src/main/resources');
    const cfgFiles = !fs.existsSync(res) ? [] : fs.readdirSync(res, { withFileTypes: true }).filter((e) => e.isFile() && /^(application|bootstrap)\.(ya?ml|properties)$/.test(e.name)).map((e) => path.join(dir, 'src/main/resources', e.name));
    const keys = new Map(), ymls = [];
    for (const f of cfgFiles) { const t = fs.readFileSync(f, 'utf8'); ymls.push({ f, t }); for (const [k, v] of configKeys(t, f.endsWith('.properties'))) keys.set(k, { ...v, file: path.relative(folder, f) }); }
    const name = keys.get('spring.application.name')?.value ?? path.basename(dir);
    const port = /^\d+$/.test(keys.get('server.port')?.value ?? '') ? keys.get('server.port').value : null;
    const rel = (p) => path.relative(folder, path.join(dir, p));
    const java = javaFiles(dir);
    const msgs = [], calls = [];
    for (const f of java) {
      const t = fs.readFileSync(f, 'utf8'), r = path.relative(folder, f);
      for (const x of messaging(t, patterns)) { const res = channelName(x, t, keys, ix); msgs.push({ kind: x.kind, dir: x.dir, line: x.line, ...res, raw: x.expr, cite: `${r}:${x.line}` }); }
      for (const c of restCalls(t)) calls.push({ ...c, cite: `${r}:${c.line}` });
    }
    for (const [k, v] of keys) { const u = /^(?:https?|lb):\/\/([a-z][a-z0-9-]*)(?::(\d+))?(?=[:/]|$)/.exec(v.value); if (u && u[1] !== 'www' && k !== 'server.port') calls.push({ host: u[1] === 'localhost' ? `localhost:${u[2]}` : u[1], path: '', via: 'config', cite: `${v.file}:${v.line}` }); }
    // Destinations bound from config that is not in the repo (env vars, deployment): named, marked unresolved.
    const unresolvedDest = [];
    for (const f of java) { const t = fs.readFileSync(f, 'utf8'), pre = /@ConfigurationProperties\s*\(\s*(?:prefix\s*=\s*)?"([^"]+)"/.exec(t)?.[1]; if (pre) for (const m of t.matchAll(/private\s+String\s+(\w*(?:Url|Uri|Host))\s*;/g)) { const key = `${pre}.${m[1]}`; if (![...keys.keys()].some((k) => k.toLowerCase().replace(/-/g, '') === key.toLowerCase())) unresolvedDest.push(key); } }
    for (const { f, t } of ymls) for (const g of gatewayRoutes(t)) calls.push({ host: g.host, path: g.paths.join(','), via: 'gateway', cite: `${path.relative(folder, f)}:${g.line}` });
    const text = java.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const role = /@EnableConfigServer/.test(text) ? 'config server' : /@EnableEurekaServer/.test(text) ? 'discovery server' : /@EnableAdminServer/.test(text) ? 'admin server' : null;
    return { name, dir: path.relative(folder, dir) || '.', role, facts, msgs, calls, unresolvedDest, port, lines: text.split('\n').length };
  });

  // Two services with the same spring.application.name (a copy-paste slip) would merge in discovery: tell them apart by folder.
  const dupes = services.filter((s) => services.filter((o) => o.name === s.name).length > 1);
  for (const s of dupes) { s.nameConflict = s.name; s.name = path.basename(s.dir); }
  // Join: topics/queues to their producers and consumers; REST calls to the service they reach.
  // Match a call to a service by its name, its folder, the same name without dashes ("customercore"), or, for
  // local URLs like http://localhost:8110, by the port the service runs on.
  const norm = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map(services.flatMap((s) => [[s.name, s], [path.basename(s.dir), s], [norm(s.name), s], [norm(path.basename(s.dir)), s], ...(s.port ? [[`localhost:${s.port}`, s]] : [])]));
  const channels = {};
  for (const s of services) for (const m of s.msgs) { const key = `${m.kind}:${m.name ?? `?${m.unresolved}`}`; (channels[key] ??= { kind: m.kind, name: m.name, unresolved: m.unresolved, out: [], in: [] })[m.dir].push({ service: s.name, cite: m.cite }); }
  const rest = [];
  for (const s of services) for (const c of s.calls) {
    const target = byName.get(c.host) ?? byName.get(norm(c.host));
    const ep = target && c.path && c.via !== 'gateway' ? target.facts.endpoints.find((e) => e.path === c.path.replace(/\{[^}]+\}/g, '{}').replace(/\/$/, '')) : null;
    rest.push({ from: s.name, to: target?.name ?? c.host, known: !!target, path: c.path, via: c.via, cite: c.cite, endpoint: ep ? `${ep.file}:${ep.line}` : null });
  }
  return { folder, services, libraries, channels: Object.values(channels), rest, duplicates: dupes.map((s) => ({ name: s.nameConflict, dir: s.dir })) };
}

// Compact digest for the system writer, with the same "facts first" contract as facts.md.
export function systemSummary(sys) {
  const L = [`# system facts for ${path.basename(sys.folder)} (${sys.services.length} services)`, 'Paths are relative to the folder. Details: system.json.', ''];
  L.push('## Services (size, data, interface)');
  if (sys.libraries.length) L.push(`- shared libraries (no entry point, not services): ${sys.libraries.join(', ')}`);
  for (const s of sys.services) {
    const ents = s.facts.entities.funnel.slice(0, 5).map((e) => e.name).join(', ');
    L.push(`- ${s.name} (${s.dir})${s.role ? ` [${s.role}]` : ''}: ${s.lines} lines, ${s.facts.endpoints.length} endpoints, ${s.facts.entities.count} entities${ents ? ` (${ents})` : ''}`);
  }
  if (sys.duplicates.length) L.push(`- DUPLICATE spring.application.name: ${sys.duplicates.map((d) => `"${d.name}" in ${d.dir}`).join(', ')}; listed under their folder names`);
  for (const s of sys.services) if (s.unresolvedDest?.length) L.push(`- ${s.name}: REST destinations set outside the repo (env/deployment), UNRESOLVED: ${s.unresolvedDest.join(', ')}`);
  L.push('', '## Messaging (channel: producers → consumers)');
  for (const c of sys.channels) {
    const who = (xs) => [...new Set(xs.map((x) => x.service))].join(', ') || 'none in this folder';
    L.push(`- ${c.kind} ${c.name ?? `UNRESOLVED (${c.unresolved})`}: ${who(c.out)} → ${who(c.in)} · ${[...c.out, ...c.in].slice(0, 4).map((x) => x.cite).join(', ')}`);
  }
  L.push('', '## REST between services (caller → callee)');
  const seen = new Set();
  for (const r of sys.rest) { const k = `${r.from}>${r.to}>${r.path}`; if (seen.has(k)) continue; seen.add(k); L.push(`- ${r.from} → ${r.to}${r.known ? '' : ' (not in this folder)'} ${r.path || ''} [${r.via}] ${r.cite}${r.endpoint ? ` → ${r.endpoint}` : ''}`); }
  // Plumbing (config, discovery, admin servers) is not something services rely on for their business.
  const plumbing = new Set(sys.services.filter((s) => s.role).map((s) => s.name));
  const fanIn = {}; for (const r of sys.rest) if (r.known && !plumbing.has(r.to)) (fanIn[r.to] ??= new Set()).add(r.from); for (const c of sys.channels) for (const o of c.out) for (const i of c.in) if (o.service !== i.service) (fanIn[o.service] ??= new Set()).add(i.service);
  L.push('', '## Dependence (who relies on each service: callers + consumers of what it produces)');
  for (const s of [...sys.services].sort((a, b) => (fanIn[b.name]?.size ?? 0) - (fanIn[a.name]?.size ?? 0))) L.push(`- ${s.name}: ${fanIn[s.name]?.size ?? 0}${fanIn[s.name]?.size ? ` (${[...fanIn[s.name]].join(', ')})` : ''}`);
  return L.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const folder = path.resolve(process.argv[2] ?? '.');
  const out = path.resolve(process.argv[3] ?? path.join(folder, 'mindmodel-system', '.work'));
  const sys = systemScan(folder);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'system.json'), JSON.stringify({ ...sys, services: sys.services.map(({ facts, ...s }) => ({ ...s, endpoints: facts.endpoints.length, entities: facts.entities.funnel.slice(0, 10).map((e) => e.name) })) }, null, 1));
  fs.writeFileSync(path.join(out, 'system.md'), systemSummary(sys));
  // Each service's own facts digest, so the writer can look inside a service without rescanning it.
  fs.mkdirSync(path.join(out, 'services'), { recursive: true });
  for (const s of sys.services) fs.writeFileSync(path.join(out, 'services', `${s.name}.md`), summarize(s.facts));
  console.log(`wrote ${out}/system.md: ${sys.services.length} services, ${sys.channels.length} channels, ${sys.rest.length} REST calls`);
}
