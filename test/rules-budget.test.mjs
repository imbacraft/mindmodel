// The budget rows in the rules quote the JSON schemas, so a number changed in one place must change in the other.
// Each row maps its numbers, in order, to the schema field (or validator word cap) it quotes. A null entry is a count
// of sentences, steps or words that no schema enforces: it is read, not checked.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPS, TIERS, budgetFor } from '../engine/budget.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const readSchema = (name) => JSON.parse(readText('schema', name));
const MINDMODEL = readSchema('mindmodel.schema.json');
const SYSTEM = readSchema('system.schema.json');
const rules = readText('rules', 'core.md');

// rules/core.md, Part 7, first table. "cap:" names a word cap enforced by engine/validate.mjs.
const CORE_ROWS = {
  'Overview': [null, null, 'purpose.boot.entries.maxItems', 'purpose.boot.run.maxItems'],
  'People & outside systems': ['context.actors.maxItems', 'context.externals.maxItems'],
  'Core concepts': ['concepts.maxItems', null],
  'Regions': ['regions.maxItems', null, 'regions.items.parts.maxItems'],
  'State & source of truth': [null, 'cap:state'],
  'How a request travels': ['runtime.steps.maxItems', 'runtime.lanes.maxItems'],
  'What runs on its own': ['background.items.maxItems'],
  'Rules': ['rules.maxItems'],
  'Stories': ['stories.minItems', 'stories.maxItems', 'stories.items.steps.maxItems', null, null],
  'Diagrams': [null],
  'Words, core map (everything except stories)': [],
  'Words, regions and state': ['cap:regions', 'cap:state'],
};

// rules/system-rules.md, Part 4.
const SYSTEM_ROWS = {
  'Domains': ['domains.maxItems', null],
  'Core service cards': ['services.maxContains'],
  'Owner rows': [null, 'ownership.maxItems'],
  'Key contracts': ['contracts.maxItems'],
  'Flows': ['flows.minItems', 'flows.maxItems', 'flows.items.hops.maxItems'],
  'Failure rows': ['failures.maxItems'],
  'Rules': ['rules.maxItems'],
  'Diagrams': [],
  'Words, whole page except flows': [null],
};

// A dotted path into a JSON schema. `items` steps into an array's items; other names read `properties`, and the
// keywords (`maxItems`, `minItems`) are read from the node itself.
function schemaValue(schema, dotted) {
  let node = schema;
  for (const seg of dotted.split('.')) {
    if (node.type === 'array' && seg === 'items') node = node.items;
    else if (node.properties && seg in node.properties) node = node.properties[seg];
    else node = node[seg];
  }
  assert.equal(typeof node, 'number', `schema path ${dotted} is not a number`);
  return node;
}

function expected(ref, schema) {
  if (!ref.startsWith('cap:')) return schemaValue(schema, ref);
  assert.ok(ref.slice(4) in CAPS, `validator has no cap ${ref}`);
  return CAPS[ref.slice(4)];
}

// The two-column rows "| Name | budget |" between `from` and `until`. The header and separator lines are skipped.
function budgetRows(md, from, until) {
  const start = md.indexOf(from);
  assert.ok(start >= 0, `missing heading "${from}"`);
  const stop = until ? md.indexOf(until, start) : -1;
  return md
    .slice(start, stop === -1 ? md.length : stop)
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Element'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 2);
}

// "1,000" is one number; "250–500" is two.
const numbers = (text) => (text.match(/\d[\d,]*/g) ?? []).map((n) => Number(n.replace(/,/g, '')));

function checkRows(rows, mapping, schema, label) {
  assert.ok(rows.length > 0, `${label}: no budget rows found`);
  assert.deepStrictEqual(
    rows.map(([name]) => name).sort(),
    Object.keys(mapping).sort(),
    `${label}: every budget row must be mapped to its schema fields`,
  );
  for (const [name, budget] of rows) {
    const got = numbers(budget);
    const refs = mapping[name];
    assert.equal(got.length, refs.length, `${label} "${name}": ${got.length} numbers in "${budget}", ${refs.length} mapped`);
    refs.forEach((ref, i) => {
      if (ref === null) return;
      assert.equal(got[i], expected(ref, schema), `${label} "${name}": "${budget}" disagrees with ${ref}`);
    });
  }
}

test('rules/core.md budget rows quote the mindmodel schema and the validator word caps', () => {
  const rows = budgetRows(readText('rules', 'core.md'), '## Part 7.', '| Section');
  checkRows(rows, CORE_ROWS, MINDMODEL, 'core.md');
});

test('rules/system-rules.md budget rows quote the system schema', () => {
  const rows = budgetRows(readText('rules', 'system-rules.md'), '## Part 4.');
  checkRows(rows, SYSTEM_ROWS, SYSTEM, 'system-rules.md');
});

// Part 7's per-tier table: "| name | tier 1 | tier 2 | tier 3 | tier 4 | hard cap |", core first, then the sections.
function part7Table() {
  const part7 = rules.slice(rules.indexOf('## Part 7.'));
  return part7
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Section') && !l.startsWith('|---'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length === 6);
}

// One endpoint count per tier: each tier's upper bound, and the widest tier's probe.
const PROBES = [...TIERS.slice(0, -1).map((t) => t.maxEndpoints), Infinity];

test('the rules’ tier table and the validator agree, cell by cell', () => {
  const rows = part7Table();
  assert.equal(rows.length, 11, 'the Part 7 table holds core plus ten sections');
  for (const [name, ...cells] of rows) {
    const capCell = cells.pop();
    const b = PROBES.map((n) => budgetFor(n));
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
  // The endpoint bands, from the one table that states them: tier 4 starts where tier 3 ends.
  const bands = /Tier 1 \(≤ (\d+) endpoints\).*Tier 2 \(≤ (\d+)\).*Tier 3 \(≤ (\d+)\).*Tier 4 \(> (\d+)\)/.exec(rules);
  assert.ok(bands, 'the Part 7 table must state the endpoint bands');
  const bounds = TIERS.slice(0, -1).map((t) => t.maxEndpoints);
  assert.deepStrictEqual(bands.slice(1).map(Number), [...bounds, bounds[bounds.length - 1]]);
  const coreRow = part7Table().find((r) => r[0] === 'core');
  assert.deepStrictEqual(coreRow.slice(1, 5).map((c) => +c), TIERS.map((t) => t.core));
});
