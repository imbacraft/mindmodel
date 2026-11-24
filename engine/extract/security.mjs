import assert from 'node:assert/strict';

// Security, in plain terms. One fact per path prefix the application protects, with what the prefix allows:
// anonymous, authenticated, or a role. Sources: Spring Security filter chains (each chain's `securityMatcher` is its
// scope, each `requestMatchers(...)`/`anyRequest()` inside `authorizeHttpRequests` is a rule) and sureness.yml.
//
// Two derived facts: a warning when an anonymous prefix exposes write endpoints with no method-level check
// (@PreAuthorize/@PostAuthorize/@Secured/@RolesAllowed), and where the tenant comes from (a request header or a token
// claim). A writer cannot see any of this from the map's usual evidence; it is why a path like /api/push looks
// authenticated when it is open.

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HEADERS = /getHeader\(\s*"([^"]+)"\s*\)|header\(\s*"([^"]+)"\s*\)/g;
const CLAIMS = /getClaim(?:AsString)?\(\s*"([^"]+)"\s*\)/g;
const TENANT_WORDS = /tenant|organisation|organization|workspace|domain|host/i;

// The matching ')' for the '(' at `open` (or -1): chain bodies nest lambdas and argument lists.
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

const ACCESS = [
  [/^permitAll$/, () => 'anonymous'],
  [/^authenticated$/, () => 'authenticated'],
  [/^hasRole$/, (args) => `role:${firstLiteral(args)}`],
  [/^hasAnyRole$/, (args) => `role:${String(args).match(/"([^"]+)"/)?.[1] ?? '?'}`],
  [/^hasAuthority$/, (args) => `authority:${firstLiteral(args)}`],
  [/^hasAnyAuthority$/, (args) => `authority:${String(args).match(/"([^"]+)"/)?.[1] ?? '?'}`],
  [/^denyAll$/, () => 'blocked'],
];
const firstLiteral = (s) => String(s).match(/"([^"]+)"/)?.[1] ?? '?';

function accessOf(rule, args) {
  for (const [re, make] of ACCESS) if (re.test(rule)) return make(args);
  return 'unknown';
}

// Spring Security chains. Each `securityMatcher` is the chain's scope; a chain without one covers every path.
export function springChains(java, fileMethods) {
  const rules = [];
  // Types this repo declares: a configurer applied here whose class is absent is a rule set the scan cannot read.
  const declared = new Set();
  for (const j of java)
    for (const m of String(j.text ?? '').matchAll(/\b(?:class|interface|enum|record)\s+(\w+)/g)) declared.add(m[1]);
  for (const j of java) {
    if (!/SecurityFilterChain/.test(j.text ?? '')) continue;
    const lines = j.text.split('\n');
    // The file's methods come from the model (`fileMethods`), not from a second parse of the source.
    const methodAt = (line) =>
      (fileMethods?.get(j.p) ?? [])
        .filter((m) => m.start <= line && line <= m.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    for (let i = 0; i < lines.length; i++) {
      if (!/\.securityMatcher\s*\(/.test(lines[i])) continue;
      const m = methodAt(i + 1);
      if (!m) continue;
      const body = lines.slice(m.start - 1, m.end).join('\n');
      const smAt = body.indexOf('securityMatcher');
      const open = body.indexOf('(', smAt);
      const sm = body.slice(open + 1, balanced(body, open));
      const scope = [...sm.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      const orderLine = [...lines.slice(Math.max(0, m.start - 6), m.start - 1)].reverse().find((l) => /@Order/.test(l));
      // The chain's own condition: a chain behind a profile or a property is not in force everywhere.
      const above = lines.slice(Math.max(0, m.start - 8), m.start - 1).join(' ');
      const cond = /@(ConditionalOnProperty|Profile)\(([^)]*)\)/.exec(above);
      const order = Number(/@Order\(\s*(\d+)\s*\)/.exec(orderLine ?? '')?.[1] ?? NaN);

      const authAt = body.indexOf('authorizeHttpRequests');
      // A configurer applied to this chain whose class the repo does not declare: its requestMatchers rules exist only
      // in that library, so this chain's paths are unknown — say so instead of reporting them as "unknown" with no
      // reason. Only `new X(...)` is claimed: a value passed to `apply` has no class the text can name.
      const applied = [...body.matchAll(/\.(?:apply|with)\s*\(\s*new\s+([\w.]+)\s*\(/g)]
        .map((x) => x[1])
        .find((fqn) => !declared.has(fqn.split('.').pop()));
      const before = rules.length;
      if (authAt >= 0) {
        const authOpen = body.indexOf('(', authAt);
        const block = body.slice(authOpen, balanced(body, authOpen) + 1);
        const ruleRe = /\.(requestMatchers|anyRequest)\s*\(([^)]*)\)\s*\.\s*([A-Za-z]+)\s*\(([^)]*)\)/g;
        for (const r of block.matchAll(ruleRe)) {
          const [, kind, args, fn, fnArgs] = r;
          // `requestMatchers(HttpMethod.OPTIONS, "/api/**")` applies to OPTIONS only; a matcher without a verb applies
          // to every method. Ignoring the verb made an OPTIONS-only permit open the whole API.
          const verbs = [...args.matchAll(/HttpMethod\.(\w+)/g)].map((x) => x[1].toUpperCase());
          const access = accessOf(fn, fnArgs);
          // `anyRequest()` means "everything this chain matches": its prefix is the chain's securityMatcher.
          const patterns =
            kind === 'anyRequest'
              ? scope.length
                ? scope
                : ['**']
              : [...args.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
          if (!patterns.length) continue;
          for (const pattern of patterns)
            rules.push({
              id: `security-rule:${pattern}:${access}${verbs.length ? `:${verbs.join(',')}` : ''}`,
              family: 'security-rule',
              confidence: 'resolved',
              source: 'spring-security',
              scope: scope.length ? scope : ['**'],
              pattern,
              verbs: verbs.length ? verbs : ['*'],
              access,
              ...(cond ? { condition: `${cond[1]}(${cond[2]})` } : {}),
              ...(applied ? { outside: applied } : {}),
              chain: `${m.name}${Number.isNaN(order) ? '' : ` (@Order(${order}))`}`,
              evidence: [`${j.p}:${i + 1}#${m.name}`],
              why: [
                `${kind === 'anyRequest' ? 'anyRequest' : `requestMatchers(${verbs.length ? `${verbs.join('/')}, ` : ''}"${pattern}")`} → ${fn}(${fnArgs})${cond ? ` [${cond[1]}]` : ''}`,
                ...(applied ? [`path rules also come from ${applied}, outside this repo: not seen`] : []),
              ],
            });
        }
      }
      // The chain's matcher is known but none of its rules are: the configurer it applies holds them, and that class is
      // not here. One rule per scope, so the prefix is reported with its reason instead of as a bare "unknown". A chain
      // without a matcher says nothing about which paths it governs, so its note claims no verb and shadows no rule.
      if (applied && rules.length === before)
        for (const pattern of scope.length ? scope : ['**'])
          rules.push({
            id: `security-rule:${pattern}:unknown:outside`,
            family: 'security-rule',
            confidence: 'inferred',
            source: 'spring-security',
            scope: scope.length ? scope : ['**'],
            pattern,
            verbs: scope.length ? ['*'] : [],
            access: 'unknown',
            outside: applied,
            chain: `${m.name} applies ${applied}`,
            evidence: [`${j.p}:${i + 1}#${m.name}`],
            why: [`path rules come from ${applied}, outside this repo: not seen`],
          });
    }
  }
  // @Order decides which chain sees a request first; a chain without an order sorts last.
  const orderOf = (r) => (Number(/@Order\((\d+)\)/.exec(r.chain)?.[1] ?? NaN));
  return rules.sort((a, b) => {
    const oa = orderOf(a),
      ob = orderOf(b);
    const na = Number.isNaN(oa) ? 1e6 : oa,
      nb = Number.isNaN(ob) ? 1e6 : ob;
    return na - nb;
  });
}

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

const globRe = (pattern) => {
  // `/**` also matches the prefix itself (Spring does): `/api/shop/**` covers `/api/shop`.
  const s = String(pattern)
    .replace(/\{[^}]+\}/g, '\x01')
    .replace(/\/\*\*$/, '\x02')
    .replace(/\*\*/g, '\x03')
    .replace(/\*/g, '\x04')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    '^' + s.replace(/\x01/g, '[^/]+').replace(/\x02/g, '(?:/.*)?').replace(/\x03/g, '.*').replace(/\x04/g, '[^/]*') + '$',
  );
};
// A rule only applies inside its chain's scope: `anyRequest().permitAll()` in the /api/shop/** chain does not open
// /api/admin/**, however wide the rule itself reads.
export const inScope = (rule, path) =>
  (rule.scope ?? ['**']).some((s) => globRe(s).test(path)) && globRe(rule.pattern).test(path);

// A rule applies to its path and its method: `HttpMethod.OPTIONS` or `===get` names one, `*` means every method.
const verbOk = (rule, verb) =>
  !verb || !rule.verbs || rule.verbs.includes('*') || rule.verbs.includes(String(verb).toUpperCase());
export const appliesTo = (rule, path, verb) => inScope(rule, path) && verbOk(rule, verb);

// The access a path gets: Spring Security evaluates its filter chains in @Order, and the first chain whose
// securityMatcher matches decides; inside a chain, the first matching requestMatchers rule decides.
export function accessFor(rules, path, verb) {
  for (const r of rules) if (appliesTo(r, path, verb)) return r.access;
  return 'unknown';
}

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
      why: [`${rule.pattern} allows anonymous access (${rule.source} ${rule.evidence[0]}) and this write endpoint has no @PreAuthorize/@Secured/@RolesAllowed`],
    });
  }
  return warnings;
}

