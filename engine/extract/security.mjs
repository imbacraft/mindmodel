import assert from 'node:assert/strict';
import { queries } from '../model/query.mjs';
import { targetIds } from '../model/targets.mjs';

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
// One call chained to another is written with the chain's own position, so the rows of one chain share `line:col` and
// Spoon lists them from the outside in: reversing a group gives the chain's source order.
const chainOrder = (calls) => {
  const groups = new Map();
  for (const c of calls) {
    const k = `${c.line ?? 0}:${c.col ?? 0}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const [al, ac] = a.split(':').map(Number);
      const [bl, bc] = b.split(':').map(Number);
      return al - bl || ac - bc;
    })
    .flatMap(([, list]) => list.slice().reverse());
};
const ACCESS_CALLS = new Set([
  'permitAll', 'authenticated', 'hasRole', 'hasAnyRole', 'hasAuthority', 'hasAnyAuthority', 'denyAll',
]);
const HTTP_METHOD = /HttpMethod\.(\w+)/;
const dumpArgs = (db, call) => (db && call?.id ? db.argsOf(call.id) : []);
// The string values an argument list folds to: a literal's or a constant's value, never a variable's name.
const stringValues = (rows) => rows.map((a) => (typeof a?.value === 'string' ? a.value : null)).filter((v) => v !== null);
// An argument as a rule's reason displays it: a string in quotes, anything else by the name the dump wrote.
const shownArg = (a) => (typeof a?.value === 'string' ? `"${a.value}"` : String(a?.text ?? ''));
const annOfElement = (element, names) => (element?.ann ?? []).find((a) => names.includes(a.name));

function accessOf(rule, args) {
  for (const [re, make] of ACCESS) if (re.test(rule)) return make(args);
  return 'unknown';
}

// Spring Security chains, from the dump's call rows: `securityMatcher(...)` states a chain's scope, and each
// `requestMatchers(...)`/`anyRequest()` in it is paired with the access call chained to it (`permitAll()`, `hasRole("X")`).
// The arguments are the dump's typed values; `HttpMethod.OPTIONS` names a verb and applies to OPTIONS only.
export function springChains(model, db = model?.dump ?? null) {
  const rules = [];
  if (!db) return rules;
  // Types this repo declares: a configurer applied here whose class is absent is a rule set the scan cannot read.
  const declared = new Set([...model.types.values()].map((t) => t.name));
  for (const t of model.types.values())
    for (const m of t.methods ?? []) {
      const calls = chainOrder((m.calls ?? []).filter((c) => c.id));
      const matchers = calls.filter((c) => c.name === 'securityMatcher');
      for (const [n, sm] of matchers.entries()) {
        const at = calls.indexOf(sm);
        const next = matchers[n + 1];
        const span = calls.slice(at + 1, next ? calls.indexOf(next) : undefined);
        const scope = stringValues(dumpArgs(db, sm));
        const order = Number(/^\s*(-?\d+)/.exec(annOfElement(m, ['Order'])?.args ?? '')?.[1] ?? NaN);
        // The chain's own condition: a chain behind a profile or a property is not in force everywhere.
        const cond =
          annOfElement(m, ['ConditionalOnProperty', 'Profile']) ?? annOfElement(t, ['ConditionalOnProperty', 'Profile']);
        // A configurer applied to this chain whose class the repo does not declare: its requestMatchers rules exist only
        // in that library, so this chain's paths are unknown — say so instead of reporting them as "unknown" with no
        // reason. Only `new X(...)` is claimed: a value passed to `apply` has no class the dump can name.
        const applied = span
          .filter((c) => c.name === 'apply' || c.name === 'with')
          .flatMap((c) => dumpArgs(db, c))
          .filter((a) => a?.kind === 'new' && a.created)
          .map((a) => a.created)
          .find((fqn) => !declared.has(fqn.split('.').pop()));
        const before = rules.length;
        const authAt = span.findIndex((c) => c.name === 'authorizeHttpRequests');
        let matcher = null;
        for (const c of span.slice(authAt < 0 ? span.length : authAt)) {
          if (c.name === 'requestMatchers' || c.name === 'anyRequest') {
            matcher = c;
            continue;
          }
          if (!matcher || !ACCESS_CALLS.has(c.name)) continue;
          const rows = dumpArgs(db, matcher);
          // `requestMatchers(HttpMethod.OPTIONS, "/api/**")` applies to OPTIONS only; a matcher without a verb applies
          // to every method. Ignoring the verb made an OPTIONS-only permit open the whole API.
          const verbs = rows
            .map((a) => HTTP_METHOD.exec(String(a?.text ?? ''))?.[1])
            .filter(Boolean)
            .map((v) => v.toUpperCase());
          const shown = dumpArgs(db, c).map(shownArg).join(', ');
          const fn = `${c.name}(${shown})`;
          const access = accessOf(c.name, shown);
          // `anyRequest()` means "everything this chain matches": its prefix is the chain's securityMatcher.
          const anyRequest = matcher.name === 'anyRequest';
          const patterns = anyRequest ? (scope.length ? scope : ['**']) : stringValues(rows);
          matcher = null;
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
              ...(cond ? { condition: `${cond.name}(${cond.args})` } : {}),
              ...(applied ? { outside: applied } : {}),
              chain: `${m.name}${Number.isNaN(order) ? '' : ` (@Order(${order}))`}`,
              evidence: [`${t.file}:${sm.line}#${m.name}`],
              why: [
                `${anyRequest ? 'anyRequest' : `requestMatchers(${verbs.length ? `${verbs.join('/')}, ` : ''}"${pattern}")`} → ${fn}${cond ? ` [${cond.name}]` : ''}`,
                ...(applied ? [`path rules also come from ${applied}, outside this repo: not seen`] : []),
              ],
            });
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
              evidence: [`${t.file}:${sm.line}#${m.name}`],
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

