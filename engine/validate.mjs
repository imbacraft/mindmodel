#!/usr/bin/env node
// Validates a mindmodel.json against the generation rules: schema, budgets (Part 7), id references, and that every citation resolves.
// Usage: node validate.mjs <mindmodel.json> [projectRoot]   (projectRoot defaults to the parent of the mindmodel/ folder)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { open as openDump } from './dump.mjs';
import { fileURLToPath } from 'node:url';
import { gitWindow, activityFor } from './activity.mjs';

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../schema/mindmodel.schema.json'), 'utf8'),
);

// `path:start-end#symbol`, and the arity form `#symbol/2` that names one overload by its parameter count.
export function parseCite(c) {
  const m = /^([^:#]+?)(?::(\d+)(?:-(\d+))?)?(?:#(\S+?)(?:\/(\d+))?)?$/.exec(c);
  if (!m) return null;
  return {
    file: m[1],
    start: m[2] ? +m[2] : null,
    end: m[3] ? +m[3] : m[2] ? +m[2] : null,
    symbol: m[4] ?? null,
    arity: m[5] != null ? +m[5] : null,
  };
}
export const parsed = (file, start, end, symbol, arity) => ({ file, start, end, symbol, arity });

// The JSON Schema subset our schemas use (type, required, additionalProperties, enum, const, pattern, items,
// min/maxItems, maxLength, $ref): enough to catch a misspelled field or a wrong enum, with no dependency.
export function checkSchema(v, s, defs, at, err) {
  if (s.$ref) return checkSchema(v, defs[s.$ref.split('/').pop()], defs, at, err);
  const type = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v;
  const types = s.type == null ? null : [].concat(s.type); // JSON Schema allows a list: ["object", "null"]
  if (types && !types.includes(type) && !(types.includes('number') && type === 'integer'))
    return err(`${at}: expected ${types.join(' or ')}, got ${type}`);
  if (s.const !== undefined && v !== s.const) err(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) err(`${at}: "${v}" is not one of ${s.enum.join(', ')}`);
  if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v))
    err(`${at}: "${v}" does not match ${s.pattern}`);
  if (s.maxLength && typeof v === 'string' && v.length > s.maxLength) err(`${at}: longer than ${s.maxLength} chars`);
  if (type === 'array') {
    if (s.maxItems != null && v.length > s.maxItems) err(`${at}: ${v.length} items > ${s.maxItems}`);
    if (s.minItems != null && v.length < s.minItems) err(`${at}: ${v.length} items < ${s.minItems}`);
    if (s.items) v.forEach((x, i) => checkSchema(x, s.items, defs, `${at}[${i}]`, err));
  }
  if (type === 'object' && s.properties) {
    for (const k of s.required ?? []) if (!(k in v)) err(`${at}: missing "${k}"`);
    for (const [k, x] of Object.entries(v))
      if (s.properties[k]) checkSchema(x, s.properties[k], defs, `${at}.${k}`, err);
      else if (s.additionalProperties === false) err(`${at}: unknown field "${k}"`);
  }
}
{
  const e = [],
    s = {
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      properties: { a: { enum: ['x'] }, b: { type: 'array', maxItems: 1, items: { type: 'string' } } },
    };
  checkSchema({ a: 'y', b: ['p', 2], c: 1 }, s, {}, '$', (m) => e.push(m));
  assert.deepStrictEqual(e, [
    '$.a: "y" is not one of x',
    '$.b: 2 items > 1',
    '$.b[1]: expected string, got integer',
    '$: unknown field "c"',
  ]);
  // A list of types: either is accepted, anything else names both.
  const t = [], u = { type: ['object', 'null'] };
  for (const v of [{}, null, 'x']) checkSchema(v, u, {}, '$', (m) => t.push(m));
  assert.deepStrictEqual(t, ['$: expected object or null, got string']);
}

const BUDGET = {
  actors: 7,
  externals: 7,
  concepts: 6,
  regions: [2, 8],
  lanes: [2, 5],
  flowSteps: 7,
  rules: 5,
  stories: [1, 5],
  storySteps: 10,
  parts: 7,
  runSteps: 3,
};

