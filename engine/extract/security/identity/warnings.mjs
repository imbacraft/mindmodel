import { queries } from '../../../model/query.mjs';
import { IDENTITY_ENTRY, verifiesIn } from './types.mjs';
import { requestReads } from '../flow/requests.mjs';
import { valueReaches } from '../flow/values.mjs';
import { securitySinks } from './sinks.mjs';

// The caller the code believes because the request said so. Two conditions, both required: the value reaches a
// *security* identity holder (the security context, an Authentication/Principal slot, or a holder of the app's own
// whose type the project declares), and no verification call is reachable in the same reach. Anything less certain
// stays a user source — a ThreadLocal of an IP, a request id or a workspace id is not a caller.
// One warning per (method, holder): every source that reaches that holder is listed in the one entry.

export function identityWarnings(model, isTest = () => false, db = null) {
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
      // A warning accuses, so it is built from the sinks whose element type the run could actually read: an inferred
      // store (element unresolved) is evidence for the user sources, never the reason for a claim about the caller.
      for (const s of sinks) if (!s.inferred) byHolder.set(s.method, [...(byHolder.get(s.method) ?? []), s]);
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
            `${t.name}#${m.name} takes the caller from ` +
              used.map((r) => `${r.kind} ${r.name} (${r.cite})`).join(', '),
            `${key} stores it as the caller (${[...new Set(group.map((s) => s.what))].join(', ')}) ` +
              'with no verification ' +
              'call: any client can claim that identity' +
              (group.some((s) => s.element === 'unresolved')
                ? '. The holder\'s element type is unresolved: no classpath read its jar, so the check is by shape'
                : ''),
          ],
        });
      }
    }
  }
  return warnings;
}
