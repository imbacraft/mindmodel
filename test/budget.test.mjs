// The schema, the validator, the rules and the digest must agree about how big a map may be. They drifted once:
// concepts allowed 6 while state.owners still capped at 5, so a legal map with six concepts could not validate.
// The size tiers are the second such drift risk: four documents carry the same table, so the table is parsed here
// and compared with the code that enforces it.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPS, budgetFor, budgetWarnings, citeTarget, sectionWords, wordCount } from '../engine/validate.mjs';
import { budgetLine } from '../engine/scan.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', 'mindmodel.schema.json'), 'utf8'));
const rules = fs.readFileSync(path.join(REPO, 'rules', 'core.md'), 'utf8');

// The tier boundaries, in one place: 50/150/400 endpoints and the four ceilings.
const TIER_ENDPOINTS = [50, 150, 400, 401];

test('state.owners admits one row per concept the schema and validator allow', () => {
  const concepts = schema.properties.concepts.maxItems;
  const owners = schema.properties.state.properties.owners.maxItems;
  assert.ok(owners >= concepts, `owners cap ${owners} must be at least the concept cap ${concepts}`);
});

test('tiers: the ceiling scales at 50, 150 and 400 endpoints', () => {
  assert.deepStrictEqual(
    [0, 1, 50, 51, 150, 151, 400, 401, 9000].map((n) => budgetFor(n).tier),
    [1, 1, 1, 2, 2, 3, 3, 4, 4],
  );
  assert.deepStrictEqual([1, 2, 3, 4].map((t) => budgetFor(TIER_ENDPOINTS[t - 1]).core), [2200, 2800, 3600, 4200]);
  // No endpoint count (no facts.json) must not make a legal map look illegal: the widest tier applies.
  assert.equal(budgetFor(null).tier, 4);
});

test('flat caps: regions never above 1,000 words, state never above 400, at any tier', () => {
  for (const n of TIER_ENDPOINTS) {
    const b = budgetFor(n);
    assert.ok(b.sections.regions <= CAPS.regions, `tier ${b.tier} regions target ${b.sections.regions}`);
    assert.ok(b.sections.state <= CAPS.state, `tier ${b.tier} state target ${b.sections.state}`);
  }
  assert.equal(CAPS.regions, 1000);
  assert.equal(CAPS.state, 400);
});

test('a section far under its share is reported as thin, not left alone', () => {
  const b = budgetFor(300);
  const counts = Object.fromEntries(Object.keys(b.sections).map((k) => [k, b.sections[k]]));
  assert.deepStrictEqual(budgetWarnings(counts, b), [], 'a map at every share has nothing to report');
  const thin = { ...counts, state: Math.floor(b.sections.state * 0.4), intros: 1 };
  const warned = budgetWarnings(thin, b);
  assert.equal(warned.length, 1, 'only state is thin: intros is exempt, and the total is still under');
  assert.match(warned[0], /^state: ~\d+ words < \d+ .*thin/);
});

test('each tier’s section shares stay under the tier ceiling', () => {
  for (const n of TIER_ENDPOINTS) {
    const b = budgetFor(n);
    const sum = Object.values(b.sections).reduce((x, y) => x + y, 0);
    assert.ok(sum <= b.core, `tier ${b.tier}: sections sum ${sum} > core ${b.core}`);
  }
});

// The table in Part 7 is what the writer drafts to; the code is what the validator enforces. Parse one, compare.
function part7Table() {
  const part7 = rules.slice(rules.indexOf('## Part 7.'));
  const rows = part7
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Section') && !l.startsWith('|---'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const table = part7.slice(part7.indexOf('| Section'));
  assert.ok(table, 'Part 7 has no per-tier section table');
  return rows.filter((r) => r.length === 6);
}

test('the rules’ tier table and the validator agree, cell by cell', () => {
  const rows = part7Table();
  assert.equal(rows.length, 11, 'the Part 7 table holds core plus ten sections');
  for (const [name, ...cells] of rows) {
    const capCell = cells.pop();
    const b = TIER_ENDPOINTS.map((n) => budgetFor(n));
    const got = name === 'core' ? b.map((x) => x.core) : b.map((x) => x.sections[name]);
    const want = cells.map((c) => +c.replace(/,/g, ''));
    assert.deepStrictEqual(got, want, `Part 7 row "${name}" disagrees with budgetFor`);
    const cap = capCell === '—' ? undefined : +capCell.replace(/,/g, '');
    assert.equal(cap, CAPS[name], `Part 7 hard cap for "${name}" disagrees with CAPS`);
  }
});

