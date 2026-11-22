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

// Where the tenant comes from: a request header or a token claim. Only names that read as a tenant are kept.
export function tenantSources(java) {
  const facts = [];
  for (const j of java) {
    const t = j.text ?? '';
    // `request.getHeader(HEADER_HOST)` names a constant; read the file's own `static final String` values.
    const consts = new Map(
      [...t.matchAll(/(?:static\s+final|final\s+static)\s+String\s+(\w+)\s*=\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    const argName = (raw) => {
      const lit = /"([^"]+)"/.exec(raw);
      if (lit) return lit[1];
      const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(raw);
      return id ? consts.get(id[1]) ?? null : null;
    };
    const HEADER_ARG = /getHeader\(\s*([^)]+?)\s*\)|header\(\s*([^)]+?)\s*\)/g;
    const CLAIM_ARG = /getClaim(?:AsString)?\(\s*([^)]+?)\s*\)/g;
    if (!/HttpServletRequest|Jwt|JwtAuthenticationToken|getClaim/.test(t)) continue;
    const lines = t.split('\n');
    const add = (kind, name, line) => {
      const m = j.ix.methods.filter((x) => x.start <= line && line <= x.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      facts.push({
        id: `tenant-source:${kind}:${name}${m ? `@${m.name}` : ''}`,
        family: 'tenant-source',
        confidence: 'resolved',
        kind,
        name,
        method: m ? `${j.p}#${m.name}` : j.p,
        evidence: [`${j.p}:${line}${m ? `#${m.name}` : ''}`],
        why: [kind === 'header' ? `read from the request header ${name}` : `read from the token claim ${name}`],
      });
    };
    lines.forEach((l, i) => {
      for (const m of l.matchAll(HEADER_ARG)) {
        const name = argName(m[1] ?? m[2] ?? '');
        if (name && TENANT_WORDS.test(name)) add('header', name, i + 1);
      }
      for (const m of l.matchAll(CLAIM_ARG)) {
        const name = argName(m[1] ?? '');
        if (name && TENANT_WORDS.test(name)) add('token', name, i + 1);
      }
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------
// A chain per scope, a rule per prefix, an anonymous write under /api/shop/**, and the header the tenant comes from.
{
  const L = (...x) => x.join('\n');
  const cfg = {
    p: 'src/a/SecurityConfig.java',
    text: L(
      'package a;',
      'class SecurityConfig {',
      '  @Bean',
      '  @Order(1)',
      '  SecurityFilterChain internal(HttpSecurity http) {',
      '    http.securityMatcher("/api/internal/**")',
      '      .authorizeHttpRequests(auth -> auth',
      '        .anyRequest().hasRole("ADMIN"))',
      '      .httpBasic(basic -> {});',
      '    return http.build();',
      '  }',
      '  @Bean',
      '  @Order(2)',
      '  SecurityFilterChain tenant(HttpSecurity http) {',
      '    http.securityMatcher("/api/shop/**")',
      '      .authorizeHttpRequests(auth -> auth',
      '        .requestMatchers("/api/shop/products/**").permitAll()',
      '        .requestMatchers(HttpMethod.OPTIONS, "/api/shop/ops/**").permitAll()',
      '        .anyRequest().authenticated())',
      '      .oauth2ResourceServer(o -> o.jwt(j -> j.decoder(d())));',
      '    return http.build();',
      '  }',
      '}',
    ),
  };
  cfg.ix = { methods: [
    { name: 'internal', start: 5, end: 11 },
    { name: 'tenant', start: 14, end: 21 },
  ] };
  const rules = springChains([cfg], new Map());
  assert.deepStrictEqual(
    rules.map((r) => [r.pattern, r.access, r.chain]),
    [
      ['/api/internal/**', 'role:ADMIN', 'internal (@Order(1))'],
      ['/api/shop/products/**', 'anonymous', 'tenant (@Order(2))'],
      ['/api/shop/ops/**', 'anonymous', 'tenant (@Order(2))'],
      ['/api/shop/**', 'authenticated', 'tenant (@Order(2))'],
    ],
  );
  // The chain scope travels with the rule, and a matcher with an HTTP method carries it.
  assert.deepStrictEqual(rules.find((r) => r.pattern === '/api/shop/ops/**').verbs, ['OPTIONS']);
  assert.deepStrictEqual(rules.find((r) => r.pattern === '/api/shop/**').verbs, ['*']);
  assert.deepStrictEqual(rules.find((r) => r.pattern === '/api/shop/**').scope, ['/api/shop/**']);

  const endpoints = [
    { verb: 'POST', path: '/api/shop/products', handlerFqn: 'a.ShopController', handler: 'ShopController.createOffer', evidence: ['src/a/ShopController.java:20#createOffer'] },
    { verb: 'GET', path: '/api/shop/products', handlerFqn: 'a.ShopController', handler: 'ShopController.listOffers', evidence: ['src/a/ShopController.java:30#listOffers'] },
    { verb: 'PUT', path: '/api/admin/settings', handlerFqn: 'a.AdminController', handler: 'AdminController.update', evidence: ['src/a/AdminController.java:10#update'] },
    { verb: 'POST', path: '/api/shop/ops/run', handlerFqn: 'a.OpsController', handler: 'OpsController.run', evidence: ['src/a/OpsController.java:10#run'] },
  ];
  const warnings = anonymousWrites(rules, endpoints, new Map([['a.ShopController', false], ['a.AdminController', false]]));
  // Only the anonymous write with no method-level check is warned: an OPTIONS-only permit does not open a POST.
  assert.deepStrictEqual(warnings.map((w) => [w.verb, w.path, w.handler]), [
    ['POST', '/api/shop/products', 'a.ShopController#createOffer'],
  ]);
  // A method-level check silences it.
  const silenced = anonymousWrites(rules, endpoints, new Map([['a.ShopController', true]]));
  assert.deepStrictEqual(silenced, []);

  const yml = ['excludedResource:', '  - /api/push/**===*', 'resourceRole:', '  - /api/x===get===[admin]'].join('\n');
  const sr = surenessRules(yml, 'src/main/resources/sureness.yml');
  assert.deepStrictEqual(sr.map((r) => [r.pattern, r.access]), [
    ['/api/push/**', 'anonymous'],
    ['/api/x', 'role:admin'],
  ]);

  const interceptor = {
    p: 'src/a/RequestContextInterceptor.java',
    text: L(
      'class RequestContextInterceptor {',
      '  boolean preHandle(HttpServletRequest request) {',
      '    String host = request.getHeader("X-Forwarded-Host");',
      '    String tenant = jwt.getClaimAsString("tenant");',
      '  }',
      '}',
    ),
    ix: { methods: [{ name: 'preHandle', start: 2, end: 5 }] },
  };
  const ts = tenantSources([interceptor]);
  assert.deepStrictEqual(ts.map((t) => [t.kind, t.name]), [
    ['header', 'X-Forwarded-Host'],
    ['token', 'tenant'],
  ]);
}
