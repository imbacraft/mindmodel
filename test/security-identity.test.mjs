// A client-asserted identity is a warning only when the value reaches a *security* holder: the security context, or a
// Spring Security Authentication/Principal slot. A ThreadLocal of a String — an IP, a request id, a workspace id — is
// where the caller comes from, a user source; believing it is not a security decision. And a verification call on the
// right receiver type (JwtDecoder, AuthenticationManager, the app's own *TokenService) means the value was checked.
//
// Every fixture below runs through the real engine: the Java is dumped by the jar, the model is built from that dump,
// and the extractor reads only the dump. A fixture the dump cannot answer stays unresolved and is asserted as such.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_ENGINE, dumpOf } from '../test-support/fixtures/dump-dir.mjs';
import { authSources, identityWarnings, requestReads, securityModel } from '../engine/extract/security/index.mjs';
import { queries } from '../engine/model/query.mjs';

const L = (...x) => x.join('\n');

const USER = {
  'src/main/java/shop/User.java': L('package shop;', 'public class User {', '  private String login;', '}'),
  'src/main/java/shop/UserService.java': L(
    'package shop;',
    'import org.springframework.security.core.Authentication;',
    'public class UserService {',
    '  public User loadByLogin(String login) {',
    '    return new User();',
    '  }',
    '  public Authentication authenticate(String login) {',
    '    return null;',
    '  }',
    '}',
  ),
  'src/main/java/shop/TfaService.java': L(
    'package shop;',
    'public class TfaService {',
    '  public TfaToken fetchFor(Object user, String token) {',
    '    return new TfaToken();',
    '  }',
    '}',
  ),
  'src/main/java/shop/TfaToken.java': L('package shop;', 'public class TfaToken {', '  public boolean isValid() {', '    return true;', '  }', '}'),
};

const IMPORTS = [
  'import jakarta.servlet.http.Cookie;',
  'import jakarta.servlet.http.HttpServletRequest;',
  'import org.springframework.security.core.Authentication;',
  'import org.springframework.security.core.context.SecurityContext;',
  'import org.springframework.security.core.context.SecurityContextHolder;',
];

// The filter that trusts a cookie: the cookie names the clerk to act as, the user is loaded by that id, and the
// resulting Authentication is made the request's caller — no verification anywhere.
const TRUSTING = L(
  'package shop;',
  ...IMPORTS,
  'public class ActAsFilter {',
  '  private final UserService users;',
  '  public ActAsFilter(UserService users) {',
  '    this.users = users;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String actor = null;',
  '    for (Cookie c : request.getCookies()) {',
  '      if (c.getName().equals("actAs")) {',
  '        actor = c.getValue();',
  '      }',
  '    }',
  '    User user = users.loadByLogin(actor);',
  '    SecurityContext context = SecurityContextHolder.getContext();',
  '    context.setAuthentication(user);',
  '  }',
  '}',
);

// The same filter, but the cookie holds a signed JWT that is decoded and checked first: a user source, never a
// warning. The verification is found by the receiver's type (`JwtDecoder`), not by the call's name.
const VERIFYING = L(
  'package shop;',
  ...IMPORTS,
  'import org.springframework.security.oauth2.jwt.Jwt;',
  'import org.springframework.security.oauth2.jwt.JwtDecoder;',
  'public class VerifiedFilter {',
  '  private final JwtDecoder jwtDecoder;',
  '  private final UserService users;',
  '  public VerifiedFilter(JwtDecoder jwtDecoder, UserService users) {',
  '    this.jwtDecoder = jwtDecoder;',
  '    this.users = users;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String token = null;',
  '    for (Cookie c : request.getCookies()) {',
  '      if (c.getName().equals("actAs")) {',
  '        token = c.getValue();',
  '      }',
  '    }',
  '    Jwt jwt = jwtDecoder.decode(token);',
  '    User user = users.loadByLogin(jwt.getSubject());',
  '    SecurityContextHolder.getContext().setAuthentication(user);',
  '  }',
  '}',
);

