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

export function parseCite(c) {
  const m = /^([^:#]+?)(?::(\d+)(?:-(\d+))?)?(?:#(\S+))?$/.exec(c);
  if (!m) return null;
  return { file: m[1], start: m[2] ? +m[2] : null, end: m[3] ? +m[3] : m[2] ? +m[2] : null, symbol: m[4] ?? null };
}
assert.deepStrictEqual(parseCite('a/b.java:10-12'), { file: 'a/b.java', start: 10, end: 12, symbol: null });
assert.deepStrictEqual(parseCite('CLAUDE.md'), { file: 'CLAUDE.md', start: null, end: null, symbol: null });
assert.deepStrictEqual(parseCite('a/B.java:5#save'), { file: 'a/B.java', start: 5, end: 5, symbol: 'save' });

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
  concepts: 5,
  regions: [2, 7],
  lanes: [2, 5],
  flowSteps: 7,
  rules: 5,
  stories: [1, 5],
  storySteps: 10,
  parts: 7,
  coreWords: 3000,
  copies: 5,
  seams: 4,
  runSteps: 3,
};

// Fill in or repair line ranges from symbols, in place: "path#method" gets the method's exact range, and a
// range that misses its #symbol is moved to the method of that name nearest to it. Writers cite methods by
// name and never need to look up line numbers. Returns how many citations changed.
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
    if (
      pc.start != null &&
      pc.end <= lines.length &&
      lines
        .slice(pc.start - 1, pc.end)
        .join('\n')
        .includes(pc.symbol)
    )
      return c;
    const named = [...at(pc.file).methods, ...at(pc.file).types].filter((m) => m.name === pc.symbol);
    if (named.length) {
      const near =
        pc.start == null
          ? named[0]
          : named.sort(
              (a, b) => Math.abs((a.nameLine ?? a.start) - pc.start) - Math.abs((b.nameLine ?? b.start) - pc.start),
            )[0];
      return `${pc.file}:${near.start}-${near.end}#${pc.symbol}`;
    }
    if (pc.start == null) {
      const i = lines.findIndex((l) => l.includes(pc.symbol));
      if (i >= 0) {
        const m = at(pc.file).methods.find((mm) => mm.start <= i + 1 && i + 1 <= mm.end);
        return m ? `${pc.file}:${m.start}-${m.end}#${pc.symbol}` : `${pc.file}:${i + 1}#${pc.symbol}`;
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
export function fillActivity(map, root) {
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
export function proseOf(map) {
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

export function p6Issues(map) {
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
    for (const m of t.methods ?? [])
      slot(t.file).methods.push({ name: m.name, start: m.start, end: m.end, nameLine: m.nameLine });
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
        });
    return byFile;
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
  max(map.state.copies, BUDGET.copies, 'state copies');
  max(map.state.seams, BUDGET.seams, 'state seams');
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
    for (const d of map.security.developerRule ?? []) need('developer rule', d.cites);
    if (map.security.tenant) need('tenant', map.security.tenant.cites);
  }

  // A rule that cites an endpoint under an anonymous-write warning is describing missing code, not the system's
  // conventions. The warning is not fatal, but it should point the writer at findings.md.
  const factsFile = path.join(root, 'mindmodel', '.work', 'facts.json');
  if (fs.existsSync(factsFile)) {
    try {
      const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
      const warned = new Set((facts.securityWarnings ?? []).map((w) => String(w.evidence?.[0] ?? '').replace(/:.*$/, '')));
      map.rules.forEach((r, i) => {
        const files = (r.cites ?? []).map((c) => String(typeof c === 'string' ? c : c.path ?? '').replace(/[:#].*$/, ''));
        if (files.some((f) => warned.has(f)))
          warn(`rule ${i + 1}: cites code covered by an anonymous-write warning; state the condition neutrally and put the gap in findings.md`);
      });
    } catch {
      // Facts are optional for validation; an unreadable file is not a validation error.
    }
  }
  if (map.stories.some((s) => s.kind === 'change'))
    err('change stories are not part of the map; stories are ranked main flows');
  const inferred = map.stories.flatMap((s) => s.steps.filter((x) => x.inferred).map(() => s.id));
  if (inferred.length) warn(`${inferred.length} story step(s) marked inferred: ${[...new Set(inferred)].join(', ')}`);

  // R7/R8: collect every citation, check it resolves.
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
    const abs = path.join(root, pc.file);
    if (!fs.existsSync(abs)) {
      err(`${where}: path not found "${pc.file}"`);
      continue;
    }
    const dir = fs.statSync(abs).isDirectory();
    if (!dir && !lineCount.has(abs)) lineCount.set(abs, fs.readFileSync(abs, 'utf8').split('\n'));
    if (pc.start == null) {
      if (pc.symbol && !dir && !lineCount.get(abs).join('\n').includes(pc.symbol))
        err(`${where}: "${c}" does not contain "${pc.symbol}"`);
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
    // #symbol: the cited range must contain it, so a citation can't silently point at the wrong lines
    if (
      pc.symbol &&
      !fileLines
        .slice(pc.start - 1, pc.end)
        .join('\n')
        .includes(pc.symbol)
    )
      err(`${where}: "${c}" does not contain "${pc.symbol}"`);
  }
  for (const [where, list] of [
    ['request path', map.runtime.steps],
    ...map.stories.map((s) => [`story ${s.id}`, s.steps]),
  ])
    list.forEach((s, i) => {
      if (!s.cites?.length) err(`${where} step ${i + 1}: no citation (R7)`);
    });

  // Words budget for the core map (everything except stories).
  const words = (o) =>
    JSON.stringify(o)
      .replace(/"[a-zA-Z]+":/g, ' ')
      .split(/\s+/)
      .filter((w) => /[a-zA-Z]{2,}/.test(w) && !w.includes('/')).length;
  const core = { ...map, stories: undefined };
  const coreWords = words(core);
  if (coreWords > BUDGET.coreWords) warn(`core map ~${coreWords} words > budget ${BUDGET.coreWords}`);

  // P6 wording and secrets, then the owner-only findings the map may not carry.
  const p6 = p6Issues(map);
  errors.push(...p6.errors);
  warnings.push(...p6.warnings);
  if (!fs.existsSync(path.join(root, 'mindmodel/.work/findings.md')))
    warn('no mindmodel/.work/findings.md: write the owner-only findings (or "none")');

  return { errors, warnings, stats: { citations: cites.length, coreWords, storyWords: words(map.stories) } };
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
  console.log(
    `${errors.length ? 'FAILED' : 'OK'}: ${errors.length} error(s), ${warnings.length} warning(s)`,
    stats ?? '',
  );
  process.exit(errors.length ? 1 : 0);
}
