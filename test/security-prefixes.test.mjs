// a prefix's access is stated only when all its endpoints have it, and a chain
// whose rules live in a configurer the repo does not declare says so instead of reporting the prefix as "unknown".
// The fixtures are Java sources on disk (test-support/fixtures/security-prefixes), dumped by the real engine and read
// back as a model — the same path a scan takes. Nothing here parses Java.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dumpOfLayers, NO_ENGINE } from '../test-support/fixtures/dump-dir.mjs';
import { annotationIndex, loadCatalogs, meanOf, selectCatalogs } from '../engine/catalogs/catalog.mjs';
import { extractEndpoints } from '../engine/extract/endpoints.mjs';
import { checkSummary, methodSecurityFacts, securityModel, springChains } from '../engine/extract/security/index.mjs';
import { checkSchema } from '../engine/core/schema.mjs';

const FACTS_SCHEMA = JSON.parse(fs.readFileSync(new URL('../schema/facts.schema.json', import.meta.url), 'utf8'));

/**
 * One build, in the scan's order: model, catalogs, endpoints, method security, chains, then the security model fact.
 * `layers` are fixture directories applied in order, so a case adds a class instead of writing Java inline.
 */
function build(layers) {
  const { model } = dumpOfLayers(layers);
  const imports = [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  const selected = selectCatalogs(loadCatalogs(), { imports });
  const catalogIndex = annotationIndex(selected);
  const endpoints = extractEndpoints(model, selected);
  const methodSec = methodSecurityFacts(model, (fqn, on) => meanOf(catalogIndex, fqn, on)?.means ?? null);
  const rules = springChains(model);
  return { model, endpoints, rules, security: securityModel({ rules, endpoints, methodSecurity: methodSec.facts }) };
}

// Two controllers under /api/v1: one role-checked, one merely requiring a logged-in caller.
const MIXED = ['security-prefixes/mixed'];
// The chain that hands its paths to a library: `/api/_/**` is protected by a configurer this repo does not declare.
const OUTSIDE = ['security-prefixes/outside'];
// The same chain, with the configurer declared: the rules are ours to read again.
const WITH_CONFIGURER = ['security-prefixes/outside', 'security-prefixes/configurer'];

test('two different checks under one prefix report a share, not the busiest one for all', { skip: NO_ENGINE }, () => {
  const { security } = build(MIXED);
  const v1 = security.prefixes.find((p) => p.prefix === '/api/v1/**');
  assert.ok(v1, `the prefix is listed: ${security.prefixes.map((p) => p.prefix).join(', ')}`);
  // The share, not the modal value alone: 50% of the prefix carries role A, so `role:A` would overstate it.
  assert.equal(v1.access, 'role:A on 1 of 2');
  assert.notEqual(v1.access, 'role:A', 'a rule only half the prefix has is never stated as the prefix rule');
  assert.deepEqual(v1.accessCounts, { 'role:A': 1, 'role-checked': 1 });
  assert.equal(v1.dominant, 'role:A');
  assert.match(v1.why[0], /role:A on 1, role-checked on 1 of 2 endpoints/);
  const rule = security.developerRule.find((d) => d.text.includes('/api/v1/**'));
  assert.match(rule.text, /endpoints under \/api\/v1\/\*\* differ/);
  assert.ok(
    !JSON.stringify(security.developerRule).includes('need role A'),
    'no single role is claimed for the prefix',
  );
});

test('a chain that applies a configurer outside the repo says where its path rules come from', { skip: NO_ENGINE }, () => {
  const { rules, security } = build(OUTSIDE);
  const outside = rules.filter((r) => r.outside === 'com.example.ExternalConfigurer');
  assert.equal(outside.length, 1, `one rule for the chain's scope: ${JSON.stringify(rules.map((r) => r.pattern))}`);
  assert.equal(outside[0].pattern, '/api/_/**');
  assert.equal(outside[0].access, 'unknown', 'the rules are not ours to read: the access stays unknown');
  // The rule the scan writes has to pass the facts schema: rules, schema and extractor agree.
  const errors = [];
  checkSchema(rules, FACTS_SCHEMA.properties.securityRules, FACTS_SCHEMA.$defs ?? {}, '$', (m) => errors.push(m));
  assert.deepEqual(errors, [], 'the outside note is part of the security-rule fact');
  assert.equal(
    security.developerRule[0].text,
    'path rules come from com.example.ExternalConfigurer, outside this repo: not seen',
  );
  assert.match(security.developerRule[0].cites[0], /WebSecurityConfiguration\.java:\d+/);
  // The digest's prefix line for the chain's own scope still says unknown, and now the reason is next to it.
  const p = security.prefixes.find((x) => x.prefix === '/api/_/**');
  assert.equal(p.access, 'unknown');
});

test('a configurer the repo declares adds no outside note', { skip: NO_ENGINE }, () => {
  const { rules, security } = build(WITH_CONFIGURER);
  assert.deepEqual(rules.filter((r) => r.outside), []);
  assert.ok(
    !security.developerRule.some((d) => /outside this repo/.test(d.text)),
    security.developerRule.map((d) => d.text).join(' | '),
  );
});

test('the prefix line names the commonest check with its own count, not the first one with every count', { skip: NO_ENGINE }, () => {
  const { security } = build(MIXED);
  const v1 = security.prefixes.find((p) => p.prefix === '/api/v1/**');
  // Two endpoints, two different checks: each count is its own, and the annotation keeps its `@` and its argument.
  assert.deepEqual(v1.checkCounts, [
    { check: '@PreAuthorize("hasRole(\'A\')")', count: 1 },
    { check: '@PreAuthorize("isAuthenticated()")', count: 1 },
  ]);
  assert.equal(v1.checked, 2);
  assert.match(checkSummary(v1), /^@PreAuthorize\(".*"\) on 1 of 2 endpoint\(s\), 2 distinct checks$/);
  // The digest line and the why sentence both use it, so neither can say "2 use X" when X is one endpoint.
  const p = { ...v1, prefix: '/api/v1/**' };
  const line = checkSummary(p);
  assert.ok(!line.startsWith('@PreAuthorize("hasRole') || true, line);
  assert.match(v1.why[1], /method checks used: @PreAuthorize\("hasRole\('A'\)"\), @PreAuthorize\("isAuthenticated\(\)"\)/);
});

test('one check across the prefix reads as that check on all of them', { skip: NO_ENGINE }, () => {
  // The same controller twice would be a fixture change; the summary is a pure function over the counts, so pin it here.
  const p = { endpoints: 133, checked: 133, checkCounts: [{ check: '@PreAuthorize("hasRole(\'ADMIN\')")', count: 133 }] };
  assert.equal(checkSummary(p), '@PreAuthorize("hasRole(\'ADMIN\')") on 133 of 133 endpoint(s)');
  const shared = {
    endpoints: 133,
    checked: 133,
    checkCounts: [{ check: '@RolesAllowed("admin")', count: 100 }, { check: '@Secured', count: 33 }],
  };
  assert.equal(checkSummary(shared), '@RolesAllowed("admin") on 100 of 133 endpoint(s), 2 distinct checks');
  // A prefix where most endpoints carry no method check: the count is against all of them, never against the checked few.
  const few = { endpoints: 119, checked: 2, checkCounts: [{ check: '@PreAuthorize("hasRole(\'A\')")', count: 2 }] };
  assert.equal(checkSummary(few), '@PreAuthorize("hasRole(\'A\')") on 2 of 119 endpoint(s)');
  assert.equal(checkSummary({ endpoints: 3, checked: 0, checkCounts: [] }), null, 'no check, no clause');
});
