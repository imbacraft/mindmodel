// Q1: end-to-end test code belongs to whoever wrote the test, not to this app's frontend. A Cypress/Playwright spec
// drives a *running* application from a browser, so its calls must not reach `frontend.apiCalls` — the same rule that
// keeps `src/test/` out of the Java model. Fixture: one SPA call plus Cypress and Playwright helpers.
import test from 'node:test';
import assert from 'node:assert';
import { isE2e } from '../engine/core/paths.mjs';
import { cachedFixtureScan } from '../test-support/scan-cache.mjs';

test('a test folder, or the Cypress `*.cy.*` naming, marks end-to-end code', () => {
  for (const p of [
    'cypress/e2e/admin.cy.ts',
    'cypress/support/helpers.ts',
    'e2e/login.ts',
    'playwright/pages.ts',
    'web-app/playwright/pages.ts',
    'web/src/test/setup.tsx',
    '__tests__/App.tsx',
    'src/a.cy.tsx',
  ])
    assert.ok(isE2e(p), `${p} is test code`);
  // The app itself is not: the folder decides, so `src/App.tsx` stays and only a test folder is skipped.
  for (const p of ['src/App.tsx', 'src/routes.tsx', 'src/Layout.ts', 'src/contest.ts', 'server/index.js'])
    assert.ok(!isE2e(p), `${p} is the app`);
});

test('only the SPA call is in frontend.apiCalls', () => {
  // The scan writes `mindmodel/.work` beside the code, so the cached scan runs on a copy: the fixture stays clean.
  const facts = cachedFixtureScan('frontend-e2e');
  // The Cypress helper (`/api/admin/users`) and the Playwright seed (`/api/seed/reset`) are gone; the SPA call stays.
  assert.deepStrictEqual(facts.frontend.unmatchedApiCalls, ['GET /api/orders src/App.tsx:3']);
  assert.equal(facts.frontend.apiCalls, 1);
  assert.equal(facts.frontend.files, 2); // src/App.tsx, src/routes.tsx
  // Routes are read from the same files: the Playwright page table is not the app's route table.
  assert.deepStrictEqual(
    facts.frontend.routes.map((r) => r.path),
    ['/orders/:id'],
  );
});