// --- the dump door: shared by everything below ------------------------------------------------------------
// The extractors read code only through `engine/model/query.mjs`. `model.dump` is the handle the model was built from
// (one dump per scan); a test may hand the dump in instead. Without one every primitive answers `no-dump` and the
// facts below come out empty with a reason — never filled in from source text.
const simple = (name) => String(name ?? '').split('.').pop();
const baseType = (text) => String(text ?? '').replace(/<[\s\S]*/, '').replace(/\[\]/g, '').trim();
const simpleType = (text) => baseType(text).split('.').pop();
// The entry methods this repo reads identity and context from: framework method names, not project conventions.
const IDENTITY_ENTRY = /^(doFilter|doFilterInternal|preHandle)$/;
// A tenant store is asked of `stores()`, the same definition security uses; the entry set is the doc's (doFilter and
// preHandle), so a `doFilterInternal` filter stays a user source without becoming a tenant source, as before.
const TENANT_ENTRY = /^(doFilter|preHandle)$/;

/** The constant name an argument carries, or null: the dump folded it, so this never reads a written expression. */
const nameOfValue = (value) =>
  value && ['constant', 'literal', 'string'].includes(value.kind) && typeof value.value === 'string'
    ? value.value
    : null;

/** Every value of one argument across its call sites, with the values the dump could not resolve kept apart. */
const argValues = (q, call, i) => q.argValue(call, i);

/** The one constant an argument resolves to, or null when the dump answers none (or several disagree). */
const constantArg = (q, call, i) => {
  const names = argValues(q, call, i).values.map((v) => nameOfValue(v.value)).filter(Boolean);
  return names.length && new Set(names).size === 1 ? names[0] : null;
};

/** A project type's FQN from a type as written (a holder's element, an argument's created type), or null. */
const projectType = (model, written) => {
  const text = baseType(written);
  if (!text) return null;
  if (model.types?.has(text)) return text;
  const hits = [...(model.types?.keys() ?? [])].filter((k) => simple(k) === simple(text));
  return hits.length === 1 ? hits[0] : null;
};

/** A member's file and declaration line, so a store can be cited where it is written. */
const memberAt = (db, id) => db?.members?.get(id) ?? null;
const memberFile = (db, id) => memberAt(db, id)?.pos?.file ?? null;
const memberLine = (db, id) => memberAt(db, id)?.pos?.line ?? null;

// One call row by id: the loader indexes calls by owning method, and an argument names the call it came from.
const CALLS = new WeakMap();
const callById = (db, id) => {
  if (!id) return null;
  let byId = CALLS.get(db);
  if (!byId) CALLS.set(db, (byId = new Map(db.calls.map((c) => [c.id, c]))));
  return byId.get(id) ?? null;
};

/**
 * A request read: a call to a library method of `HttpServletRequest`/`Cookie` (or `@CookieValue`/`@RequestHeader`,
 * whose name sits on the parameter) whose name argument the dump resolved. A helper that compares its own parameter
 * to a constant is followed with `comparedTo`: the name is the constant the caller passes.
 */
