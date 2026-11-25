// Security, in plain terms. One fact per path prefix the application protects, with what the prefix allows:
// anonymous, authenticated, or a role. Sources: Spring Security filter chains (each chain's `securityMatcher` is its
// scope, each `requestMatchers(...)`/`anyRequest()` inside `authorizeHttpRequests` is a rule) and sureness.yml.
//
// Two derived facts: a warning when an anonymous prefix exposes write endpoints with no method-level check
// (@PreAuthorize/@PostAuthorize/@Secured/@RolesAllowed), and where the tenant comes from (a request header or a token
// claim). A writer cannot see any of this from the map's usual evidence; it is why a path like /api/push looks
// authenticated when it is open.
//
// The folder: rules/ (one parser per framework), flow/ (the dump door and the request, store and value walks),
// identity/ (where the caller comes from and what checks it), tenant.mjs, model/ (the model and its warnings) and
// summary.mjs (the one-line check text). This file re-exports the public API.

export { springChains } from './rules/spring.mjs';
export { surenessRules } from './rules/sureness.mjs';
export { shiroRules, shiroCodeRules } from './rules/shiro.mjs';
export { methodSecurityFacts } from './rules/method-security.mjs';
export { webXmlRules } from './rules/web-xml.mjs';
export { accessFor } from './rules/match.mjs';
export { requestReads } from './flow/requests.mjs';
export { authSources } from './identity/sources.mjs';
export { identityWarnings } from './identity/warnings.mjs';
export { tenantSources } from './tenant.mjs';
export { anonymousWrites } from './model/anonymous-writes.mjs';
export { securityModel } from './model/security-model.mjs';
export { checkSummary } from './summary.mjs';
