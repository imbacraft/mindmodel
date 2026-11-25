import { simple } from '../../../core/names.mjs';
import { accessFor } from '../rules/match.mjs';
import { checkSummary } from '../summary.mjs';

// The model in one fact: prefixes and their access, where the user and the tenant come from, and what a developer
// adding an endpoint in a prefix has to do. All derived from the rules and from how existing endpoints are protected.
export function securityModel({
  rules,
  endpoints,
  methodSecurity = [],
  tenancy = null,
  userSources = [],
  baseControllers = new Set(),
}) {
  const prefixOf = (p) => {
    const parts = String(p ?? '').split('/').filter(Boolean);
    return '/' + parts.slice(0, Math.min(2, parts.length)).join('/') + '/**';
  };
  const byPrefix = new Map();
  for (const e of endpoints) {
    // A path ending in a file name is one endpoint, not a zone; a generic base controller's mappings are not zones.
    const single = /\.[a-z]{2,5}$/.test(String(e.path ?? ''));
    const prefix = single ? e.path : prefixOf(e.path);
    if (baseControllers.has(e.handlerFqn)) continue;
    if (!single && (/\/\/|\/\{\}/.test(e.path ?? '') || prefix.split('/').filter(Boolean).length < 2)) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(e);
  }
  // The check sits on the type that runs the handler; an inherited endpoint is checked on its declaring type.
  const checkedFor = (e) => {
    const owner = e.declaredIn ?? e.handlerFqn;
    return methodSecurity.filter(
      (f) => f.type === owner || f.method === `${owner}#${String(e.handler ?? '').split('.').pop()}`,
    );
  };
  // `@Ann(arg)`, the way a reader writes it: the annotation's own name, its argument in parentheses when it has one.
  const checkOf = (f) => {
    const args = String(f.args ?? '').trim();
    if (!args) return `@${simple(f.annotation)}`;
    return `@${simple(f.annotation)}${args.startsWith('(') ? args : `(${args})`}`;
  };
  const prefixes = [];
  for (const [prefix, eps] of [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const accessOfEndpoint = (e) => {
      // The chain rule decides the path's access; a method-level check only fills in when no rule matches.
      const fromRule = accessFor(rules, e.path ?? '', e.verb);
      if (fromRule !== 'unknown') return fromRule;
      const checks = checkedFor(e);
      if (checks.length) {
        const a = checks[0].access;
        if (a.startsWith('checked:')) {
          const role = /hasAnyRole\s*\(([^)]*)\)|hasRole\s*\(([^)]*)\)|hasAuthority\s*\(([^)]*)\)/.exec(a);
          const named = role ? (role[1] ?? role[2] ?? role[3]).replace(/['"\s]/g, '').split(',')[0] : null;
          return named ? `role:${named}` : 'role-checked';
        }
        return a;
      }
      return accessFor(rules, e.path ?? '', e.verb);
    };
    const counts = {};
    for (const e of eps) {
      const a = accessOfEndpoint(e);
      counts[a] = (counts[a] ?? 0) + 1;
    }
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [modal, n] = ranked[0] ?? ['unknown', 0];
    // A prefix rule is stated only when every endpoint under the prefix has it. The modal value is never reported as
    // the prefix's rule: `/api/v1/**: role:X` would cover every endpoint under the prefix when only the external
    // controllers carry the annotation and the rest are merely authenticated. A share ("role:A on 95 of 142") names the
    // commonest check, which is what a reader acts on, and never claims it for the whole prefix.
    const mixed = ranked.length > 1;
    const access = mixed ? `${modal} on ${n} of ${eps.length}` : modal;
    const example = eps.find((e) => accessOfEndpoint(e) === modal) ?? eps[0];
    // Every check with its own count: one prefix usually carries several (`@PreAuthorize(...)` on some endpoints,
    // `@RolesAllowed` on others), and printing the first one alone says "these 133 use X" when X is merely the
    // earliest.
    // Per endpoint, not per fact: one endpoint may carry a class-level check and a method-level one, and a count larger
    // than the endpoints it describes is nonsense ("on 6 of 2 checked endpoint(s)"). A check counted once per endpoint.
    const checkHits = new Map();
    for (const e of eps)
      for (const c of new Set(checkedFor(e).map(checkOf))) checkHits.set(c, (checkHits.get(c) ?? 0) + 1);
    const checkCounts = [...checkHits.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([check, count]) => ({ check, count }));
    const checks = checkCounts.map((c) => c.check);
    const checkedCount = eps.filter((e) => checkedFor(e).length).length;
    prefixes.push({
      prefix,
      access,
      endpoints: eps.length,
      agreement: Math.round((n / eps.length) * 100),
      ...(mixed ? { dominant: modal, accessCounts: counts } : {}),
      example: `${example.verb} ${example.path}`,
      checks,
      checkCounts,
      checked: checkedCount,
      evidence: [...new Set(eps.map((e) => e.evidence?.[1] ?? e.evidence?.[0]).filter(Boolean))].slice(0, 3),
      why: [
        mixed
          ? `${ranked.map(([a, c]) => `${a} on ${c}`).join(', ')} of ${eps.length} endpoints under ${prefix}: ` +
            'no single rule covers them'
          : `${n} of ${eps.length} endpoints under ${prefix} are ${access}`,
        checks.length ? `method checks used: ${checks.join(', ')}` : 'no method-level checks',
      ],
    });
  }
  // Sibling prefixes under one parent with the same access are one zone
  // (`/health/live`, `/health/ready` → `/health/**`).
  const merged = [];
  const byParent = new Map();
  for (const p of prefixes) {
    if (/\.[a-z]{2,5}$/.test(p.prefix)) { merged.push(p); continue; }
    const parent = '/' + p.prefix.split('/').filter(Boolean)[0] + '/**';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(p);
  }
  for (const [parent, list] of byParent) {
    const sameAccess = list.every((p) => p.access === list[0].access);
    if (list.length > 1 && parent !== '/**' && sameAccess && !list.some((p) => p.prefix === parent)) {
      const sum = (key) => list.reduce((a, p) => a + p[key], 0);
      merged.push({
        ...list[0],
        prefix: parent,
        endpoints: sum('endpoints'),
        checked: sum('checked'),
        why: [`${list.length} sibling prefixes with the same access`],
      });
    } else merged.push(...list);
  }
  merged.sort((a, b) => b.endpoints - a.endpoints);
  // A configurer outside the repo holds rules this scan cannot read: the reader has to know that a prefix's silence is
  // not proof that it is unprotected. It comes first, because the digest shows the first few lines only.
  const outsideRules = [...new Map(rules.filter((r) => r.outside).map((r) => [r.outside, r])).entries()];
  // A caller taken from a cookie or header and stored without a verification call is knowledge the reader must have:
  // the digest prints the user source's kind, and the "<...> (unverified)" suffix is how that state survives it.
  const unverified = userSources.filter((u) => /\(unverified\)$/.test(u.kind ?? ''));
  const developerRule = [
    ...unverified.map((u) => ({
      text:
        `the caller's identity comes from ${u.kind.replace(/\s*\(unverified\)$/, '')}, stored with no ` +
        `verification call (${u.cites?.[0] ?? 'no cite'}): any client can claim it`,
      cites: u.cites ?? [],
    })),
    ...outsideRules.map(([type, rule]) => ({
      text: `path rules come from ${type}, outside this repo: not seen`,
      cites: rule.evidence,
      outside: type,
    })),
    ...merged
      .filter((p) => p.endpoints >= 2)
      .slice(0, 8)
      .map((p) => ({
        text:
          p.accessCounts
            ? `endpoints under ${p.prefix} differ (${Object.entries(p.accessCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([a, c]) => `${a} on ${c} of ${p.endpoints}`)
                .join(', ')}): no single rule covers the prefix`
            : p.access === 'anonymous'
              ? `endpoints under ${p.prefix} are public: ` +
                (p.checks.length
                  ? `${checkSummary(p)}; the rest must protect themselves`
                  : 'each endpoint must protect itself')
              : p.access === 'authenticated'
                ? `endpoints under ${p.prefix} need a logged-in caller${p.checked ? `; ${checkSummary(p)}` : ''}`
                : p.access.startsWith('role:')
                  ? `endpoints under ${p.prefix} need role ${p.access.slice(5)}`
                  : `endpoints under ${p.prefix} are ${p.access}`,
        cites: p.evidence,
      })),
  ];
  return {
    id: 'security-model',
    family: 'security-model',
    confidence: 'inferred',
    prefixes: merged,
    developerRule,
    userSources,
    tenant: tenancy?.key
      ? {
          key: tenancy.key,
          sources: tenancy.sources.slice(0, 4),
          cites: (tenancy.sources[0]?.evidence ?? []).slice(0, 1),
        }
      : null,
    why: [`${prefixes.length} prefixes from ${rules.length} rules and ${endpoints.length} endpoints`],
  };
}
