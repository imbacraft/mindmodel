// Task 4 of docs/engine-improvements.md: a prefix's access is stated only when all its endpoints have it, and a chain
// whose rules live in a configurer the repo does not declare says so instead of reporting the prefix as "unknown".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { index } from './fixtures/syntax-java.mjs';
import { buildModel } from './fixtures/model-from-source.mjs';
import { linkCallsTyped } from '../engine/model/link-for-tests.mjs';
import { annotationIndex, loadCatalogs, meanOf, selectCatalogs } from '../engine/catalogs/catalog.mjs';
import { extractEndpoints } from '../engine/extract/endpoints.mjs';
import { methodSecurityFacts, securityModel, springChains } from '../engine/extract/security.mjs';
import { checkSchema } from '../engine/validate.mjs';

const FACTS_SCHEMA = JSON.parse(fs.readFileSync(new URL('../schema/facts.schema.json', import.meta.url), 'utf8'));

const L = (...x) => x.join('\n');

// Two controllers under /api/v1: one role-checked, one merely requiring a logged-in caller.
const MIXED = {
  'src/main/java/shop/ExternalController.java': L(
    'package shop;',
    'import org.springframework.security.access.prepost.PreAuthorize;',
    'import org.springframework.web.bind.annotation.GetMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class ExternalController {',
    '  @PreAuthorize("hasRole(\'A\')")',
    '  @GetMapping("/api/v1/external/offers")',
    '  public Object offers() {',
    '    return "offers";',
    '  }',
    '}',
  ),
  'src/main/java/shop/GuiController.java': L(
    'package shop;',
    'import org.springframework.security.access.prepost.PreAuthorize;',
    'import org.springframework.web.bind.annotation.GetMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class GuiController {',
    '  @PreAuthorize("isAuthenticated()")',
    '  @GetMapping("/api/v1/gui/children")',
    '  public Object children() {',
    '    return "children";',
    '  }',
    '}',
  ),
};

// The chain that hands its paths to a library: `/api/_/**` is protected by a configurer this repo does not declare.
const OUTSIDE = (configurerInRepo) => ({
  'src/main/java/shop/WebSecurityConfiguration.java': L(
    'package shop;',
    'import org.springframework.context.annotation.Bean;',
    'import org.springframework.security.config.annotation.web.builders.HttpSecurity;',
    'import org.springframework.security.web.SecurityFilterChain;',
    'public class WebSecurityConfiguration {',
    '  @Bean',
    '  public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {',
    '    http.securityMatcher("/api/_/**");',
    '    http.apply(new com.example.ExternalConfigurer());',
    '    return http.build();',
    '  }',
    '}',
  ),
  'src/main/java/shop/InternalController.java': L(
    'package shop;',
    'import org.springframework.web.bind.annotation.GetMapping;',
    'import org.springframework.web.bind.annotation.RestController;',
    '@RestController',
    'public class InternalController {',
    '  @GetMapping("/api/_/ping")',
    '  public Object ping() {',
    '    return "pong";',
    '  }',
    '}',
  ),
  ...(configurerInRepo
    ? {
        'src/main/java/shop/ExternalConfigurer.java': L(
          'package shop;',
          'public class ExternalConfigurer {',
          '  public void configure() {',
          '  }',
          '}',
        ),
      }
    : {}),
});

// One build, in the scan's order: model, catalogs, endpoints, method security, chains, then the security model fact.
function build(files) {
  const model = buildModel(Object.entries(files).map(([p, text]) => ({ p, text, ix: index(text) })));
  linkCallsTyped(model);
  const imports = [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  const selected = selectCatalogs(loadCatalogs(), { imports });
  const catalogIndex = annotationIndex(selected);
  const endpoints = extractEndpoints(model, selected);
  const methodSec = methodSecurityFacts(model, (fqn, on) => meanOf(catalogIndex, fqn, on)?.means ?? null);
  const java = [...model.types.values()].map((t) => ({ p: t.file, text: files[t.file] }));
  // springChains locates a chain's method by line, so each file maps to its own methods.
  const fileMethods = new Map(
    [...model.byFile.entries()].map(([file, fqns]) => [
      file,
      fqns.flatMap((fqn) => model.types.get(fqn).methods ?? []),
    ]),
  );
  const rules = springChains(java, fileMethods);
  return { model, endpoints, rules, security: securityModel({ rules, endpoints, methodSecurity: methodSec.facts }) };
}

test('two different checks under one prefix report a share, not the busiest one for all', () => {
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

test('a chain that applies a configurer outside the repo says where its path rules come from', () => {
  const { rules, security } = build(OUTSIDE(false));
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

test('a configurer the repo declares adds no outside note', () => {
  const { rules, security } = build(OUTSIDE(true));
  assert.deepEqual(rules.filter((r) => r.outside), []);
  assert.ok(
    !security.developerRule.some((d) => /outside this repo/.test(d.text)),
    security.developerRule.map((d) => d.text).join(' | '),
  );
});
