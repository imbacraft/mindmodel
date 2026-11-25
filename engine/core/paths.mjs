// Paths the engine compares: the folders a repo walk skips, test and end-to-end code by path, the endpoint path shape,
// and repo-relative paths with forward slashes.
import assert from 'node:assert';
import path from 'node:path';

// Folders no repo walk reads: build output, caches, IDE and tool state, and the engine's own output.
// `docs` and `scripts` stay readable: a frontend can be built into either one.
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'build',
  'bin',
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.vscode',
  '.settings',
  '.ua',
  'mindmodel',
  'uploads',
  'coverage',
  '.next',
  'android',
  'ios',
  '.mvn',
  'vendor',
  '.claude',
  '.cursor',
  '.agent',
]);

// Folders no service lives in: the ignored ones, the system's own output, and documentation, container and script
// folders, which can hold sample projects that look like a service.
export const NON_SERVICE_DIRS = new Set([...IGNORED_DIRS, 'mindmodel-system', 'docs', 'docker', 'scripts']);

// Java test code by its Maven or Gradle layout: `src/test/`, `src/it/` and `src/integrationTest/`, in any module.
export const isTestCode = (p) => /(^|\/)src\/(test|it|integrationTest)\//.test(p ?? '');

// Folders that hold end-to-end or unit-test code in a frontend. Some of these names belong to Cypress and Playwright.
const TEST_FOLDERS = new Set([
  'cypress',
  'e2e',
  'e2e-tests',
  'playwright',
  'playwright-tests',
  'playwright-e2e',
  '__e2e__',
  '__tests__',
  'test',
  'tests',
]);

// End-to-end test code outside the Java layouts: a test folder, a Cypress `*.cy.*` spec, or an `-e2e` name. Only the
// folder decides: `src/App.tsx` is the app, `cypress/e2e/App.tsx` is a test. Takes a repo-relative path.
export function isE2e(p) {
  const dirs = String(p ?? '').split('/');
  const file = dirs.pop();
  return (
    /\.cy\.[cm]?[jt]sx?$/i.test(file) ||
    /[-_]e2e\b/i.test(file) ||
    dirs.some((d) => TEST_FOLDERS.has(d.toLowerCase()) || /[-_]e2e\b/i.test(d))
  );
}

// The shape endpoint paths compare in: `{}` for every variable (`{id}`, `${x}`, `:id`), no query, no trailing slash.
// `{?}` is the engine's marker for a part it could not resolve, so it stays as written.
export function normalizePath(p) {
  const MARK = '\u0000';
  const out = ('/' + String(p ?? '').replace(/\{\?\}/g, MARK))
    .replace(/\/+/g, '/')
    .replace(/\$\{[^}]*\}|\{[^}]*\}|:\w+/g, '{}')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '');
  return (out || '/').replace(new RegExp(MARK, 'g'), '{?}');
}

// A path relative to `root`, with forward slashes on every platform.
export const relPosix = (root, p) => path.relative(root, p).split(path.sep).join('/');

{
  assert.equal(normalizePath('/api/orders/${o.id}/items?x=1'), '/api/orders/{}/items');
  assert.equal(normalizePath('/api/a/{?}/{id}/'), '/api/a/{?}/{}');
  assert.equal(normalizePath('/users/:id'), '/users/{}');
  assert.equal(normalizePath(''), '/');
  assert.equal(isTestCode('svc/src/integrationTest/java/A.java'), true);
  assert.equal(isTestCode('src/test/java/A.java'), true, 'a single-module repo has the layout at its top');
  assert.equal(isTestCode('svc/src/main/java/A.java'), false);
  assert.equal(isTestCode(undefined), false);
  for (const p of ['cypress/e2e/admin.cy.ts', 'cypress/support/helpers.ts', 'web/src/test/setup.tsx']) {
    assert.equal(isE2e(p), true, p);
  }
  assert.equal(isE2e('__tests__/A.tsx'), true);
  for (const p of ['src/App.tsx', 'src/contest.ts', 'server/index.js', 'src/main/resources/application.yml'])
    assert.equal(isE2e(p), false, p);
  assert.equal(isE2e('app/src/main/resources/application-e2e.yml'), true);
  assert.equal(isE2e('web-e2e/src/index.ts'), true);
  assert.equal(relPosix('/a/b', '/a/b/c/d.java'), 'c/d.java');
  assert.ok(IGNORED_DIRS.has('node_modules') && !IGNORED_DIRS.has('scripts'), 'scripts hold frontends');
  assert.ok(NON_SERVICE_DIRS.has('docs') && NON_SERVICE_DIRS.has('node_modules'));
}