// Two client-sent values into one holder: one warning, both sources listed.
const TWO_SOURCES = L(
  'package shop;',
  ...IMPORTS,
  'public class TwoHeaderFilter {',
  '  private final UserService users;',
  '  public TwoHeaderFilter(UserService users) {',
  '    this.users = users;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String actor = request.getHeader("X-Act-As");',
  '    String key = request.getHeader("X-Api-Key");',
  '    User user = users.loadByLogin(actor, key);',
  '    SecurityContextHolder.getContext().setAuthentication(user);',
  '  }',
  '}',
);

// A header read into a plain ThreadLocal of a String, held for the request: a user source, not a warning.
const LOCAL_STRING = L(
  'package shop;',
  'import jakarta.servlet.http.HttpServletRequest;',
  'public class ApiKeyContextFilter {',
  '  private static final ThreadLocal<String> API_KEY = new ThreadLocal<>();',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String key = request.getHeader("X-Api-Key");',
  '    API_KEY.set(key);',
  '  }',
  '}',
);

// A cookie stored in a ThreadLocal of the user: the caller arrives from the client unchecked. The holder is the app's
// own — a ThreadLocal of a type the project declares — and that is an identity sink even though it is not Spring
// Security's.
const LOCAL_COOKIE = L(
  'package shop;',
  ...IMPORTS,
  'public class LocalCookieFilter {',
  '  private static final ThreadLocal<User> ACTOR = new ThreadLocal<>();',
  '  private final UserService users;',
  '  public LocalCookieFilter(UserService users) {',
  '    this.users = users;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String actor = null;',
  '    for (Cookie c : request.getCookies()) {',
  '      if (c.getName().equals("actAs")) {',
  '        actor = c.getValue();',
  '      }',
  '    }',
  '    User user = users.loadByLogin(actor);',
  '    ACTOR.set(user);',
  '  }',
  '}',
);

// A header that is only *checked* before the request's existing caller is re-stored (a two-factor token): the value
// never reaches the holder, so nothing is asserted. This is the shape that made the old warning fire on every filter.
const CHECKED_ONLY = L(
  'package shop;',
  ...IMPORTS,
  'public class TwoFactorFilter {',
  '  private final TfaService tfa;',
  '  public TwoFactorFilter(TfaService tfa) {',
  '    this.tfa = tfa;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    SecurityContext context = SecurityContextHolder.getContext();',
  '    Authentication current = context.getAuthentication();',
  '    String token = request.getHeader("X-Tfa-Token");',
  '    TfaToken access = tfa.fetchFor(current, token);',
  '    Authentication updated = addAuthority(current);',
  '    context.setAuthentication(updated);',
  '  }',
  '  private Authentication addAuthority(Authentication current) {',
  '    return current;',
  '  }',
  '}',
);

// The app's own context holder, filled from a cookie. `TenantContext` keeps a ThreadLocal of a project type
// (`UserContext`), and the filter stores the context it builds from the user the cookie named. The holder is not
// Spring Security's and the value is not a String: the type alone makes it an identity, and no verification runs.
const TENANT_CONTEXT = {
  'src/main/java/shop/UserContext.java': L(
    'package shop;',
    'public class UserContext {',
    '  private final User user;',
    '  public UserContext(User user) {',
    '    this.user = user;',
    '  }',
    '  public User getUser() {',
    '    return user;',
    '  }',
    '}',
  ),
  'src/main/java/shop/TenantContext.java': L(
    'package shop;',
    'public class TenantContext {',
    '  private static final ThreadLocal<UserContext> CURRENT = new ThreadLocal<>();',
    '  public static void setContext(UserContext ctx) {',
    '    CURRENT.set(ctx);',
    '  }',
    '  public static UserContext getContext() {',
    '    return CURRENT.get();',
    '  }',
    '}',
  ),
};

