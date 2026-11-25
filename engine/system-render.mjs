#!/usr/bin/env node
// Validates a system mindmodel against the system scan and renders it. The "how it talks" table is computed here
// from the scan's proven edges, never written by the writer (rules/system-rules.md 3.4).
// Usage: node system-render.mjs <system-map.json> <folder> [--fix] [--web <base URL> --out <file>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCite, citesOf, resolveCites } from './validate.mjs';
import { checkSchema } from './core/schema.mjs';
import { simple } from './core/names.mjs';
import { inlineBase } from './base.mjs';

// "How it talks" as a table: per service, what it calls, what it publishes (and who listens), what it listens to.
export function talks(map, sys) {
  const role = new Map(sys.services.map((s) => [s.name, s.role]));
  return map.services
    .filter((s) => !role.get(s.name))
    .map((s) => ({
      service: s.name,
      calls: [
        ...new Set(sys.rest.filter((r) => r.from === s.name && r.to !== s.name && !role.get(r.to)).map((r) => r.to)),
      ],
      // Inbound REST too: a service that is only ever called (a shared core) would otherwise look idle.
      calledBy: [
        ...new Set(
          sys.rest
            .filter((r) => r.known && r.to === s.name && r.from !== s.name && !role.get(r.from))
            .map((r) => r.from),
        ),
      ],
      // A channel a service only consumes itself (saga replies, a Streams store) is labelled as such, not as unheard.
      publishes: sys.channels
        .filter((c) => c.out.some((o) => o.service === s.name))
        .map((c) => {
          const to = [...new Set(c.in.map((i) => i.service))];
          return {
            channel: simple(c.name) || `unresolved ${c.unresolved}`,
            kind: c.kind,
            to: to.filter((n) => n !== s.name),
            self: to.includes(s.name),
          };
        }),
      listens: sys.channels
        .filter((c) => c.in.some((i) => i.service === s.name))
        .map((c) => {
          const from = [...new Set(c.out.map((o) => o.service))];
          return {
            channel: simple(c.name) || `unresolved ${c.unresolved}`,
            kind: c.kind,
            from: from.filter((n) => n !== s.name),
            self: from.includes(s.name),
          };
        }),
    }));
}

// Names the scan could not resolve (rules 3.4), so nobody reads a missing edge as "no connection".
export const unresolved = (sys) => [
  ...sys.channels
    .filter((c) => !c.name)
    .flatMap((c) =>
      [...new Set([...c.out, ...c.in].map((x) => x.service))].map((service) => ({
        service,
        name: c.unresolved,
        what: `${c.kind} channel`,
      })),
    ),
  ...sys.rest.filter((r) => !r.known).map((r) => ({ service: r.from, name: r.to, what: 'host' })),
  ...sys.services.flatMap((s) =>
    (s.unresolvedDest ?? []).map((name) => ({ service: s.name, name, what: 'URL setting' })),
  ),
];

export function validateSystem(map, sys, root) {
  const errors = [],
    warnings = [],
    err = (m) => errors.push(m),
    warn = (m) => warnings.push(m);
  const cache = new Map();
  resolveCites(map, root, null, cache);
  const schema = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../schema/system.schema.json'), 'utf8'),
  );
  checkSchema(map, schema, schema.$defs ?? {}, '$', err);
  if (errors.length) return { errors, warnings, stats: {} };
  const known = new Set(sys.services.map((s) => s.name)),
    domains = new Set(map.domains.map((d) => d.id));
  const listed = new Set(map.services.map((s) => s.name));
  for (const s of map.services) {
    if (!known.has(s.name)) err(`service "${s.name}" is not in the system scan`);
    if (!domains.has(s.domain)) err(`service ${s.name}: unknown domain "${s.domain}"`);
    if (s.tier === 'core' && !s.importance) err(`core service ${s.name}: missing "importance"`);
  }
  for (const n of known) if (!listed.has(n)) err(`scanned service "${n}" is not placed in any tier`);
  if (map.services.filter((s) => s.tier === 'core').length > 8) err('more than 8 core services');
  for (const m of map.overview.sentence.matchAll(/\[\[([a-z][a-z0-9-]*)\|/g))
    if (!domains.has(m[1])) err(`system sentence: unknown domain "${m[1]}"`);
  const named = new Set([...known, ...sys.rest.map((r) => r.to)]);
  for (const f of map.flows)
    for (const h of f.hops)
      for (const n of [h.from, h.to]) if (!named.has(n)) warn(`flow ${f.id}: "${n}" is not a scanned service`);
  // Citations: every one must resolve to a real file and range, checked the way validate() checks a project map.
  const cites = citesOf(map);
  for (const { cite, where } of cites) {
    const why = checkCite(cite, root, null, cache);
    if (why) err(`${where}: ${why}`);
  }
  for (const f of map.flows) if (!f.hops.length) err(`flow ${f.id}: no hops`);
  return {
    errors,
    warnings,
    stats: {
      citations: cites.length,
      services: map.services.length,
      core: map.services.filter((s) => s.tier === 'core').length,
    },
  };
}

// The page for a map that has already passed validateSystem(). The tables are computed here from the scan.
export function renderSystemPage(map, sys, root, web = null) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const data = JSON.stringify({ ...map, talks: talks(map, sys), unresolved: unresolved(sys) }).replace(/</g, '\\u003c');
  return inlineBase(fs.readFileSync(path.join(here, '../template/system.html'), 'utf8'))
    .replace('/*__MINDMODEL_DATA__*/', () => data)
    .replace('__MINDMODEL_ROOT__', () => (web ?? root).replace(/"/g, '\\"'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2),
    opt = (k) => {
      const i = args.indexOf(k);
      return i >= 0 ? args.splice(i, 2)[1] : null;
    };
  const web = opt('--web'),
    outArg = opt('--out'),
    fix = args.includes('--fix');
  const [file, folderArg] = args.filter((a) => !a.startsWith('--'));
  const root = path.resolve(folderArg ?? '.'),
    mapFile = path.resolve(file);
  const sys = JSON.parse(fs.readFileSync(path.join(path.dirname(mapFile), '.work', 'system.json'), 'utf8'));
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')),
    before = JSON.stringify(map);
  const { errors, warnings, stats } = validateSystem(map, sys, root);
  if (fix && JSON.stringify(map) !== before) fs.writeFileSync(mapFile, JSON.stringify(map, null, 1));
  warnings.forEach((w) => console.log(`warn  ${w}`));
  errors.forEach((e) => console.log(`ERROR ${e}`));
  console.log(`${errors.length ? 'FAILED' : 'OK'}: ${errors.length} error(s), ${warnings.length} warning(s)`, stats);
  if (errors.length) process.exit(1);
  const html = renderSystemPage(map, sys, root, web);
  const out = outArg ? path.resolve(outArg) : path.join(path.dirname(mapFile), 'index.html');
  fs.writeFileSync(out, html);
  console.log(`wrote ${out}`);
}