export function requestReads(entryId, q, db, model, depth = 2, methods = null) {
  const reads = [];
  const unresolved = [];
  const reach = methods ?? q.reach(entryId, depth).methods;
  const libraryCall = (c) => c.recv?.type && !db.types.has(c.recv.type);
  const requestRecv = (c) =>
    libraryCall(c) && ['HttpServletRequest', 'ServletRequest'].includes(simpleType(c.recv.type));
  const cookieRecv = (c) => libraryCall(c) && simpleType(c.recv.type) === 'Cookie';
  // A cookie is only read where one is in reach: `getName()` names it, `getValue()` reads it. Without that, a helper
  // comparing its parameter to a constant is a host check, not a cookie name.
  const cookieInReach = reach.some(({ id }) =>
    db.callsOf(id).some((c) => ['getName', 'getValue'].includes(c.name) && cookieRecv(c)),
  );
  for (const { id } of reach) {
    const member = memberAt(db, id);
    const file = member?.pos?.file ?? member?.file ?? null;
    if (!member) continue;
    const calls = db.callsOf(id);
    const cite = (c) => `${c.file}:${c.line}`;
    // The cookie value read in this method, if any: the comparison names the cookie, `getValue()` reads it.
    const valueRead = calls.find((c) => c.name === 'getValue' && cookieRecv(c)) ?? null;
    for (const c of calls) {
      // A header: `request.getHeader(NAME)`, the name a constant or a literal the dump folded.
      if (c.name === 'getHeader' && requestRecv(c)) {
        const name = constantArg(q, c, 0);
        if (name) reads.push({ kind: 'header', name, value: c.id, cite: cite(c), call: c.id, method: id });
        else {
          const why = argValues(q, c, 0).unresolved[0]?.reason ?? 'no-constant';
          unresolved.push({ ...siteOf(c), what: 'header', reason: why });
        }
      }
      // `WebUtils.getCookie(request, NAME)`: a library call whose last argument is the cookie's name.
      if (c.name === 'getCookie' && libraryCall(c) && (c.args ?? []).length) {
        const name = constantArg(q, c, (c.args ?? []).length - 1);
        if (name)
          reads.push({ kind: 'cookie', name, value: valueRead?.id ?? c.id, cite: cite(c), call: c.id, method: id });
        else unresolved.push({ ...siteOf(c), what: 'cookie', reason: 'no-constant' });
      }
      // A cookie named at a comparison: `"actAs".equals(c.getName())` or `c.getName().equals("actAs")`.
      if (['equals', 'equalsIgnoreCase', 'contentEquals'].includes(c.name)) {
        const named = (c.args ?? []).some((a, i) => {
          const inner = a?.kind === 'call' ? callById(db, a.call) : null;
          return Boolean(inner && inner.name === 'getName' && cookieRecv(inner));
        });
        const chained = c.recv?.how === 'chain' && /getName\s*\(\s*\)/.test(String(c.recv.text ?? ''));
        if (!named && !chained) continue;
        // The name is the other side of the comparison: an argument that resolves, or a constant receiver.
        const other = (c.args ?? []).map((_, i) => constantArg(q, c, i)).find(Boolean);
        const name = other ?? (chained ? null : constantNameAt(db, id, c));
        if (name)
          reads.push({ kind: 'cookie', name, value: valueRead?.id ?? null, cite: cite(c), call: c.id, method: id });
        else
          // `"actAs".equals(c.getName())`: the name is the receiver, and the dump records a receiver's written text,
          // not its value. Unresolved with that reason, never parsed out of the text.
          unresolved.push({ ...siteOf(c), what: 'cookie-name', reason: 'receiver-is-not-a-value' });
      }
    }
    // A helper that compares its own parameter to a constant: the cookie name is what the caller passes.
    for (const [index, param] of (cookieInReach ? member.params ?? [] : []).entries()) {
      if (!param.name) continue;
      const found = q.comparedTo({ method: id, index }).comparisons;
      for (const cmp of found) {
        const row = callById(db, cmp.call);
        if (!row) continue;
        const name =
          (row.args ?? []).map((_, i) => constantArg(q, row, i)).find(Boolean) ??
          constantNameAt(db, member.owner, row);
        if (name)
          reads.push({
            kind: 'cookie',
            name,
            value: valueRead?.id ?? null,
            cite: `${row.file}:${row.line}`,
            call: row.id,
            method: id,
            via: 'helper',
          });
      }
      if (found.length && !reads.some((r) => r.method === id && r.kind === 'cookie'))
        unresolved.push({ method: id, what: 'cookie-name', reason: 'helper-name-not-resolved' });
    }
    // `@CookieValue("x")` / `@RequestHeader("X")`: the annotation names the value the parameter carries.
    for (const param of member.params ?? [])
      for (const a of param.ann ?? []) {
        const cookie = /(?:^|\.)CookieValue$/.test(a.name ?? '');
        const kind = cookie ? 'cookie' : /(?:^|\.)RequestHeader$/.test(a.name ?? '') ? 'header' : null;
        if (!kind) continue;
        const name = annotationName(a);
        if (name)
          reads.push({
            kind,
            name,
            value: param.name ?? null,
            cite: `${file}:${a.line ?? member.pos?.line}`,
            method: id,
          });
        else unresolved.push({ method: id, what: kind, reason: 'annotation-value-not-in-dump' });
      }
  }
  return { reads, unresolved };
}

