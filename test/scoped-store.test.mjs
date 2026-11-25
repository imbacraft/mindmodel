// A store whose lifetime is one request, found without a classpath: the holder's type is a library type the dump cannot
// read, so the *shape* is the evidence — a call on one type inside a try block, the same type cleared in that try's
// finally. This is the project-K shape: two cookies read in if arms, a private project method that stores the value,
// and the clear written in the finalizer. Every fixture runs through the real engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_ENGINE, dumpOf } from '../test-support/fixtures/dump-dir.mjs';
import { authSources, tenantSources } from '../engine/extract/security.mjs';

const L = (...x) => x.join('\n');

const FILTER = L(
  'package shop;',
  'import jakarta.servlet.http.Cookie;',
  'import jakarta.servlet.http.HttpServletRequest;',
  'public class ContextFilter {',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    try {',
  '      for (Cookie c : request.getCookies()) {',
  '        if (c.getName().equals("cluster")) {',
  '          remember(c.getValue());',
  '        }',
  '        if (c.getName().equals("region")) {',
  '          remember(c.getValue());',
  '        }',
  '      }',
  '    } finally {',
  '      library.ContextHolder.clearContext();',
  '    }',
  '  }',
  '',
  '  private void remember(String value) {',
  '    library.ContextHolder.setContext(value);',
  '  }',
  '}',
);

// The same method, but nothing is cleared in a finalizer: one static call on a library type is not a request store.
const NO_FINALLY = L(
  'package shop;',
  'import jakarta.servlet.http.Cookie;',
  'import jakarta.servlet.http.HttpServletRequest;',
  'public class LinearFilter {',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    remember("x");',
  '  }',
  '',
  '  private void remember(String value) {',
  '    library.ContextHolder.setContext(value);',
  '  }',
  '}',
);

const tenantOf = (model, db) => tenantSources(model, () => false, db);
const userOf = (model, db) => authSources(model, () => false, db);

test('scoped store: a library holder called in a try and cleared in its finally is a tenant source', { skip: NO_ENGINE }, () => {
  const { model, db } = dumpOf({ 'src/main/java/shop/ContextFilter.java': FILTER });
  const facts = tenantOf(model, db);
  // Both cookies the filter reads are named, and each is the value that reaches the store.
  assert.deepStrictEqual(facts.map((f) => [f.kind, f.name]), [['cookie', 'cluster'], ['cookie', 'region']]);
  for (const f of facts) {
    assert.equal(f.confidence, 'inferred', 'the holder type is unreadable: the shape is the evidence, never a resolution');
    assert.equal(f.via, 'try-finally-pattern');
    assert.equal(f.storedBy, 'thread-local');
    assert.equal(f.method, 'ContextFilter#doFilterInternal');
    // The store's own call site is cited, not the filter's line: the value is written in the helper.
    assert.match(f.evidence[0], /ContextFilter\.java:2[0-9]#remember\(String\)$/);
    assert.match(f.why[1], /ContextHolder is called in a try block and cleared in its finally/);
  }
});

test('scoped store: the filter that sets the holder is also the user source for the cookies it reads', { skip: NO_ENGINE }, () => {
  const { model, db } = dumpOf({ 'src/main/java/shop/ContextFilter.java': FILTER });
  const facts = userOf(model, db);
  assert.deepStrictEqual(facts.map((f) => f.kind), ['cookie cluster (unverified)', 'cookie region (unverified)']);
  for (const f of facts) assert.match(f.why[0], /stores the caller \(ContextHolder\.setContext\(/);
});

test('scoped store: a static call with no finalizer is not a store by shape', { skip: NO_ENGINE }, () => {
  const { model, db } = dumpOf({ 'src/main/java/shop/LinearFilter.java': NO_FINALLY });
  assert.deepStrictEqual(tenantOf(model, db), [], 'no try, no request-scoped store');
  assert.deepStrictEqual(userOf(model, db), [], 'and so no user source either');
});
