// Method-level security facts from real Java: Spring's proxy secures public methods only, so a check on a private or
// package-private method, or on a constructor, guards nothing and is not a fact. The dump answers which members are
// public and which are constructors; the rule reads only those answers.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_ENGINE, dumpOf } from '../test-support/fixtures/dump-dir.mjs';
import { methodSecurityFacts } from '../engine/extract/security/rules/method-security.mjs';

const L = (...x) => x.join('\n');
const PRE = 'org.springframework.security.access.prepost.PreAuthorize';
const ENABLE = 'org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity';
const meansOf = (fqn) => (fqn === PRE || fqn === ENABLE ? 'method-security' : null);

test('method security: only public, non-constructor members are facts', { skip: NO_ENGINE }, () => {
  const { model } = dumpOf({
    'src/main/java/shop/Admin.java': L(
      'package shop;',
      'import org.springframework.security.access.prepost.PreAuthorize;',
      '@PreAuthorize("isAuthenticated()")',
      'public class Admin {',
      '  public Admin() {}',
      '  public void list() {}',
      '  private void evict() {}',
      '  void internal() {}',
      '  @PreAuthorize("hasRole(\'ADMIN\')")',
      '  public void one() {}',
      '}',
    ),
    'src/main/java/shop/Config.java': L(
      'package shop;',
      'import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;',
      '@EnableMethodSecurity',
      'public class Config {',
      '}',
    ),
    'src/main/java/shop/Api.java': L(
      'package shop;',
      'import org.springframework.security.access.prepost.PreAuthorize;',
      'public interface Api {',
      '  @PreAuthorize("hasRole(\'ADMIN\')")',
      '  void call();',
      '}',
    ),
  });
  const { facts } = methodSecurityFacts(model, meansOf);
  const where = facts.map((f) => `${f.method ?? f.type}:${f.where}`).sort();
  // list and one are public; one has its own check on top of the class's. The constructor, evict and internal are
  // not proxied. The interface's abstract method is public by definition. The configuration has no method, so its
  // @EnableMethodSecurity is the one fact the rule holds for it.
  assert.deepEqual(where, [
    'shop.Admin#list:class',
    'shop.Admin#one:class',
    'shop.Admin#one:method',
    'shop.Api#call:method',
    'shop.Config:type',
  ]);
});