const siteOf = (c) => ({ method: c.method ?? null, call: c.id ?? null, file: c.file ?? null, line: c.line ?? null });

/** A constant written as a call's receiver (`NAME.equals(x)`): the dump names the field, its row carries the value. */
const constantNameAt = (db, owner, row) => {
  const written = simpleType(row.recv?.text ?? '');
  if (!written || !/^[A-Z]/.test(written)) return null;
  const value = db.constant(owner, written);
  return typeof value?.value === 'string' ? value.value : null;
};

/** The name an annotation argument carries: the resolved `value` when the dump has it, else its own written text. */
export function annotationName(a) {
  const resolved = a?.args?.value;
  if (typeof resolved === 'string' && resolved) return resolved;
  const raw = String(a?.raw ?? a?.args ?? '');
  const named = /(?:^|,)\s*value\s*=\s*"([^"]*)"/.exec(raw)?.[1];
  if (named) return named;
  const first = /^\s*"([^"]*)"/.exec(raw)?.[1];
  return first || null;
}

// Where the tenant comes from: a store an entry performs — `stores()`, one definition shared with security — and
// the request value that feeds it. A claim read outranks a header read: a filter that reads a header *and* a claim
// stores what the claim said, and the header is only checked against it. Then the path. Nothing is read from text.
export function tenantSources(model, _textOf, isTest = () => false, db = null) {
  const d = db ?? model?.dump ?? null;
  const q = queries(d);
  const facts = [];
  for (const t of model.types?.values() ?? []) {
    if (isTest(t.file)) continue;
    for (const m of t.methods ?? []) {
      if (!TENANT_ENTRY.test(m.name ?? '')) continue;
      const id = m.id ?? `${t.fqn}#${m.name}`;
      const { methods } = q.reach(id, 2);
      // The tenant is *stored*: a holder write, a request attribute, the security context. A clear is not a store.
      // A tenant is kept in a holder or a request attribute. The security context is the *caller*, not the tenant:
      // `stores()` knows that store too, and counting it here would make every authenticated request a tenant source.
      const stores = methods.flatMap(({ id: mid }) =>
        q.stores(mid, 0).stores.filter((s) => s.op !== 'clear' && s.kind !== 'security-context'),
      );
      if (!stores.length) continue;
      const writer = stores[0];
      const storedBy =
        writer.kind === 'request-attribute'
          ? 'request-attribute'
          : writer.kind === 'holder'
            ? 'thread-local'
            : 'security-context';
      const fieldName = writer.field
        ? String(writer.field).split('#').pop()
        : writer.holder
          ? simpleType(writer.holder)
          : null;
      const valueName = fieldName ? camelName(fieldName) : null;
      const writerCite = `${memberFile(d, writer.method) ?? t.file}:${memberLine(d, writer.method) ?? m.start}`;
      const reads = requestReads(id, q, d, model, 2, methods).reads;
      const headers = reads.filter((r) => r.kind === 'header');
      const claim = claimReadIn(methods, d);
      const path = pathReadIn(methods, d);
      const origin = claim
        ? { kind: 'token', name: valueName ?? 'token claim', cite: writerCite }
        : headers.length
          ? headers[0]
          : path
            ? { kind: 'path', name: 'request path', cite: `${path.file}:${path.line}` }
            : null;
      if (!origin) continue;
      const all = origin.kind === 'header' ? headers : [origin];
      for (const o of all)
        facts.push({
          id: `tenant-source:${o.kind}:${o.name}@${m.name}`,
          family: 'tenant-source',
          confidence: o.kind === 'token' || o.kind === 'path' ? 'inferred' : 'resolved',
          kind: o.kind,
          name: o.name,
          method: `${t.name}#${m.name}`,
          storedBy,
          evidence: [`${writerCite}#${String(writer.method).split('#').pop()}`, o.cite],
          why: [
            `${simple(String(writer.method).split('#')[0])}#${String(writer.method).split('#').pop()} ` +
              `stores the tenant into a ${storedBy}`,
            `the value read here comes from ${o.kind} ${o.name} (${o.cite})`,
          ],
        });
    }
  }
  const seen = new Set();
  return facts.filter((f) => !seen.has(`${f.kind}:${f.name}`) && seen.add(`${f.kind}:${f.name}`));
}

