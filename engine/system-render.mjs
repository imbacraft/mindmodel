#!/usr/bin/env node
// Validates a system mindmodel against the system scan and renders it. The "how it talks" diagram is computed here
// from the scan's proven edges, never drawn by the writer, so its limits hold by construction (rules/system-rules.md 3.4).
// Usage: node system-render.mjs <system-map.json> <folder> [--fix] [--web <base URL> --out <file>]
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { parseCite, resolveCites } from './validate.mjs';

const MAX_BOXES = 12, MAX_LINES = 15;

// One line per pair: every REST call and every producer→consumer channel between two drawn nodes merges into one.
export function diagram(map, sys, forceDomains = false) {
  const role = new Map(sys.services.map((s) => [s.name, s.role]));
  const gateway = sys.services.find((s) => s.calls?.some((c) => c.via === 'gateway'))?.name ?? null;
  const svc = new Map(map.services.map((s) => [s.name, s]));
  const drawn = (n) => n === gateway || (svc.has(n) && svc.get(n).tier !== 'peripheral' && !role.get(n));
  const raw = [];
  for (const r of sys.rest) if (r.known && r.from !== r.to) raw.push({ a: r.from, b: r.to, kind: 'rest' });
  for (const c of sys.channels) for (const o of c.out) for (const i of c.in) if (o.service !== i.service) raw.push({ a: o.service, b: i.service, kind: c.kind, name: c.name });
  const label = (a, b) => map.contracts.find((k) => (k.from === a && k.to.includes(b)) || (k.from === b && k.to.includes(a)))?.name;
  const merge = (edges, keyOf) => {
    const out = new Map();
    for (const e of edges) {
      const [x, y] = [keyOf(e.a), keyOf(e.b)]; if (!x || !y || x === y) continue;
      const k = [x, y].sort().join('|'), m = out.get(k) ?? { a: [x, y].sort()[0], b: [x, y].sort()[1], fwd: false, back: false, kinds: new Set(), names: new Set() };
      if (x === m.a) m.fwd = true; else m.back = true;
      m.kinds.add(e.kind); if (e.name) m.names.add(e.name); out.set(k, m);
    }
    return [...out.values()].map((m) => ({ ...m, kinds: [...m.kinds], names: [...m.names] }));
  };
  const services = [...new Set([gateway, ...map.services.map((s) => s.name)])].filter((n) => n && drawn(n));
  let mode = 'services', nodes = services, edges = merge(raw, (n) => (drawn(n) ? n : null));
  if (forceDomains || nodes.length > MAX_BOXES || edges.length > MAX_LINES) {
    mode = 'domains';
    const dom = (n) => (n === gateway ? 'gateway' : svc.get(n)?.domain ?? null);
    nodes = [...new Set(services.map(dom))].filter(Boolean);
    edges = merge(raw, (n) => (drawn(n) ? dom(n) : null));
  }
  // Only named contracts label a line; a bare count ("2 channels") tells the reader nothing.
  for (const e of edges) e.label = mode === 'services' ? label(e.a, e.b) ?? '' : '';
  const column = (n) => (n === gateway || n === 'gateway' ? -1 : map.domains.findIndex((d) => d.id === (mode === 'domains' ? n : svc.get(n)?.domain)));
  return { mode, gateway, nodes: nodes.map((n) => ({ id: n, col: column(n), name: mode === 'domains' && n !== 'gateway' ? map.domains.find((d) => d.id === n)?.name ?? n : n })), edges: edges.slice(0, MAX_LINES), dropped: Math.max(0, edges.length - MAX_LINES) };
}
{
  const map = { services: [{ name: 'orders', domain: 'o', tier: 'core' }, { name: 'payment', domain: 'p', tier: 'core' }, { name: 'cfg', domain: 'x', tier: 'supporting' }], domains: [{ id: 'o' }, { id: 'p' }, { id: 'x' }], contracts: [{ name: 'OrderPlaced', from: 'orders', to: ['payment'] }] };
  const sys = { services: [{ name: 'orders' }, { name: 'payment' }, { name: 'cfg', role: 'config server' }], rest: [{ from: 'payment', to: 'cfg', known: true }], channels: [{ kind: 'kafka', name: 'orders', out: [{ service: 'orders' }], in: [{ service: 'payment' }] }, { kind: 'kafka', name: 'paid', out: [{ service: 'payment' }], in: [{ service: 'orders' }] }] };
  const d = diagram(map, sys);
  assert.deepStrictEqual(d.nodes.map((n) => n.id), ['orders', 'payment']); // the config server is plumbing: not drawn
  assert.equal(d.edges.length, 1); // two topics, both directions: one line
  assert.ok(d.edges[0].fwd && d.edges[0].back && d.edges[0].label === 'OrderPlaced');
}

