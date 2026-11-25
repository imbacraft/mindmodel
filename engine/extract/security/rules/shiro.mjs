import { dumpArgs } from '../flow/dump.mjs';

// shiro.ini `[urls]`: `path = anon|authc|user|roles[a,b]|perms[x]|jwt[...]`.
export function shiroRules(text, file) {
  const rules = [];
  const at = text.indexOf('[urls]');
  if (at < 0) return rules;
  const body = text.slice(at + 6).split(/^\[/m)[0];
  for (const [i, line] of body.split('\n').entries()) {
    const m = /^\s*(\/[^=\s]*)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, pattern, exprRaw] = m;
    const expr = exprRaw.trim();
    const roles = /^roles\[([^\]]*)\]/.exec(expr)?.[1];
    const access = /^anon\b/.test(expr)
      ? 'anonymous'
      : roles
        ? `role:${roles.replace(/"/g, '').split(',')[0].trim()}`
        : 'authenticated';
    rules.push({
      id: `security-rule:${pattern}:${access}:shiro`,
      family: 'security-rule',
      confidence: 'resolved',
      source: 'shiro',
      scope: ['**'],
      pattern,
      verbs: ['*'],
      access,
      chain: 'shiro.ini [urls]',
      evidence: [`${file}:${at + 6 + i + 1}#urls`],
      why: [`[urls] ${pattern} = ${expr}`],
    });
  }
  return rules;
}

// Shiro's code-based chain (`filterChainDefinitionMap.put("/api/**", "authc")`, `addPathDefinition`): each call's two
// arguments are the path and the access, and both are the dump's folded values. A call whose arguments the dump could
// not fold is not a rule — the path would be a guess.
export function shiroCodeRules(model, db = model?.dump ?? null) {
  const rules = [];
  if (!db) return rules;
  for (const t of model.types.values()) {
    if (!/ShiroFilterChainDefinition|ShiroFilterFactoryBean/.test(t.name)) continue;
    for (const m of t.methods ?? [])
      for (const c of m.calls ?? []) {
        if (c.name !== 'put' && c.name !== 'addPathDefinition') continue;
        const rows = dumpArgs(db, c);
        const [pattern, expr] = [0, 1].map((i) => (typeof rows[i]?.value === 'string' ? rows[i].value : null));
        if (!pattern || !expr) continue;
        const roles = /roles\[([^\]]+)\]/.exec(expr)?.[1];
        const access = /anon/.test(expr) ? 'anonymous' : roles ? `role:${roles.split(',')[0].trim()}` : 'authenticated';
        rules.push({
          id: `security-rule:${pattern}:${access}:shiro-code`,
          family: 'security-rule',
          confidence: 'resolved',
          source: 'shiro',
          scope: ['**'],
          pattern,
          verbs: ['*'],
          access,
          chain: t.name,
          evidence: [`${t.file}:${t.nameLine}#${t.name}`],
          why: [`${t.name} maps ${pattern} to ${expr}`],
        });
      }
  }
  return rules;
}
