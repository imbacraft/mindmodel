// Tenancy: the key is decided by counts, never by the name. Then coverage (which entities carry it), the
// repository methods that read or write a keyed entity without the key (possible cross-tenant access), where the key
// comes from (the tenant sources), and code without a request (jobs, listeners, async, webhooks) that touches
// keyed entities and whether it sets the tenant context first.
import assert from 'node:assert/strict';
import {
  isAsyncAnnotation,
  isJobAnnotation,
  isListenerAnnotation,
  isNoRequestAnnotation,
  listOf,
  patternOf,
} from '../catalogs/catalog.mjs';
import { queries } from '../model/query.mjs';
import { isTestCode } from '../core/paths.mjs';
import { targetIds } from '../model/targets.mjs';

const MIN_ENTITIES = 3;
// Tuned on hertzbeat: its workspace sits on 9 of 60 entities (15%), and a 30% cut produces no key at all.
const MIN_SHARE = 0.1;
export const MIN_FILTER_SHARE = 0.5;
// A tenancy key is an identifier exchanged with the request, not a free-text attribute.
const IDENTIFIER = /(Id|ID|Uuid)$/;

// A field name on the key candidates: ids, versions and timestamps are not tenancy.
export const NOT_A_KEY = patternOf('tenancy-not-a-key');

// The write methods, by exact name: a call to one of these is not a read of the tenant's rows.
const WRITE_METHODS = listOf('repository-write-names');

// A written identifier — `workspaceId`, `workspace_id` — and nothing else: the dump's argument `text` is display
// text (cut at 80 characters), so an expression in it is never matched against a key, only a bare name is.
export const identifier = (text) => (/^[A-Za-z_]\w*$/.test(String(text ?? '')) ? String(text) : null);

