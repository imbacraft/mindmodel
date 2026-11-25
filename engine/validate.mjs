#!/usr/bin/env node
// Validates a mindmodel.json against the generation rules: schema, budgets (Part 7), id references, and that every citation resolves.
// Usage: node validate.mjs <mindmodel.json> [projectRoot]   (projectRoot defaults to the parent of the mindmodel/ folder)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { open as openDump } from './dump.mjs';
import { startsAt } from './model/from-dump-model.mjs';
import { fileURLToPath } from 'node:url';
import { gitWindow, activityFor } from './io/activity.mjs';
import { formatCite, parseCite } from './core/cite.mjs';
import { checkSchema } from './core/schema.mjs';
import { budgetFor, budgetWarnings, isThin } from './budget.mjs';
import { degraded, degradedMark, degradedSince } from './core/degrade.mjs';

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../schema/mindmodel.schema.json'), 'utf8'),
);

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

// A citation's target among the file's declarations: the same name, and the same arity when the cite gives one
// (`#save/2`). Null when there is no dump (`declared` null: said once, where the dump was read) or no symbol to match.
// A Java file the dump knows nothing about, cited by symbol, is a partial dump: the overload check is off.
// Build output never has dump rows (a generated source is read for its types, never cited), so it is not a gap.
const BUILD_OUTPUT = /(^|\/)(target|build)\//;
export function citeCandidates(declared, pc) {
  if (!declared || !pc.symbol) return null;
  const decl = declared.get(pc.file);
  if (!decl) {
    if (!/\.java$/.test(pc.file) || BUILD_OUTPUT.test(pc.file)) return null;
    return degraded(`dump has no declarations for ${pc.file}: the overload check for #${pc.symbol} is off`, null);
  }
  const named = [...(decl.methods ?? []), ...(decl.types ?? [])].filter((d) => d.name === pc.symbol);
  return pc.arity == null ? named : named.filter((d) => d.arity == null || d.arity === pc.arity);
}
const overlaps = (d, pc) => pc.start != null && d.start <= pc.end && pc.start <= d.end;
const containsSymbol = (lines, pc) =>
  pc.start != null && pc.end <= lines.length && lines.slice(pc.start - 1, pc.end).join('\n').includes(pc.symbol);

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

// Every citation field in the map, in walk order: `cites` and `start` arrays, and `cite` strings. Each entry has its
// holder's path (`where`, for messages) and `set`, which rewrites the citation in place, so repairs and checks share
// one walk.
export function citesOf(map) {
  const out = [];
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'cites' || k === 'start') && Array.isArray(v))
        v.forEach((cite, i) => out.push({ cite, where: `${where}.${k}`, set: (f) => (v[i] = f) }));
      else if (k === 'cite' && typeof v === 'string')
        out.push({ cite: v, where: `${where}.cite`, set: (f) => (node[k] = f) });
      else walk(v, `${where}.${k}`);
    }
  };
  walk(map, '$');
  return out;
}
{
  const map = { a: { cites: ['x.java:1'] }, b: [{ cite: 'y.java:2' }], start: ['z.java:3'] };
  assert.deepStrictEqual(
    citesOf(map).map(({ cite, where }) => [cite, where]),
    [
      ['x.java:1', '$.a.cites'],
      ['y.java:2', '$.b[0].cite'],
      ['z.java:3', '$.start'],
    ],
  );
}

// A cited file's lines, read once per run: validate() and the citation repairs share the cache.
const linesOf = (cache, abs) => {
  if (!cache.has(abs)) cache.set(abs, fs.readFileSync(abs, 'utf8').split('\n'));
  return cache.get(abs);
};

