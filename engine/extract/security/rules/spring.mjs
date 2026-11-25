import { listOf, mapOf, patternOf } from '../../../catalogs/catalog.mjs';
import { annotationOn } from '../../../core/annotations.mjs';
import { dumpArgs, shownArg, stringValues } from '../flow/dump.mjs';

// What a rule's call grants, from the vocabulary: `{literal}` is the call's first string argument.
const ACCESS = mapOf('access-calls');
const HTTP_METHOD = patternOf('http-method-enum');
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
const ACCESS_CALLS = new Set(Object.keys(ACCESS));

function accessOf(rule, args) {
  if (!Object.hasOwn(ACCESS, rule)) return 'unknown';
  return ACCESS[rule].replace('{literal}', () => firstLiteral(args));
}

// Spring Security chains, from the dump's call rows: `securityMatcher(...)` states a chain's scope, and each
// `requestMatchers(...)`/`anyRequest()` in it is paired with the access call chained to it (`permitAll()`,
// `hasRole("X")`).
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
        const orderArgs = annotationOn(m, ...listOf('order-annotations'))?.args ?? '';
        const order = Number(/^\s*(-?\d+)/.exec(orderArgs)?.[1] ?? NaN);
        // The chain's own condition: a chain behind a profile or a property is not in force everywhere.
        const conditional = listOf('conditional-annotations');
        const cond = annotationOn(m, ...conditional) ?? annotationOn(t, ...conditional);
        // A configurer applied to this chain whose class the repo does not declare: its requestMatchers rules exist
        // only
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
          const verbText = verbs.length ? `${verbs.join('/')}, ` : '';
          const matcherText = (pattern) =>
            anyRequest ? 'anyRequest' : `requestMatchers(${verbText}"${pattern}")`;
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
                `${matcherText(pattern)} → ${fn}${cond ? ` [${cond.name}]` : ''}`,
                ...(applied ? [`path rules also come from ${applied}, outside this repo: not seen`] : []),
              ],
            });
        }
        // The chain's matcher is known but none of its rules are: the configurer it applies holds them, and that
        // class is not here. One rule per scope, so the prefix is reported with its reason instead of as a bare
        // "unknown". A chain
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
