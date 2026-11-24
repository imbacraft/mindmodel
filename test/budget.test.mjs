// The schema, the validator, the rules and the digest must agree about how big a map may be. They drifted once:
// concepts allowed 6 while state.owners still capped at 5, so a legal map with six concepts could not validate.
// The size tiers are the second such drift risk: four documents carry the same table, so the table is parsed here
// and compared with the code that enforces it.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { CAPS, budgetFor, budgetWarnings, citeTarget, sectionWords, wordCount } from '../engine/validate.mjs';
import { budgetLine } from '../engine/scan.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', 'mindmodel.schema.json'), 'utf8'));
const validateSource = fs.readFileSync(path.join(REPO, 'engine', 'validate.mjs'), 'utf8');
const rules = fs.readFileSync(path.join(REPO, 'rules', 'generation-rules.md'), 'utf8');

const budget = (name) => +new RegExp(`${name}: (\\d+)`).exec(validateSource)?.[1];
// The tier boundaries, in one place: 50/150/400 endpoints and the four ceilings.
const TIER_ENDPOINTS = [50, 150, 400, 401];

test('state.owners admits one row per concept the schema and validator allow', () => {
  const concepts = schema.properties.concepts.maxItems;
  const owners = schema.properties.state.properties.owners.maxItems;
  assert.ok(owners >= concepts, `owners cap ${owners} must be at least the concept cap ${concepts}`);
});

test('the schema concept cap and the validator budget are the same number', () => {
  assert.equal(schema.properties.concepts.maxItems, budget('concepts'), 'schema and BUDGET disagree on concepts');
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

test('P8 states the tiers the code enforces', () => {
  const m = /≤ 50 → ([\d,]+) words · ≤ 150 → ([\d,]+) · ≤ 400 → ([\d,]+) · > 400 → ([\d,]+)/.exec(rules);
  assert.ok(m, 'P8 must state the four tiers in the validator’s form');
  assert.deepStrictEqual(m.slice(1).map((x) => +x.replace(/,/g, '')), [2200, 2800, 3600, 4200]);
});

test('the digest prints the tier, the core ceiling and both flat caps', () => {
  const line = budgetLine(296); // dragonsoftworks
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
  // 338 cites on the old dragonsoftworks map was line-by-line: this shape needs ~109, so the warning fires.
  assert.ok(338 > Math.round(citeTarget(map) * 1.4));
});
