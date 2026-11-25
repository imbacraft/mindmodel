import path from 'node:path';

// Compact digest for the system writer, with the same "facts first" contract as facts.md.
export function systemSummary(sys) {
  const L = [
    `# system facts for ${path.basename(sys.folder)} (${sys.services.length} services)`,
    'Paths are relative to the folder. Details: system.json.',
    '',
  ];
  L.push('## Services (size, data, interface)');
  if (sys.libraries.length) L.push(`- shared libraries (no entry point, not services): ${sys.libraries.join(', ')}`);
  for (const s of sys.services) {
    const ents = s.facts.entities.model
      .slice(0, 5)
      .map((e) => e.name)
      .join(', ');
    L.push(
      `- ${s.name} (${s.dir})${s.role ? ` [${s.role}]` : ''}: ${s.lines} lines, ` +
        `${s.facts.endpoints.length} endpoints, ${s.facts.entities.count} entities${ents ? ` (${ents})` : ''}`,
    );
  }
  if (sys.duplicates.length)
    L.push(
      `- DUPLICATE spring.application.name: ` +
        `${sys.duplicates.map((d) => `"${d.name}" in ${d.dir}`).join(', ')}; listed under their folder names`,
    );
  for (const s of sys.services)
    if (s.unresolvedDest?.length)
      L.push(
        `- ${s.name}: REST destinations set outside the repo (env/deployment), ` +
          `UNRESOLVED: ${s.unresolvedDest.join(', ')}`,
      );
  L.push('', '## Messaging (channel: producers → consumers)');
  for (const c of sys.channels) {
    const who = (xs) => [...new Set(xs.map((x) => x.service))].join(', ') || 'none in this folder';
    L.push(
      `- ${c.kind} ${c.name ?? `UNRESOLVED (${c.unresolved})`}: ${who(c.out)} → ${who(c.in)} · ${[...c.out, ...c.in]
        .slice(0, 4)
        .map((x) => x.cite)
        .join(', ')}`,
    );
  }
  L.push('', '## REST between services (caller → callee)');
  const seen = new Set();
  for (const r of sys.rest) {
    const k = `${r.from}>${r.to}>${r.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    L.push(
      `- ${r.from} → ${r.to}${r.known ? '' : ' (not in this folder)'} ${r.path || ''} [${r.via}] ${r.cite}` +
        `${r.endpoint ? ` → ${r.endpoint}` : ''}`,
    );
  }
  // Plumbing (config, discovery, admin servers) is not something services rely on for their business.
  const plumbing = new Set(sys.services.filter((s) => s.role).map((s) => s.name));
  const fanIn = {};
  for (const r of sys.rest) if (r.known && !plumbing.has(r.to)) (fanIn[r.to] ??= new Set()).add(r.from);
  for (const c of sys.channels)
    for (const o of c.out)
      for (const i of c.in) if (o.service !== i.service) (fanIn[o.service] ??= new Set()).add(i.service);
  L.push('', '## Dependence (who relies on each service: callers + consumers of what it produces)');
  for (const s of [...sys.services].sort((a, b) => (fanIn[b.name]?.size ?? 0) - (fanIn[a.name]?.size ?? 0)))
    L.push(
      `- ${s.name}: ${fanIn[s.name]?.size ?? 0}${fanIn[s.name]?.size ? ` (${[...fanIn[s.name]].join(', ')})` : ''}`,
    );
  return L.join('\n') + '\n';
}