// Why one citation does not resolve, as the message that follows its location (null when it resolves). `declared` is
// the dump's declarations, or null when there is no dump; `cache` is the run's file cache (see linesOf).
export function checkCite(c, root, declared, cache) {
  const pc = parseCite(c);
  if (!pc) return `malformed citation "${c}"`;
  // Build output is never a citation's target: it is rewritten by every build, and a citation into it would point at
  // code the project does not own (a generated source contributes no dump row at all, so nothing real is there).
  if (BUILD_OUTPUT.test(pc.file)) return `"${c}" cites build output; cite the source behind it`;
  const abs = path.join(root, pc.file);
  if (!fs.existsSync(abs)) return `path not found "${pc.file}"`;
  const dir = fs.statSync(abs).isDirectory();
  if (pc.start == null) {
    const why = dir ? null : citeProblem(pc, citeCandidates(declared, pc), linesOf(cache, abs));
    return why ? `"${c}" ${why}` : null;
  }
  if (dir) return `line given for directory "${c}"`;
  const lines = linesOf(cache, abs);
  if (pc.start < 1 || pc.end < pc.start || pc.end > lines.length) return `"${c}" outside file (${lines.length} lines)`;
  // #symbol: the cited lines must be the declaration the writer meant. Overloads are never guessed: with several
  // methods of that name the range must overlap exactly one of them, and a bare name is ambiguous.
  const why = citeProblem(pc, citeCandidates(declared, pc), lines);
  return why ? `"${c}" ${why}` : null;
}
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cache = new Map();
  assert.equal(checkCite('::bad::', root, null, cache), 'malformed citation "::bad::"');
  assert.equal(
    checkCite('target/x.java:1', root, null, cache),
    '"target/x.java:1" cites build output; cite the source behind it',
  );
  assert.equal(checkCite('engine/nope.mjs:1', root, null, cache), 'path not found "engine/nope.mjs"');
  assert.equal(checkCite('engine:1-2', root, null, cache), 'line given for directory "engine:1-2"');
  assert.equal(checkCite('engine', root, null, cache), null);
  assert.ok(
    checkCite('engine/validate.mjs:0-3', root, null, cache).startsWith('"engine/validate.mjs:0-3" outside file'),
  );
  assert.equal(
    checkCite('engine/render.mjs#noSuchSymbolXyz', root, null, cache),
    '"engine/render.mjs#noSuchSymbolXyz" does not contain "noSuchSymbolXyz"',
  );
  assert.equal(cache.size, 2, 'each cited file is read once');
}

// Fill in or repair line ranges from symbols, in place: "path#method" gets the method's exact range, and a
// range that misses its #symbol is moved to the method of that name nearest to it. Writers cite methods by
// name and never need to look up line numbers. Overloads are never guessed: a name the file declares several
// times is left for validate() to report with its candidates, and a range that overlaps one declaration is kept
// as written. Returns how many citations changed.
export function resolveCites(map, root, declared = null, cache = new Map()) {
  const at = (file) => declared?.get(file) ?? { methods: [], types: [] };
  const fix = (c) => {
    const pc = parseCite(c);
    if (!pc?.symbol) return c;
    const abs = path.join(root, pc.file);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return c;
    const lines = linesOf(cache, abs);
    const named = citeCandidates(declared, pc);
    const cite = (d) => formatCite({ ...pc, start: d.start, end: d.end });
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
  for (const ref of citesOf(map)) {
    if (typeof ref.cite !== 'string') continue;
    const f = fix(ref.cite);
    if (f !== ref.cite) {
      ref.set(f);
      changed++;
    }
  }
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

/** The dump's declarations per file, in the shape citeCandidates() reads. */
function declarationsOf(dump) {
  const byFile = new Map();
  const slot = (file) => {
    if (!byFile.has(file)) byFile.set(file, { methods: [], types: [] });
    return byFile.get(file);
  };
  for (const row of dump.types.values())
    if (row.pos?.file)
      slot(row.pos.file).types.push({
        name: String(row.fqn).split('.').pop(),
        start: startsAt(row, row.pos.line),
        end: row.pos.endLine ?? row.pos.line,
        nameLine: startsAt(row, row.pos.line),
      });
  for (const m of dump.members.values())
    if (m.kind === 'method' && m.pos?.file)
      slot(m.pos.file).methods.push({
        name: m.name,
        start: startsAt(m, m.pos.line),
        end: m.pos.endLine ?? m.pos.line,
        nameLine: startsAt(m, m.pos.line),
        arity: Array.isArray(m.params) ? m.params.length : null,
      });
  return byFile;
}

/** The dump beside the map, when there is one: the CLI's own way to the same answers. Without a readable dump there are
 * no declarations, so the overload checks are off, and that is a degradation. */
function declaredFromDump(root) {
  const dir = path.join(root, 'mindmodel', '.work', 'dump');
  if (!fs.existsSync(path.join(dir, 'meta.json')))
    return degraded('no engine dump at mindmodel/.work/dump: the overload checks are off', null);
  try {
    return declarationsOf(openDump(dir));
  } catch (e) {
    return degraded(`mindmodel/.work/dump cannot be read (${e.message}): the overload checks are off`, null);
  }
}

// The scan facts, read once per run: the endpoint count sets the size tier (P8), and the security warnings say which
// files must not become rules. Facts are optional for validation, but without them the budget falls back to the
// widest tier and no security warning applies: that is a degradation, not a silent default.
export function readFacts(file) {
  if (!fs.existsSync(file))
    return degraded(`no ${file}: the budget uses the widest tier and no security warnings apply`, null);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return degraded(
      `facts.json cannot be read (${e.message}): the budget uses the widest tier, and no security warnings apply`,
      null,
    );
  }
}

// The ids a reference may name. A reference to an unknown region or concept is an error where it is written.
function idChecks(map, err) {
  const conceptIds = new Set(map.concepts.map((c) => c.id));
  const regionIds = new Set(map.regions.map((r) => r.id));
  return {
    conceptIds,
    regionIds,
    laneIds: new Set(map.runtime.lanes.map((l) => l.id)),
    needRegion: (id, where) => {
      if (!regionIds.has(id)) err(`${where}: unknown region "${id}"`);
    },
    needConcept: (id, where) => {
      if (!conceptIds.has(id)) err(`${where}: unknown concept "${id}"`);
    },
  };
}

// The ids a `[[id|text]]` mention names in a sentence.
const markedIds = (text) =>
  new Set([...(text ?? '').matchAll(/\[\[([a-z][a-z0-9-]*)\|[^\]]+\]\]/g)].map((x) => x[1]));

