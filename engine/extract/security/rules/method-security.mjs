// Jakarta EE: @RolesAllowed/@PermitAll/@DenyAll on a class or a method, and method-level @PreAuthorize/@Secured.
// The expression or role list is recorded, not interpreted.
// The annotation meanings that are method-level checks (the catalogs name them).
const CHECK_MEANS = ['method-security', 'permit-all', 'deny-all'];
export function methodSecurityFacts(model, meansOf) {
  const facts = [];
  const index = new Map();
  for (const t of model.types.values()) {
    const tAnn = (t.ann ?? []).filter((a) => CHECK_MEANS.includes(meansOf(a.fqn, 'type')));
    if (tAnn.length) index.set(t.fqn, true);
    for (const m of t.methods ?? []) {
      const methodAnn = (m.ann ?? []).filter((a) => CHECK_MEANS.includes(meansOf(a.fqn, 'method')));
      const anns = [...tAnn.map((a) => ({ ...a, from: 'class' })), ...methodAnn];
      if (!anns.length) continue;
      index.set(`${t.fqn}#${m.name}`, true);
      for (const a of anns) {
        const means = meansOf(a.fqn, 'method');
        const argText = (a.args ?? '').replace(/^\(|\)$/g, '').trim() || a.name;
        const access =
          means === 'permit-all' ? 'anonymous' : means === 'deny-all' ? 'denied' : `checked:${argText}`;
        facts.push({
          id: `method-security:${t.fqn}#${m.name}:${a.name}`,
          family: 'method-security',
          confidence: 'resolved',
          where: a.from ?? 'method',
          type: t.fqn,
          method: `${t.fqn}#${m.name}`,
          annotation: a.name,
          args: a.args ?? '',
          access,
          evidence: [`${t.file}:${a.line ?? m.nameLine}#${m.name}`],
          why: [`${a.name}${a.args || ''} on ${a.from ?? 'method'}`],
        });
      }
    }
  }
  return { facts, index };
}