// "How it talks" as a table: per service, what it calls, what it publishes (and who listens), what it listens to.
export function talks(map, sys) {
  const role = new Map(sys.services.map((s) => [s.name, s.role]));
  const short = (n) => (n ?? '').split('.').pop();
  return map.services.filter((s) => !role.get(s.name)).map((s) => ({
    service: s.name,
    calls: [...new Set(sys.rest.filter((r) => r.from === s.name && r.to !== s.name && !role.get(r.to)).map((r) => r.to))],
    // A channel a service only consumes itself (saga replies, a Streams store) is labelled as such, not as unheard.
    publishes: sys.channels.filter((c) => c.out.some((o) => o.service === s.name)).map((c) => { const to = [...new Set(c.in.map((i) => i.service))]; return { channel: short(c.name) || `unresolved ${c.unresolved}`, kind: c.kind, to: to.filter((n) => n !== s.name), self: to.includes(s.name) }; }),
    listens: sys.channels.filter((c) => c.in.some((i) => i.service === s.name)).map((c) => { const from = [...new Set(c.out.map((o) => o.service))]; return { channel: short(c.name) || `unresolved ${c.unresolved}`, kind: c.kind, from: from.filter((n) => n !== s.name), self: from.includes(s.name) }; }),
  }));
}

export function validateSystem(map, sys, root) {
  const errors = [], warnings = [], err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  resolveCites(map, root);
  const known = new Set(sys.services.map((s) => s.name)), domains = new Set(map.domains.map((d) => d.id));
  const listed = new Set(map.services.map((s) => s.name));
  for (const s of map.services) { if (!known.has(s.name)) err(`service "${s.name}" is not in the system scan`); if (!domains.has(s.domain)) err(`service ${s.name}: unknown domain "${s.domain}"`); if (s.tier === 'core' && !s.importance) err(`core service ${s.name}: missing "importance"`); }
  for (const n of known) if (!listed.has(n)) err(`scanned service "${n}" is not placed in any tier`);
  if (map.services.filter((s) => s.tier === 'core').length > 8) err('more than 8 core services');
  for (const m of map.overview.sentence.matchAll(/\[\[([a-z][a-z0-9-]*)\|/g)) if (!domains.has(m[1])) err(`system sentence: unknown domain "${m[1]}"`);
  const named = new Set([...known, ...sys.rest.map((r) => r.to)]);
  for (const f of map.flows) for (const h of f.hops) for (const n of [h.from, h.to]) if (!named.has(n)) warn(`flow ${f.id}: "${n}" is not a scanned service`);
  // Citations: every one must resolve to a real file and range.
  const walk = (node, where, out) => { if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${where}[${i}]`, out)); else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) if (k === 'cites' && Array.isArray(v)) v.forEach((c) => out.push([c, where])); else walk(v, `${where}.${k}`, out); return out; };
  const cites = walk(map, '$', []);
  for (const [c, where] of cites) {
    const pc = parseCite(c); if (!pc) { err(`${where}: malformed citation "${c}"`); continue; }
    const abs = path.join(root, pc.file); if (!fs.existsSync(abs)) { err(`${where}: path not found "${pc.file}"`); continue; }
    if (pc.start == null || fs.statSync(abs).isDirectory()) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    if (pc.end > lines.length) err(`${where}: "${c}" outside file`);
    else if (pc.symbol && !lines.slice(pc.start - 1, pc.end).join('\n').includes(pc.symbol)) err(`${where}: "${c}" does not contain "${pc.symbol}"`);
  }
  for (const f of map.flows) if (!f.hops.length) err(`flow ${f.id}: no hops`);
  return { errors, warnings, stats: { citations: cites.length, services: map.services.length, core: map.services.filter((s) => s.tier === 'core').length } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const web = opt('--web'), outArg = opt('--out'), fix = args.includes('--fix');
  const [file, folderArg] = args.filter((a) => !a.startsWith('--'));
  const root = path.resolve(folderArg ?? '.'), mapFile = path.resolve(file);
  const sys = JSON.parse(fs.readFileSync(path.join(path.dirname(mapFile), '.work', 'system.json'), 'utf8'));
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')), before = JSON.stringify(map);
  const { errors, warnings, stats } = validateSystem(map, sys, root);
  if (fix && JSON.stringify(map) !== before) fs.writeFileSync(mapFile, JSON.stringify(map, null, 1));
  warnings.forEach((w) => console.log(`warn  ${w}`)); errors.forEach((e) => console.log(`ERROR ${e}`));
  console.log(`${errors.length ? 'FAILED' : 'OK'}: ${errors.length} error(s), ${warnings.length} warning(s)`, stats);
  if (errors.length) process.exit(1);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const data = JSON.stringify({ ...map, diagram: diagram(map, sys, true), talks: talks(map, sys) }).replace(/</g, '\\u003c');
  const html = fs.readFileSync(path.join(here, '../template/system.html'), 'utf8').replace('/*__MINDMODEL_DATA__*/', () => data).replace('__MINDMODEL_ROOT__', () => (web ?? root).replace(/"/g, '\\"'));
  const out = outArg ? path.resolve(outArg) : path.join(path.dirname(mapFile), 'index.html');
  fs.writeFileSync(out, html);
  console.log(`wrote ${out}`);
}
