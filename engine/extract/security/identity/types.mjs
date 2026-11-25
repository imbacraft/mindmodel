import assert from 'node:assert/strict';
import { listOf } from '../../../catalogs/catalog.mjs';
import { simple } from '../../../core/names.mjs';
import { baseType, projectType, simpleType } from '../flow/dump.mjs';

// The entry methods this repo reads identity and context from: framework method names, not project conventions.
export const IDENTITY_ENTRY = /^(doFilter|doFilterInternal|preHandle)$/;

// A verification call is a property of its receiver's *type*, never of a method or class name: `validate` on a
// WorkspaceValidator checks a workspace, `decode` on a cache parses a cache key, and a filter whose name says
// *AuthenticationFilter may still trust whatever arrives. The type is the dump's receiver answer.
const VERIFIER_TYPES = listOf('verifier-types');
const VERIFIER_SIMPLE = new Set([...VERIFIER_TYPES].map((fqn) => fqn.split('.').pop()));
// The app's own token service, also by type: a receiver the app declares whose type name ends in TokenService.
const TOKEN_SERVICE = /TokenService$/;

export const isVerifierType = (type, model) => {
  if (!type) return false;
  const name = simpleType(type);
  return (
    VERIFIER_TYPES.has(type) ||
    VERIFIER_SIMPLE.has(name) ||
    (TOKEN_SERVICE.test(name) && (model.types?.has(type) || type === name))
  );
};

// A value of a type the project declares — a User, a ResolvedTenantContext — is an identity once a holder keeps it.
// A String, a primitive or a JDK type (an IP, a request id, an idempotency key) is request bookkeeping: that is the
// whole distinction, and it is the value's type, never the holder's name.
// A JDK type is bookkeeping even when it has fields: a String, a number, a UUID, a Locale, an InetAddress.
const JDK_NAMESPACE = /^(?:java|javax|jakarta|sun|jdk)\./;

/**
 * The type that makes a holder's value an identity, or null. A project type always; a library type when the classpath
 * read it as a value class: at least one field, not a JDK type. The holder's element often lives in the organisation's
 * shared jar next to the holder (`ThreadLocal<Ctx>` where `Ctx` is no project's type), and a name-only guess is exactly
 * what this must not do: the dump's own rows decide, and a stub with no members is unresolved rather than an identity.
 */
export const isIdentityType = (model, written, db = null) => {
  const project = projectType(model, written);
  if (project) return project;
  const text = baseType(written);
  if (!text) return null;
  const row = db?.library?.get(text) ?? [...(db?.library?.values() ?? [])].find((r) => simple(r.fqn) === simple(text));
  if (!row || row.origin === 'error' || JDK_NAMESPACE.test(row.fqn ?? text)) return null;
  return (row.fields ?? []).length ? row.fqn : null;
};

/**
 * The verification calls in a reach: a call whose receiver's type is a verifier. This is what makes a cookie read a
 * fact about where the caller comes from instead of a warning about believing it — the receiver's type, never a name
 * of the calling method.
 */
export function verifiesIn(methods, db, model) {
  for (const { id } of methods)
    for (const c of db.callsOf(id))
      if (isVerifierType(c.recv?.typeFqn, model)) return { type: c.recv.typeFqn, cite: `${c.file}:${c.line}` };
  return null;
}

{
  // The type gates, on values the dump would write. `==` comparisons are not in the dump: those are gaps, not guesses.
  const model = {
    types: new Map([
      ['shop.User', { fqn: 'shop.User' }],
      ['shop.UserContext', { fqn: 'shop.UserContext' }],
      ['shop.JwtTokenService', { fqn: 'shop.JwtTokenService' }],
      ['shop.TwoFactorService', { fqn: 'shop.TwoFactorService' }],
    ]),
  };
  assert.ok(isIdentityType(model, 'UserContext'), 'a project type is an identity value');
  assert.ok(isIdentityType(model, 'shop.UserContext'), 'written or qualified');
  assert.ok(!isIdentityType(model, 'String'), 'a String is bookkeeping');
  assert.ok(!isIdentityType(model, 'long'), 'a primitive is bookkeeping');
  // A holder's element in the organisation's shared jar: a value class, read from the classpath as a stub.
  const jar = {
    library: new Map([
      ['com.acme.Ctx', { fqn: 'com.acme.Ctx', fields: [{ name: 'userId', type: 'java.lang.String' }] }],
      ['com.acme.Marker', { fqn: 'com.acme.Marker', fields: [] }],
      ['com.acme.Broken', { fqn: 'com.acme.Broken', origin: 'error', reason: 'library-class-unreadable', fields: [] }],
    ]),
  };
  assert.equal(isIdentityType(model, 'com.acme.Ctx', jar), 'com.acme.Ctx', 'a library value type carries an identity');
  assert.equal(isIdentityType(model, 'com.acme.Marker', jar), null, 'a stub with no state does not');
  assert.equal(isIdentityType(model, 'com.acme.Broken', jar), null, 'an unreadable class is not a guess');
  const uuid = { library: new Map([['java.util.UUID', { fqn: 'java.util.UUID', fields: [{ name: 'msb' }] }]]) };
  assert.equal(isIdentityType(model, 'java.util.UUID', uuid), null, 'a JDK type is bookkeeping even with fields');
  assert.ok(isVerifierType('org.springframework.security.oauth2.jwt.JwtDecoder', model));
  assert.ok(isVerifierType('java.security.MessageDigest', model));
  assert.ok(isVerifierType('shop.JwtTokenService', model));
  assert.ok(!isVerifierType('shop.TwoFactorService', model));
  assert.ok(!isVerifierType('java.lang.String', model));
  assert.equal(simple('shop.User'), 'User');
}
