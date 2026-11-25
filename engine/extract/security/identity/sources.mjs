import { queries } from '../../../model/query.mjs';
import { IDENTITY_ENTRY, verifiesIn } from './types.mjs';
import { requestReads } from '../flow/requests.mjs';
import { identityStores, storeLabel } from '../flow/stores.mjs';

// A user source says where the caller comes from: the cookie or header a filter reads and stores. The stored caller is
// whatever makes it current — `stores()`, the same definition tenancy uses.
export function authSources(model, isTest = () => false, db = null) {
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
      const typed = methods.flatMap(({ id: mid }) => identityStores(q, mid, d));
      // A store found by shape (one request, one try/finally) is enough for a caller carried in a cookie, and for
      // nothing else: without a classpath the element type is unknown, and an unknown is no evidence for a header
      // identity or for a warning (P6: never a claim the code cannot support).
      const scoped = methods.flatMap(({ id: mid }) => (q.scopedStores ? q.scopedStores(mid).stores : []));
      const stores = typed.length ? typed : scoped;
      if (!stores.length) continue;
      const { reads } = requestReads(id, q, d, model, 2, methods);
      // The same verification the warning uses: the receiver's type, never the method's name.
      const verified = Boolean(verifiesIn(methods, d, model));
      const store = storeLabel(stores[0], d);
      const cookies = reads.filter((r) => r.kind === 'cookie');
      if (cookies.length) {
        // One fact per cookie the filter reads: the digest lists what the caller can come from, and a filter that
        // reads two names a reader needs both. The unverified state belongs in the kind: it is the one field of a user
        // source the digest keeps, and a caller the code believes without checking it is what a reader has to know.
        for (const cookie of cookies)
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