export function tenancyFacts(
  { entities, repos, repoMethods },
  { tenantSources = [], model, db = null, minShare = MIN_SHARE, entryMethods = [], requestMethods = [] } = {},
) {
  const byName = new Map(entities.map((e) => [e.name, e]));
  // Field name → entity names carrying it (own or inherited fields are both in `e.fields`).
  const carriers = new Map();
  for (const e of entities)
    for (const f of e.fields) {
      if (!f.name || NOT_A_KEY.test(f.name)) continue;
      if (!carriers.has(f.name)) carriers.set(f.name, new Set());
      carriers.get(f.name).add(e.name);
    }

  // Repository methods per entity, with their query text (derived name, @Query, or MyBatis SQL).
  const methodsOf = new Map();
  for (const [repo, entity] of repos) for (const m of repoMethods.get(repo) ?? []) {
    if (!methodsOf.has(entity)) methodsOf.set(entity, []);
    methodsOf.get(entity).push({ repo, ...m });
  }

  const filterShare = (field, entitiesWithField) => {
    const all = [...entitiesWithField].flatMap((e) => methodsOf.get(e) ?? []).filter((m) => !WRITE_METHODS.has(m.name));
    if (!all.length) return { filtered: 0, total: 0, share: 0 };
    const key = field[0].toUpperCase() + field.slice(1);
    const byKey = (m) => new RegExp(`By${key}\\b|\\b${field}\\b|\\b${field.replace(/[A-Z]/g, (c) => `_${c}`).toLowerCase()}\\b`).test(m.query);
    const filtered = all.filter(byKey).length;
    return { filtered, total: all.length, share: filtered / all.length };
  };

  // (b2) the key is *stored into* a request/context holder — a ThreadLocal write, a request attribute, the security
  // context — through a call chain of at most three hops. ONE definition of "store", shared with security:
  // `engine/model/query.mjs`'s `stores()`. Being read off the request (a `@PathVariable`, a query parameter) is a
  // foreign key in the path, not a tenant: naming it in request-scoped code would be enough to outvote the repository
  // evidence, so a child id in controllers became "the tenant". The key may be handed over directly or wrapped by a
  // helper (`setupForSubscription(subscriptionId)` builds a context and stores it).
  const flat = (s) => String(s ?? '').replace(/_/g, '').toLowerCase();
  const namesKey = (key) => (s) => flat(s).includes(flat(key));
  const d = db ?? model?.dump ?? null;
  const q = queries(d);
  // A name the dump wrote: `value.from` and `value.call` are call ids, a target a member id.
  const callIndex = new Map((d?.calls ?? []).map((c) => [c.id, c]));
  const nameOfCall = (id) => callIndex.get(id)?.name ?? d?.members?.get(id)?.name ?? null;
  // Methods in the order the model lists them, so a tie between two holders is broken the same way every run.
  const methodsInOrder = [];
  for (const t of model?.types?.values() ?? []) for (const m of t.methods ?? []) methodsInOrder.push({ t, m });
  // A method *containing* a store is at distance 0; its callers are one hop from the store. A clear is not a store.
  const distance = new Map();
  const storeCallers = (id) => d?.callersOf?.(id) ?? [];
  for (const { t, m } of methodsInOrder) {
    if (isTestCode(t.file)) continue;
    if (q.stores(m.id, 0).stores.some((s) => s.op !== 'clear')) distance.set(m.id, 0);
  }
  let frontier = [...distance.keys()];
  for (let d = 1; d <= 3 && frontier.length; d++) {
    const next = [];
    for (const id of frontier)
      for (const c of storeCallers(id)) {
        if (!c.method || distance.has(c.method)) continue;
        distance.set(c.method, d);
        next.push(c.method);
      }
    frontier = next;
  }
  // The store's name, as the dump names it: the constant a call passes (a query parameter), the field a value is
  // assigned to, the call a local was assigned from, the type a value is created as, or — for a local or a parameter
  // the dump has no other name for — the written identifier itself (see `identifier` above).
  const valueNames = (value, named) => {
    if (!value) return false;
    const candidates =
      value.kind === 'constant' || value.kind === 'literal' || value.kind === 'string'
        ? [value.value?.value]
        : value.kind === 'field'
          ? [String(value.field ?? '').split('#').pop()]
          : value.kind === 'call'
            ? [nameOfCall(value.call)]
            : value.kind === 'local'
              ? [nameOfCall(value.from), identifier(value.text)]
              : value.kind === 'param'
                ? [identifier(value.text)]
                : value.kind === 'new'
                  ? [String(value.created ?? value.typeFqn ?? '').split('.').pop()]
                  : [];
    return candidates.some((text) => typeof text === 'string' && text.length > 0 && named(text));
  };
  // The key names the holder when a method's own parameter or name carries it, or when a call passes a value named
  // after it into a method within the remaining hops of a store. `setupForSubscription(Long subscriptionId)` covers
  // the wrapper; `holder.setWorkspace(workspaceId)` covers the setter.
  const holderStore = (key) => {
    const named = namesKey(key);
    const selfNamed = [],
      viaArg = [];
    for (const { t, m } of methodsInOrder) {
      if (isTestCode(t.file)) continue;
      if (!distance.has(m.id)) continue;
      if ((m.params ?? []).some((p) => p.name && named(p.name)) || named(m.name)) {
        selfNamed.push(`${t.name}#${m.name}`);
        continue;
      }
      const carries = (d?.callsOf?.(m.id) ?? []).some(
        (c) =>
          targetIds(c).some((tg) => (distance.get(tg) ?? Infinity) <= 2) &&
          (c.args ?? []).some((_, i) => q.argValue(c, i).values.some((v) => valueNames(v.value, named))),
      );
      if (carries) viaArg.push(`${t.name}#${m.name}`);
    }
    return selfNamed[0] ?? viaArg[0] ?? null;
  };
  // A tie-break only: the request names the key literally in a filter (`getParameter("workspaceId")`), or a filter
  // method's own parameter is named after it. It ranks candidates; it does not decide on its own.
  const strongLink = (key) => {
    const named = namesKey(key);
    for (const t of model?.types?.values() ?? []) {
      if (isTestCode(t.file)) continue;
      if (!/(Filter|Interceptor|Security|ApiToken)/i.test(t.name)) continue;
      for (const m of t.methods ?? []) {
        // The request names the key literally: `request.getParameter("workspaceId")`, `headers.get("X-Tenant")`, or a
        // value the code itself calls `workspaceId` handed on.
        for (const c of d?.callsOf?.(m.id) ?? [])
          for (let i = 0; i < (c.args ?? []).length; i++)
            if (q.argValue(c, i).values.some(({ value }) => valueNames(value, named)))
              return `${t.name}#${m.name}`;
        if ((m.params ?? []).some((p) => p.name && named(p.name)) || named(m.name)) return `${t.name}#${m.name}`;
      }
    }
    return null;
  };
  const assignsKey = (key) => holderStore(key);

  // How much the repository queries actually filter by a field: every repository read in the app, not just those of the
  // entities carrying it. This is the number the owner can check against the code.
  const allReads = [...repoMethods.values()].flat().filter((m) => !WRITE_METHODS.has(m.name));
  const repoFilters = (field) => {
    const re = new RegExp('(' + field.replace(/([A-Z])/g, '_?$1') + ')', 'i');
    return allReads.filter((m) => re.test(m.query)).length;
  };

  const candidates = [];
  for (const [field, set] of carriers) {
    if (!IDENTIFIER.test(field)) continue;
    if (set.size < MIN_ENTITIES || set.size / entities.length < minShare) continue;
    const { filtered, total, share } = filterShare(field, set);
    const holder = assignsKey(field);
    const strong = strongLink(field);
    const ok = (total > 0 && share >= MIN_FILTER_SHARE) || !!holder;
    candidates.push({
      key: field,
      entities: [...set].sort(),
      counts: {
        entities: set.size,
        of: entities.length,
        percent: Math.round((set.size / entities.length) * 100),
        filteredMethods: filtered,
        repoMethods: total,
        filteredPercent: Math.round(share * 100),
        repoFilters: repoFilters(field),
      },
      holder,
      strong,
      passed: ok,
      why: [
        `${set.size} of ${entities.length} entities carry ${field} (${Math.round((set.size / entities.length) * 100)}% ≥ 10% and ≥ 3)`,
        total ? `${filtered} of ${total} repository read methods filter by ${field} (${Math.round(share * 100)}%)` : 'no repository read methods to test',
        holder
          ? `stored into a request/context holder by ${holder}`
          : 'read in request-scoped code but never stored into a context holder',
      ],
    });
  }
  // Ranked by how much the repository queries actually filter by the field; request linkage only breaks ties.
  const rank = (c) => [c.passed ? 1 : 0, c.counts.repoFilters, c.strong ? 1 : 0, c.counts.percent];
  candidates.sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return a.key.localeCompare(b.key);
  });
  const chosen = candidates.find((c) => c.passed) ?? null;
  const key = chosen?.key ?? null;
  const keyed = new Set(chosen?.entities ?? []);

  // Unscoped access: a repository read on a keyed entity whose query names the key nowhere.
  const unscoped = [];
  const globalLookups = [];
  const unscopedWrites = [];
  const crossTenant = [];
  // Field metadata per entity: the id name and the key's own column (from @Column/join), for SQL matching.
  const metaOf = new Map(
    entities.map((e) => [
      e.name,
      {
        id: (e.fields.find((f) => f.id) ?? {}).name ?? 'id',
        keyColumn: key ? (e.fields.find((f) => f.name === key) ?? {}).column ?? null : null,
      },
    ]),
  );
  const entryIds = new Set(entryMethods ?? []);
  const requestIds = new Set(requestMethods ?? []);
  // A read is cross-tenant by design when every caller chain ends in a job/listener/worker and never in a request
  // handler (three hops, enough for service → helper → repository).
  const ancestors = (id) => {
    const seen = new Set(),
      queue = [id];
    let hitRequest = false;
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (requestIds.has(cur)) hitRequest = true;
      for (const c of callersOf.get(cur) ?? []) if (!seen.has(c)) queue.push(c);
      if (seen.size > 400) break;
    }
    return { hitRequest, hitEntry: [...seen].some((x) => entryIds.has(x)), root: [...seen].find((x) => entryIds.has(x)) ?? null };
  };
  // Who calls each method: used to tell no-request-only reads from ordinary ones. Targets when resolved; otherwise
  // the call name, so a read whose receiver stayed unresolved still has callers to judge by (heuristic).
  const callersOf = new Map();
  for (const t of model?.types?.values() ?? [])
    for (const m of t.methods ?? [])
      for (const c of m.calls ?? []) {
        const tgs = c.targets?.length ? c.targets : c.name ? [`?${c.name}`] : [];
        for (const raw of tgs) {
          // Method ids carry their signature (`Type#m(Long)`); callers are keyed by `Type#m` too.
          for (const tg of new Set([raw, raw.replace(/\(.*$/, '')])) {
            if (!callersOf.has(tg)) callersOf.set(tg, new Set());
            callersOf.get(tg).add(`${t.fqn}#${m.name}`);
          }
        }
      }
  const uniqueOf = new Map(entities.map((e) => [e.name, e.uniqueFields ?? []]));
  if (key) {
    // camelCase in a derived query has no word boundary: `findByIdAndWorkspaceId` is split before matching.
    // Another key that passed the same test scopes the entity too (a site's subscription belongs to its customer).
    const alsoKeys = candidates.filter((c) => c.passed && c.key !== key).map((c) => c.key);
    // A derived name glues the key to its neighbours (`findByIdAndWorkspaceId`): match the key without word boundaries,
    // allowing the snake-case spelling too.
    const keyText = new RegExp('(' + [key, ...alsoKeys].map((k) => k.replace(/([A-Z])/g, '_?$1')).join('|') + ')', 'i');
    for (const [repo, entity] of repos) {
      if (!keyed.has(entity)) continue;
      for (const m of repoMethods.get(repo) ?? []) {
        if (WRITE_METHODS.has(m.name)) continue;
        // A parameter that is the key scopes the read, and so does a native query naming the key's column.
        const keyColumn = metaOf.get(entity)?.keyColumn ?? key.replace(/([A-Z])/g, '_$1').toLowerCase();
        const paramIsKey = (m.params ?? []).some((p) => keyText.test(p) || new RegExp(keyColumn.replace(/_/g, '_?'), 'i').test(p));
        const sqlNames = new RegExp(`${keyText.source}|${keyColumn}`, 'i');
        if (paramIsKey || sqlNames.test(m.query)) continue;
        if (/^(findById|getById|findOne|existsById|countById|deleteById)$/.test(m.name)) continue;
        // A read filtered by a unique column is a global lookup by unique key, not an unscoped read.
        const uniq = (uniqueOf.get(entity) ?? []).filter((f) => f !== 'id');
        const hitUnique = uniq.find((f) => new RegExp(f.replace(/([A-Z])/g, '_?$1'), 'i').test(m.query));
        // An UPDATE/DELETE query is not a lookup: it belongs in its own list.
        if (m.modifying || /^\s*(update|delete)\b/i.test(m.query)) {
          unscopedWrites.push({
            confidence: 'inferred',
            repo: repo.split('.').pop(),
            repoFqn: repo,
            method: m.name,
            query: m.query,
            entity,
            evidence: m.evidence ?? [],
            why: [`${m.query} changes rows and never mentions ${key}`],
          });
          continue;
        }
        const idName = metaOf.get(entity)?.id ?? 'id';
        // A @Query that filters by the entity's @Id is a global lookup, extra conditions and parameter name aside.
        const idPredicate = new RegExp(`(?:[a-z]\\w*\\.)?${idName}\\s*(?:=|in\\b)|[:.#]${idName}\\b`, 'i');
        const whereOnlyId = m.dynamic && idPredicate.test(m.query);
        if (whereOnlyId) {
          globalLookups.push({
            confidence: 'inferred',
            repo: repo.split('.').pop(),
            repoFqn: repo,
            method: m.name,
            query: m.query,
            entity,
            uniqueField: idName,
            evidence: m.evidence ?? [],
            why: [`${m.query} filters only by ${entity}.${idName}, the @Id`],
          });
          continue;
        }
        if (hitUnique) {
          globalLookups.push({
            confidence: 'inferred',
            repo: repo.split('.').pop(),
            repoFqn: repo,
            method: m.name,
            query: m.query,
            entity,
            uniqueField: hitUnique,
            evidence: m.evidence ?? [],
            why: [`${m.query} filters by ${hitUnique}, a unique column on ${entity}`],
          });
          continue;
        }
        const whoCalls = new Set([
          ...(callersOf.get(`${repo}#${m.name}`) ?? []),
          ...(callersOf.get(`?${m.name}`) ?? []),
        ]);
        const chain = whoCalls.size ? ancestors(`${repo}#${m.name}`) : { hitEntry: false, hitRequest: false, root: null };
        if (!chain.hitEntry && whoCalls.size) {
          const byName = ancestors(`?${m.name}`);
          if (byName.hitEntry) Object.assign(chain, byName);
        }
        if (entryIds.size && whoCalls.size && chain.hitEntry && !chain.hitRequest) {
          crossTenant.push({
            confidence: 'inferred',
            repo: repo.split('.').pop(),
            repoFqn: repo,
            method: m.name,
            query: m.query,
            entity,
            callers: [...whoCalls],
            root: chain.root,
            evidence: m.evidence ?? [],
            why: [`only called from no-request code: ${[...whoCalls].join(', ')}`],
          });
          continue;
        }
        unscoped.push({
          confidence: 'inferred',
          repo: repo.split('.').pop(),
          repoFqn: repo,
          method: m.name,
          query: m.query,
          entity,
          evidence: m.evidence ?? [],
          why: [`${entity} carries ${key}, and ${m.query} has no ${key} predicate`],
        });
      }
    }
  }
  // A base service that applies the key for every caller: methods of a base class (or of its subclasses) that pass the
  // current key into the repository. A read that only runs through it is scoped, not unscoped.
  const baseName = (n) => /^(Base|Abstract)[\w]*(Service|Repository|Dao)$/.test(n) || /TenantAware/.test(n);
  const keyish = key ? new RegExp(key.replace(/([A-Z])/g, '_?$1'), 'i') : null;
  const baseTypes = new Set();
  // The repository reads that only happen inside a base service method which passes the key: those are scoped.
  const baseApplied = new Set();
  for (const t of model?.types?.values() ?? []) {
    if (!baseName(t.name)) continue;
    let applies = false;
    for (const m of t.methods ?? [])
      for (const c of m.calls ?? []) {
        const keyed =
          (keyish && (keyish.test(c.name ?? '') || (c.args ?? []).some((a) => keyish.test(a)))) ||
          /TenantContext|currentTenant|currentSubscription/i.test((c.recvFqn ?? '') + ' ' + (c.name ?? ''));
        if (!keyed) continue;
        applies = true;
        for (const tg of c.targets ?? []) if (repos.has(tg.split('#')[0])) baseApplied.add(tg);
      }
    if (applies) baseTypes.add(t.fqn);
  }
  const viaBaseType = (fqn) => {
    let cur = model?.types?.get(fqn);
    for (let i = 0; cur && i < 6; i++) {
      if (baseTypes.has(cur.fqn)) return true;
      cur = (cur.supers ?? []).map((x) => (x.fqn ? model.types.get(x.fqn) : null)).find(Boolean);
    }
    return false;
  };
  let bridged = 0;
  const scoped = [];
  for (const u of unscoped) {
    const who = callersOf.get(`${u.repoFqn}#${u.method}`) ?? new Set();
    const throughBase = baseApplied.has(`${u.repoFqn}#${u.method}`) || (who.size && [...who].every(viaBaseType));
    if (baseTypes.size && throughBase) {
      bridged++;
      continue;
    }
    scoped.push(u);
  }
  unscoped.length = 0;
  unscoped.push(...scoped);
  const byRepo = new Map();
  for (const u of unscoped) byRepo.set(u.repo, (byRepo.get(u.repo) ?? 0) + 1);

  // Where the key comes from: the tenant sources, kept in one fact with the key.
  const sources = (tenantSources ?? []).map((s) => ({ kind: s.kind, name: s.name, method: s.method, evidence: s.evidence }));

  return {
    key,
    confidence: 'inferred',
    counts: chosen?.counts ?? { entities: 0, of: entities.length, percent: 0, filteredMethods: 0, repoMethods: 0, filteredPercent: 0 },
    candidates,
    coverage: {
      withKey: [...keyed].sort(),
      withoutKey: entities.filter((e) => !keyed.has(e.name)).map((e) => e.name).sort(),
    },
    unscoped,
    unscopedWrites,
    globalLookups,
    crossTenant,
    bridged,
    bases: [...baseTypes].map((f) => f.split('.').pop()),
    baseApplied: baseApplied.size,
    unscopedByRepo: [...byRepo.entries()].map(([repo, n]) => ({ repo, n })).sort((a, b) => b.n - a.n),
    sources,
  };
}