// `AUTHENTICATED_WORKSPACE_ID` -> `authenticatedWorkspaceId`: the field a value is stored in, named the way the code
// names the value. A name the dump wrote, never a word list.
const camelName = (field) =>
  String(field)
    .toLowerCase()
    .replace(/_id$|_/g, (x) => (x === '_id' ? 'Id' : ' '))
    .replace(/ (.)/g, (_, c) => c.toUpperCase());

/** A call in the reach that reads a token claim: what makes the stored tenant a claim rather than a header. */
const claimReadIn = (methods, db) => {
  for (const { id } of methods)
    for (const c of db.callsOf(id))
      if (/claim/i.test(c.name ?? '') || /^(get|resolve|read|load|parse).*(Subject|Token)/i.test(c.name ?? ''))
        return c;
  return null;
};
const pathReadIn = (methods, db) => {
  for (const { id } of methods)
    for (const c of db.callsOf(id)) if (['getRequestURI', 'getServletPath', 'getPathInfo'].includes(c.name)) return c;
  return null;
};

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

// --- identity: the caller the request says it is ----------------------------------------------------------

// A verification call is a property of its receiver's *type*, never of a method or class name: `validate` on a
// WorkspaceValidator checks a workspace, `decode` on a cache parses a cache key, and a filter whose name says
// *AuthenticationFilter may still trust whatever arrives. The type is the dump's receiver answer.
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
// The caller slots: a field, or a project method's parameter, that carries the authenticated caller itself.
const CALLER_SIMPLE = new Set(['Authentication', 'Principal']);

const isVerifierType = (type, model) => {
  if (!type) return false;
  const name = simpleType(type);
  return (
    VERIFIER_TYPES.has(type) ||
    VERIFIER_SIMPLE.has(name) ||
    (TOKEN_SERVICE.test(name) && (model.types?.has(type) || type === name))
  );
};

// A value of a type the project declares — a User, a ResolvedTenantContext — is an identity once a holder keeps it.
// A String, a primitive or a JDK type (an IP, a request id, an idempotency key) is request bookkeeping: that is the
// whole distinction, and it is the value's type, never the holder's name.
const isIdentityType = (model, written) => Boolean(projectType(model, written));

/**
 * The stores a method performs: `stores()`'s own list, plus the store-shaped calls it could not tie to a receiver — a
 * chained library call (`SecurityContextHolder.getContext().setAuthentication(x)`) arrives with no receiver type, so
 * the dump calls it `receiver-untyped` instead of naming the holder. An unknown never clears a warning: those gaps are
 * kept, marked `unresolved`, and only for the calls that store an identity.
 */
function identityStores(q, id, db) {
  const { stores, unresolved } = q.stores(id, 0);
  const kept = stores.filter((s) => s.op !== 'clear');
  for (const gap of unresolved)
    if (/%?(setAuthentication|setContext)$/.test(gap.name ?? '') && /receiver-untyped$/.test(gap.reason ?? ''))
      kept.push({
        kind: 'security-context',
        holder: null,
        how: gap.name,
        unresolved: true,
        method: gap.method,
        call: gap.call,
        file: gap.file,
        line: gap.line,
        args: callById(db, gap.call)?.args ?? [],
      });
  return kept;
}

/** A store as one short phrase, for the `why` line a writer reads. */
const storeLabel = (store, db) => {
  const row = callById(db, store.call);
  const recv = row?.recv?.type ? `${simpleType(row.recv.type)}.` : '';
  return `${recv}${row?.name ?? store.kind}(${row?.args?.map((a) => a.text).join(', ') ?? ''})`;
};

/**
 * The verification calls in a reach: a call whose receiver's type is a verifier. This is what makes a cookie read a
 * fact about where the caller comes from instead of a warning about believing it — the receiver's type, never a name
 * of the calling method.
 */