const PROJECT_CONTEXT_FILTER = L(
  'package shop;',
  ...IMPORTS,
  'public class ContextFilter {',
  '  private final UserService users;',
  '  public ContextFilter(UserService users) {',
  '    this.users = users;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String actor = null;',
  '    for (Cookie c : request.getCookies()) {',
  '      if (c.getName().equals("actAs")) {',
  '        actor = c.getValue();',
  '      }',
  '    }',
  '    User user = users.loadByLogin(actor);',
  '    TenantContext.setContext(new UserContext(user));',
  '  }',
  '}',
);

// The same shape, but the app's holder keeps a String — a workspace id, a request id. That is bookkeeping, so the
// cookie stays a user source and there is no warning: the stored value's type is the whole distinction.
const STRING_CONTEXT = {
  'src/main/java/shop/RequestContext.java': L(
    'package shop;',
    'public class RequestContext {',
    '  private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();',
    '  public static void setCurrent(String value) {',
    '    CURRENT.set(value);',
    '  }',
    '  public static String getCurrent() {',
    '    return CURRENT.get();',
    '  }',
    '}',
  ),
};

const STRING_CONTEXT_FILTER = L(
  'package shop;',
  ...IMPORTS,
  'public class StringContextFilter {',
  '  private final UserService users;',
  '  public StringContextFilter(UserService users) {',
  '    this.users = users;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String actor = null;',
  '    for (Cookie c : request.getCookies()) {',
  '      if (c.getName().equals("actAs")) {',
  '        actor = c.getValue();',
  '      }',
  '    }',
  '    User user = users.loadByLogin(actor);',
  '    RequestContext.setCurrent(user.getLogin());',
  '  }',
  '}',
);

// The name read through a helper: the filter asks `isActAs(c.getName())` and the helper compares its own parameter to
// a constant. The dump resolves the name through the helper (`comparedTo`), not by reading the helper's body.
const HELPER_NAMED = {
  'src/main/java/shop/CookieNames.java': L(
    'package shop;',
    'public class CookieNames {',
    '  private static final String ACT_AS = "actAs";',
    '  public static boolean isActAs(String name) {',
    '    return ACT_AS.equals(name);',
    '  }',
    '}',
  ),
  'src/main/java/shop/HelperFilter.java': L(
    'package shop;',
    ...IMPORTS,
    'public class HelperFilter {',
    '  private final UserService users;',
    '  public HelperFilter(UserService users) {',
    '    this.users = users;',
    '  }',
    '  public void doFilterInternal(HttpServletRequest request) {',
    '    String actor = null;',
    '    for (Cookie c : request.getCookies()) {',
    '      if (CookieNames.isActAs(c.getName())) {',
    '        actor = c.getValue();',
    '      }',
    '    }',
    '    User user = users.loadByLogin(actor);',
    '    SecurityContextHolder.getContext().setAuthentication(user);',
    '  }',
    '}',
  ),
};

// The name as a literal *receiver* (`"actAs".equals(c.getName())`): the dump records a receiver's written text, not
// its value, so the read is unresolved with that reason — the one cookie shape this layer cannot name.
const RECEIVER_NAME = L(
  'package shop;',
  ...IMPORTS,
  'public class ReceiverFilter {',
  '  private final UserService users;',
  '  public ReceiverFilter(UserService users) {',
  '    this.users = users;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String actor = null;',
  '    for (Cookie c : request.getCookies()) {',
  '      if ("actAs".equals(c.getName())) {',
  '        actor = c.getValue();',
  '      }',
  '    }',
  '    User user = users.loadByLogin(actor);',
  '    SecurityContextHolder.getContext().setAuthentication(user);',
  '  }',
  '}',
);

/** One dump for one fixture; the extractors read it through the model it produced. */
function build(cls, filter, extra = {}) {
  const { db, model } = dumpOf({ ...USER, ...extra, [`src/main/java/shop/${cls}.java`]: filter });
  return { db, model, sources: authSources(model), warnings: identityWarnings(model) };
}

