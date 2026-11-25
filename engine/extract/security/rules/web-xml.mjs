// web.xml <security-constraint>: url-pattern + auth-constraint (role-name, or empty for deny).
export function webXmlRules(text, file) {
  const rules = [];
  for (const c of text.matchAll(/<security-constraint\b[\s\S]*?<\/security-constraint>/g)) {
    const patterns = [...c[0].matchAll(/<url-pattern>([^<]+)<\/url-pattern>/g)].map((x) => x[1].trim());
    const roles = [...c[0].matchAll(/<role-name>([^<]+)<\/role-name>/g)].map((x) => x[1].trim());
    for (const pattern of patterns) {
      const access = roles.length ? `role:${roles[0]}` : 'denied';
      rules.push({
        id: `security-rule:${pattern}:${access}:web-xml`,
        family: 'security-rule',
        confidence: 'resolved',
        source: 'web-xml',
        scope: ['**'],
        pattern,
        verbs: ['*'],
        access,
        chain: 'web.xml security-constraint',
        evidence: [`${file}#security-constraint`],
        why: [
          `<url-pattern>${pattern}</url-pattern> with ` +
            (roles.length ? `<role-name>${roles.join(',')}</role-name>` : 'no role (denied)'),
        ],
      });
    }
  }
  return rules;
}