function verifiesIn(methods, db, model) {
  for (const { id } of methods)
    for (const c of db.callsOf(id))
      if (isVerifierType(c.recv?.type, model)) return { type: c.recv.type, cite: `${c.file}:${c.line}` };
  return null;
}

/**
 * The identity sinks a reach performs, each with the value it stores: the security context made current, a holder of
 * the project's own type (`ThreadLocal<User>`, `ThreadLocal<ResolvedTenantContext>`), a caller-typed field, or a
 * project method handed the caller. A ThreadLocal<String> is a user source and never a sink: the element type decides.
 */
function securitySinks(entryId, q, db, model, holders) {
  const sinks = [];
  const { methods } = q.reach(entryId, 2);
  for (const { id } of methods) {
    const member = memberAt(db, id);
    if (!member) continue;
    const label = `${simple(member.owner)}#${member.name}`;
    const params = member.params ?? [];
    for (const store of identityStores(q, id, db)) {
      const args = store.args ?? callById(db, store.call)?.args ?? [];
      if (store.kind === 'security-context') {
        const recv = callById(db, store.call)?.recv?.type;
        sinks.push({
          method: label,
          what:
            `${store.unresolved ? 'unresolved:' : ''}${simpleType(recv ?? 'SecurityContext')}.` +
            `${store.how ?? 'setAuthentication'}`,
          cite: `${store.file}:${store.line}`,
          arg: args[0] ?? null,
        });
        continue;
      }
      if (store.kind !== 'holder') continue; // a request attribute is a user source, not a security sink
      const holder = holders.find((h) => h.field === store.field);
      if (!holder || !isIdentityType(model, holder.element)) continue;
      // A setter that only forwards its own parameter is the caller's store one frame up: the call site carries it,
      // and counting both would make two warnings for one store.
      if (args[0]?.kind === 'param' && params[args[0].index]?.name === args[0].text) continue;
      sinks.push({
        method: label,
        what: `thread-local ${String(store.field).split('#').pop()} (${simpleType(holder.element)})`,
        cite: `${store.file}:${store.line}`,
        arg: args[0] ?? null,
      });
    }
    // A field of the caller type (`Authentication`, `Principal`) the method assigns: the dump's own field write.
    for (const f of db.fields ?? [])
      if (f.method === id && f.op === 'write' && f.field) {
        const field = db.members.get(f.field);
        if (!CALLER_SIMPLE.has(simpleType(field?.type ?? field?.typeFqn ?? ''))) continue;
        sinks.push({
          method: label,
          what: `field ${String(f.field).split('#').pop()} (${simpleType(field?.type)})`,
          cite: `${f.file}:${f.line}`,
          arg: f.value ?? null,
        });
      }
    // A call handing the value to a project method whose parameter is the caller, or whose own parameter it stores
    // in a holder of a project type (`setResolvedContext(new ResolvedTenantContext(user))`).
    for (const c of db.callsOf(id))
      for (const target of targetIds(c)) {
        const hit = memberAt(db, target);
        if (!hit || hit.kind !== 'method') continue;
        const callerAt = (hit.params ?? []).findIndex((p) => CALLER_SIMPLE.has(simpleType(p.type)));
        if (callerAt >= 0) {
          sinks.push({
            method: label,
            what: `${simple(hit.owner)}#${hit.name}(${hit.params[callerAt].name})`,
            cite: `${c.file}:${c.line}`,
            arg: c.args?.[callerAt] ?? null,
            weak: true,
          });
          continue;
        }
        const slot = projectHolderSlot(hit, c, q, db, model);
        if (slot)
          sinks.push({
            method: label,
            what: `${simple(hit.owner)}#${hit.name}(${slot.name})`,
            cite: `${c.file}:${c.line}`,
            arg: slot.arg,
            weak: true,
          });
      }
  }
  return sinks;
}

/**
 * The parameter of a project method that stands for an identity: it is stored into a holder of the project's own type,
 * and the value at this call site is built here — `new UserContext(user)` is the client's id becoming an identity. A
 * record the method looked up (`setTenant(tenant)`) is a tenant-source fact, not an identity.
 */
function projectHolderSlot(hit, call, q, db, model) {
  const params = hit.params ?? [];
  for (const store of q.stores(hit.id, 0).stores) {
    if (store.kind !== 'holder' || store.op === 'clear') continue;
    const holder = q.holders().holders.find((h) => h.field === store.field);
    if (!holder || !isIdentityType(model, holder.element)) continue;
    const args = callById(db, store.call)?.args ?? [];
    if (args[0]?.kind !== 'param') continue; // the method builds its own value: found in its own body
    const built = builtValue(q, call, args[0].index, db, model);
    if (built) return { name: params[args[0].index]?.name ?? '_', arg: built };
  }
  return null;
}