// Where the tenant comes from: the place a tenant value is *stored* by behaviour — a ThreadLocal `.set`, a request
// attribute, RequestContextHolder, or a field of a @RequestScope bean — reached from a filter's doFilter / a
// HandlerInterceptor#preHandle within two calls. No name lists: the store is what counts. The stored value is traced
// back to a header read, a token claim or the path, with static final constants resolved.
export function tenantSources(model, textOf, isTest = () => false) {
  const facts = [];
  const body = (t, m) => {
    const text = textOf(t.file);
    return text.split('\n').slice(m.start - 1, m.end).join('\n');
  };
  const lineAt = (t, m, offsetText, needle) => {
    const start = m.start;
    const idx = offsetText.indexOf(needle);
    return idx < 0 ? start : start + offsetText.slice(0, idx).split('\n').length - 1;
  };
  // ThreadLocal fields per file, so `.set` on one is a store and `.set` on anything else is not.
  const tlsOf = new Map();
  for (const t of model.types.values()) {
    if (isTest(t.file)) continue;
    const names = [...textOf(t.file).matchAll(/ThreadLocal<[^>]*>\s+(\w+)/g)].map((x) => x[1]);
    if (names.length) tlsOf.set(t.file, names);
  }
  const stores = (t, m) => {
    const b = body(t, m);
    const tls = tlsOf.get(t.file) ?? [];
    const tl = tls.find((n) => new RegExp(`\\b${n}\\s*\\.\\s*set\\s*\\(`).test(b));
    if (tl) return `thread-local:${tl}`;
    if (/setAttribute\s*\(/.test(b)) return 'request-attribute';
    if (/RequestContextHolder/.test(b)) return 'request-context';
    if (/@RequestScope/.test(textOf(t.file)) && /this\.\w+\s*=/.test(b)) return 'request-scope-bean';
    return null;
  };
  const byId = new Map();
  for (const t of model.types.values()) for (const m of t.methods ?? []) byId.set(`${t.fqn}#${m.name}`, { t, m });
  const writeKind = new Map();
  for (const [id, { t, m }] of byId) {
    const k = stores(t, m);
    if (k) writeKind.set(id, k);
  }
  // A method that calls a writer one hop away is a writer too (the filter calls bindWorkspaceId on a holder class).
  const callsWriter = (t, m) =>
    writeKind.get(`${t.fqn}#${m.name}`) ?? (m.calls ?? []).map((c) => (c.targets ?? []).map((x) => writeKind.get(x.replace(/\(.*$/, ''))).find(Boolean)).find(Boolean);
  // Entry points: the servlet filter and the interceptor hook (framework method names, not project conventions).
  for (const t of model.types.values()) {
    if (isTest(t.file)) continue;
    for (const m of t.methods ?? []) {
      if (!/^(doFilter|preHandle)$/.test(m.name)) continue;
      // Reachable within two calls: the entry, its callees, and their callees (same class or a holder class).
      const reach = [{ t, m }];
      for (const c of m.calls ?? [])
        for (const tg of c.targets ?? []) {
          const hit = byId.get(tg.replace(/\(.*$/, ''));
          if (hit) reach.push(hit);
        }
      for (const r of [...reach].slice(1))
        for (const c of r.m.calls ?? [])
          for (const tg of c.targets ?? []) {
            const hit = byId.get(tg.replace(/\(.*$/, ''));
            if (hit) reach.push(hit);
          }
      const writer = reach.find(({ t: wt, m: wm }) => callsWriter(wt, wm));
      if (!writer) continue;
      const kind = callsWriter(writer.t, writer.m) ?? 'store';
      const storedField = String(kind).includes(':') ? String(kind).split(':')[1] : null;
      const valueName = storedField ? storedField.toLowerCase().replace(/_id$|_/g, (m) => (m === '_id' ? 'Id' : ' ')).replace(/ (.)/g, (_, c) => c.toUpperCase()) : null;
      const texts = reach.map(({ t: rt, m: rm }) => ({ t: rt, m: rm, b: body(rt, rm) }));
      // Origin: header (constants resolved), else token, else path — searched across the reachable bodies.
      let origin = null;
      const headers = [];
      for (const x of texts) {
        const consts = new Map([...textOf(x.t.file).matchAll(/(?:static\s+final|final\s+static)\s+String\s+(\w+)\s*=\s*"([^"]*)"/g)].map((z) => [z[1], z[2]]));
        for (const hm of x.b.matchAll(/getHeader\s*\(\s*([^)]*)\)/g)) {
          const lit = /^"([^"]+)"$/.exec(hm[1].trim());
          const name = lit ? lit[1] : (hm[1].split(/[.,]/).map((z) => z.trim()).find((z) => consts.has(z)) ? consts.get(hm[1].split(/[.,]/).map((z) => z.trim()).find((z) => consts.has(z))) : null);
          if (name) headers.push({ kind: 'header', name, cite: `${x.t.file}:${lineAt(x.t, x.m, x.b, hm[0])}` });
        }
      }
      if (headers.length) origin = headers[0];
      if (!origin && texts.some((x) => /getClaim\s*\(|claim\(|SubjectSum|resolveSubject|token/i.test(x.b)))
        origin = { kind: 'token', name: valueName ?? 'token claim', cite: `${writer.t.file}:${writer.m.start}` };
      if (!origin && texts.some((x) => /getRequestURI|getPathInfo|getServletPath/.test(x.b)))
        origin = { kind: 'path', name: 'request path', cite: `${t.file}:${m.start}` };
      if (!origin) continue;
      const all = headers.length ? headers : [origin];
      for (const o of all) facts.push({
        id: `tenant-source:${o.kind}:${o.name}@${m.name}`,
        family: 'tenant-source',
        confidence: origin.kind === 'token' || origin.kind === 'path' ? 'inferred' : 'resolved',
        kind: o.kind,
        name: o.name,
        method: `${t.name}#${m.name}`,
        storedBy: kind.split(':')[0],
        evidence: [`${writer.t.file}:${writer.m.start}#${writer.m.name}`, o.cite],
        why: [
          `${writer.t.name}#${writer.m.name} stores the tenant into a ${kind.split(':')[0]}`,
          `the value read here comes from ${o.kind} ${o.name} (${o.cite})`,
        ],
      });
    }
  }
  const seen = new Set();
  return facts.filter((f) => !seen.has(`${f.kind}:${f.name}`) && seen.add(`${f.kind}:${f.name}`));
}

// --- Shiro, Jakarta EE, method-level checks, and the model in one fact -------------------------------

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
    const access = /^anon\b/.test(expr) ? 'anonymous' : roles ? `role:${roles.replace(/"/g, '').split(',')[0].trim()}` : 'authenticated';
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

// Shiro's code-based chain (`filterChainDefinitionMap.put("/api/**", "authc")`, `addPathDefinition`).
export function shiroCodeRules(model, textOf) {
  const rules = [];
  for (const t of model.types.values()) {
    if (!/ShiroFilterChainDefinition|ShiroFilterFactoryBean/.test(t.name)) continue;
    const text = textOf(t.file);
    for (const m of text.matchAll(/put\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)|addPathDefinition\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
      const pattern = m[1] ?? m[3];
      const expr = m[2] ?? m[4];
      const access = /anon/.test(expr) ? 'anonymous' : /roles\[([^\]]+)\]/.exec(expr)?.[1] ? `role:${/roles\[([^\]]+)\]/.exec(expr)[1].split(',')[0].trim()}` : 'authenticated';
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

// Jakarta EE: @RolesAllowed/@PermitAll/@DenyAll on a class or a method, and method-level @PreAuthorize/@Secured.
// The expression or role list is recorded, not interpreted.
export function methodSecurityFacts(model, meansOf) {
  const facts = [];
  const index = new Map();
  for (const t of model.types.values()) {
    const tAnn = (t.ann ?? []).filter((a) => ['method-security', 'permit-all', 'deny-all'].includes(meansOf(a.fqn, 'type')));
    if (tAnn.length) index.set(t.fqn, true);
    for (const m of t.methods ?? []) {
      const anns = [...tAnn.map((a) => ({ ...a, from: 'class' })), ...(m.ann ?? []).filter((a) => ['method-security', 'permit-all', 'deny-all'].includes(meansOf(a.fqn, 'method')))];
      if (!anns.length) continue;
      index.set(`${t.fqn}#${m.name}`, true);
      for (const a of anns) {
        const means = meansOf(a.fqn, 'method');
        const access = means === 'permit-all' ? 'anonymous' : means === 'deny-all' ? 'denied' : `checked:${(a.args ?? '').replace(/^\(|\)$/g, '').trim() || a.name}`;
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
        why: [`<url-pattern>${pattern}</url-pattern> with ${roles.length ? `<role-name>${roles.join(',')}</role-name>` : 'no role (denied)'}`],
      });
    }
  }
  return rules;
}

// Authentication sources, found the same way as tenant sources: from a filter's entry, follow calls two deep, and ask
// what a reached method *stores* (security context, request attribute, ThreadLocal). A filter that stores the caller
// and reads an Authorization/token header is an API-token source. Sureness's configured processors come from catalog
// data (`auth-type`), not from names.
//
// The caller's identity also arrives in cookies — one cookie switching to a system-user context, another naming the
// clerk to act as. Cookies are read (and named) here next to headers, because a filter that trusts one is a user
// source no matter how the value arrived.

// A store of the caller for the user-source fact: any holder a filter fills, from the security context to a
// ThreadLocal or a request attribute. A user source says where the caller comes from; the warning below is stricter
// and needs a *security* holder.
const STORES_CALLER =
  /setAuthentication\s*\(|SecurityContextHolder|setAttribute\s*\(|\b[A-Z][A-Z0-9_]{2,}\s*\.\s*set\s*\(/;

// A verification call is a property of its receiver's *type*, never of a method or class name: `validate` on a
// WorkspaceValidator checks a workspace, `decode` on a cache parses a cache key, and a filter named
// *AuthenticationFilter may still trust whatever arrives.
const VERIFIER_TYPES = new Set([
  'org.springframework.security.authentication.AuthenticationManager',
  'org.springframework.security.authentication.ProviderManager',
  'org.springframework.security.oauth2.jwt.JwtDecoder',
  'io.jsonwebtoken.JwtParser',
  'java.security.MessageDigest',
  'javax.crypto.Mac',
  'java.security.Signature',
  'org.springframework.security.crypto.password.PasswordEncoder',
  'org.springframework.security.oauth2.server.resource.web.BearerTokenResolver',
]);
const VERIFIER_SIMPLE = new Set([...VERIFIER_TYPES].map((fqn) => fqn.split('.').pop()));
// The app's own token service, also by type: a receiver the app declares whose type name ends in TokenService.
const TOKEN_SERVICE = /TokenService$/;
// The security holders themselves: the context a caller is made current in, and Spring Security's caller slots.
const SECURITY_CONTEXT = 'org.springframework.security.core.context.SecurityContext';
const CALLER_SIMPLE = new Set(['Authentication', 'Principal']);

const baseType = (text) => String(text ?? '').replace(/<[\s\S]*/, '').replace(/\[\]/g, '').trim();
const simpleType = (text) => baseType(text).split('.').pop();

// A value of a type the project declares — a User, a ResolvedTenantContext — is an identity once a holder keeps it.
// A String, a primitive or a JDK type (an IP, a request id, an idempotency key) is request bookkeeping: that is the
// whole distinction, and it is the value's type, never the holder's name.
const PRIMITIVE = /^(?:void|boolean|byte|char|short|int|long|float|double)$/;
const JDK_VALUE = new Set([
  'String', 'Object', 'Integer', 'Long', 'Short', 'Byte', 'Boolean', 'Character', 'Double', 'Float', 'Number',
  'UUID', 'URI', 'URL', 'Instant', 'LocalDate', 'LocalDateTime', 'Duration', 'BigDecimal', 'BigInteger',
  'InetAddress', 'InetSocketAddress', 'Optional',
]);
const isProjectValueType = (model, file, written) => {
  const text = baseType(written);
  if (!text || PRIMITIVE.test(text)) return false;
  const fqn = fqnOf(model, file, text);
  if (fqn) return Boolean(model.types?.has(fqn));
  // No import answered: a simple name the project declares is still the project's type.
  const simple = text.split('.').pop();
  if (JDK_VALUE.has(simple)) return false;
  for (const key of model.types?.keys() ?? []) if (key.split('.').pop() === simple) return true;
  return false;
};

// The element type of `ThreadLocal<X>`, as written; null for any other field type.
const threadLocalElement = (type) =>
  /(?:^|\.)ThreadLocal\s*<(.*)>$/.exec(String(type ?? '').trim())?.[1]?.trim() ?? null;

// A written type's FQN, from the file's imports. Null when the file does not name it: the caller of these helpers
// still reads the written simple name, so an import that is missing never hides a type.
const fqnOf = (model, file, written) => {
  const text = baseType(written);
  if (!text) return null;
  return model.resolveIn?.(file, text) ?? null;
};

// The declared type of every name a method can hold: its parameters, its class's fields (the model resolved those),
// and the locals its body declares. The dump carries no locals, and a local's type is written only in the source.
const LOCAL_DECL = /(?:^|[;{(\s])([A-Z][\w.]*(?:\s*<[^;=(){}]*>)?)\s+([a-z_]\w*)\s*[=;,)]/g;
function declaredTypes(t, m, b) {
  const out = new Map();
  for (const p of m.params ?? []) if (p.name) out.set(p.name, p.type ?? '');
  for (const f of t.fields ?? []) if (f.name) out.set(f.name, f.typeFqn ?? f.type ?? '');
  for (const d of b.matchAll(LOCAL_DECL)) if (!out.has(d[2])) out.set(d[2], d[1]);
  return out;
}

// The type a call is made on: the receiver's compiler answer when the dump has one, else the declared type of the
// receiver's name, as written.
const receiverTypeOf = (c, declared, model, file) => {
  const name = c.recv?.kind === 'name' ? c.recv.text : null;
  const written = name ? declared.get(name) : null;
  return c.recvFqn ?? (written ? fqnOf(model, file, written) : null) ?? (written ? baseType(written) : null);
};

const isVerifierType = (type, model) => {
  if (!type) return false;
  const simple = simpleType(type);
  return (
    VERIFIER_TYPES.has(type) ||
    VERIFIER_SIMPLE.has(simple) ||
    (TOKEN_SERVICE.test(simple) && (model.types?.has(type) || type === simple))
  );
};

// A verification call in the entry method or within two hops of it, in the same file. This is what makes a cookie
// read a fact about where the caller comes from instead of a warning about believing it.
function verifiesIn(model, bodies, file) {
  for (const x of bodies) {
    if (x.t.file !== file) continue;
    const declared = declaredTypes(x.t, x.m, x.b);
    for (const c of x.m.calls ?? []) {
      const type = receiverTypeOf(c, declared, model, x.t.file);
      if (isVerifierType(type, model))
        return { type, cite: `${x.t.file}:${c.line ?? x.m.start}` };
    }
  }
  return null;
}

// A security identity holder a method writes, with the text of the value it stores there. A caller slot counts: the
// security context, an Authentication/Principal field, a project method called with a caller parameter. So does the
// app's own context holder — a ThreadLocal (or a project method filling one) whose element type the project declares,
// because storing a ResolvedTenantContext or a User there makes it the request's identity just the same. A
// ThreadLocal of a String (an IP, a request id, a workspace id), a request attribute or a context holder of a JDK type
// is a user-source fact and never a warning.
function securitySinks(t, m, b, model, byId, textOf = null) {
  const sinks = [];
  const declared = declaredTypes(t, m, b);
  const lineAt = (idx) => Math.max(1, m.start + b.slice(0, idx).split('\n').length - 1);
  const argAt = (open) => {
    const close = balanced(b, open);
    return b.slice(open + 1, close < 0 ? b.length : close);
  };
  // SecurityContextHolder.getContext().setAuthentication(value) — the framework's own way to make a caller current.
  for (const s of b.matchAll(/SecurityContextHolder\s*\.\s*getContext\s*\(\s*\)\s*\.\s*setAuthentication\s*\(/g))
    sinks.push({
      what: 'SecurityContextHolder.getContext().setAuthentication',
      cite: `${t.file}:${lineAt(s.index)}`,
      arg: argAt(s.index + s[0].length - 1),
    });
  // SecurityContext.setAuthentication(value): the same store through a SecurityContext the method holds.
  for (const s of b.matchAll(/(\w+)\s*\.\s*setAuthentication\s*\(/g)) {
    if (s[1] === 'SecurityContextHolder') continue;
    const written = declared.get(s[1]) ?? '';
    if (fqnOf(model, t.file, written) === SECURITY_CONTEXT || simpleType(written) === 'SecurityContext')
      sinks.push({
        what: `${s[1]}.setAuthentication`,
        cite: `${t.file}:${lineAt(s.index)}`,
        arg: argAt(s.index + s[0].length - 1),
      });
  }
  // A field of the caller type (`Authentication`, `Principal`) that the method assigns.
  for (const f of t.fields ?? []) {
    const fqn = f.typeFqn ?? fqnOf(model, t.file, f.type);
    if (!CALLER_SIMPLE.has(simpleType(f.type ?? '')) && !CALLER_SIMPLE.has(simpleType(fqn ?? ''))) continue;
    const a = new RegExp(`(?:this\\s*\\.\\s*)?\\b${f.name}\\s*=\\s*([^;]+)`).exec(b);
    if (a)
      sinks.push({
        what: `field ${f.name} (${simpleType(f.type ?? fqn)})`,
        cite: `${t.file}:${lineAt(a.index)}`,
        arg: a[1],
      });
  }
  // A context holder of the app's own: a ThreadLocal field whose element type the project declares (a
  // ResolvedTenantContext, a User, a *Context object). Not Spring Security's, and still the request's identity. A
  // ThreadLocal<String> (an IP, a request id, an idempotency key) is excluded by the type alone.
  for (const f of t.fields ?? []) {
    const element = threadLocalElement(f.type);
    if (!element || !isProjectValueType(model, t.file, element)) continue;
    const a = new RegExp(`\\b${f.name}\\s*\\.\\s*set\\s*\\(`).exec(b);
    if (!a) continue;
    const arg = argAt(a.index + a[0].length - 1);
    // A setter that only forwards its own parameter is the caller's store one frame up: the call site below carries
    // it, and counting both would make two warnings for one store.
    if ((m.params ?? []).some((p) => p.name && p.name === arg.trim())) continue;
    sinks.push({
      what: `thread-local ${f.name} (${simpleType(element)})`,
      cite: `${t.file}:${lineAt(a.index)}`,
      arg,
    });
  }
  // A call handing the value to a project method whose parameter is the caller: `void bind(Authentication caller)`.
  // The same store one frame up when the parameter is a project type the method puts in a project-typed holder and the
  // value is built here: `setResolvedContext(new ResolvedTenantContext(user))` is the filter storing the user, not
  // merely reading it. A record the method looked up (`setTenant(tenant)`) is a tenant-source fact, not an identity.
  for (const c of m.calls ?? [])
    for (const hit of targetHits(model, t.file, c, byId)) {
      const args = c.args ?? [];
      const callerAt = (hit.m.params ?? []).findIndex((p) => {
        const type = fqnOf(model, hit.t.file, p.type) ?? baseType(p.type);
        return CALLER_SIMPLE.has(simpleType(type));
      });
      const slot = callerAt >= 0
        ? { name: hit.m.params[callerAt].name, arg: args.join(', ') || null }
        : projectHolderSlot(model, hit, args, b, textOf);
      if (!slot) continue;
      sinks.push({
        what: `${hit.t.name}#${hit.m.name}(${slot.name})`,
        cite: `${t.file}:${c.line ?? m.start}`,
        arg: slot.arg,
      });
    }
  return sinks;
}

// The project methods a call reaches. A static call (`TenantContext.setContext(...)`) names its type as the receiver:
// when the dump or the fixture linker left the call without targets, the receiver's own type answers, as javac would.
function targetHits(model, file, c, byId) {
  const hits = [];
  for (const tg of c.targets ?? []) {
    const hit = byId.get(tg) ?? byId.get(String(tg).replace(/\(.*$/, ''));
    if (hit) hits.push(hit);
  }
  if (hits.length) return hits;
  const name = c.recv?.kind === 'name' ? c.recv.text : null;
  if (!name || !/^[A-Z]/.test(name)) return hits;
  const fqn = model.resolveIn?.(file, name) ?? null;
  const hit = fqn && model.types?.has(fqn) ? byId.get(`${fqn}#${c.name}`) : null;
  return hit ? [hit] : hits;
}

// The parameter of a project method that stands for an identity: a project-typed value the method stores in a
// ThreadLocal holder of the project's own type (its parameter is the only thing it can be storing). Null when the
// method is no such holder, or when the value at this call is not built here — `new UserContext(user)` is the
// client's id becoming an identity; a `User` the method looked up by that id is the same thing one hop away only
// when some holder holds it, which is what the type gate already decides.
function projectHolderSlot(model, hit, args, callerBody, textOf) {
  if (!textOf) return null;
  const heldBody = String(textOf(hit.t.file) ?? '').split('\n').slice(hit.m.start - 1, hit.m.end).join('\n');
  const holder = (hit.t.fields ?? []).find((f) => {
    const element = threadLocalElement(f.type);
    if (!element || !isProjectValueType(model, hit.t.file, element)) return false;
    const set = new RegExp(`\\b${f.name}\\s*\\.\\s*set\\s*\\(([^)]*)\\)`).exec(heldBody);
    // Only a setter that stores its own parameter: anything else is a store this method builds, found in its body.
    return Boolean(set && (hit.m.params ?? []).some((p) => p.name && p.name === set[1].trim()));
  });
  if (!holder) return null;
  for (const [i, p] of (hit.m.params ?? []).entries()) {
    if (!isProjectValueType(model, hit.t.file, p.type)) continue;
    const built = builtValue(args[i], callerBody, model, hit.t.file);
    if (built) return { name: p.name, arg: built };
  }
  return null;
}

// The project value a call passes: `new Context(user)`, or the construction the caller's own body assigns to the
// name it passes (`ResolvedTenantContext ctx = new ResolvedTenantContext(user); setResolvedContext(ctx);`).
const builtValue = (argText, callerBody, model, file) => {
  const text = String(argText ?? '').trim();
  const inline = /^new\s+([\w.]+)\s*\(/.exec(text);
  if (inline) return isProjectValueType(model, file, inline[1]) ? text : null;
  const name = /^(\w+)$/.exec(text)?.[1];
  if (!name) return null;
  const assigned = new RegExp(`\\b${name}\\s*=\\s*([^;]+)`).exec(String(callerBody ?? ''));
  const made = assigned ? /^new\s+([\w.]+)\s*\(/.exec(assigned[1].trim()) : null;
  return made && isProjectValueType(model, file, made[1]) ? assigned[1].trim() : null;
};

// The value the client sent has to reach the holder. A read the code only compares, logs, or hands to a check and
// nothing else does not become the caller. Followed one assignment deep (`user = users.loadByLogin(actor)`); when the
// read's variable cannot be named — the servlet cookie loop compares a name, then takes getValue() — the read itself
// is the source and the warning stands.
function valueReaches(read, bodies, arg) {
  const value = read.value;
  if (!value || !arg) return true;
  const mentions = (text, name) => new RegExp(`\\b${name}\\b`).test(text);
  if (mentions(arg, value)) return true;
  for (const name of new Set(String(arg).match(/\b[a-z_]\w*\b/g) ?? [])) {
    if (name === value) continue;
    for (const { b } of bodies)
      for (const a of b.matchAll(new RegExp(`\\b${name}\\s*=\\s*([^;]*)`, 'g')))
        if (mentions(a[1], value)) return true;
  }
  return false;
}

// `static final String NAME = "value"` per file: a cookie or header name is usually one of these.
const constantMap = (text) =>
  new Map(
    [...text.matchAll(/(?:static\s+final|final\s+static)\s+String\s+(\w+)\s*=\s*"([^"]*)"/g)].map((z) => [z[1], z[2]]),
  );

// The name in a read's argument list: a literal, or a constant of the same file (qualified or imported statically).
const nameOf = (expr, consts) => {
  const lit = /^\s*"([^"]+)"\s*$/.exec(String(expr ?? '').trim())?.[1];
  if (lit) return lit;
  const ref = String(expr ?? '')
    .split(/[.,]/)
    .map((x) => x.trim())
    .reverse()
    .find((z) => consts.has(z));
  return ref ? consts.get(ref) : null;
};

// Cookie reads: `"actAs".equals(cookie.getName())`, `cookie.getName().equals("actAs")`, and
// `WebUtils.getCookie(request, "actAs")`. The servlet loop names its cookie at the comparison, not at getCookies().
const COOKIE_READ = new RegExp(
  [
    '"([^"]+)"\\s*\\.\\s*equals(?:IgnoreCase)?\\s*\\(\\s*\\w+\\s*\\.\\s*getName\\s*\\(\\s*\\)\\s*\\)',
    '(\\w+)\\s*\\.\\s*getName\\s*\\(\\s*\\)\\s*\\.\\s*equals(?:IgnoreCase)?\\s*\\(\\s*"([^"]+)"\\s*\\)',
    'getCookie\\s*\\(\\s*[^,]+,\\s*([^)]+)\\)',
  ].join('|'),
  'g',
);

// Every value a filter reads off the request as a possible identity, with the line it is read on and the name it
// lands in (the variable a later store can be followed to).
function requestReads(x, consts) {
  const out = [];
  const lineOf = (needle, idx) => x.m.start + x.b.slice(0, idx).split('\n').length - 1;
  const assignedTo = (idx) => /(\w+)\s*=\s*[^;=]*$/.exec(x.b.slice(Math.max(0, idx - 200), idx))?.[1] ?? null;
  for (const m of x.b.matchAll(/getHeader\s*\(\s*([^)]*)\)/g)) {
    // A header name that does not resolve (`HttpHeaders.AUTHORIZATION`) is reported as written: the reader still has to
    // see which header the filter reads, and the old fact did the same.
    const name = nameOf(m[1], consts) ?? String(m[1]).replace(/["']/g, '').trim();
    if (name)
      out.push({
        kind: 'header',
        name,
        value: assignedTo(m.index),
        cite: `${x.t.file}:${Math.max(1, lineOf(m[0], m.index))}`,
      });
  }
  const cookieValue = /\b(\w+)\s*=\s*\w+\s*\.\s*getValue\s*\(\s*\)/.exec(x.b)?.[1] ?? null;
  for (const m of x.b.matchAll(COOKIE_READ)) {
    const name = m[1] ?? m[3] ?? nameOf(m[4], consts);
    const cite = `${x.t.file}:${Math.max(1, lineOf(m[0], m.index))}`;
    out.push({ kind: 'cookie', name: name ?? 'unnamed cookie', value: cookieValue, cite });
  }
  // @CookieValue is a cookie read the model resolves: the name is in the annotation.
  for (const p of x.m.params ?? [])
    for (const a of p.ann ?? [])
      if (/(?:^|\.)CookieValue$/.test(a.fqn ?? '')) {
        const name = nameOf(a.args, consts);
        if (name) out.push({ kind: 'cookie', name, value: p.name ?? null, cite: `${x.t.file}:${a.line ?? x.m.nameLine}` });
      }
  return out;
}

// Project methods by id and by `Type#name`, which is how a call's targets are written.
function methodIndex(model) {
  const byId = new Map();
  for (const t of model.types.values())
    for (const m of t.methods ?? []) {
      const entry = { t, m };
      byId.set(m.id ?? `${t.fqn}#${m.name}`, entry);
      byId.set(`${t.fqn}#${m.name}`, entry);
    }
  return byId;
}

// The entry method, its callees and their callees (same class or a holder class), each once.
function reachOf(t, m, byId) {
  const reach = [{ t, m }];
  const seen = new Set([`${t.fqn}#${m.name}`]);
  const follow = (from) => {
    for (const c of from.m.calls ?? [])
      for (const tg of c.targets ?? []) {
        const hit = byId.get(tg) ?? byId.get(tg.replace(/\(.*$/, ''));
        const key = hit ? `${hit.t.fqn}#${hit.m.name}` : null;
        if (!hit || seen.has(key)) continue;
        seen.add(key);
        reach.push(hit);
      }
  };
  follow({ m });
  for (const r of [...reach].slice(1)) follow(r);
  return reach;
}

export function authSources(model, textOf, isTest = () => false) {
  const facts = [];
  const byId = methodIndex(model);
  const body = (t, m) => textOf(t.file).split('\n').slice(m.start - 1, m.end).join('\n');
  for (const t of model.types.values()) {
    if (isTest(t.file)) continue;
    for (const m of t.methods ?? []) {
      if (!/^(doFilter|doFilterInternal|preHandle)$/.test(m.name)) continue;
      const bodies = reachOf(t, m, byId).map(({ t: rt, m: rm }) => ({ t: rt, m: rm, b: body(rt, rm) }));
      const stores = bodies.find((x) => STORES_CALLER.test(x.b));
      if (!stores) continue;
      const reads = bodies.flatMap((x) => requestReads(x, constantMap(textOf(x.t.file))));
      // The same verification the warning uses: the receiver's type, never the method's name.
      const verified = Boolean(verifiesIn(model, bodies, t.file));
      const cookie = reads.find((r) => r.kind === 'cookie');
      if (cookie) {
        // The unverified state belongs in the kind: it is the one field of a user source the digest keeps, and a
        // caller the code believes without checking it is what a reader has to know.
        facts.push({
          id: `user-source:cookie:${t.name}:${cookie.name}`,
          family: 'user-source',
          confidence: 'resolved',
          kind: `cookie ${cookie.name}${verified ? '' : ' (unverified)'}`,
          method: `${t.name}#${m.name}`,
          name: cookie.name,
          verified,
          evidence: [`${cookie.cite}#${m.name}`],
          why: [
            `${t.name}#${m.name} reads cookie ${cookie.name} and stores the caller (${stores.b.trim().slice(0, 60)})`,
            verified
              ? 'a verification call runs before the caller is stored'
              : 'nothing verifies the cookie: the caller asserts its own identity',
          ],
        });
        continue;
      }
      const headerLine = reads.find(
        (r) => r.kind === 'header' && /authorization|bearer|token|api[-_]?key/i.test(r.name),
      );
      if (!headerLine) continue;
      facts.push({
        id: `user-source:api-token:${t.name}`,
        family: 'user-source',
        confidence: 'resolved',
        kind: 'API token',
        method: `${t.name}#${m.name}`,
        name: headerLine.name,
        evidence: [`${headerLine.cite}#${m.name}`],
        why: [
          `${t.name}#${m.name} reads the ${headerLine.name} header and stores the caller (${stores.b.trim().slice(0, 60)})`,
        ],
      });
    }
  }
  return facts;
}

// The caller the code believes because the request said so. Two conditions, both required: the value reaches a
// *security* identity holder (the security context, an Authentication/Principal slot, or a holder of the app's own
// whose type the project declares), and no verification call is reachable in the same method (same file, two hops)
// from a receiver of a security-library or token-service type. Anything less certain stays a user source — a
// ThreadLocal of an IP, a request id or a workspace id is not a caller.
// One warning per (method, holder): every source that reaches that holder is listed in the one entry.
export function identityWarnings(model, textOf, isTest = () => false) {
  const warnings = [];
  const byId = methodIndex(model);
  const body = (t, m) => textOf(t.file).split('\n').slice(m.start - 1, m.end).join('\n');
  for (const t of model.types.values()) {
    if (isTest(t.file)) continue;
    for (const m of t.methods ?? []) {
      if (!/^(doFilter|doFilterInternal|preHandle)$/.test(m.name)) continue;
      const bodies = reachOf(t, m, byId).map(({ t: rt, m: rm }) => ({ t: rt, m: rm, b: body(rt, rm) }));
      // The sink decides first: without a security holder there is no warning to make, whatever is read.
      const holders = new Map();
      for (const x of bodies)
        for (const sink of securitySinks(x.t, x.m, x.b, model, byId, textOf)) {
          const key = `${x.t.name}#${x.m.name}`;
          if (!holders.has(key)) holders.set(key, { x, sinks: [] });
          holders.get(key).sinks.push(sink);
        }
      if (!holders.size) continue;
      if (verifiesIn(model, bodies, t.file)) continue;
      // One entry per value the client can send, not per place it was read.
      const reads = [
        ...new Map(
          bodies.flatMap((x) => requestReads(x, constantMap(textOf(x.t.file)))).map((r) => [`${r.kind}:${r.name}`, r]),
        ).values(),
      ];
      for (const [key, { x, sinks }] of holders) {
        const used = reads.filter((r) => sinks.some((s) => valueReaches(r, bodies, s.arg)));
        if (!used.length) continue;
        warnings.push({
          id: `security-warning:client-asserted-identity@${t.name}:${key}`,
          family: 'security-warning',
          confidence: 'inferred',
          kind: 'client-asserted-identity',
          method: `${t.name}#${m.name}`,
          source: used.map((r) => `${r.kind}:${r.name}`).join(', '),
          holder: key,
          evidence: [...used.map((r) => r.cite), `${x.t.file}:${x.m.start}#${x.m.name}`],
          why: [
            `${t.name}#${m.name} takes the caller from ${used.map((r) => `${r.kind} ${r.name} (${r.cite})`).join(', ')}`,
            `${key} stores it as the caller (${[...new Set(sinks.map((s) => s.what))].join(', ')}) with no verification ` +
              'call: any client can claim that identity',
          ],
        });
      }
    }
  }
  return warnings;
}

{
  // Type reading: a local's type comes from the source, a verification call from its receiver's type, and a read that
  // never reaches the holder is not a caller.
  const model = {
    types: new Map([
      ['shop.Svc', { fqn: 'shop.Svc', file: 'x', methods: [], fields: [] }],
      ['shop.JwtTokenService', { fqn: 'shop.JwtTokenService', file: 'x', methods: [], fields: [] }],
      ['shop.TwoFactorService', { fqn: 'shop.TwoFactorService', file: 'x', methods: [], fields: [] }],
    ]),
    resolveIn: () => null,
  };
  const t = { fqn: 'shop.F', name: 'F', file: 'src/F.java', fields: [] };
  const m = { name: 'doFilterInternal', start: 1, end: 4, params: [], calls: [] };
  const b = ['SecurityContext context = SecurityContextHolder.getContext();', 'context.setAuthentication(user);'].join('\n');
  assert.deepStrictEqual([...declaredTypes(t, m, b)], [['context', 'SecurityContext']]);
  assert.deepStrictEqual(securitySinks(t, m, b, model, new Map()).map((s) => s.what), ['context.setAuthentication']);
  assert.deepStrictEqual(
    securitySinks(t, m, 'ThreadLocal<String> ID = new ThreadLocal<>();\nID.set(id);', model, new Map()),
    [],
  );
  assert.ok(isVerifierType('org.springframework.security.oauth2.jwt.JwtDecoder', model));
  assert.ok(isVerifierType('java.security.MessageDigest', model));
  assert.ok(isVerifierType('shop.JwtTokenService', model));
  assert.ok(!isVerifierType('shop.TwoFactorService', model));
  assert.ok(!isVerifierType('java.lang.String', model));
  // The value's type decides an identity holder: a project type is one, a String or a JDK type is not.
  assert.equal(threadLocalElement('ThreadLocal<User>'), 'User');
  assert.equal(threadLocalElement('ThreadLocal<Map<String, Object>>'), 'Map<String, Object>');
  assert.equal(threadLocalElement('String'), null);
  assert.ok(isProjectValueType(model, 'x', 'Svc'));
  assert.ok(!isProjectValueType(model, 'x', 'String'));
  assert.ok(!isProjectValueType(model, 'x', 'long'));
  assert.ok(
    valueReaches({ kind: 'cookie', name: 'actAs', value: 'actor' }, [{ b: 'User u = users.loadByLogin(actor);' }], 'u'),
  );
  assert.ok(
    !valueReaches(
      { kind: 'header', name: 'T', value: 'token' },
      [{ b: 'TfaToken t = tfa.fetch(user, token);\nAuthentication updated = addAuthority(authentication);' }],
      'updated',
    ),
  );
}

// The model in one fact: prefixes and their access, where the user and the tenant come from, and what a developer
// adding an endpoint in a prefix has to do — all derived from the rules and from how existing endpoints are protected.
export function securityModel({ rules, endpoints, methodSecurity = [], tenancy = null, userSources = [], baseControllers = new Set() }) {
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
  const checksCount = (p) => methodSecurity.filter((f) => p.checks.some((c) => c === `${f.annotation}${f.args || ''}`)).length;
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
    // A prefix rule is stated only when every endpoint under the prefix has it. The modal value used to be reported as
    // the prefix's rule, so `/api/v1/**: role:role:X` covered 142 endpoints when only the external
    // controllers carried the annotation and the rest were merely authenticated. A share ("role:A on 95 of 142") still
    // names the commonest check, which is what a reader acts on, and never claims it for the whole prefix.
    const mixed = ranked.length > 1;
    const access = mixed ? `${modal} on ${n} of ${eps.length}` : modal;
    const example = eps.find((e) => accessOfEndpoint(e) === modal) ?? eps[0];
    const checks = eps.flatMap(checkedFor).map((f) => `${f.annotation}${f.args || ''}`).filter((x, i, a) => a.indexOf(x) === i);
    const checkedCount = eps.filter((e) => checkedFor(e).length).length;
    prefixes.push({
      prefix,
      access,
      endpoints: eps.length,
      agreement: Math.round((n / eps.length) * 100),
      ...(mixed ? { dominant: modal, accessCounts: counts } : {}),
      example: `${example.verb} ${example.path}`,
      checks,
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
  // Sibling prefixes under one parent with the same access are one zone (`/health/live`, `/health/ready` → `/health/**`).
  const merged = [];
  const byParent = new Map();
  for (const p of prefixes) {
    if (/\.[a-z]{2,5}$/.test(p.prefix)) { merged.push(p); continue; }
    const parent = '/' + p.prefix.split('/').filter(Boolean)[0] + '/**';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(p);
  }
  for (const [parent, list] of byParent) {
    if (list.length > 1 && parent !== '/**' && list.every((p) => p.access === list[0].access) && !list.some((p) => p.prefix === parent)) {
      merged.push({ ...list[0], prefix: parent, endpoints: list.reduce((a, p) => a + p.endpoints, 0), checked: list.reduce((a, p) => a + p.checked, 0), why: [`${list.length} sibling prefixes with the same access`] });
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
              ? `endpoints under ${p.prefix} are public: ${p.checks.length ? `${p.checked} of ${p.endpoints} use ${p.checks[0]}; the rest must protect themselves` : 'each endpoint must protect itself'}`
              : p.access === 'authenticated'
                ? `endpoints under ${p.prefix} need a logged-in caller${p.checked ? `; ${p.checked} of ${p.endpoints} also use ${p.checks[0]}` : ''}`
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
      ? { key: tenancy.key, sources: tenancy.sources.slice(0, 4), cites: (tenancy.sources[0]?.evidence ?? []).slice(0, 1) }
      : null,
    why: [`${prefixes.length} prefixes from ${rules.length} rules and ${endpoints.length} endpoints`],
  };
}