// P8 size tiers: the core ceiling scales with the app, because a 40-endpoint tool and a 900-endpoint platform cannot
// say the same thing in the same number of words. Regions and state keep a flat cap: that is where overflow lives.
const TIERS = [
  { tier: 1, maxEndpoints: 50, core: 2200 },
  { tier: 2, maxEndpoints: 150, core: 2800 },
  { tier: 3, maxEndpoints: 400, core: 3600 },
  { tier: 4, maxEndpoints: Infinity, core: 4200 },
];
const SECTION_SHARES = {
  purpose: 0.04,
  context: 0.08,
  concepts: 0.18,
  regions: 0.18,
  state: 0.13,
  runtime: 0.08,
  background: 0.08,
  rules: 0.13,
  security: 0.07,
  intros: 0.03,
};
// Hard caps whatever the tier, clamped onto the share so a section target never exceeds them.
export const CAPS = { regions: 1000, state: 400 };

// The budget for an app with this many endpoints (null when the count is unknown: use the widest tier, so a missing
// facts file never makes a legal map look over budget).
export function budgetFor(endpoints) {
  const t = TIERS.find((x) => (endpoints ?? Infinity) <= x.maxEndpoints);
  const sections = {};
  for (const [name, share] of Object.entries(SECTION_SHARES))
    sections[name] = Math.min(Math.round(t.core * share), CAPS[name] ?? Infinity);
  return { tier: t.tier, endpoints, core: t.core, sections, caps: CAPS };
}

// Words, with JSON keys dropped and path/symbol tokens ignored: the page's prose, not its citations.
export function wordCount(o) {
  return JSON.stringify(o ?? {})
    .replace(/"[a-zA-Z]+":/g, ' ')
    .split(/\s+/)
    .filter((w) => /[a-zA-Z]{2,}/.test(w) && !w.includes('/')).length;
}

// Each section measured on its own, so a writer can fix the one that is over instead of rewriting the map.
const SECTION_KEYS = {
  intros: ['version', 'project'],
  purpose: ['purpose'],
  context: ['context'],
  concepts: ['coreSentence', 'concepts'],
  regions: ['regionSentence', 'regions'],
  state: ['state'],
  runtime: ['runtime'],
  background: ['background'],
  rules: ['rules'],
  security: ['security'],
};
export function sectionWords(map) {
  const out = {};
  for (const [name, keys] of Object.entries(SECTION_KEYS))
    out[name] = wordCount(Object.fromEntries(keys.filter((k) => map[k] !== undefined).map((k) => [k, map[k]])));
  return out;
}

// P3: a citation covers a claim block — a rule, a region part, a concept card, a story step — not a sentence. This is
// the count a block-cited map of this shape needs; far above it means the writer cited line by line.
export function citeTarget(map) {
  const steps = (map.runtime?.steps?.length ?? 0) + (map.stories ?? []).reduce((n, s) => n + (s.steps?.length ?? 0), 0);
  return (
    2 * (map.rules?.length ?? 0) +
    4 * (map.regions?.length ?? 0) +
    2 * (map.concepts?.length ?? 0) +
    steps +
    (map.background?.items?.length ?? 0) +
    (map.state?.owners?.length ?? 0) +
    6
  );
}

// A share is the room a section has, not a target to fill. Writing to the ceiling and stopping early is the mirror of
// writing over it: the section stops answering its question. `intros` is exempt (version and project strings).
const UNDER_SHARE = 0.6;

// One warning per section over its share, plus the total: the writer fixes a section, never the whole map.
export function budgetWarnings(counts, budget) {
  const out = [];
  for (const [name, n] of Object.entries(counts)) {
    const target = budget.sections[name];
    if (n <= target) continue;
    const cap = CAPS[name];
    out.push(
      `${name}: ~${n} words > tier ${budget.tier} target ${target}${cap && n > cap ? ` (over the hard cap ${cap})` : ''}`,
    );
  }
  for (const [name, n] of Object.entries(counts)) {
    const target = budget.sections[name];
    if (name === 'intros' || n >= target * UNDER_SHARE) continue;
    out.push(`${name}: ~${n} words < ${Math.round(target * UNDER_SHARE)} (60% of the tier ${budget.tier} share ` +
      `${target}): thin, answer the section's question before cutting`);
  }
  const total = Object.values(counts).reduce((n, x) => n + x, 0);
  if (total > budget.core)
    out.push(
      `core map ~${total} words > tier ${budget.tier} budget ${budget.core}` +
        `${budget.endpoints == null ? ' (no facts.json: endpoint count unknown)' : ` (${budget.endpoints} endpoints)`}`,
    );
  return out;
}