/** The project value built at a call site: the dump says `new` and names the created type. */
const builtValue = (q, call, i, db, model) => {
  for (const { value } of q.argValue(call, i).values)
    if (value.kind === 'new' && isIdentityType(model, value.created ?? value.type)) return value;
  return null;
};

/**
 * The value the client sent has to reach the holder. Followed through what the dump records: the store's argument is
 * the read's own call, or a local assigned from it, or a local assigned from a call that took it (one hop). A value
 * the dump cannot place — a parameter of the sink's own method, or a value built inside a `new` whose arguments are
 * not recorded — keeps the warning: an unknown never clears a warning.
 */
function valueReaches(read, value, q, db, weak = false, depth = 2) {
  if (!value) return true;
  const ids = new Set([read.call, read.value].filter(Boolean));
  const isRead = (v) => Boolean(v) && ((v.kind === 'call' && ids.has(v.call)) || (v.kind === 'local' && ids.has(v.from)));
  if (isRead(value)) return true;
  if (value.kind === 'param') return !weak;
  // A local assigned in more than one place has no `from` in the dump (`actor = null; ... actor = c.getValue();`).
  // The servlet cookie loop is that shape. A *weak* sink — a project method merely handed the caller — does not warn
  // on it: the weakest sink warns only on what the dump can show reaching it, or every filter that re-stores the
  // caller already authenticated would be flagged.
  if (value.kind === 'local' && !value.from) return !weak;
  // A value built inline (`new UserContext(user)`): the dump names the created type, not its arguments, so what was
  // passed to the constructor is not in it. Unplaceable, and the warning stands.
  if (value.kind === 'new') return true;
  if (value.kind === 'local' && value.from && depth > 0) {
    const row = callById(db, value.from);
    if (!row) return false;
    for (let i = 0; i < (row.args ?? []).length; i++)
      for (const v of q.argValue(row, i).values)
        if (isRead(v.value) || valueReaches(read, v.value, q, db, weak, depth - 1)) return true;
    return false;
  }
  return false;
}

// A user source says where the caller comes from: the cookie or header a filter reads and stores. The stored caller is
// whatever makes it current — `stores()`, the same definition tenancy uses.
export function authSources(model, _textOf, isTest = () => false, db = null) {
  const facts = [];
  const d = db ?? model?.dump ?? null;
  if (!d) return facts;
  const q = queries(d);
  for (const t of model.types?.values() ?? []) {
    if (isTest(t.file)) continue;
    for (const m of t.methods ?? []) {
      if (!IDENTITY_ENTRY.test(m.name ?? '')) continue;
      const id = m.id ?? `${t.fqn}#${m.name}`;
      const { methods } = q.reach(id, 2);
      const stores = methods.flatMap(({ id: mid }) => identityStores(q, mid, d));
      if (!stores.length) continue;
      const { reads } = requestReads(id, q, d, model, 2, methods);
      // The same verification the warning uses: the receiver's type, never the method's name.
      const verified = Boolean(verifiesIn(methods, d, model));
      const store = storeLabel(stores[0], d);
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
            `${t.name}#${m.name} reads cookie ${cookie.name} and stores the caller (${store})`,
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
        why: [`${t.name}#${m.name} reads the ${headerLine.name} header and stores the caller (${store})`],
      });
    }
  }
  return facts;
}

