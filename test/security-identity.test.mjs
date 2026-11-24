// A client-asserted identity is a warning only when the value reaches a *security* holder: the security context, or a
// Spring Security Authentication/Principal slot. A ThreadLocal of a String — an IP, a request id, a workspace id — is
// where the caller comes from, a user source; believing it is not a security decision. And a verification call on the
// right receiver type (JwtDecoder, AuthenticationManager, the app's own *TokenService) means the value was checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { index } from './fixtures/syntax-java.mjs';
import { buildModel } from './fixtures/model-from-source.mjs';
import { linkCallsTyped } from '../engine/model/link-for-tests.mjs';
import { authSources, identityWarnings, securityModel } from '../engine/extract/security.mjs';

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
  '      if ("actAs".equals(c.getName())) {',
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
  'public class ActAsFilter {',
  '  private final JwtDecoder jwtDecoder;',
  '  private final UserService users;',
  '  public ActAsFilter(JwtDecoder jwtDecoder, UserService users) {',
  '    this.jwtDecoder = jwtDecoder;',
  '    this.users = users;',
  '  }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    String token = null;',
  '    for (Cookie c : request.getCookies()) {',
  '      if ("actAs".equals(c.getName())) {',
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
  'public class ActAsFilter {',
  '  private final UserService users;',
  '  public ActAsFilter(UserService users) {',
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

// A cookie stored in a ThreadLocal of the user: the caller arrives from the client unchecked, and the fact says so.
const LOCAL_COOKIE = L(
  'package shop;',
  ...IMPORTS,
  'public class ActAsFilter {',
  '  private static final ThreadLocal<User> ACTOR = new ThreadLocal<>();',
  '  private final UserService users;',
  '  public ActAsFilter(UserService users) {',
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

function build(filter, cls = 'ActAsFilter') {
  const files = {
    ...USER,
    'src/main/java/shop/TfaService.java': L(
      'package shop;',
      'public class TfaService {',
      '  public TfaToken fetchFor(Object user, String token) {',
      '    return new TfaToken();',
      '  }',
      '}',
    ),
    'src/main/java/shop/TfaToken.java': L('package shop;', 'public class TfaToken {', '  public boolean isValid() {', '    return true;', '  }', '}'),
    [`src/main/java/shop/${cls}.java`]: filter,
  };
  const model = buildModel(Object.entries(files).map(([p, text]) => ({ p, text, ix: index(text) })));
  linkCallsTyped(model);
  const textOf = (rel) => files[rel];
  return {
    model,
    textOf,
    sources: authSources(model, textOf),
    warnings: identityWarnings(model, textOf),
  };
}

test('a cookie that becomes the caller through SecurityContextHolder gets one warning citing it', () => {
  const { sources, warnings } = build(TRUSTING);
  assert.equal(warnings.length, 1, `one warning: ${JSON.stringify(warnings.map((w) => w.id))}`);
  const w = warnings[0];
  assert.equal(w.family, 'security-warning');
  assert.equal(w.kind, 'client-asserted-identity');
  assert.equal(w.method, 'ActAsFilter#doFilterInternal');
  assert.equal(w.source, 'cookie:actAs');
  assert.equal(w.holder, 'ActAsFilter#doFilterInternal');
  assert.ok(
    w.evidence.some((e) => e.startsWith('src/main/java/shop/ActAsFilter.java:')),
    `the warning cites the filter: ${w.evidence.join(', ')}`,
  );
  assert.match(w.why[1], /context\.setAuthentication/);
  // The cookie is a user source, named, and its unverified state is what the digest keeps.
  const cookie = sources.find((s) => s.name === 'actAs');
  assert.ok(cookie, `the cookie is a user source: ${sources.map((s) => s.kind).join(', ')}`);
  assert.equal(cookie.kind, 'cookie actAs (unverified)');
  assert.match(cookie.evidence[0], /ActAsFilter\.java:\d+#doFilterInternal/);
});

test('a JwtDecoder decoding the cookie first is a verified user source with no warning', () => {
  const { sources, warnings } = build(VERIFYING);
  assert.deepEqual(warnings, []);
  const cookie = sources.find((s) => s.name === 'actAs');
  assert.ok(cookie, `the cookie is still a user source: ${sources.map((s) => s.kind).join(', ')}`);
  assert.equal(cookie.kind, 'cookie actAs');
  assert.equal(cookie.verified, true);
});

test('two client-sent values into one holder are one warning listing both sources', () => {
  const { warnings } = build(TWO_SOURCES);
  assert.equal(warnings.length, 1, `one entry per (method, holder): ${JSON.stringify(warnings.map((w) => w.id))}`);
  assert.equal(warnings[0].source, 'header:X-Act-As, header:X-Api-Key');
  assert.equal(new Set(warnings[0].evidence).size, 3, 'both reads are cited, next to the holder');
});

test('a header into a plain ThreadLocal of a String is a user source and no warning', () => {
  const { sources, warnings } = build(LOCAL_STRING);
  assert.deepEqual(warnings, [], 'a String ThreadLocal is not a security holder');
  const source = sources.find((s) => s.name === 'X-Api-Key');
  assert.ok(source, `the read is still a user source: ${sources.map((s) => s.kind).join(', ')}`);
  assert.equal(source.kind, 'API token');
});

test('a cookie into a ThreadLocal of the user is a user source and no warning', () => {
  const { sources, warnings } = build(LOCAL_COOKIE);
  assert.deepEqual(warnings, []);
  assert.equal(sources.find((s) => s.name === 'actAs')?.kind, 'cookie actAs (unverified)');
});

test('a header that is only checked, never stored, is a user source and no warning', () => {
  const { sources, warnings } = build(CHECKED_ONLY, 'TwoFactorFilter');
  assert.deepEqual(warnings, [], 'the token is checked; the caller stored is the one already authenticated');
  assert.ok(
    sources.some((s) => s.name === 'X-Tfa-Token'),
    `the read is still a user source: ${sources.map((s) => s.kind).join(', ')}`,
  );
});

test('the security model carries the unverified caller into the digest rules', () => {
  const { model, textOf, sources } = build(LOCAL_COOKIE);
  const userSources = sources.map((s) => ({ kind: s.kind, cites: s.evidence, why: s.why?.[0] }));
  const security = securityModel({ rules: [], endpoints: [], userSources });
  assert.match(security.developerRule[0].text, /identity comes from cookie actAs, stored with no verification call/);
  assert.match(security.developerRule[0].text, /ActAsFilter\.java:\d+/);
  // A verified source produces no such line.
  const verified = build(VERIFYING).sources.map((s) => ({ kind: s.kind, cites: s.evidence, why: s.why?.[0] }));
  assert.deepEqual(securityModel({ rules: [], endpoints: [], userSources: verified }).developerRule, []);
  // Nothing here depends on a model type name: the source is the store the filter performs.
  assert.ok(model.types.get('shop.ActAsFilter'));
  assert.ok(textOf('src/main/java/shop/ActAsFilter.java').includes('ACTOR.set(user)'));
});
