import { appliesTo } from '../rules/match.mjs';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Write endpoints under an anonymous prefix with no method-level check.
export function anonymousWrites(rules, endpoints, methodSecurity) {
  const anon = rules.filter((r) => r.access === 'anonymous');
  const warnings = [];
  for (const e of endpoints) {
    if (!WRITE.has(e.verb)) continue;
    const rule = anon.find((r) => appliesTo(r, e.path ?? '', e.verb));
    if (!rule) continue;
    // An inherited handler runs on the mapped controller: a class-level guard there governs it too, so both the
    // class that declares the body and the class the mapping is written on are checked.
    const name = String(e.handler ?? '').split('.').pop();
    const owners = new Set([e.declaredIn, e.handlerFqn].filter(Boolean));
    const checked = [...owners].some(
      (owner) => (methodSecurity.get(owner) ?? false) || (methodSecurity.get(`${owner}#${name}`) ?? false),
    );
    if (checked) continue;
    warnings.push({
      id: `security-warning:anonymous-write@${e.verb} ${e.path}`,
      family: 'security-warning',
      confidence: 'resolved',
      kind: 'anonymous-write',
      path: e.path,
      verb: e.verb,
      handler: e.declaredIn || e.handlerFqn ? `${e.declaredIn ?? e.handlerFqn}#${name}` : (e.handler ?? null),
      rule: `${rule.pattern} is ${rule.access}`,
      evidence: [e.evidence?.[1] ?? e.evidence?.[0], rule.evidence[0]].filter(Boolean),
      why: [
        `${rule.pattern} allows anonymous access (${rule.source} ${rule.evidence[0]}) and this write endpoint ` +
          'has no @PreAuthorize/@Secured/@RolesAllowed',
      ],
    });
  }
  return warnings;
}
