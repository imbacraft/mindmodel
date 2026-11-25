const globRe = (pattern) => {
  // `/**` also matches the prefix itself (Spring does): `/api/shop/**` covers `/api/shop`.
  const s = String(pattern)
    .replace(/\{[^}]+\}/g, '\x01')
    .replace(/\/\*\*$/, '\x02')
    .replace(/\*\*/g, '\x03')
    .replace(/\*/g, '\x04')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    '^' +
      s
        .replace(/\x01/g, '[^/]+')
        .replace(/\x02/g, '(?:/.*)?')
        .replace(/\x03/g, '.*')
        .replace(/\x04/g, '[^/]*') +
      '$',
  );
};
// A rule only applies inside its chain's scope: `anyRequest().permitAll()` in the /api/shop/** chain does not open
// /api/admin/**, however wide the rule itself reads.
const inScope = (rule, path) =>
  (rule.scope ?? ['**']).some((s) => globRe(s).test(path)) && globRe(rule.pattern).test(path);

// A rule applies to its path and its method: `HttpMethod.OPTIONS` or `===get` names one, `*` means every method.
const verbOk = (rule, verb) =>
  !verb || !rule.verbs || rule.verbs.includes('*') || rule.verbs.includes(String(verb).toUpperCase());
export const appliesTo = (rule, path, verb) => inScope(rule, path) && verbOk(rule, verb);

// The access a path gets: Spring Security evaluates its filter chains in @Order, and the first chain whose
// securityMatcher matches decides; inside a chain, the first matching requestMatchers rule decides.
export function accessFor(rules, path, verb) {
  for (const r of rules) if (appliesTo(r, path, verb)) return r.access;
  return 'unknown';
}
