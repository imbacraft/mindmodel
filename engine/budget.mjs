// The one owner of writer budgets: how big a map may be (per endpoint tier and per section), what the digest announces
// about that, and the core-service cap of a system map. validate.mjs and digest/facts-md.mjs read these numbers from
// here. rules/core.md (Part 7) and rules/system-rules.md (Part 4) quote them, and test/rules-budget.test.mjs checks
// that the quotes agree. Item counts that a JSON schema already holds are read from the schema, not restated here.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SYSTEM_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../schema/system.schema.json'), 'utf8'),
);

// P8 size tiers: the core ceiling scales with the app, because a 40-endpoint tool and a 900-endpoint platform cannot
// say the same thing in the same number of words.
export const TIERS = [
  { tier: 1, maxEndpoints: 50, core: 2200 },
  { tier: 2, maxEndpoints: 150, core: 2800 },
  { tier: 3, maxEndpoints: 400, core: 3600 },
  { tier: 4, maxEndpoints: Infinity, core: 4200 },
];

// A section's share of the tier's core ceiling.
export const SECTION_SHARES = {
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

// Flat caps, whatever the tier: that is where overflow lives. A share is clamped onto its cap.
export const CAPS = { regions: 1000, state: 400 };

// Below this fraction of its share a section is thin: the writer answers the section's question before cutting.
export const UNDER_SHARE = 0.6;

// The most services a system map may rank as core. The schema holds the number (services.maxContains).
export const CORE_SERVICE_CAP = SYSTEM_SCHEMA.properties.services.maxContains;

// facts.md over this many characters makes the digest warn the writer to read it selectively.
export const DIGEST_WARN_CHARS = 70_000;

// The budget for an app with this many endpoints. Null means the count is unknown: the widest tier applies, so a
// missing facts file never makes a legal map look over budget.
export function budgetFor(endpoints) {
  const t = TIERS.find((x) => (endpoints ?? Infinity) <= x.maxEndpoints);
  const sections = {};
  for (const [name, share] of Object.entries(SECTION_SHARES))
    sections[name] = Math.min(Math.round(t.core * share), CAPS[name] ?? Infinity);
  return { tier: t.tier, endpoints, core: t.core, sections, caps: CAPS };
}

// A section is thin when it sits under its share's floor. `intros` is exempt (version and project strings).
export const isThin = (name, n, target) => name !== 'intros' && n < target * UNDER_SHARE;

// One warning per section over its share, plus the total: the writer fixes a section, never the whole map.
export function budgetWarnings(counts, budget) {
  const out = [];
  for (const [name, n] of Object.entries(counts)) {
    const target = budget.sections[name];
    if (n <= target) continue;
    const cap = CAPS[name];
    const over = cap && n > cap ? ` (over the hard cap ${cap})` : '';
    out.push(`${name}: ~${n} words > tier ${budget.tier} target ${target}${over}`);
  }
  for (const [name, n] of Object.entries(counts)) {
    const target = budget.sections[name];
    if (isThin(name, n, target))
      out.push(`${name}: ~${n} words < ${Math.round(target * UNDER_SHARE)} (60% of the tier ${budget.tier} ` +
        `share ${target}): thin, answer the section's question before cutting`);
  }
  const total = Object.values(counts).reduce((n, x) => n + x, 0);
  if (total > budget.core)
    out.push(
      `core map ~${total} words > tier ${budget.tier} budget ${budget.core}` +
        `${budget.endpoints == null ? ' (no facts.json: endpoint count unknown)' : ` (${budget.endpoints} endpoints)`}`,
    );
  return out;
}

// The digest's second line: the tier and its targets, so the writer drafts to numbers instead of meeting them at
// validation. The validator prints the same numbers from the same function.
export function budgetLine(endpoints) {
  const b = budgetFor(endpoints);
  const thousands = (n) => n.toLocaleString('en-US');
  const sections = Object.entries(b.sections)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
  return (
    `**budget: tier ${b.tier} — core ≤ ${thousands(b.core)} words, regions ≤ ${thousands(CAPS.regions)}, ` +
    `state ≤ ${CAPS.state}**; sections ${sections}`
  );
}

// --- Self-checks, run on import --------------------------------------------------------------------------------------

{
  const cores = TIERS.map((t) => t.core);
  assert.deepStrictEqual(cores, [...cores].sort((a, b) => a - b), 'tier ceilings must not shrink as apps grow');
  for (const name of Object.keys(CAPS)) assert.ok(name in SECTION_SHARES, `cap "${name}" names no section`);
  assert.equal(budgetFor(0).tier, 1);
  assert.equal(budgetFor(null).tier, TIERS.length, 'an unknown endpoint count uses the widest tier');
  assert.ok(Number.isInteger(CORE_SERVICE_CAP) && CORE_SERVICE_CAP > 0, 'the system schema holds the core-service cap');
}

{
  const b = budgetFor(300);
  assert.deepStrictEqual(budgetWarnings(b.sections, b), [], 'a map at its targets warns about nothing');
  assert.match(budgetLine(300), /^\*\*budget: tier 3 — core ≤ 3,600 words, regions ≤ 1,000, state ≤ 400\*\*/);
  assert.ok(isThin('state', 1, 400) && !isThin('intros', 0, 100), 'intros is exempt from the thin floor');
}