test('P8 points at Part 7, which states the tiers the code enforces — once', () => {
  // The numbers live in the Part 7 table alone: P8 names the tiers and points there, so the two cannot drift apart.
  const p8 = /\*\*P8\.[^\n]*/.exec(rules)?.[0];
  assert.ok(p8, 'the rules must carry P8');
  assert.match(p8, /Part 7/, 'P8 must point at Part 7 for the numbers');
  assert.doesNotMatch(p8, /2,?200/, 'P8 must not restate the ceilings: Part 7 holds them');
  // The endpoint bands, from the one table that states them.
  const bands = /\| Section \| Tier 1 \(≤ (\d+) endpoints\) \| Tier 2 \(≤ (\d+)\) \| Tier 3 \(≤ (\d+)\) \| Tier 4 \(> (\d+)\) \|/
    .exec(rules);
  assert.ok(bands, 'the Part 7 table must state the endpoint bands');
  assert.deepStrictEqual(bands.slice(1).map(Number), [50, 150, 400, 400]);
  const coreRow = part7Table().find((r) => r[0] === 'core');
  assert.deepStrictEqual(coreRow.slice(1, 5).map((c) => +c), [2200, 2800, 3600, 4200]);
});

test('the always-read core keeps its own budget: ≤ 180 lines and ≤ 5,000 tokens', () => {
  // The split exists because this file is read on every writer call: growing it again is a cost regression.
  const lines = rules.split('\n').length - (rules.endsWith('\n') ? 1 : 0);
  assert.ok(lines <= 180, `rules/core.md is ${lines} lines: the always-read file must stay ≤ 180`);
  assert.ok(rules.length / 4 <= 5000, `rules/core.md is ~${Math.round(rules.length / 4)} tokens: must stay ≤ 5,000`);
  assert.ok(fs.existsSync(path.join(REPO, 'rules', 'sections.md')), 'the on-demand section rules must exist');
});

test('the digest prints the tier, the core ceiling and both flat caps', () => {
  const line = budgetLine(296); // a 296-word core, from a large scanned app
  assert.match(line, /budget: tier 3 — core ≤ 3,600 words, regions ≤ 1,000, state ≤ 400/);
  assert.match(line, /sections purpose 144 · .* state 400 /);
  assert.match(budgetLine(12), /tier 1 — core ≤ 2,200 words/);
});

test('sectionWords measures each section on its own, and the total is the core', () => {
  const map = {
    version: '0.6',
    project: { name: 'demo' },
    purpose: { text: 'one two three' },
    context: { actors: [{ id: 'a', name: 'A', text: 'four five' }], externals: [] },
    concepts: [],
    regions: [],
    state: { owners: [] },
    runtime: { lanes: [], steps: [] },
    background: { items: [] },
    rules: [],
    stories: [{ id: 'story', steps: [] }],
  };
  const counts = sectionWords(map);
  assert.equal(counts.purpose, 3);
  assert.equal(counts.context, 2);
  assert.equal(counts.intros, 1);
  assert.equal(wordCount(map.stories), 1, 'stories sit outside the core');
  assert.equal(
    Object.values(counts).reduce((a, b) => a + b, 0),
    wordCount({ ...map, stories: undefined }),
    'the sections must add up to the core map',
  );
});

test('budgetWarnings names the section that overflowed, and the total once', () => {
  const b = budgetFor(296);
  const counts = { ...b.sections, regions: 1172, state: 500 };
  const w = budgetWarnings(counts, b);
  assert.ok(w.some((x) => /^regions: ~1172 words > tier 3 target 648/.test(x)), w.join('\n'));
  assert.ok(w.some((x) => /state: ~500 words > tier 3 target 400 \(over the hard cap 400\)/.test(x)), w.join('\n'));
  assert.equal(w.filter((x) => x.startsWith('core map')).length, 1);
  assert.deepStrictEqual(budgetWarnings(b.sections, b), [], 'a map at its targets warns about nothing');
});

test('citeTarget counts blocks, not sentences: 2 per rule, 4 per region, 2 per concept, 1 per step', () => {
  const map = {
    rules: new Array(5).fill({}),
    regions: new Array(7).fill({}),
    concepts: new Array(6).fill({}),
    runtime: { steps: new Array(7).fill({}) },
    stories: [{ steps: new Array(10).fill({}) }, { steps: new Array(10).fill({}) }, { steps: new Array(10).fill({}) }],
    background: { items: new Array(10).fill({}) },
    state: { owners: new Array(6).fill({}) },
  };
  assert.equal(citeTarget(map), 2 * 5 + 4 * 7 + 2 * 6 + 37 + 10 + 6 + 6);
  // 338 cites on a large app's map was line-by-line: this shape needs ~109, so the warning fires.
  assert.ok(338 > Math.round(citeTarget(map) * 1.4));
});