// A citation's target among the file's declarations: the same name, and the same arity when the cite gives one
// (`#save/2`). Null when the file's declarations are unknown here (no dump, or not a Java file).
export function citeCandidates(declared, pc) {
  const decl = declared?.get(pc.file);
  if (!decl) return null;
  const named = [...(decl.methods ?? []), ...(decl.types ?? [])].filter((d) => d.name === pc.symbol);
  return pc.arity == null ? named : named.filter((d) => d.arity == null || d.arity === pc.arity);
}
const overlaps = (d, pc) => pc.start != null && d.start <= pc.end && pc.start <= d.end;
const containsSymbol = (lines, pc) =>
  pc.start != null && pc.end <= lines.length && lines.slice(pc.start - 1, pc.end).join('\n').includes(pc.symbol);
// The symbol as the writer wrote it, arity included: what a repaired citation keeps.
const symbolWithArity = (pc) => (pc.arity == null ? pc.symbol : `${pc.symbol}/${pc.arity}`);

// `path:start-end#name (N params)` for each declaration the citation could mean, so the error can list them all.
function citeCandidatesText(file, named) {
  return named
    .map((d) => `${file}:${d.start}-${d.end}#${d.name} (${d.arity == null ? 'arity unknown' : `${d.arity} params`})`)
    .join(', ');
}

// Why a citation does not name the declaration it means, or null when it does. One declaration of that name keeps the
// plain test (the cited lines must contain it); several make a bare name ambiguous, so only a range overlapping exactly
// one of them, or the arity form `#name/2`, resolves it. Nothing is guessed: the writer is given the candidates.
export function citeProblem(pc, named, lines) {
  if (!pc.symbol) return null;
  if (named && named.length > 1 && named.filter((d) => overlaps(d, pc)).length !== 1)
    return `is ambiguous: ${citeCandidatesText(pc.file, named)}`;
  if (named && !named.length && pc.arity != null) return `names no "${pc.symbol}" with ${pc.arity} params in that file`;
  if (!lines) return null;
  if (pc.start == null) return lines.join('\n').includes(pc.symbol) ? null : `does not contain "${pc.symbol}"`;
  return containsSymbol(lines, pc) ? null : `does not contain "${pc.symbol}"`;
}

// Fill in or repair line ranges from symbols, in place: "path#method" gets the method's exact range, and a
// range that misses its #symbol is moved to the method of that name nearest to it. Writers cite methods by
// name and never need to look up line numbers. Overloads are never guessed: a name the file declares several
// times is left for validate() to report with its candidates, and a range that overlaps one declaration is kept
// as written. Returns how many citations changed.
export function resolveCites(map, root, declared = null) {
  const cache = new Map(),
    load = (abs) => {
      if (!cache.has(abs)) cache.set(abs, { lines: fs.readFileSync(abs, 'utf8').split('\n') });
      return cache.get(abs);
    },
    at = (file) => declared?.get(file) ?? { methods: [], types: [] };
  const fix = (c) => {
    const pc = parseCite(c);
    if (!pc?.symbol) return c;
    const abs = path.join(root, pc.file);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return c;
    const { lines } = load(abs);
    const named = citeCandidates(declared, pc);
    const cite = (d) => `${pc.file}:${d.start}-${d.end}#${symbolWithArity(pc)}`;
    // The range names one declaration: nothing to repair, and nothing to guess.
    if (named && named.filter((d) => overlaps(d, pc)).length === 1) return c;
    // Several methods of that name: only the writer knows which one the claim is about.
    if (named && named.length > 1) return c;
    // The name is already in the cited lines: keep today's tolerance for a single declaration of that name.
    if (pc.arity == null && containsSymbol(lines, pc)) return c;
    if (named?.length === 1) return cite(named[0]);
    if (pc.start == null && pc.arity == null) {
      const i = lines.findIndex((l) => l.includes(pc.symbol));
      if (i >= 0) {
        const m = at(pc.file).methods.find((mm) => mm.start <= i + 1 && i + 1 <= mm.end);
        return m ? cite(m) : `${pc.file}:${i + 1}#${pc.symbol}`;
      }
    }
    return c;
  };
  let changed = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'cites' || k === 'start') && Array.isArray(v))
        v.forEach((c, i) => {
          const f = typeof c === 'string' ? fix(c) : c;
          if (f !== c) {
            v[i] = f;
            changed++;
          }
        });
      else if (k === 'cite' && typeof v === 'string') {
        const f = fix(v);
        if (f !== v) {
          node[k] = f;
          changed++;
        }
      } else walk(v);
    }
  };
  walk(map);
  return changed;
}

