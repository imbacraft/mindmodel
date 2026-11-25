// sureness.yml: `excludedResource` (anonymous) and `resourceRole` (`path===verb===[role]`).
export function surenessRules(text, file) {
  const rules = [];
  const lines = text.split('\n');
  const section = (name) => {
    const out = [];
    let inside = false;
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`^${name}\\s*:`).test(lines[i])) {
        inside = true;
        continue;
      }
      if (!inside) continue;
      if (/^\S/.test(lines[i])) break;
      const m = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
      if (m) out.push([m[1], i + 1]);
    }
    return out;
  };
  for (const [entry, line] of section('excludedResource')) {
    const [pathRaw, verbRaw] = entry.split('===');
    const path = pathRaw.trim();
    const verb = (verbRaw ?? '*').trim().toLowerCase();
    rules.push({
      id: `security-rule:${path}:anonymous:${verb}`,
      family: 'security-rule',
      confidence: 'resolved',
      source: 'sureness',
      scope: ['**'],
      pattern: path,
      verbs: verb === '*' ? ['*'] : [verb.toUpperCase()],
      access: 'anonymous',
      chain: 'sureness excludedResource',
      evidence: [`${file}:${line}`],
      why: ['listed under excludedResource: no authentication is applied'],
    });
  }
  for (const [entry, line] of section('resourceRole')) {
    const [path, verb, role] = entry.split('===');
    rules.push({
      id: `security-rule:${path.trim()}:${(role ?? '').replace(/^\[|\]$/g, '').toLowerCase()}:${(verb ?? '*').trim()}`,
      family: 'security-rule',
      confidence: 'resolved',
      source: 'sureness',
      scope: ['**'],
      pattern: path.trim(),
      verbs: !verb || verb.trim() === '*' ? ['*'] : [verb.trim().toUpperCase()],
      access: `role:${(role ?? '').replace(/^\[|\]$/g, '')}`,
      chain: 'sureness resourceRole',
      evidence: [`${file}:${line}`],
      why: [`${verb ?? 'any'} requires ${role ?? 'a role'}`],
    });
  }
  return rules;
}
