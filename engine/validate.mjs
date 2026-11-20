#!/usr/bin/env node
// Validates a mindmodel.json against the PRD rules: shape, budgets (§7), id references, and that every citation resolves (R7, R8).
// Usage: node validate.mjs <mindmodel.json> [projectRoot]   (projectRoot defaults to the parent of the mindmodel/ folder)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

export function parseCite(c) {
  const m = /^([^:#]+?)(?::(\d+)(?:-(\d+))?)?(?:#(\S+))?$/.exec(c);
  if (!m) return null;
  return { file: m[1], start: m[2] ? +m[2] : null, end: m[3] ? +m[3] : (m[2] ? +m[2] : null), symbol: m[4] ?? null };
}
assert.deepStrictEqual(parseCite('a/b.java:10-12'), { file: 'a/b.java', start: 10, end: 12, symbol: null });
assert.deepStrictEqual(parseCite('CLAUDE.md'), { file: 'CLAUDE.md', start: null, end: null, symbol: null });
assert.deepStrictEqual(parseCite('a/B.java:5#save'), { file: 'a/B.java', start: 5, end: 5, symbol: 'save' });

const BUDGET = { actors: 7, externals: 7, concepts: 5, regions: [4, 7], lanes: [2, 5], flowSteps: 7, rules: 5, stories: [1, 5], storySteps: 10, landmarks: 3, parts: 7, coreWords: 3000, copies: 5, seams: 4, switches: 4, runSteps: 3 };

export function validate(map, root) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  for (const k of ['purpose', 'context', 'coreSentence', 'concepts', 'state', 'regionSentence', 'regions', 'runtime', 'background', 'rules', 'stories']) if (!map[k]) err(`missing top-level "${k}"`);
  if (errors.length) return { errors, warnings };

  const max = (arr, n, what) => { if ((arr?.length ?? 0) > n) err(`${what}: ${arr.length} > budget ${n}`); };
  const range = (arr, [lo, hi], what) => { const n = arr?.length ?? 0; if (n < lo || n > hi) err(`${what}: ${n} outside budget ${lo}-${hi}`); };
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
  const needRegion = (id, where) => { if (!regionIds.has(id)) err(`${where}: unknown region "${id}"`); };
  const needConcept = (id, where) => { if (!conceptIds.has(id)) err(`${where}: unknown concept "${id}"`); };

  // Core sentence: links every concept in one line, so each must be marked [[id|text]] and the claim cited.
  const marked = new Set([...(map.coreSentence?.text ?? '').matchAll(/\[\[([a-z][a-z0-9-]*)\|[^\]]+\]\]/g)].map((x) => x[1]));
  if (!map.coreSentence?.text) err('missing coreSentence');
  else {
    for (const id of marked) needConcept(id, 'coreSentence');
    for (const id of conceptIds) if (!marked.has(id)) err(`coreSentence: concept "${id}" not mentioned as [[${id}|…]]`);
    if (!map.coreSentence.cites?.length) err('coreSentence: no citation (R7)');
  }
  for (const c of map.concepts) for (const r of c.relations ?? []) {
    needConcept(r.to, `concept ${c.id} relation`);
    if (!r.cites?.length) err(`concept ${c.id} → ${r.to}: relation has no citation (R7)`);
  }

  const inSentence = new Set([...(map.regionSentence?.text ?? '').matchAll(/\[\[([a-z][a-z0-9-]*)\|[^\]]+\]\]/g)].map((x) => x[1]));
  if (!map.regionSentence?.text) err('missing regionSentence');
  else {
    for (const id of inSentence) needRegion(id, 'regionSentence');
    for (const id of regionIds) if (!inSentence.has(id)) err(`regionSentence: region "${id}" not mentioned as [[${id}|…]]`);
  }
  for (const r of map.regions) {
    if (r.activity && !(r.activity.commits >= 0 && r.activity.commits <= r.activity.of)) err(`region ${r.id}: activity ${r.activity.commits} of ${r.activity.of} is impossible`);
    for (const o of r.owns ?? []) needConcept(o, `region ${r.id} owns`);
    max(r.landmarks, BUDGET.landmarks, `region ${r.id} landmarks`);
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
  bg.forEach((b) => { needRegion(b.region, `background "${b.name}"`); if (!b.cites?.length) err(`background "${b.name}": no citation (R7)`); });

  // State & source of truth (3.4): one owner row per core concept, writers named by region.
  const owners = map.state.owners ?? [];
  for (const o of owners) { needConcept(o.concept, 'state owner'); needRegion(o.writer, `state owner ${o.concept}`); (o.others ?? []).forEach((w) => needRegion(w.region, `state owner ${o.concept} other writer`)); }
  for (const id of conceptIds) if (owners.filter((o) => o.concept === id).length !== 1) err(`state: concept "${id}" needs exactly one owner row`);
  max(map.state.copies, BUDGET.copies, 'state copies');
  max(map.state.seams, BUDGET.seams, 'state seams');
  max(map.purpose.boot?.switches, BUDGET.switches, 'boot switches');
  max(map.purpose.boot?.run, BUDGET.runSteps, 'boot run steps');

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
  for (const [what, list] of [['rule', map.rules], ['story', map.stories]]) list.forEach((x, i) => { if (!x.importance) err(`${what} ${i + 1}: missing "importance" (why it ranks here)`); });
  if (map.stories.some((s) => s.kind === 'change')) err('change stories are not part of the map; stories are ranked main flows');
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
    if (!pc) { err(`${where}: malformed citation "${c}"`); continue; }
    const abs = path.join(root, pc.file);
    if (!fs.existsSync(abs)) { err(`${where}: path not found "${pc.file}"`); continue; }
    if (pc.start == null) { if (pc.symbol && !fs.statSync(abs).isDirectory() && !fs.readFileSync(abs, 'utf8').includes(pc.symbol)) err(`${where}: "${c}" does not contain "${pc.symbol}"`); continue; }
    if (fs.statSync(abs).isDirectory()) { err(`${where}: line given for directory "${c}"`); continue; }
    if (!lineCount.has(abs)) lineCount.set(abs, fs.readFileSync(abs, 'utf8').split('\n'));
    const fileLines = lineCount.get(abs), n = fileLines.length;
    if (pc.start < 1 || pc.end < pc.start || pc.end > n) { err(`${where}: "${c}" outside file (${n} lines)`); continue; }
    // #symbol: the cited range must contain it, so a citation can't silently point at the wrong lines
    if (pc.symbol && !fileLines.slice(pc.start - 1, pc.end).join('\n').includes(pc.symbol)) err(`${where}: "${c}" does not contain "${pc.symbol}"`);
  }
  for (const [where, list] of [['request path', map.runtime.steps], ...map.stories.map((s) => [`story ${s.id}`, s.steps])])
    list.forEach((s, i) => { if (!s.cites?.length) err(`${where} step ${i + 1}: no citation (R7)`); });

  // Words budget for the core map (everything except stories).
  const words = (o) => JSON.stringify(o).replace(/"[a-zA-Z]+":/g, ' ').split(/\s+/).filter((w) => /[a-zA-Z]{2,}/.test(w) && !w.includes('/')).length;
  const core = { ...map, stories: undefined };
  const coreWords = words(core);
  if (coreWords > BUDGET.coreWords) warn(`core map ~${coreWords} words > budget ${BUDGET.coreWords}`);

  return { errors, warnings, stats: { citations: cites.length, coreWords, storyWords: words(map.stories) } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = path.resolve(process.argv[2] ?? 'mindmodel/mindmodel.json');
  const root = path.resolve(process.argv[3] ?? path.join(path.dirname(file), '..'));
  const { errors, warnings, stats } = validate(JSON.parse(fs.readFileSync(file, 'utf8')), root);
  warnings.forEach((w) => console.log(`warn  ${w}`));
  errors.forEach((e) => console.log(`ERROR ${e}`));
  console.log(`${errors.length ? 'FAILED' : 'OK'}: ${errors.length} error(s), ${warnings.length} warning(s)`, stats ?? '');
  process.exit(errors.length ? 1 : 0);
}