// Activity badges are computed, never written by hand: each region lists its `paths`, and the commit
// counts come from git in the shared window. Regions without paths keep whatever activity they have.
function fillActivity(map, root) {
  const regions = (map.regions ?? []).filter((r) => r.paths?.length);
  if (!regions.length) return;
  const w = gitWindow(root);
  for (const r of regions) {
    if (w) r.activity = activityFor(root, w.since, r.paths);
    else delete r.activity;
  }
}

// P6: the map states behaviour, never weakness and never a secret. Ids, paths and citations are code, not prose, so
// they are not scanned; a placeholder such as `${X}` is not a credential.
const P6_CODE_KEYS = new Set([
  'id', 'ids', 'path', 'paths', 'cite', 'cites', 'citation', 'citations', 'evidence', 'file', 'files',
  'handler', 'handlerFqn', 'declaredIn', 'method', 'target', 'symbol',
]);
const P6_SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/, 'a GitHub token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'an API key'],
  [/password\s*[=:]\s*(?!\$\{|\$\(|%|<|\[|x{3,}|\*{3,}|\b(?:none|null|empty|changeit)\b)[^\s"'&,;]{6,}/i, 'a password value'],
];
const P6_WEAKNESS = [
  [/\bvulnerab(?:le|ility|ilities)\b/i, 'vulnerability'],
  [/\bexploits?\b/i, 'exploit'],
  [/\battackers?\b/i, 'attacker'],
  [/\bsecurity holes?\b/i, 'security hole'],
  [/\bCVE-\d{4}-\d{4,}\b/, 'a CVE id'],
];
const P6_BUG = /\bbugs?\b/i;

// Every prose string with its location in the map, skipping the fields that hold code.
function proseOf(map) {
  const out = [];
  const walk = (v, where, code) => {
    if (typeof v === 'string') {
      if (!code) out.push([where, v]);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`, code));
    if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, where ? `${where}.${k}` : k, code || P6_CODE_KEYS.has(k));
  };
  walk(map, '', false);
  return out;
}

function p6Issues(map) {
  const errors = [], warnings = [];
  for (const [where, text] of proseOf(map)) {
    for (const [re, what] of P6_SECRETS) if (re.test(text)) errors.push(`${where}: looks like ${what}`);
    for (const [re, what] of P6_WEAKNESS) if (re.test(text)) errors.push(`${where}: names a ${what} (P6: state behaviour neutrally)`);
    if (P6_BUG.test(text)) warnings.push(`${where}: says "bug"; some domains use the word (P6)`);
  }
  return { errors, warnings };
}

{
  const ok = p6Issues({
    purpose: 'Orders are charged as the browser sends them.',
    rules: [{ id: 'r1', text: 'The tenant comes from `${TENANT}`.', cite: 'a/C.java:1' }],
  });
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.warnings, []);
  const bad = p6Issues({
    purpose: 'This controller is vulnerable to an exploit by an attacker.',
    context: { actors: [{ id: 'a', what: 'DB password=Sup3rS3cret!' }] },
    concepts: [{ id: 'c', text: 'This is a bug.' }],
  });
  assert.equal(bad.errors.length, 4); // vulnerability, exploit, attacker, the password value
  assert.equal(bad.warnings.length, 1);
  assert.ok(bad.errors.every((e) => !e.includes('Sup3rS3cret')), 'the message never repeats the secret');
}

/** `file -> {methods, types}` from the model: what citation repair reads instead of re-parsing Java. */
export function declaredFromModel(model) {
  const byFile = new Map();
  const slot = (file) => {
    if (!byFile.has(file)) byFile.set(file, { methods: [], types: [] });
    return byFile.get(file);
  };
  for (const t of model.types.values()) {
    slot(t.file).types.push({ name: t.name, start: t.start, end: t.end, nameLine: t.nameLine });
    for (const m of t.methods ?? []) {
      // A constructor carries its type's name: a `#Type` citation means the type, never one of its constructors.
      if (m.name === t.name) continue;
      slot(t.file).methods.push({
        name: m.name,
        start: m.start,
        end: m.end,
        nameLine: m.nameLine,
        arity: Array.isArray(m.params) ? m.params.length : null,
      });
    }
  }
  return byFile;
}

/** The dump beside the map, when there is one: the CLI's own way to the same answers. */
function declaredFromDump(root) {
  const dir = path.join(root, 'mindmodel', '.work', 'dump');
  if (!fs.existsSync(path.join(dir, 'meta.json'))) return null;
  try {
    const dump = openDump(dir);
    const byFile = new Map();
    const slot = (file) => {
      if (!byFile.has(file)) byFile.set(file, { methods: [], types: [] });
      return byFile.get(file);
    };
    for (const row of dump.types.values())
      if (row.pos?.file)
        slot(row.pos.file).types.push({
          name: String(row.fqn).split('.').pop(),
          start: row.pos.line,
          end: row.pos.endLine ?? row.pos.line,
          nameLine: row.pos.line,
        });
    for (const m of dump.members.values())
      if (m.kind === 'method' && m.pos?.file)
        slot(m.pos.file).methods.push({
          name: m.name,
          start: m.pos.line,
          end: m.pos.endLine ?? m.pos.line,
          nameLine: m.pos.line,
          arity: Array.isArray(m.params) ? m.params.length : null,
        });
    return byFile;
  } catch {
    return null;
  }
}

// The scan facts, when the run has them: the endpoint count sets the size tier (P8), and the security warnings say
// which files must not become rules. Facts are optional for validation; an unreadable file is not a validation error.
function readFacts(root) {
  const file = path.join(root, 'mindmodel', '.work', 'facts.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function validate(map, root, declared = declaredFromDump(root)) {
  resolveCites(map, root, declared);
  fillActivity(map, root);
  const errors = [],
    warnings = [];
  const err = (m) => errors.push(m),
    warn = (m) => warnings.push(m);
  for (const k of [
    'purpose',
    'context',
    'coreSentence',
    'concepts',
    'state',
    'regionSentence',
    'regions',
    'runtime',
    'background',
    'rules',
    'stories',
  ])
    if (!map[k]) err(`missing top-level "${k}"`);
  if (errors.length) return { errors, warnings };
  checkSchema(map, SCHEMA, SCHEMA.$defs ?? {}, '$', err);
  if (errors.length) return { errors, warnings };

  const max = (arr, n, what) => {
    if ((arr?.length ?? 0) > n) err(`${what}: ${arr.length} > budget ${n}`);
  };
  const range = (arr, [lo, hi], what) => {
    const n = arr?.length ?? 0;
    if (n < lo || n > hi) err(`${what}: ${n} outside budget ${lo}-${hi}`);
  };
  max(map.context.actors, BUDGET.actors, 'actors');
  max(map.context.externals, BUDGET.externals, 'externals');
  max(map.concepts, BUDGET.concepts, 'concepts');
  range(map.regions, BUDGET.regions, 'regions');
  range(map.runtime.lanes, BUDGET.lanes, 'request lanes');
  max(map.runtime.steps, BUDGET.flowSteps, 'request steps');
  max(map.rules, BUDGET.rules, 'rules');
  range(map.stories, BUDGET.stories, 'stories');

  const conceptIds = new Set(map.concepts.map((c) => c.id));
  const regionIds = new Set(map.regions.map((r) => r.id));
  const laneIds = new Set(map.runtime.lanes.map((l) => l.id));
  const needRegion = (id, where) => {
    if (!regionIds.has(id)) err(`${where}: unknown region "${id}"`);
  };
  const needConcept = (id, where) => {
    if (!conceptIds.has(id)) err(`${where}: unknown concept "${id}"`);
  };

  // Core sentence: links every concept in one line, so each must be marked [[id|text]] and the claim cited.
  const marked = new Set(
    [...(map.coreSentence?.text ?? '').matchAll(/\[\[([a-z][a-z0-9-]*)\|[^\]]+\]\]/g)].map((x) => x[1]),
  );
  if (!map.coreSentence?.text) err('missing coreSentence');
  else {
    for (const id of marked) needConcept(id, 'coreSentence');
    for (const id of conceptIds) if (!marked.has(id)) err(`coreSentence: concept "${id}" not mentioned as [[${id}|…]]`);
    if (!map.coreSentence.cites?.length) err('coreSentence: no citation (R7)');
  }
  for (const c of map.concepts)
    for (const r of c.relations ?? []) {
      needConcept(r.to, `concept ${c.id} relation`);
      if (!r.cites?.length) err(`concept ${c.id} → ${r.to}: relation has no citation (R7)`);
    }

  const inSentence = new Set(
    [...(map.regionSentence?.text ?? '').matchAll(/\[\[([a-z][a-z0-9-]*)\|[^\]]+\]\]/g)].map((x) => x[1]),
  );
  if (!map.regionSentence?.text) err('missing regionSentence');
  else {
    for (const id of inSentence) needRegion(id, 'regionSentence');
    for (const id of regionIds)
      if (!inSentence.has(id)) err(`regionSentence: region "${id}" not mentioned as [[${id}|…]]`);
  }
  for (const r of map.regions) {
    for (const p of r.paths ?? []) if (!fs.existsSync(path.join(root, p))) err(`region ${r.id}: path not found "${p}"`);
    if (r.activity && !(r.activity.commits >= 0 && r.activity.commits <= r.activity.of))
      err(`region ${r.id}: activity ${r.activity.commits} of ${r.activity.of} is impossible`);
    for (const o of r.owns ?? []) needConcept(o, `region ${r.id} owns`);
    max(r.parts, BUDGET.parts, `region ${r.id} parts`);
  }
  map.runtime.steps.forEach((s, i) => {
    needRegion(s.region, `request step ${i + 1}`);
    for (const lane of [s.from, s.to]) if (!laneIds.has(lane)) err(`request step ${i + 1}: unknown lane "${lane}"`);
    if ((s.label ?? '').length > 56) err(`request step ${i + 1}: label longer than 56 chars`);
  });
  const bg = map.background?.items ?? [];
  if (!bg.length && !map.background?.intro) err('background: no items and no intro saying nothing runs on its own');
  if (bg.length > 10) err(`background: ${bg.length} > budget 10`);
  bg.forEach((b) => {
    needRegion(b.region, `background "${b.name}"`);
    if (!b.cites?.length) err(`background "${b.name}": no citation (R7)`);
  });

  // State & source of truth (3.4): one owner row per core concept, writers named by region.
  const owners = map.state.owners ?? [];
  for (const o of owners) {
    needConcept(o.concept, 'state owner');
    needRegion(o.writer, `state owner ${o.concept}`);
    (o.others ?? []).forEach((w) => needRegion(w.region, `state owner ${o.concept} other writer`));
  }
  for (const id of conceptIds)
    if (owners.filter((o) => o.concept === id).length !== 1) err(`state: concept "${id}" needs exactly one owner row`);
  max(map.purpose.boot?.run, BUDGET.runSteps, 'boot run steps');

  const act = map.regions.filter((r) => r.activity);
  if (act.length > 1 && act.every((r) => r.activity.commits === 0))
    warn("every region has 0 commits: check the regions' paths");
  map.context.actors.forEach((a) => {
    if (!a.importance) warn(`actor ${a.id}: missing "importance" (why it ranks here)`);
  });

  // R14: each story touches >=2 regions; regions no flow runs through are reported.
  const covered = new Set();
  for (const st of map.stories) {
    max(st.steps, BUDGET.storySteps, `story ${st.id} steps`);
    const touched = new Set(st.steps.map((s) => s.region));
    st.steps.forEach((s) => needRegion(s.region, `story ${st.id}`));
    // A caution is a rare exception on the step it belongs to (rule 3.9), never a running commentary.
    const careful = st.steps.filter((s) => s.careful?.trim());
    if (careful.length > 2) warn(`story ${st.id}: ${careful.length} "careful" cautions (at most 2)`);
    if (touched.size < 2) err(`story ${st.id}: touches ${touched.size} region(s), needs >= 2`);
    touched.forEach((r) => covered.add(r));
  }
  for (const r of regionIds) if (!covered.has(r)) warn(`region ${r}: no story runs through it`);
  for (const [what, list] of [
    ['rule', map.rules],
    ['story', map.stories],
  ])
    list.forEach((x, i) => {
      if (!x.importance) err(`${what} ${i + 1}: missing "importance" (why it ranks here)`);
    });
  // A rule that is absolute should say when it holds (P10a), but the check is a warning: an instruction ("never read
  // the tenant from the request") is not a claim that something never happens, and rejecting it as an error would
  // punish a correct, verified rule for its grammar.
  const ABSOLUTE =
    /\b(never|always|all requests|every request|no authentication|requires? authentication|guaranteed|impossible)\b/i;
  map.rules.forEach((r, i) => {
    if (ABSOLUTE.test(`${r.title ?? ''} ${r.text ?? ''}`) && !String(r.condition ?? '').trim())
      warn(`rule ${i + 1}: absolute wording without a "condition" (state when it holds, or say why it is unconditional)`);
  });
  // The security section states knowledge, and every claim in it cites code (S4).
  if (map.security) {
    const need = (what, cites) => {
      if (!cites || !cites.length) err(`security: ${what} has no citation`);
    };
    need('intro', map.security.cites);
    for (const p of map.security.prefixes ?? []) need(`prefix ${p.prefix}`, p.cites);
    for (const u of map.security.userSources ?? []) need(`user source ${u.kind}`, u.cites);
    if (map.security.tenant) need('tenant', map.security.tenant.cites);
  }

  // A rule that cites an endpoint under an anonymous-write warning is describing missing code, not the system's
  // conventions. The warning is not fatal, but it should point the writer at findings.md.
  const secFacts = readFacts(root);
  if (secFacts) {
    const warned = new Set((secFacts.securityWarnings ?? []).map((w) => String(w.evidence?.[0] ?? '').replace(/:.*$/, '')));
    map.rules.forEach((r, i) => {
      const files = (r.cites ?? []).map((c) => String(typeof c === 'string' ? c : c.path ?? '').replace(/[:#].*$/, ''));
      if (files.some((f) => warned.has(f)))
        warn(`rule ${i + 1}: cites code covered by an anonymous-write warning; state the condition neutrally and put the gap in findings.md`);
    });
  }
  if (map.stories.some((s) => s.kind === 'change'))
    err('change stories are not part of the map; stories are ranked main flows');
  const inferred = map.stories.flatMap((s) => s.steps.filter((x) => x.inferred).map(() => s.id));
  if (inferred.length) warn(`${inferred.length} story step(s) marked inferred: ${[...new Set(inferred)].join(', ')}`);

  // Collect every citation, check it resolves.
  const cites = [];
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'cites' || k === 'start') && Array.isArray(v)) v.forEach((c) => cites.push([c, `${where}.${k}`]));
        else if (k === 'cite' && typeof v === 'string') cites.push([v, `${where}.cite`]);
        else walk(v, `${where}.${k}`);
      }
    }
  };
  walk(map, '$');
  const lineCount = new Map();
  for (const [c, where] of cites) {
    const pc = parseCite(c);
    if (!pc) {
      err(`${where}: malformed citation "${c}"`);
      continue;
    }
    // Build output is never a citation's target: it is rewritten by every build, and a citation into it would point at
    // code the project does not own (a generated source contributes no dump row at all, so nothing real is there).
    if (/(^|\/)(target|build)\//.test(pc.file)) {
      err(`${where}: "${c}" cites build output; cite the source behind it`);
      continue;
    }
    const abs = path.join(root, pc.file);
    if (!fs.existsSync(abs)) {
      err(`${where}: path not found "${pc.file}"`);
      continue;
    }
    const dir = fs.statSync(abs).isDirectory();
    if (!dir && !lineCount.has(abs)) lineCount.set(abs, fs.readFileSync(abs, 'utf8').split('\n'));
    if (pc.start == null) {
      const why = dir ? null : citeProblem(pc, citeCandidates(declared, pc), lineCount.get(abs));
      if (why) err(`${where}: "${c}" ${why}`);
      continue;
    }
    if (dir) {
      err(`${where}: line given for directory "${c}"`);
      continue;
    }
    const fileLines = lineCount.get(abs),
      n = fileLines.length;
    if (pc.start < 1 || pc.end < pc.start || pc.end > n) {
      err(`${where}: "${c}" outside file (${n} lines)`);
      continue;
    }
    // #symbol: the cited lines must be the declaration the writer meant. Overloads are never guessed: with several
    // methods of that name the range must overlap exactly one of them, and a bare name is ambiguous.
    const why = citeProblem(pc, citeCandidates(declared, pc), fileLines);
    if (why) err(`${where}: "${c}" ${why}`);
  }
  for (const [where, list] of [
    ['request path', map.runtime.steps],
    ...map.stories.map((s) => [`story ${s.id}`, s.steps]),
  ])
    list.forEach((s, i) => {
      if (!s.cites?.length) err(`${where} step ${i + 1}: no citation (R7)`);
    });

  // Words budget (P8): the core map (everything except stories) against its tier, and each section against its share.
  const counts = sectionWords(map);
  const coreWords = Object.values(counts).reduce((n, x) => n + x, 0);
  const facts = readFacts(root);
  const endpoints = facts?.endpoints?.length ?? null;
  const budget = budgetFor(endpoints);
  budgetWarnings(counts, budget).forEach(warn);
  const citeNeeded = citeTarget(map);
  if (cites.length > Math.round(citeNeeded * 1.4))
    warn(`citations: ${cites.length} > 1.4x the ~${citeNeeded} a block-cited map needs (P3: one or two per block)`);

  // P6 wording and secrets, then the owner-only findings the map may not carry.
  const p6 = p6Issues(map);
  errors.push(...p6.errors);
  warnings.push(...p6.warnings);
  // The writer's harness may refuse this write, so the main session saves the writer's `findings` reply block after
  // the writer returns: absence here means "not written yet", not a mistake in the map.
  if (!fs.existsSync(path.join(root, 'mindmodel/.work/findings.md')))
    warn('mindmodel/.work/findings.md not written yet: the main session saves the writer\'s findings block' +
      ' (or "none")');

  return {
    errors,
    warnings,
    stats: {
      citations: cites.length,
      citeTarget: citeNeeded,
      tier: budget.tier,
      coreWords,
      budget: budget.core,
      sections: counts,
      targets: budget.sections,
      storyWords: wordCount(map.stories),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fileArg, rootArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const file = path.resolve(fileArg ?? 'mindmodel/mindmodel.json');
  const root = path.resolve(rootArg ?? path.join(path.dirname(file), '..'));
  const map = JSON.parse(fs.readFileSync(file, 'utf8')),
    before = JSON.stringify(map);
  const { errors, warnings, stats } = validate(map, root);
  // --fix writes resolved citations and computed badges back, so the file matches what was validated and rendered
  if (process.argv.includes('--fix') && JSON.stringify(map) !== before) {
    fs.writeFileSync(file, JSON.stringify(map, null, 1));
    console.log('fixed: citations resolved and activity computed');
  }
  warnings.forEach((w) => console.log(`warn  ${w}`));
  errors.forEach((e) => console.log(`ERROR ${e}`));
  console.log(`${errors.length ? 'FAILED' : 'OK'}: ${errors.length} error(s), ${warnings.length} warning(s)`);
  // The tier, the total and every section against its share, so the next edit is one section, not the whole map.
  if (stats) {
    const parts = Object.entries(stats.sections).map(
      ([k, n]) =>
        `${k} ${n}/${stats.targets[k]}${n > stats.targets[k] ? '!' : n < stats.targets[k] * UNDER_SHARE && k !== 'intros' ? '_' : ''}`,
    );
    console.log(
      `budget: tier ${stats.tier} — core ${stats.coreWords}/${stats.budget} words · citations ${stats.citations}` +
        ` (target ~${stats.citeTarget}) · stories ${stats.storyWords} words`,
    );
    console.log(`sections: ${parts.join(' · ')}`);
  }
  process.exit(errors.length ? 1 : 0);
}