test('a cookie that becomes the caller through SecurityContextHolder gets one warning citing it', { skip: NO_ENGINE }, () => {
  const { sources, warnings } = build('ActAsFilter', TRUSTING);
  assert.equal(warnings.length, 1, `one warning: ${JSON.stringify(warnings.map((w) => w.id))}`);
  const w = warnings[0];
  assert.equal(w.family, 'security-warning');
  assert.equal(w.kind, 'client-asserted-identity');
  assert.equal(w.method, 'ActAsFilter#doFilterInternal');
  assert.equal(w.source, 'cookie:actAs');
  assert.equal(w.holder, 'ActAsFilter#doFilterInternal');
  assert.ok(w.evidence.some((e) => e.startsWith('src/main/java/shop/ActAsFilter.java:')), `cites the filter: ${w.evidence.join(', ')}`);
  assert.match(w.why[1], /SecurityContext\.setAuthentication/);
  // The cookie is a user source, named, and its unverified state is what the digest keeps.
  const cookie = sources.find((s) => s.name === 'actAs');
  assert.ok(cookie, `the cookie is a user source: ${sources.map((s) => s.kind).join(', ')}`);
  assert.equal(cookie.kind, 'cookie actAs (unverified)');
  assert.match(cookie.evidence[0], /ActAsFilter\.java:\d+#doFilterInternal/);
});

test('a JwtDecoder decoding the cookie first is a verified user source with no warning', { skip: NO_ENGINE }, () => {
  const { sources, warnings } = build('VerifiedFilter', VERIFYING);
  assert.deepEqual(warnings, []);
  const cookie = sources.find((s) => s.name === 'actAs');
  assert.ok(cookie, `the cookie is still a user source: ${sources.map((s) => s.kind).join(', ')}`);
  assert.equal(cookie.kind, 'cookie actAs');
  assert.equal(cookie.verified, true);
});

test('two client-sent values into one holder are one warning listing both sources', { skip: NO_ENGINE }, () => {
  const { warnings } = build('TwoHeaderFilter', TWO_SOURCES);
  assert.equal(warnings.length, 1, `one entry per (method, holder): ${JSON.stringify(warnings.map((w) => w.id))}`);
  assert.equal(warnings[0].source, 'header:X-Act-As, header:X-Api-Key');
  assert.equal(new Set(warnings[0].evidence).size, 3, 'both reads are cited, next to the holder');
});

test('a header into a plain ThreadLocal of a String is a user source and no warning', { skip: NO_ENGINE }, () => {
  const { sources, warnings } = build('ApiKeyContextFilter', LOCAL_STRING);
  assert.deepEqual(warnings, [], 'a String ThreadLocal is not a security holder');
  const source = sources.find((s) => s.name === 'X-Api-Key');
  assert.ok(source, `the read is still a user source: ${sources.map((s) => s.kind).join(', ')}`);
  assert.equal(source.kind, 'API token');
});

test('a cookie into a ThreadLocal of the user is a warning: the app holder stores a project type', { skip: NO_ENGINE }, () => {
  const { sources, warnings } = build('LocalCookieFilter', LOCAL_COOKIE);
  assert.equal(warnings.length, 1, `a project-typed ThreadLocal is an identity sink: ${JSON.stringify(warnings)}`);
  assert.equal(warnings[0].method, 'LocalCookieFilter#doFilterInternal');
  assert.equal(warnings[0].source, 'cookie:actAs');
  assert.match(warnings[0].why[1], /thread-local ACTOR \(User\)/);
  assert.equal(sources.find((s) => s.name === 'actAs')?.kind, 'cookie actAs (unverified)');
});

test("a cookie made the caller through the app's own context holder is one warning", { skip: NO_ENGINE }, () => {
  const { warnings } = build('ContextFilter', PROJECT_CONTEXT_FILTER, TENANT_CONTEXT);
  assert.equal(warnings.length, 1, `one warning: ${JSON.stringify(warnings.map((w) => w.id))}`);
  const w = warnings[0];
  assert.equal(w.kind, 'client-asserted-identity');
  assert.equal(w.method, 'ContextFilter#doFilterInternal');
  assert.equal(w.source, 'cookie:actAs');
  assert.match(w.why[1], /TenantContext#setContext\(ctx\)/, 'the store is the holder setter, not a name');
  assert.ok(w.evidence.some((e) => e.startsWith('src/main/java/shop/ContextFilter.java:')), `cites the filter: ${w.evidence.join(', ')}`);
});

test('the same holder of a String is a user source and no warning', { skip: NO_ENGINE }, () => {
  const { sources, warnings } = build('StringContextFilter', STRING_CONTEXT_FILTER, STRING_CONTEXT);
  assert.deepEqual(warnings, [], 'a ThreadLocal<String> is not an identity holder');
  const source = sources.find((s) => s.name === 'actAs');
  assert.ok(source, `the read is still a user source: ${sources.map((s) => s.kind).join(', ')}`);
  assert.equal(source.kind, 'cookie actAs (unverified)');
});

test('a header that is only checked, never stored, is a user source and no warning', { skip: NO_ENGINE }, () => {
  const { sources, warnings } = build('TwoFactorFilter', CHECKED_ONLY);
  assert.deepEqual(warnings, [], 'the token is checked; the caller stored is the one already authenticated');
  assert.ok(sources.some((s) => s.name === 'X-Tfa-Token'), `the read is still a user source: ${sources.map((s) => s.kind).join(', ')}`);
});

test('a cookie name compared inside a helper is resolved through the helper', { skip: NO_ENGINE }, () => {
  const { sources } = build('HelperFilter', HELPER_NAMED['src/main/java/shop/HelperFilter.java'], { 'src/main/java/shop/CookieNames.java': HELPER_NAMED['src/main/java/shop/CookieNames.java'] });
  const cookie = sources.find((s) => s.kind.startsWith('cookie'));
  assert.ok(cookie, `the helper's cookie is a user source: ${sources.map((s) => s.kind).join(', ')}`);
  assert.equal(cookie.name, 'actAs', 'the constant the helper compares against names the cookie');
});

test('a literal receiver is not in the dump: the read is unresolved, and says why', { skip: NO_ENGINE }, () => {
  const { db, model } = dumpOf({ ...USER, 'src/main/java/shop/ReceiverFilter.java': RECEIVER_NAME });
  const id = 'shop.ReceiverFilter#doFilterInternal(HttpServletRequest)';
  const { reads, unresolved } = requestReads(id, queries(db), db, model);
  assert.deepEqual(reads.filter((r) => r.kind === 'cookie'), [], 'no cookie is named');
  assert.ok(unresolved.some((u) => u.reason === 'receiver-is-not-a-value'), JSON.stringify(unresolved));
  // Nothing is invented from it: no source, and no warning either.
  assert.deepEqual(authSources(model), []);
  assert.deepEqual(identityWarnings(model), []);
});

test('the security model carries the unverified caller into the digest rules', { skip: NO_ENGINE }, () => {
  const { sources } = build('LocalCookieFilter', LOCAL_COOKIE);
  const userSources = sources.map((s) => ({ kind: s.kind, cites: s.evidence, why: s.why?.[0] }));
  const security = securityModel({ rules: [], endpoints: [], userSources });
  assert.match(security.developerRule[0].text, /identity comes from cookie actAs, stored with no verification call/);
  assert.match(security.developerRule[0].text, /LocalCookieFilter\.java:\d+/);
  // A verified source produces no such line.
  const verified = build('VerifiedFilter', VERIFYING).sources.map((s) => ({ kind: s.kind, cites: s.evidence, why: s.why?.[0] }));
  assert.deepEqual(securityModel({ rules: [], endpoints: [], userSources: verified }).developerRule, []);
});
