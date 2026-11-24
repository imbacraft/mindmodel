// Q1: end-to-end test code belongs to whoever wrote the test, not to this app's frontend. A Cypress/Playwright spec
// drives a *running* application from a browser, so its calls must not reach `frontend.apiCalls` — the same rule that
// keeps `src/test/` out of the Java model. Fixture: one SPA call plus Cypress and Playwright helpers.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isE2ePath, scan } from '../engine/scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '../test-support/fixtures/frontend-e2e');

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
    assert.ok(isE2ePath(p), `${p} is test code`);
  // The app itself is not: the folder decides, so `src/App.tsx` stays and only a test folder is skipped.
  for (const p of ['src/App.tsx', 'src/routes.tsx', 'src/Layout.ts', 'src/contest.ts', 'server/index.js'])
    assert.ok(!isE2ePath(p), `${p} is the app`);
});

test('only the SPA call is in frontend.apiCalls', () => {
  // The scan writes `mindmodel/.work` beside the code, so it reads a copy: the fixture stays clean.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmodel-e2e-'));
  fs.cpSync(fixture, dir, { recursive: true });
  let facts;
  try {
    facts = scan(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
