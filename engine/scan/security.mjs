import { isTestCode } from '../core/paths.mjs';
import { meanOf } from '../catalogs/catalog.mjs';
import {
  anonymousWrites,
  authSources,
  identityWarnings,
  methodSecurityFacts,
  securityModel as buildSecurityModel,
  shiroCodeRules,
  shiroRules,
  springChains,
  surenessRules,
  webXmlRules,
} from '../extract/security/index.mjs';

/**
 * The rules the security configs state: Spring chains, sureness.yml, Shiro, the code's own calls and web.xml. One rule
 * per chain prefix and access, however many copies of a config repeat it.
 */
function securityRulesOf(model, files, R, read) {
  const resourceFiles = files
    .filter((f) => /\.(?:ya?ml|properties)$/.test(f) && /sureness|application|security/i.test(f))
    .map((f) => ({ p: R(f), text: read(f) }));
  const ruleSeen = new Set();
  return [
    ...springChains(model),
    ...resourceFiles
      .filter((r) => /sureness\.ya?ml$/i.test(r.p) && !isTestCode(r.p))
      .flatMap((r) => surenessRules(r.text, r.p)),
    ...files
      .filter((f) => /shiro\.(ini|properties)$/i.test(f) && !isTestCode(f))
      .flatMap((f) => shiroRules(read(f), R(f))),
    ...shiroCodeRules(model),
    ...files
      .filter((f) => /web\.xml$/.test(f) && !isTestCode(f))
      .flatMap((f) => webXmlRules(read(f), R(f))),
  ].filter((r) => !ruleSeen.has(r.id) && ruleSeen.add(r.id));
}

/** Security as facts: the rules, the method-level security index, and the warnings the rules expose. */
export function securityOf({ model, files, R, read, annIndex }, endpoints) {
  const methodSec = methodSecurityFacts(model, (fqn, on) => meanOf(annIndex, fqn, on)?.means ?? null);
  const securityRules = securityRulesOf(model, files, R, read);
  // Two warning kinds in one family: an anonymous prefix that exposes writes, and an identity the client asserts
  // (a filter takes a header/cookie value as the caller with no verification call between).
  const securityWarnings = [
    ...anonymousWrites(securityRules, endpoints, methodSec.index),
    ...identityWarnings(model, isTestCode),
  ];
  return { methodSec, securityRules, securityWarnings };
}

/**
 * Where the user comes from, from what the code configures: the security chain's own calls (httpBasic(),
 * oauth2ResourceServer().jwt(), formLogin(), sessionManagement()) and filters that authenticate from a header by
 * setting the security context. Structural, not text matching; the citation is the call's own line.
 */
export function userSourcesOf(model, selected) {
  const userSources = [];
  const addUser = (kind, cite, why) => {
    if (cite && !userSources.some((u) => u.kind === kind)) userSources.push({ kind, cites: [cite], why });
  };
  const citeOf = (t, c) => `${t.file}:${c.line}`;
  for (const t of model.types.values())
    for (const m of t.methods ?? []) {
      const calls = m.calls ?? [];
      for (const c of calls) {
        if (c.name === 'httpBasic') addUser('basic auth', citeOf(t, c), `${t.name} configures httpBasic()`);
        if (c.name === 'oauth2ResourceServer' || c.name === 'jwt')
          addUser('JWT bearer token', citeOf(t, c), `${t.name} configures ${c.name}()`);
        if (c.name === 'formLogin') addUser('HTTP session', citeOf(t, c), `${t.name} configures formLogin()`);
        if (c.name === 'setAttribute' && calls.some((x) => x.name === 'getSession'))
          addUser('HTTP session', citeOf(t, c), `${t.name}#${m.name} stores the caller in the HttpSession`);
        // `sessionCreationPolicy(STATELESS)` names the policy in its argument: a stateless app has no session.
        if (c.name === 'sessionManagement' && !calls.some((x) => /STATELESS|NEVER/.test((x.args ?? []).join(' '))))
          addUser('HTTP session', citeOf(t, c), `${t.name} configures a stateful sessionManagement()`);
        if (
          /^(setAuthentication|setContext)$/.test(c.name ?? '') &&
          (/Filter$/.test(t.name) || calls.some((x) => ['getHeader', 'getCookies'].includes(x.name)))
        )
          addUser('API token', citeOf(t, c), `${t.name}#${m.name} sets the authentication from the request`);
        // A filter that reads the Authorization header and stores the caller (attribute, ThreadLocal, SecurityContext).
        if (
          /Filter$/.test(t.name) &&
          calls.some((x) => x.name === 'getHeader') &&
          calls.some((x) => ['setAttribute', 'set', 'setAuthentication'].includes(x.name)) &&
          // The header the filter reads names the token: the dump folded the argument, no source text is read.
          calls.some((x) => (x.args ?? []).some((a) => /Authorization|Bearer|token/i.test(a)))
        )
          addUser('API token', citeOf(t, c), `${t.name}#${m.name} reads the token header and stores the caller`);
      }
    }
  // Sureness declares its authentication types as processors; the catalog names them.
  const holderOf = firstHolderIndex(model.types.values());
  for (const { catalog } of selected)
    for (const t of catalog.types ?? []) {
      if (t.means !== 'auth-type') continue;
      const holder = holderOf.get(t.fqn);
      if (holder)
        addUser(
          t.authType,
          `${holder.file}:${holder.nameLine}`,
          `${holder.name} is a Sureness ${t.authType} processor`,
        );
    }
  for (const a of authSources(model, isTestCode))
    if (!userSources.some((u) => u.kind === a.kind))
      userSources.push({ kind: a.kind, cites: a.evidence, why: a.why?.[0] });
  return userSources;
}

/**
 * The first type, in model order, that extends or implements a supertype FQN or is that FQN itself: one pass over the
 * types, then a lookup per catalog name (a generic supertype counts by its raw name).
 */
function firstHolderIndex(types) {
  const first = new Map();
  const put = (key, t) => {
    if (!first.has(key)) first.set(key, t);
  };
  for (const x of types) {
    for (const sp of x.supers ?? []) put((sp.fqn ?? '').split('<')[0], x);
    put(x.fqn, x);
  }
  return first;
}

/** The security model: rules, endpoints, method security, tenancy and user sources, with the base controllers. */
export function securityModelOf(model, { endpoints, sec, tenancy, userSources }) {
  const baseControllers = new Set(
    [...model.implsOf.keys()].filter((fqn) => {
      const t = model.types.get(fqn);
      return t?.methods?.length && /Controller$/.test(t.name ?? '');
    }),
  );
  return buildSecurityModel({
    rules: sec.securityRules,
    endpoints,
    methodSecurity: sec.methodSec.facts,
    tenancy,
    userSources,
    baseControllers,
  });
}