// Core sentence: links every concept in one line, so each must be marked [[id|text]] and the claim cited. The
// relations and the region sentence link the same way.
function checkSentences(ctx) {
  const { map, err, conceptIds, regionIds, needConcept, needRegion } = ctx;
  const marked = markedIds(map.coreSentence?.text);
  if (!map.coreSentence?.text) err('missing coreSentence');
  else {
    for (const id of marked) needConcept(id, 'coreSentence');
    for (const id of conceptIds)
      if (!marked.has(id)) err(`coreSentence: concept "${id}" not mentioned as [[${id}|…]]`);
    if (!map.coreSentence.cites?.length) err('coreSentence: no citation (R7)');
  }
  for (const c of map.concepts)
    for (const r of c.relations ?? []) {
      needConcept(r.to, `concept ${c.id} relation`);
      if (!r.cites?.length) err(`concept ${c.id} → ${r.to}: relation has no citation (R7)`);
    }
  const inSentence = markedIds(map.regionSentence?.text);
  if (!map.regionSentence?.text) err('missing regionSentence');
  else {
    for (const id of inSentence) needRegion(id, 'regionSentence');
    for (const id of regionIds)
      if (!inSentence.has(id)) err(`regionSentence: region "${id}" not mentioned as [[${id}|…]]`);
  }
}

// Regions, request steps and background jobs name real regions, lanes and concepts, and each job is cited.
function checkRefs(ctx) {
  const { map, err, root, laneIds, needConcept, needRegion } = ctx;
  for (const r of map.regions) {
    for (const p of r.paths ?? []) if (!fs.existsSync(path.join(root, p))) err(`region ${r.id}: path not found "${p}"`);
    if (r.activity && !(r.activity.commits >= 0 && r.activity.commits <= r.activity.of))
      err(`region ${r.id}: activity ${r.activity.commits} of ${r.activity.of} is impossible`);
    for (const o of r.owns ?? []) needConcept(o, `region ${r.id} owns`);
  }
  map.runtime.steps.forEach((s, i) => {
    needRegion(s.region, `request step ${i + 1}`);
    for (const lane of [s.from, s.to]) if (!laneIds.has(lane)) err(`request step ${i + 1}: unknown lane "${lane}"`);
  });
  const bg = map.background?.items ?? [];
  if (!bg.length && !map.background?.intro) err('background: no items and no intro saying nothing runs on its own');
  bg.forEach((b) => {
    needRegion(b.region, `background "${b.name}"`);
    if (!b.cites?.length) err(`background "${b.name}": no citation (R7)`);
  });
}

