#!/usr/bin/env node
// System scan: the services in a folder and the proven connections between them (REST, Kafka, JMS).
// The folder is read through one engine dump — the only reader of its Java — and every service's own facts come from
// the single-app scanner; this adds what crosses service boundaries and joins it.
// Usage: node system.mjs <folder> [outDir]   (default out: <folder>/mindmodel-system/.work/)
import fs from 'node:fs';
import { retuneHeap } from './io/heap.mjs';
import path from 'node:path';
import { scan, summarize } from './scan.mjs';
import { configKeys } from './extract/config.mjs';
import { dumpFor } from './io/dump-run.mjs';
import { open as openDump } from './dump.mjs';
import { simple } from './core/names.mjs';
import { annotationOn, hasAnnotation } from './core/annotations.mjs';
import { NON_SERVICE_DIRS, relPosix } from './core/paths.mjs';
import { placeholderOf } from './core/placeholders.mjs';
import { buildModelFromDump } from './model/from-dump-model.mjs';

// --- per-service extraction --------------------------------------------------------
// Placeholders like "${app.topics.orders:orders}" resolve from the service's own config, else their default.
export function resolve(value, keys) {
  const p = placeholderOf(value);
  if (!p) return { name: value };
  const k = keys.get(p.key);
  if (k && !/^\$\{/.test(k.value)) return { name: k.value, via: p.key };
  return p.def ? { name: p.def, via: `${p.key} default` } : { name: null, unresolved: p.key };
}

const dumpArgs = (db, call) => (db && call?.id ? db.argsOf(call.id) : []);
const stringArg = (a) => (typeof a?.value === 'string' ? a.value : null);
const quoted = (v) => `"${v}"`;
// An annotation as the dump wrote it: its arguments are values, not the source text the model keeps for display.
const typeRow = (module, t) => module?.db?.type(t.fqn) ?? null;
const memberRow = (module, m) => (m.id ? (module.db.members.get(m.id) ?? null) : null);

/** Every string an annotation value folds to, arrays included; a nested annotation names no channel. */
const flatStrings = (value) => {
  if (!value) return [];
  if (value.kind === 'array') return (value.value ?? []).flatMap((v) => flatStrings(v));
  if (value.kind === 'annotation' || value.kind === 'unresolved' || value.value == null) return [];
  return typeof value.value === 'string' ? [value.value] : [];
};


// Messaging is one row per channel use: a listener annotation's topic, or a call on a messaging library type whose
// channel argument the dump folded. `recv` is the receiver type's simple name (a suffix: a project's own publisher
// extends the library's), `name` the method the call names.
// `<folder>/mindmodel-system.json` may add a company's own wrappers: an entry's `re` is then tested against
// `Type.method` — names the dump wrote, never source text.
export const BUILTIN = [
  { kind: 'kafka', dir: 'in', annotation: 'KafkaListener', arg: 'topics' },
  { kind: 'jms', dir: 'in', annotation: 'JmsListener', arg: 'destination' },
  { kind: 'kafka', dir: 'out', recv: 'KafkaTemplate', name: 'send' },
  { kind: 'kafka', dir: 'out', recv: 'StreamBridge', name: 'send' },
  { kind: 'jms', dir: 'out', recv: 'JmsTemplate', name: 'convertAndSend' },
  { kind: 'jms', dir: 'out', recv: 'JmsTemplate', name: 'send' },
  // Eventuate Tram (domain events and saga commands, carried by Kafka)
  { kind: 'kafka', dir: 'out', recv: 'DomainEventPublisher', name: 'publish', publisher: true },
  { kind: 'kafka', dir: 'out', name: 'withChannel' },
  { kind: 'kafka', dir: 'in', name: 'fromChannel' },
  { kind: 'kafka', dir: 'in', name: 'forAggregateType' },
  { kind: 'kafka', dir: 'in', name: 'andForAggregateType' },
  // Kafka Streams only with a named topic: a variable here is almost always Java's own Stream API.
  { kind: 'kafka', dir: 'in', recv: 'StreamsBuilder', name: 'stream', named: true },
  { kind: 'kafka', dir: 'out', name: 'to', named: true },
];

/**
 * Messaging rows for one module: `{kind, dir, line, expr, raw, arg, recv, file}`. `expr` is the argument as the dump
 * spells it (a literal in quotes, a constant by name, `X.class`), `arg` the typed value `channelName` resolves.
 */
export function messaging(module, patterns = BUILTIN) {
  const out = [];
  const { db, types } = module ?? {};
  if (!db) return out;
  for (const t of types ?? []) {
    for (const m of t.methods ?? []) {
      const row = memberRow(module, m);
      for (const rule of patterns.filter((p) => p.annotation)) {
        const a = annotationOn(row, rule.annotation);
        if (!a) continue;
        for (const v of flatStrings(a.args?.[rule.arg]))
          out.push({
            kind: rule.kind,
            dir: rule.dir,
            line: a.line || m.start,
            expr: quoted(v),
            raw: quoted(v),
            arg: { kind: 'literal', text: quoted(v), value: v, valueKind: 'string' },
            file: module.prefix + t.file,
            mfile: t.file,
          });
      }
      for (const c of m.calls ?? []) {
        const recvName = simple(c.recvFqn);
        for (const rule of patterns) {
          if (rule.annotation) continue;
          if (rule.recv && !recvName.endsWith(rule.recv)) continue;
          if (rule.name && c.name !== rule.name) continue;
          if (rule.re && !new RegExp(rule.re).test(`${recvName}.${c.name}`)) continue;
          const arg = dumpArgs(db, c)[0];
          if (!arg) continue;
          // A streams `stream(...)`/`to(...)` with a variable names no topic: Java's own Stream API looks the same.
          if (rule.named && !namedTopic(arg)) continue;
          out.push({
            kind: rule.kind,
            dir: rule.dir,
            line: c.line,
            expr: String(arg.text ?? ''),
            raw: String(arg.text ?? ''),
            arg,
            recv: rule.publisher ? recvName : undefined,
            publisher: rule.publisher,
            file: module.prefix + t.file,
            mfile: t.file,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.dir.localeCompare(b.dir));
}

/** A literal or a `Class.CONSTANT` read: the two shapes a named topic takes. */
const namedTopic = (arg) => arg.kind === 'literal' || arg.kind === 'constant';

// Jakarta EE JMS, which a listener's activation config names instead of a topic: a message-driven bean's destination is
// in `@MessageDriven`'s activation properties, and a sender sends to a field injected by JNDI name (`@Resource`).
export function jakartaJms(module) {
  const { db, types } = module ?? {};
  const out = [];
  if (!db) return out;
  for (const t of types ?? []) {
    const row = typeRow(module, t);
    const mdb = annotationOn(row, 'MessageDriven');
    if (mdb) {
      const dest = messageDestination(mdb);
      if (dest) out.push({ kind: 'jms', dir: 'in', name: dest, line: mdb.line || t.start, file: module.prefix + t.file });
    }
    // A JNDI-injected destination: the field names the queue, and a send on that field is a producer for it.
    const injected = new Map();
    for (const f of t.fields ?? []) {
      const fieldRow = (db.membersOf(t.fqn) ?? []).find((x) => x.kind === 'field' && x.name === f.name);
      const a = annotationOn(fieldRow, 'Resource');
      if (!a) continue;
      const name = ['lookup', 'name', 'mappedName'].map((k) => flatStrings(a.args?.[k])[0]).find(Boolean);
      if (name) injected.set(`${t.fqn}#${f.name}`, name);
    }
    if (!injected.size) continue;
    for (const m of t.methods ?? [])
      for (const c of m.calls ?? []) {
        if (c.name !== 'send' && c.name !== 'convertAndSend') continue;
        const arg = dumpArgs(db, c)[0];
        const name = arg?.field ? injected.get(arg.field) : null;
        if (name) out.push({ kind: 'jms', dir: 'out', name, line: c.line, file: module.prefix + t.file });
      }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The destination an MDB's activation config names: `destinationLookup`, `destinationName`, `destination`, `mappedName`. */
function messageDestination(a) {
  const props = flatAnnotationValues(a.args?.activationConfig);
  for (const p of props) {
    const key = ['propertyName'].map((k) => flatStrings(p?.args?.[k])[0])[0];
    if (!/^destination(?:Lookup|Name)?$/.test(key ?? '')) continue;
    const value = flatStrings(p.args.propertyValue)[0];
    if (value) return value;
  }
  return flatStrings(a.args?.mappedName)[0] ?? null;
}

const flatAnnotationValues = (value) => {
  if (!value) return [];
  if (value.kind === 'array') return (value.value ?? []).flatMap((v) => flatAnnotationValues(v));
  if (value.kind !== 'annotation') return [];
  return [value.value];
};

/** Folder-wide index for resolving channel expressions: string constants, simple names to FQNs, aggregate publishers. */
export function codeIndex(model) {
  const constants = new Map(),
    fqn = new Map(),
    aggregateOf = new Map();
  for (const t of model?.types?.values() ?? []) {
    fqn.set(t.name, t.fqn);
    for (const [id, value] of model.constants ?? []) {
      if (!id.startsWith(`${t.fqn}.`)) continue;
      const name = id.slice(t.fqn.length + 1);
      constants.set(`${t.name}.${name}`, value);
      if (!constants.has(name)) constants.set(name, value);
    }
    // An aggregate publisher (`FooDomainEventPublisher extends ...Aggregate...Publisher<Foo>`) publishes to Foo's channel.
    const base = (t.supers ?? []).find((s) => /Aggregate\w*Publisher/.test(s.text ?? ''));
    const aggregate = /<\s*([\w.]+)/.exec(base?.text ?? '')?.[1];
    if (aggregate) aggregateOf.set(t.name, simple(aggregate));
  }
  return { constants, fqn, aggregateOf };
}

/** A type's simple name as the file that writes it resolves it: its imports, then the one type of that name. */
function typeNamed(model, file, name) {
  const resolved = model?.resolveIn?.(file, name);
  const hit = resolved ? model.types.get(resolved) : null;
  if (hit) return hit;
  const names = [...(model?.types?.values() ?? [])].filter((t) => t.name === name);
  return names.length === 1 ? names[0] : null;
}

// Resolve a channel expression to a name from what the dump folded. Unresolvable names stay visible as unresolved.
export function channelName(x, module, keys, ix) {
  const { db, model } = module ?? {};
  const arg = x.arg ?? {};
  // The argument as the dump spells it (a constant's name, a class literal, a variable): display, never a fact.
  const written = String(arg.text ?? x.expr ?? '');
  // A class literal (`Consumer.class`) names the event type an Eventuate publisher carries.
  if (/\.class$/.test(written)) {
    const name = written.replace(/\.class$/, '').split('.').pop();
    const type = typeNamed(model, x.mfile ?? x.file, name);
    return type ? { name: type.fqn, via: `${name}.class` } : { name: null, unresolved: written };
  }
  const literal = stringArg(arg);
  if (literal != null) {
    const r = resolve(literal, keys);
    return r.unresolved ? r : { name: r.name, via: r.via };
  }
  // A constant field: the value the dump folded, named as the source names it.
  if (arg.kind === 'constant' && arg.value != null) return { name: String(arg.value), via: written };
  // A field or parameter injected from config: `@Value("${key}") String var` — the field's own annotation says which key.
  if (arg.kind === 'field' && arg.field) {
    const owner = model?.types?.get(String(arg.field).split('#')[0]);
    const fieldRow = (db?.membersOf(owner?.fqn) ?? []).find(
      (x) => x.kind === 'field' && `${x.owner}#${x.name}` === arg.field,
    );
    const key = flatStrings(annotationOn(fieldRow, 'Value')?.args?.value)[0];
    if (key) return resolve(key, keys);
    return { name: null, unresolved: written };
  }
  // An aggregate publisher publishes to the aggregate's channel.
  if (x.publisher && x.recv) {
    const aggregate = ix.aggregateOf.get(x.recv);
    if (aggregate && ix.fqn.has(aggregate)) return { name: ix.fqn.get(aggregate), via: `${x.recv} → ${aggregate}` };
  }
  return { name: null, unresolved: written };
}

// REST calls to other services: Feign clients, discovery lookups, and URLs (or `lb://` routes) whose host the dump
// folded. A URL built in a local variable is not a value the dump has: those calls stay out, never a guess.
const URL_HOST = /^(?:https?|lb):\/\/([a-z][a-z0-9-]*)(?::(\d+))?(\/[^?#]*)?$/;
export function restCalls(module) {
  const { db, types } = module ?? {};
  const out = [];
  if (!db) return out;
  for (const t of types ?? []) {
    const feign = annotationOn(typeRow(module, t), 'FeignClient');
    if (feign) {
      const host = flatStrings(feign.args?.name)[0] ?? flatStrings(feign.args?.value)[0];
      if (host) out.push({ host, path: '', line: feign.line ?? t.start, via: 'feign', file: module.prefix + t.file });
    }
    for (const m of t.methods ?? []) {
      for (const c of m.calls ?? []) {
        const rows = dumpArgs(db, c);
        if (/^(getInstances|choose|getInstance)$/.test(c.name)) {
          const d = stringArg(rows[0]);
          if (d && /^[a-z][a-z0-9-]*$/.test(d))
            out.push({ host: d, path: '', line: c.line, via: 'discovery', file: module.prefix + t.file });
        }
        // A URL the dump folded, wherever it is passed: a client's `uri(...)`, a route, a webhook.
        for (const a of rows) {
          const value = stringArg(a);
          const u = value == null ? null : URL_HOST.exec(value);
          if (!u || /^(localhost|www)$/.test(u[1])) continue;
          out.push({ host: u[1], path: (u[3] ?? '').split('?')[0], line: c.line, via: 'url', file: module.prefix + t.file });
        }
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.via.localeCompare(b.via));
}

// Gateway routes in YAML: "uri: lb://vets-service" followed by "- Path=/api/vet/**".
export function gatewayRoutes(yml) {
  const out = [];
  let cur = null;
  yml.split('\n').forEach((l, i) => {
    const u = /uri:\s*(?:lb|https?):\/\/([a-z][a-z0-9-]*)(?=[:/\s"']|$)/.exec(l);
    if (u) {
      cur = { host: u[1], line: i + 1, paths: [] };
      out.push(cur);
    }
    const p = /-\s*Path=([^\s#]+)/.exec(l);
    if (p && cur) cur.paths.push(...p[1].split(','));
  });
  return out;
}

// --- discovery -----------------------------------------------------------------------
function findServices(folder) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > 2) return;
    const has = (f) => fs.existsSync(path.join(dir, f));
    if (
      (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) &&
      fs.existsSync(path.join(dir, 'src/main'))
    ) {
      out.push(dir);
      return;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory() && !e.name.startsWith('.') && !NON_SERVICE_DIRS.has(e.name))
        visit(path.join(dir, e.name), depth + 1);
  };
  visit(folder, 0);
  return out;
}

// --- the system scan ---------------------------------------------------------------
const javaFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!/^(test|target|build)$/.test(e.name)) walk(p);
      } else if (e.name.endsWith('.java')) out.push(p);
    }
  };
  walk(path.join(dir, 'src/main'));
  return out;
};
// An app is a Spring Boot configuration class, a Spring Boot servlet initializer (a WAR), or a Jakarta EE /
// MicroProfile deployable (a WAR or EAR, or a server plugin in its build).
const eeApp = (dir) => {
  const p = path.join(dir, 'pom.xml');
  if (!fs.existsSync(p)) return false;
  const t = fs.readFileSync(p, 'utf8');
  return (
    !/<packaging>\s*pom\s*</.test(t) &&
    /<packaging>\s*(war|ear)\s*<|quarkus-maven-plugin|liberty-maven-plugin|wildfly(-jar)?-maven-plugin|payara-micro-maven-plugin|tomee-maven-plugin/.test(
      t,
    )
  );
};
const BOOT_START = new Set(['SpringBootApplication', 'SpringBootConfiguration']);
// A Spring Boot app declares one of the boot annotations, extends the servlet initializer (a WAR), or runs
// `SpringApplication.run` from a main method — the dump's `isMain` and the call's receiver type say so.
const bootsFromMain = (t) => (t.methods ?? []).some((m) => m.isMain && (m.calls ?? []).some((c) => /(^|\.)SpringApplication(?:Builder)?$/.test(c.recvFqn ?? '')));
const isApp = (dir, types) =>
  eeApp(dir) ||
  (types ?? []).some(
    (t) =>
      (t.ann ?? []).some((a) => BOOT_START.has(a.name)) ||
      (t.supers ?? []).some((s) => /SpringBootServletInitializer$/.test(s.fqn ?? simple(s.text))) ||
      bootsFromMain(t),
  );

/** The package and imports each file wrote, from the dump's own header reader. */
const sourcesOf = (db) =>
  new Map(
    [...db.files].map(([p, f]) => [
      p,
      {
        pkg: f.package ?? '',
        imports: (f.imports ?? []).map((i) => ({ name: i.name, wildcard: !!i.wildcard, isStatic: !!i.static })),
      },
    ]),
  );

/** A module's size, from the dump: the last line each of its types ends on. */
const linesOf = (types) => {
  const files = new Map();
  for (const t of types) files.set(t.file, Math.max(files.get(t.file) ?? 0, t.end ?? 0));
  return [...files.values()].reduce((a, b) => a + b, 0);
};

/** One dump of the whole folder, and the model built from it: the only reader of the modules' Java. */
function folderModel(folder, modules) {
  const rels = modules.flatMap((d) => javaFiles(d).map((p) => relPosix(folder, p)));
  if (!rels.length) return null;
  const run = dumpFor(folder, rels, { outDir: path.join(folder, 'mindmodel-system', '.work', 'dump') });
  if (!run.ok) throw new Error(`mindmodel: no engine dump for ${rels.length} Java file(s) (${run.reason})`);
  const db = openDump(run.dir);
  return { db, model: buildModelFromDump(db, sourcesOf(db)) };
}

/**
 * One module's types, out of the folder's dump. A module owning a file the folder dump could not parse has a sibling
 * declaring the same type (a lambda or API variant); that module is dumped again on its own, because its build is what
 * its calls belong to and a copied class name must not empty its messaging.
 */
function moduleOf(folder, dir, db, model, collided) {
  const rel = relPosix(folder, dir);
  // A module at the folder itself has no prefix: its files are already relative to the folder.
  const prefix = rel ? `${rel}/` : '';
  if (collided.has(dir)) {
    const own = dumpFor(dir, javaFiles(dir).map((p) => relPosix(dir, p)));
    if (own.ok) {
      const ownDb = openDump(own.dir);
      const ownModel = buildModelFromDump(ownDb, sourcesOf(ownDb));
      const types = [...ownModel.types.values()];
      return { dir, prefix, db: ownDb, model: ownModel, types, lines: linesOf(types) };
    }
  }
  const types = [...model.types.values()].filter((t) => t.file.startsWith(prefix));
  return { dir, prefix, db, model, types, lines: linesOf(types) };
}

export function systemScan(folder) {
  const modules = findServices(folder);
  // Company wrappers around Kafka/JMS: extra patterns from <folder>/mindmodel-system.json ({"messaging":[{"kind","dir","re"}]}).
  const custom = fs.existsSync(path.join(folder, 'mindmodel-system.json'))
    ? (JSON.parse(fs.readFileSync(path.join(folder, 'mindmodel-system.json'), 'utf8')).messaging ?? [])
    : [];
  const patterns = [...BUILTIN, ...custom];
  const folderFacts = folderModel(folder, modules);
  const db = folderFacts?.db ?? null;
  const model = folderFacts?.model ?? null;
  const ix = codeIndex(model);
  // Modules with a file the folder dump could not parse: the dump keeps one type per name, so a module that copies a
  // sibling's class needs its own dump.
  const collided = new Set(
    [...(db?.files?.values() ?? [])]
      .filter((f) => (f.errors ?? []).length)
      .map((f) => modules.find((d) => f.path.startsWith(`${relPosix(folder, d)}/`)))
      .filter(Boolean),
  );
  const byModule = new Map(modules.map((d) => [d, moduleOf(folder, d, db, model, collided)]));
  // Modules without a Spring entry point are shared libraries (DTOs, events), not services.
  const libraries = modules.filter((d) => !isApp(d, byModule.get(d).types)).map((d) => path.relative(folder, d));
  const services = modules
    .filter((dir) => isApp(dir, byModule.get(dir).types))
    .map((dir) => {
      const facts = scan(dir);
      const res = path.join(dir, 'src/main/resources');
      const cfgFiles = !fs.existsSync(res)
        ? []
        : fs
            .readdirSync(res, { withFileTypes: true })
            .filter((e) => e.isFile() && /^(application|bootstrap)\.(ya?ml|properties)$/.test(e.name))
            .map((e) => path.join(dir, 'src/main/resources', e.name));
      const keys = new Map(),
        ymls = [];
      for (const f of cfgFiles) {
        const t = fs.readFileSync(f, 'utf8');
        ymls.push({ f, t });
        for (const [k, v] of configKeys(t, f.endsWith('.properties')))
          keys.set(k, { ...v, file: path.relative(folder, f) });
      }
      const name = keys.get('spring.application.name')?.value ?? path.basename(dir);
      const port = /^\d+$/.test(keys.get('server.port')?.value ?? '') ? keys.get('server.port').value : null;
      const module = byModule.get(dir);
      const cite = (file, line) => `${file}:${line}`;
      const msgs = [];
      for (const x of messaging(module, patterns)) {
        const r = channelName(x, module, keys, ix);
        msgs.push({ kind: x.kind, dir: x.dir, line: x.line, ...r, raw: x.raw, cite: cite(x.file, x.line) });
      }
      for (const x of jakartaJms(module))
        msgs.push({ ...x, via: 'JNDI name', raw: x.name, cite: cite(x.file, x.line) });
      const calls = restCalls(module).map(({ file, ...c }) => ({ ...c, cite: cite(file, c.line) }));
      for (const [k, v] of keys) {
        const u = /^(?:https?|lb):\/\/([a-z][a-z0-9-]*)(?::(\d+))?(?=[:/]|$)/.exec(v.value);
        if (u && u[1] !== 'www' && k !== 'server.port')
          calls.push({
            host: u[1] === 'localhost' ? `localhost:${u[2]}` : u[1],
            path: '',
            via: 'config',
            cite: `${v.file}:${v.line}`,
          });
      }
      // Destinations bound from config that is not in the repo (env vars, deployment): named, marked unresolved.
      const unresolvedDest = [];
      for (const t of module.types) {
        const pre = flatStrings(annotationOn(typeRow(module, t), 'ConfigurationProperties')?.args?.prefix)[0];
        if (!pre) continue;
        for (const f of t.fields ?? []) {
          if (!/(Url|Uri|Host)$/.test(f.name)) continue;
          const key = `${pre}.${f.name}`;
          if (![...keys.keys()].some((k) => k.toLowerCase().replace(/-/g, '') === key.toLowerCase())) unresolvedDest.push(key);
        }
      }
      for (const { f, t } of ymls)
        for (const g of gatewayRoutes(t))
          calls.push({
            host: g.host,
            path: g.paths.join(','),
            via: 'gateway',
            cite: `${path.relative(folder, f)}:${g.line}`,
          });
      // Plumbing the system relies on to run (config, discovery, admin): named, not a business service.
      const moduleCarriesAnn = (name) => module.types.some((t) => hasAnnotation(typeRow(module, t), name));
      const role = moduleCarriesAnn('EnableConfigServer')
        ? 'config server'
        : moduleCarriesAnn('EnableEurekaServer')
          ? 'discovery server'
          : moduleCarriesAnn('EnableAdminServer')
            ? 'admin server'
            : null;
      return {
        name,
        dir: path.relative(folder, dir) || '.',
        role,
        facts,
        msgs,
        calls,
        unresolvedDest,
        port,
        // The module's size, from the dump: the last line each of its types ends on.
        lines: module.lines,
      };
    });

  // Two services with the same spring.application.name (a copy-paste slip) would merge in discovery: tell them apart by folder.
  const dupes = services.filter((s) => services.filter((o) => o.name === s.name).length > 1);
  for (const s of dupes) {
    s.nameConflict = s.name;
    s.name = path.basename(s.dir);
  }
  // Join: topics/queues to their producers and consumers; REST calls to the service they reach.
  // Match a call to a service by its name, its folder, the same name without dashes ("customercore"), or, for
  // local URLs like http://localhost:8110, by the port the service runs on.
  const normService = (n) =>
    String(n)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const byName = new Map(
    services.flatMap((s) => [
      [s.name, s],
      [path.basename(s.dir), s],
      [normService(s.name), s],
      [normService(path.basename(s.dir)), s],
      ...(s.port ? [[`localhost:${s.port}`, s]] : []),
    ]),
  );
  const channels = {};
  for (const s of services)
    for (const m of s.msgs) {
      const key = `${m.kind}:${m.name ?? `?${m.unresolved}`}`;
      (channels[key] ??= { kind: m.kind, name: m.name, unresolved: m.unresolved, out: [], in: [] })[m.dir].push({
        service: s.name,
        cite: m.cite,
      });
    }
  const rest = [];
  for (const s of services)
    for (const c of s.calls) {
      const target = byName.get(c.host) ?? byName.get(normService(c.host));
      const ep =
        target && c.path && c.via !== 'gateway'
          ? target.facts.endpoints.find((e) => e.path === c.path.replace(/\{[^}]+}/g, '{}').replace(/\/$/, ''))
          : null;
      rest.push({
        from: s.name,
        to: target?.name ?? c.host,
        known: !!target,
        path: c.path,
        via: c.via,
        cite: c.cite,
        endpoint: ep ? `${ep.file}:${ep.line}` : null,
      });
    }
  return {
    folder,
    services,
    libraries,
    channels: Object.values(channels),
    rest,
    duplicates: dupes.map((s) => ({ name: s.nameConflict, dir: s.dir })),
  };
}

// Compact digest for the system writer, with the same "facts first" contract as facts.md.
export function systemSummary(sys) {
  const L = [
    `# system facts for ${path.basename(sys.folder)} (${sys.services.length} services)`,
    'Paths are relative to the folder. Details: system.json.',
    '',
  ];
  L.push('## Services (size, data, interface)');
  if (sys.libraries.length) L.push(`- shared libraries (no entry point, not services): ${sys.libraries.join(', ')}`);
  for (const s of sys.services) {
    const ents = s.facts.entities.model
      .slice(0, 5)
      .map((e) => e.name)
      .join(', ');
    L.push(
      `- ${s.name} (${s.dir})${s.role ? ` [${s.role}]` : ''}: ${s.lines} lines, ${s.facts.endpoints.length} endpoints, ${s.facts.entities.count} entities${ents ? ` (${ents})` : ''}`,
    );
  }
  if (sys.duplicates.length)
    L.push(
      `- DUPLICATE spring.application.name: ${sys.duplicates.map((d) => `"${d.name}" in ${d.dir}`).join(', ')}; listed under their folder names`,
    );
  for (const s of sys.services)
    if (s.unresolvedDest?.length)
      L.push(
        `- ${s.name}: REST destinations set outside the repo (env/deployment), UNRESOLVED: ${s.unresolvedDest.join(', ')}`,
      );
  L.push('', '## Messaging (channel: producers → consumers)');
  for (const c of sys.channels) {
    const who = (xs) => [...new Set(xs.map((x) => x.service))].join(', ') || 'none in this folder';
    L.push(
      `- ${c.kind} ${c.name ?? `UNRESOLVED (${c.unresolved})`}: ${who(c.out)} → ${who(c.in)} · ${[...c.out, ...c.in]
        .slice(0, 4)
        .map((x) => x.cite)
        .join(', ')}`,
    );
  }
  L.push('', '## REST between services (caller → callee)');
  const seen = new Set();
  for (const r of sys.rest) {
    const k = `${r.from}>${r.to}>${r.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    L.push(
      `- ${r.from} → ${r.to}${r.known ? '' : ' (not in this folder)'} ${r.path || ''} [${r.via}] ${r.cite}${r.endpoint ? ` → ${r.endpoint}` : ''}`,
    );
  }
  // Plumbing (config, discovery, admin servers) is not something services rely on for their business.
  const plumbing = new Set(sys.services.filter((s) => s.role).map((s) => s.name));
  const fanIn = {};
  for (const r of sys.rest) if (r.known && !plumbing.has(r.to)) (fanIn[r.to] ??= new Set()).add(r.from);
  for (const c of sys.channels)
    for (const o of c.out)
      for (const i of c.in) if (o.service !== i.service) (fanIn[o.service] ??= new Set()).add(i.service);
  L.push('', '## Dependence (who relies on each service: callers + consumers of what it produces)');
  for (const s of [...sys.services].sort((a, b) => (fanIn[b.name]?.size ?? 0) - (fanIn[a.name]?.size ?? 0)))
    L.push(
      `- ${s.name}: ${fanIn[s.name]?.size ?? 0}${fanIn[s.name]?.size ? ` (${[...fanIn[s.name]].join(', ')})` : ''}`,
    );
  return L.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  retuneHeap();
  const folder = path.resolve(process.argv[2] ?? '.');
  const out = path.resolve(process.argv[3] ?? path.join(folder, 'mindmodel-system', '.work'));
  const sys = systemScan(folder);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, 'system.json'),
    JSON.stringify(
      {
        ...sys,
        services: sys.services.map(({ facts, ...s }) => ({
          ...s,
          endpoints: facts.endpoints.length,
          entities: facts.entities.model.slice(0, 10).map((e) => e.name),
        })),
      },
      null,
      1,
    ),
  );
  fs.writeFileSync(path.join(out, 'system.md'), systemSummary(sys));
  // Each service's own facts digest, so the writer can look inside a service without rescanning it.
  fs.mkdirSync(path.join(out, 'services'), { recursive: true });
  for (const s of sys.services) fs.writeFileSync(path.join(out, 'services', `${s.name}.md`), summarize(s.facts));
  console.log(
    `wrote ${out}/system.md: ${sys.services.length} services, ${sys.channels.length} channels, ${sys.rest.length} REST calls`,
  );
}
