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
  for (const j of java) {
    if (!/SecurityFilterChain/.test(j.text ?? '')) continue;
    const lines = j.text.split('\n');
    const methodAt = (line) => j.ix.methods.filter((m) => m.start <= line && line <= m.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
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
      if (authAt < 0) continue;
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
            chain: `${m.name}${Number.isNaN(order) ? '' : ` (@Order(${order}))`}`,
            evidence: [`${j.p}:${i + 1}#${m.name}`],
            why: [
              `${kind === 'anyRequest' ? 'anyRequest' : `requestMatchers(${verbs.length ? `${verbs.join('/')}, ` : ''}"${pattern}")`} → ${fn}(${fnArgs})${cond ? ` [${cond[1]}]` : ''}`,
            ],
          });
      }
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
    const checked = (methodSecurity.get(e.handlerFqn) ?? false) || (methodSecurity.get(`${e.handlerFqn}#${String(e.handler ?? '').split('.').pop()}`) ?? false);
    if (checked) continue;
    warnings.push({
      id: `security-warning:anonymous-write@${e.verb} ${e.path}`,
      family: 'security-warning',
      confidence: 'resolved',
      kind: 'anonymous-write',
      path: e.path,
      verb: e.verb,
      handler: e.handlerFqn ? `${e.handlerFqn}#${String(e.handler ?? '').split('.').pop()}` : null,
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
export function authSources(model, textOf, isTest = () => false) {
  const facts = [];
  const byId = new Map();
  const body = (t, m) => textOf(t.file).split('\n').slice(m.start - 1, m.end).join('\n');
  for (const t of model.types.values()) for (const m of t.methods ?? []) byId.set(`${t.fqn}#${m.name}`, { t, m });
  for (const t of model.types.values()) {
    if (isTest(t.file)) continue;
    for (const m of t.methods ?? []) {
      if (!/^(doFilter|doFilterInternal|preHandle)$/.test(m.name)) continue;
      const reach = [{ t, m }];
      for (const c of m.calls ?? []) for (const tg of c.targets ?? []) {
        const hit = byId.get(tg.replace(/\(.*$/, ''));
        if (hit) reach.push(hit);
      }
      for (const r of [...reach].slice(1)) for (const c of r.m.calls ?? []) for (const tg of c.targets ?? []) {
        const hit = byId.get(tg.replace(/\(.*$/, ''));
        if (hit) reach.push(hit);
      }
      const bodies = reach.map(({ t: rt, m: rm }) => ({ t: rt, m: rm, b: body(rt, rm) }));
      // A store into the security context, a request attribute, or a static ThreadLocal field (`NAME.set(...)`).
      const stores = bodies.find((x) => /setAuthentication\s*\(|SecurityContextHolder|setAttribute\s*\(|\b[A-Z][A-Z0-9_]{2,}\s*\.\s*set\s*\(/.test(x.b));
      if (!stores) continue;
      const headerLine = bodies
        .flatMap((x) => [...x.b.matchAll(/getHeader\s*\(\s*([^)]*)\)/g)].map((hm) => ({ name: hm[1].replace(/["']/g, '').trim(), t: x.t, m: x.m, idx: hm.index, b: x.b })))
        .find((h) => /authorization|bearer|token|api[-_]?key/i.test(h.name));
      if (!headerLine) continue;
      const line = headerLine.m.start + headerLine.b.slice(0, headerLine.idx).split('\n').length - 1;
      facts.push({
        id: `user-source:api-token:${t.name}`,
        family: 'user-source',
        confidence: 'resolved',
        kind: 'API token',
        method: `${t.name}#${m.name}`,
        name: headerLine.name,
        evidence: [`${headerLine.t.file}:${Math.max(1, line + 1)}#${m.name}`],
        why: [`${t.name}#${m.name} reads the ${headerLine.name} header and stores the caller (${stores.b.trim().slice(0, 60)})`],
      });
    }
  }
  return facts;
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
  const checkedFor = (e) =>
    methodSecurity.filter(
      (f) => f.type === e.handlerFqn || f.method === `${e.handlerFqn}#${String(e.handler ?? '').split('.').pop()}`,
    );
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
    const [access, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? ['unknown', 0];
    const example = eps.find((e) => accessOfEndpoint(e) === access) ?? eps[0];
    const checks = eps.flatMap(checkedFor).map((f) => `${f.annotation}${f.args || ''}`).filter((x, i, a) => a.indexOf(x) === i);
    const checkedCount = eps.filter((e) => checkedFor(e).length).length;
    prefixes.push({
      prefix,
      access,
      endpoints: eps.length,
      agreement: Math.round((n / eps.length) * 100),
      example: `${example.verb} ${example.path}`,
      checks,
      checked: checkedCount,
      evidence: [...new Set(eps.map((e) => e.evidence?.[1] ?? e.evidence?.[0]).filter(Boolean))].slice(0, 3),
      why: [`${n} of ${eps.length} endpoints under ${prefix} are ${access}`, checks.length ? `method checks used: ${checks.join(', ')}` : 'no method-level checks'],
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
  const developerRule = merged
    .filter((p) => p.endpoints >= 2)
    .slice(0, 8)
    .map((p) => ({
      text:
        p.access === 'anonymous'
          ? `endpoints under ${p.prefix} are public: ${p.checks.length ? `${p.checked} of ${p.endpoints} use ${p.checks[0]}; the rest must protect themselves` : 'each endpoint must protect itself'}`
          : p.access === 'authenticated'
            ? `endpoints under ${p.prefix} need a logged-in caller${p.checked ? `; ${p.checked} of ${p.endpoints} also use ${p.checks[0]}` : ''}`
            : p.access.startsWith('role:')
              ? `endpoints under ${p.prefix} need role ${p.access.slice(5)}`
              : `endpoints under ${p.prefix} are ${p.access}`,
      cites: p.evidence,
    }));
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