// State & source of truth (3.4): one owner row per core concept, writers named by region.
function checkState(ctx) {
  const { map, err, conceptIds, needConcept, needRegion } = ctx;
  const owners = map.state.owners ?? [];
  for (const o of owners) {
    needConcept(o.concept, 'state owner');
    needRegion(o.writer, `state owner ${o.concept}`);
    (o.others ?? []).forEach((w) => needRegion(w.region, `state owner ${o.concept} other writer`));
  }
  for (const id of conceptIds)
    if (owners.filter((o) => o.concept === id).length !== 1) err(`state: concept "${id}" needs exactly one owner row`);
}

// Activity badges are computed (fillActivity): every region at 0 commits points at the paths, not at the code.
function checkActivityAndActors({ map, warn }) {
  const act = map.regions.filter((r) => r.activity);
  if (act.length > 1 && act.every((r) => r.activity.commits === 0))
    warn("every region has 0 commits: check the regions' paths");
  map.context.actors.forEach((a) => {
    if (!a.importance) warn(`actor ${a.id}: missing "importance" (why it ranks here)`);
  });
}

// R14: each story touches >=2 regions; regions no flow runs through are reported.
function checkStories(ctx) {
  const { map, err, warn, needRegion, regionIds } = ctx;
  const covered = new Set();
  for (const st of map.stories) {
    const touched = new Set(st.steps.map((s) => s.region));
    st.steps.forEach((s) => needRegion(s.region, `story ${st.id}`));
    // A caution is a rare exception on the step it belongs to (rule 3.9), never a running commentary.
    const careful = st.steps.filter((s) => s.careful?.trim());
    if (careful.length > 2) warn(`story ${st.id}: ${careful.length} "careful" cautions (at most 2)`);
    if (touched.size < 2) err(`story ${st.id}: touches ${touched.size} region(s), needs >= 2`);
    touched.forEach((r) => covered.add(r));
  }
  for (const r of regionIds) if (!covered.has(r)) warn(`region ${r}: no story runs through it`);
}

// Rules and stories say why they rank here. An absolute rule should say when it holds (P10a), but that check is a
// warning: an instruction ("never read the tenant from the request") is not a claim that something never happens, and
// rejecting it as an error would punish a correct, verified rule for its grammar.
function checkRules({ map, err, warn }) {
  for (const [what, list] of [
    ['rule', map.rules],
    ['story', map.stories],
  ])
    list.forEach((x, i) => {
      if (!x.importance) err(`${what} ${i + 1}: missing "importance" (why it ranks here)`);
    });
  const ABSOLUTE =
    /\b(never|always|all requests|every request|no authentication|requires? authentication|guaranteed|impossible)\b/i;
  map.rules.forEach((r, i) => {
    if (ABSOLUTE.test(`${r.title ?? ''} ${r.text ?? ''}`) && !String(r.condition ?? '').trim())
      warn(
        `rule ${i + 1}: absolute wording without a "condition" ` +
          '(state when it holds, or say why it is unconditional)',
      );
  });
}

