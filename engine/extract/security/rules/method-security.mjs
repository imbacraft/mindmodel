// Jakarta EE: @RolesAllowed/@PermitAll/@DenyAll on a class or a method, and method-level @PreAuthorize/@Secured.
// The expression or role list is recorded, not interpreted.
// The annotation meanings that are method-level checks (the catalogs name them).
const CHECK_MEANS = ['method-security', 'permit-all', 'deny-all'];

// The proxy secures public methods only, and never a constructor; an interface method is public unless it is private.
const proxied = (t, m) =>
  !m.isConstructor && (m.isPublic || (t.kind === 'interface' && !(m.modifiers ?? []).includes('private')));

const argTextOf = (a) => (a.args ?? '').replace(/^\(|\)$/g, '').trim() || a.name;
const accessOf = (means, a) =>
  means === 'permit-all' ? 'anonymous' : means === 'deny-all' ? 'denied' : `checked:${argTextOf(a)}`;

function fact(t, { where, method, a, means, line, why }) {
  return {
    id: method ? `method-security:${method}:${a.name}` : `method-security:${t.fqn}:${a.name}`,
    family: 'method-security',
    confidence: 'resolved',
    where,
    type: t.fqn,
    method,
    annotation: a.name,
    args: a.args ?? '',
    access: accessOf(means, a),
    evidence: [`${t.file}:${line}#${method ? method.split('#').pop() : t.name}`],
    why: [why],
  };
}

export function methodSecurityFacts(model, meansOf) {
  const facts = [];
  const index = new Map();
  for (const t of model.types.values()) {
    const tAnn = (t.ann ?? []).filter((a) => CHECK_MEANS.includes(meansOf(a.fqn, 'type')));
    if (tAnn.length) index.set(t.fqn, true);
    // A type-level rule with no public method to cover is still a rule the code defines (a configuration's
    // @EnableMethodSecurity): one fact for the rule, not one per method.
    // shortcut: a configuration with public @Bean methods has proxied methods, so its enabler is not counted,
    // upgrade when the catalog marks enabler annotations apart from class-level checks
    if (tAnn.length && !(t.methods ?? []).some((m) => proxied(t, m))) {
      for (const a of tAnn)
        facts.push(
          fact(t, {
            where: 'type',
            method: null,
            a,
            means: meansOf(a.fqn, 'type'),
            line: a.line ?? t.nameLine,
            why: `${a.name}${a.args || ''} on the type, with no public method of its own`,
          }),
        );
    }
    for (const m of t.methods ?? []) {
      if (!proxied(t, m)) continue;
      const methodAnn = (m.ann ?? []).filter((a) => CHECK_MEANS.includes(meansOf(a.fqn, 'method')));
      const anns = [...tAnn.map((a) => ({ ...a, from: 'class' })), ...methodAnn];
      if (!anns.length) continue;
      index.set(`${t.fqn}#${m.name}`, true);
      for (const a of anns)
        facts.push(
          fact(t, {
            where: a.from ?? 'method',
            method: `${t.fqn}#${m.name}`,
            a,
            means: meansOf(a.fqn, 'method'),
            line: a.line ?? m.nameLine,
            why: `${a.name}${a.args || ''} on ${a.from ?? 'method'}`,
          }),
        );
    }
  }
  return { facts, index };
}