// Code without a request: entry methods that are jobs, listeners, async or webhooks, and whether the path sets the
// tenant context before it reaches a repository of a keyed entity.
export function noRequestPaths({ model, tenancy, repos, extra = [] }) {
  if (!tenancy.key) return [];
  const keyedRepos = new Set([...repos].filter(([, e]) => tenancy.coverage.withKey.includes(e)).map(([r]) => r));
  const entryAnn = (m) => (m.ann ?? []).map((a) => a.fqn ?? a.name);
  const kindOf = (m) => {
    const names = entryAnn(m);
    if (!names.some((n) => isNoRequestAnnotation(n))) return null;
    if (names.some((n) => isJobAnnotation(n))) return 'job';
    if (names.some((n) => isAsyncAnnotation(n))) return 'async';
    if (names.some((n) => isListenerAnnotation(n))) return 'listener';
    return 'job'; // a remaining no-request name, such as a timer's @Timeout
  };
  const setsContext = (t, m) => (m.calls ?? []).some((c) => /^(set|current)(Tenant|Workspace|Site)/.test(c.name ?? '')) || /Context|Holder/.test(t.name);
  const out = [];
  // Worker loops have no annotation: the flow builder already found them (a loop polling a queue, started by an
  // executor or a lifecycle hook), so they enter here as entries too.
  const work = [];
  for (const t of model.types.values())
    for (const m of t.methods ?? []) {
      const kind = kindOf(m);
      if (kind) work.push({ kind, t, m });
    }
  for (const e of extra) if (e.t && e.m) work.push({ kind: e.kind, t: e.t, m: e.m });
  const seenEntry = new Set();
  for (const { kind, t, m } of work) {
    {
      if (seenEntry.has(`${t.fqn}#${m.name}`)) continue;
      seenEntry.add(`${t.fqn}#${m.name}`);
      // Breadth-first over resolved calls, three hops, to a keyed repository.
      let frontier = [m], seen = new Set(), hit = null, depth = 0;
      const maxDepth = kind === 'worker' ? 8 : 3;
      while (frontier.length && depth++ < maxDepth && !hit) {
        const next = [];
        for (const cur of frontier)
          for (const c of cur.calls ?? []) {
            for (const tg of c.targets ?? []) {
              if (seen.has(tg)) continue;
              seen.add(tg);
              const [ownerFqn, method] = tg.split('#');
              if (keyedRepos.has(ownerFqn)) hit = `${ownerFqn.split('.').pop()}#${method}`;
              const ot = model.types.get(ownerFqn);
              const om = ot?.methods?.find((x) => x.name === method);
              if (om) next.push(om);
            }
          }
        frontier = next;
      }
      if (!hit) continue;
      out.push({
        kind,
        method: `${t.name}#${m.name}`,
        file: t.file,
        line: m.nameLine,
        reaches: hit,
        setsContext: setsContext(t, m),
        evidence: [`${t.file}:${m.nameLine}#${m.name}`],
      });
    }
  }
  return out;
}

{
  // The name test a key is matched with, and the identifier guard that keeps display text out of it.
  assert.deepEqual(['workspaceId', 'workspace_id', '_id'].map(identifier), ['workspaceId', 'workspace_id', '_id']);
  assert.equal(identifier('subscription.getSubscriptionId()'), null, 'an expression is display text, never a name');
  assert.equal(identifier('name.equals(other) + "x"................. truncated by the dump at eighty chars'), null);
}