// The security section states knowledge, and every claim in it cites code (S4). A rule that cites code under an
// anonymous-write warning is describing missing code, not the system's conventions: it is warned, and points at
// findings.md.
function checkSecurity({ map, err, warn, facts }) {
  if (map.security) {
    const need = (what, cites) => {
      if (!cites || !cites.length) err(`security: ${what} has no citation`);
    };
    need('intro', map.security.cites);
    for (const p of map.security.prefixes ?? []) need(`prefix ${p.prefix}`, p.cites);
    for (const u of map.security.userSources ?? []) need(`user source ${u.kind}`, u.cites);
    if (map.security.tenant) need('tenant', map.security.tenant.cites);
  }
  if (facts) {
    const warned = new Set(
      (facts.securityWarnings ?? []).map((w) => String(w.evidence?.[0] ?? '').replace(/:.*$/, '')),
    );
    map.rules.forEach((r, i) => {
      const files = (r.cites ?? []).map((c) => String(typeof c === 'string' ? c : c.path ?? '').replace(/[:#].*$/, ''));
      if (files.some((f) => warned.has(f)))
        warn(
          `rule ${i + 1}: cites code covered by an anonymous-write warning; state the condition neutrally ` +
            'and put the gap in findings.md',
        );
    });
  }
}

// Change stories are not part of the map, and inferred steps are reported, never hidden.
function checkStoryKinds({ map, err, warn }) {
  if (map.stories.some((s) => s.kind === 'change'))
    err('change stories are not part of the map; stories are ranked main flows');
  const inferred = map.stories.flatMap((s) => s.steps.filter((x) => x.inferred).map(() => s.id));
  if (inferred.length) warn(`${inferred.length} story step(s) marked inferred: ${[...new Set(inferred)].join(', ')}`);
}

// Every citation in the map resolves (checkCite). Returns the citations, which the budget counts.
function checkCites({ map, root, declared, cache, err }) {
  const cites = citesOf(map);
  for (const { cite, where } of cites) {
    const why = checkCite(cite, root, declared, cache);
    if (why) err(`${where}: ${why}`);
  }
  return cites;
}

// Every request step and story step is cited (R7).
function checkSteps({ map, err }) {
  const groups = [['request path', map.runtime.steps], ...map.stories.map((s) => [`story ${s.id}`, s.steps])];
  for (const [where, list] of groups)
    list.forEach((s, i) => {
      if (!s.cites?.length) err(`${where} step ${i + 1}: no citation (R7)`);
    });
}

// Words budget (P8): the core map (everything except stories) against its tier, and each section against its share.
function checkBudget({ map, facts, warn }, citeCount) {
  const counts = sectionWords(map);
  const coreWords = Object.values(counts).reduce((n, x) => n + x, 0);
  const budget = budgetFor(facts?.endpoints?.length ?? null);
  budgetWarnings(counts, budget).forEach(warn);
  const citeNeeded = citeTarget(map);
  if (citeCount > Math.round(citeNeeded * 1.4))
    warn(`citations: ${citeCount} > 1.4x the ~${citeNeeded} a block-cited map needs (P3: one or two per block)`);
  return { counts, coreWords, budget, citeNeeded };
}

/**
 * The checks validate() runs on a map that has passed the schema, in the order their messages are reported.
 * `declared` is the dump's declarations: undefined reads the dump beside the map, null means none. `facts` is the
 * parsed facts.json: undefined reads it from the map's project, null means none.
 */
export function validate(map, root, declared, facts) {
  const mark = degradedMark();
  if (declared === undefined) declared = declaredFromDump(root);
  if (facts === undefined) facts = readFacts(path.join(root, 'mindmodel', '.work', 'facts.json'));
  const result = checkMap(map, root, declared, facts);
  // What this run gave up on, then what the scan gave up on (facts.runtime.degraded): both reach the user as warnings.
  const fromScan = (facts?.runtime?.degraded ?? []).map((r) => `scan degraded: ${r}`);
  result.warnings.push(...degradedSince(mark).map((r) => `degraded: ${r}`), ...fromScan);
  return result;
}

// The checks behind validate(), with `declared` and `facts` already resolved.
function checkMap(map, root, declared, facts) {
  const errors = [],
    warnings = [];
  const err = (m) => errors.push(m),
    warn = (m) => warnings.push(m);
  const cache = new Map();
  resolveCites(map, root, declared, cache);
  fillActivity(map, root);
  // The schema holds the required fields and every budget ceiling and floor; the checks below are what it cannot say.
  checkSchema(map, SCHEMA, SCHEMA.$defs ?? {}, '$', err);
  if (errors.length) return { errors, warnings };

  const ctx = { map, root, err, warn, facts, declared, cache, ...idChecks(map, err) };
  checkSentences(ctx);
  checkRefs(ctx);
  checkState(ctx);
  checkActivityAndActors(ctx);
  checkStories(ctx);
  checkRules(ctx);
  checkSecurity(ctx);
  checkStoryKinds(ctx);
  const cites = checkCites(ctx);
  checkSteps(ctx);
  const sized = checkBudget(ctx, cites.length);

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
      citeTarget: sized.citeNeeded,
      tier: sized.budget.tier,
      coreWords: sized.coreWords,
      budget: sized.budget.core,
      sections: sized.counts,
      targets: sized.budget.sections,
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
        `${k} ${n}/${stats.targets[k]}${n > stats.targets[k] ? '!' : isThin(k, n, stats.targets[k]) ? '_' : ''}`,
    );
    console.log(
      `budget: tier ${stats.tier} — core ${stats.coreWords}/${stats.budget} words · citations ${stats.citations}` +
        ` (target ~${stats.citeTarget}) · stories ${stats.storyWords} words`,
    );
    console.log(`sections: ${parts.join(' · ')}`);
  }
  process.exit(errors.length ? 1 : 0);
}
