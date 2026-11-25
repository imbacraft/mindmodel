import { isNoRequestAnnotation } from '../catalogs/catalog.mjs';
import { noRequestPaths, tenancyFacts } from '../extract/tenancy.mjs';
import { securityModelOf, userSourcesOf } from './security.mjs';

/**
 * The tenant key and the paths that run without a request. Callers that are no-request code (jobs, listeners, async
 * methods, worker loops, webhooks) are named as entry methods; the key is also reported at 10%, 20% and 30% shares.
 */
export function tenancyOf(model, { endpoints, flowEntryList, entFacts, tenantFacts }) {
  // Callers that are no-request code: jobs, listeners, async methods and worker loops.
  const entryMethods = [
    ...flowEntryList.filter((e) => e.kind === 'worker').map((e) => `${e.t.fqn}#${e.m.name}`),
    ...[...model.types.values()].flatMap((t) =>
      (t.methods ?? [])
        .filter((m) => (m.ann ?? []).some((a) => isNoRequestAnnotation(a.name ?? '')))
        .map((m) => `${t.fqn}#${m.name}`),
    ),
  ];
  // Webhook endpoints are request handlers, but nothing behind them has a logged-in tenant: reads they alone call are
  // judged like jobs (cross-tenant by design), not as unscoped request reads.
  // The id names the method that runs, which for an inherited endpoint is the declaring class's method.
  const methodIdOf = (e) => `${e.declaredIn ?? e.handlerFqn}#${String(e.handler).split('.').pop()}`;
  const webhookIds = endpoints.filter((e) => /webhook|callback|\bhooks?\b/i.test(e.path ?? '')).map(methodIdOf);
  const requestMethods = endpoints.map(methodIdOf).filter((id) => !webhookIds.includes(id));
  entryMethods.push(...webhookIds);
  const tenancy = tenancyFacts(entFacts, { tenantSources: tenantFacts, model, entryMethods, requestMethods });
  // The tenant key at 10%, 20% and 30% shares is reported side by side, and the owner decides.
  const tenancyThresholds = [0.1, 0.2, 0.3].map((share) => ({
    share,
    key: tenancyFacts(entFacts, { tenantSources: tenantFacts, model, minShare: share }).key,
  }));
  const withoutRequest = noRequestPaths({
    model,
    tenancy,
    repos: entFacts.repos,
    // Worker entries only matter when there is a key to reach; skipping the build keeps large keyless apps fast.
    extra: tenancy.key
      ? flowEntryList.filter((e) => e.kind === 'worker').map((e) => ({ kind: 'worker', t: e.t, m: e.m }))
      : [],
  });
  return { tenancy, tenancyThresholds, withoutRequest };
}

/** The tenant key, the user sources and the security model built from them. */
export function tenancyAndSecurity(model, selected, { endpoints, sec, flowEntryList, tenantFacts, entFacts }) {
  const ten = tenancyOf(model, { endpoints, flowEntryList, entFacts, tenantFacts });
  const userSources = userSourcesOf(model, selected);
  const securityModelFact = securityModelOf(model, { endpoints, sec, tenancy: ten.tenancy, userSources });
  return { ten, securityModelFact };
}