// The caller the code believes because the request said so. Two conditions, both required: the value reaches a
// *security* identity holder (the security context, an Authentication/Principal slot, or a holder of the app's own
// whose type the project declares), and no verification call is reachable in the same reach. Anything less certain
// stays a user source — a ThreadLocal of an IP, a request id or a workspace id is not a caller.
// One warning per (method, holder): every source that reaches that holder is listed in the one entry.
export function identityWarnings(model, _textOf, isTest = () => false, db = null) {
  const warnings = [];
  const d = db ?? model?.dump ?? null;
  if (!d) return warnings;
  const q = queries(d);
  const holders = q.holders().holders;
  for (const t of model.types?.values() ?? []) {
    if (isTest(t.file)) continue;
    for (const m of t.methods ?? []) {
      if (!IDENTITY_ENTRY.test(m.name ?? '')) continue;
      const id = m.id ?? `${t.fqn}#${m.name}`;
      const { methods } = q.reach(id, 2);
      // The sink decides first: without a security holder there is no warning to make, whatever is read.
      const sinks = securitySinks(id, q, d, model, holders);
      if (!sinks.length) continue;
      if (verifiesIn(methods, d, model)) continue;
      // One entry per value the client can send, not per place it was read.
      const reads = [
        ...new Map(requestReads(id, q, d, model, 2, methods).reads.map((r) => [`${r.kind}:${r.name}`, r])).values(),
      ];
      const byHolder = new Map();
      for (const s of sinks) byHolder.set(s.method, [...(byHolder.get(s.method) ?? []), s]);
      for (const [key, group] of byHolder) {
        const used = reads.filter((r) => group.some((s) => valueReaches(r, s.arg, q, d, Boolean(s.weak))));
        if (!used.length) continue;
        warnings.push({
          id: `security-warning:client-asserted-identity@${t.name}:${key}`,
          family: 'security-warning',
          confidence: 'inferred',
          kind: 'client-asserted-identity',
          method: `${t.name}#${m.name}`,
          source: used.map((r) => `${r.kind}:${r.name}`).join(', '),
          holder: key,
          evidence: [...used.map((r) => r.cite), group[0].cite],
          why: [
            `${t.name}#${m.name} takes the caller from ${used.map((r) => `${r.kind} ${r.name} (${r.cite})`).join(', ')}`,
            `${key} stores it as the caller (${[...new Set(group.map((s) => s.what))].join(', ')}) with no verification ` +
              'call: any client can claim that identity',
          ],
        });
      }
    }
  }
  return warnings;
}

{
  // The type gates, and the value walk, on values the dump would write. `==` comparisons are not in the dump and a
  // `new` keeps no argument ids: both are reported as gaps, never guessed.
  const model = {
    types: new Map([
      ['shop.User', { fqn: 'shop.User' }],
      ['shop.UserContext', { fqn: 'shop.UserContext' }],
      ['shop.JwtTokenService', { fqn: 'shop.JwtTokenService' }],
      ['shop.TwoFactorService', { fqn: 'shop.TwoFactorService' }],
    ]),
  };
  assert.ok(isIdentityType(model, 'UserContext'), 'a project type is an identity value');
  assert.ok(isIdentityType(model, 'shop.UserContext'), 'written or qualified');
  assert.ok(!isIdentityType(model, 'String'), 'a String is bookkeeping');
  assert.ok(!isIdentityType(model, 'long'), 'a primitive is bookkeeping');
  assert.ok(isVerifierType('org.springframework.security.oauth2.jwt.JwtDecoder', model));
  assert.ok(isVerifierType('java.security.MessageDigest', model));
  assert.ok(isVerifierType('shop.JwtTokenService', model));
  assert.ok(!isVerifierType('shop.TwoFactorService', model));
  assert.ok(!isVerifierType('java.lang.String', model));
  assert.equal(simpleType('java.util.Map<String, Object>'), 'Map');
  assert.equal(annotationName({ raw: 'value = "X-Tenant", required = false' }), 'X-Tenant');
  assert.equal(annotationName({ raw: '"actAs"' }), 'actAs');
  assert.equal(annotationName({ raw: '' }), null);
  // The value walk: a read assigned to a local that the store is handed reaches it; an unrelated local does not.
  const calls = [
    { id: 'a.F#go()@4:9', method: 'a.F#go()', name: 'getHeader', file: 'a/F.java', line: 4, args: [] },
    { id: 'a.F#go()@8:9', method: 'a.F#go()', name: 'store', file: 'a/F.java', line: 8, args: [] },
  ];
  const db = { calls, members: new Map(), types: new Map() };
  const q = { argValue: (call, i) => ({ values: [], unresolved: [] }) };
  const read = { kind: 'header', name: 'X-Api-Key', call: 'a.F#go()@4:9' };
  assert.ok(valueReaches(read, { kind: 'local', from: 'a.F#go()@4:9' }, q, db), 'the local is assigned from the read');
  assert.ok(!valueReaches(read, { kind: 'local', from: 'a.F#go()@5:9' }, q, db), 'an unrelated local does not reach');
  assert.ok(valueReaches(read, { kind: 'param', index: 0 }, q, db), 'a value the dump cannot place keeps the warning');
  assert.ok(valueReaches(read, null, q, db), 'a store whose argument was not recorded keeps the warning');
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
    // the prefix's rule, so `/api/v1/**: role:X` covered every endpoint under the prefix when only the external
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
