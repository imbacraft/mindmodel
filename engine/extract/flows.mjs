import assert from 'node:assert/strict';

// Flow skeletons (§5.3, revised): a path from an entry point to at least one effect. An effect is a state write (a
// repository or EntityManager call, from the state family), an outside call (HTTP, mail, messaging, from the outside
// family) or a message sent (an outside call to a broker). A branch with no effect is not part of the flow, so response
// envelopes and read-only side branches disappear; a path with no effect anywhere is not a flow at all.
//
// The walk runs on the resolved call graph (`call.targets`), through an interface target to the implementation that has
// a body. Every effect and every hop is cited, and the rank is computed from facts only — never from a name — with each
// part of the score written into `why`, so a reader can check the order.

const ENTRY_VERB = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'ANY']);
const SCHEDULE = /(?:^|\.)(Scheduled|Schedules|Schedule)$/;
const LISTENER = /(?:^|\.)(JmsListener|RabbitListener|KafkaListener|MessageDriven|EventListener)$/;
const BOUNDARY = new Set(['requires-new', 'after-commit', 'outside-in-transaction', 'outside-then-save']);
const MESSAGING = /^(Kafka|Rabbit|RabbitMQ|JMS|SQS|PubSub|Messaging|MQ|AMQP)$/i;
// Call names that are plumbing in any program: they are never a hop and never an effect.
const NOISE =
  /^(?:(?:get|set|is|has|to|of|with|from)[A-Z_$]|name$|size$|isEmpty$|isBlank$|orElse$|ifPresent$|toString$|equals$|hashCode$|valueOf$|stream$|collect$|map$|filter$|forEach$|add$|put$|remove$|iterator$|next$|parse$|now$|split$|trim$|length$|charAt$|contains$|matches$|matcher$|test$|apply$|accept$|run$|execute$|warn$|info$|error$|debug$|trace$|lock$|unlock$|requireNonNull$|printStackTrace$|format$|append$|build$|call$)/;

// The rank, in one place. Every weight is a fact count or a fixed kind; nothing here reads a method or type name
// except the entry verb. Changing a weight changes the digest order and nothing else.
export const FLOW_WEIGHTS = {
  entityWrite: 3, // per distinct entity written
  outsideCall: 2, // per outside call (HTTP, mail, and the message send below counted in addition)
  message: 2, // per message sent
  risk: 10, // a transaction-boundary fact on the path; bugs hide here
  entryWriteVerb: 3, // POST/PUT/PATCH/DELETE
  entryJob: 3, // scheduled job or message listener
  entryUi: 3, // a JSF action method on a UI bean (weighted like POST)
  entryGet: 0, // a GET with an effect is still a flow
  centralityEntity: 2, // writes an entity many other types refer to (once per flow)
  centralityRefs: 20, // "many" = referenced by at least this many types
  entityCap: 5, // entity points stop here, however many entities a flow writes
  sharedService: 1, // passes through a type that three or more flows pass through
  // Outside effects are counted per client kind and target (`JMS|JMSProducer.send`), not per call: a notification
  // fan-out to thirteen channels of the same kind is one effect, not thirteen.
  activity: 1, // a file on the path changed in the git window; small, never decisive
};

const simple = (s) => String(s ?? '').split('.').pop();
const siteKey = (methodId, line, name) => `${methodId}|${line}|${name}`;

// Effects by call site: the fact families already decided what a write and an outside call are; this only indexes them.
function effectIndex({ stateWrites = [], outsideCalls = [] }) {
  const by = new Map();
  for (const w of stateWrites) {
    if (!w.method || w.line == null) continue;
    // An EntityManager write names no entity (the argument is a local); it still counts as a state write, under the
    // persistence API that performed it.
    const what = w.entity ? simple(w.entity) : `via ${simple(w.repository ?? 'state')}`;
    by.set(siteKey(w.method, w.line, w.operation), {
      kind: 'entity',
      label: `writes ${what}`,
      key: what,
      // The call site, not the caller: six writes in one method are six effects.
      site: siteKey(w.method, w.line, w.operation),
      cite: w.evidence?.[0] ?? null,
    });
  }
  for (const o of outsideCalls) {
    if (!o.method || o.line == null) continue;
    const name = String(o.target ?? '').split('.').pop();
    const message = MESSAGING.test(o.kind ?? '');
    by.set(siteKey(o.method, o.line, name), {
      kind: message ? 'message' : 'outside',
      label: message ? `sends ${o.kind}` : `${o.kind} ${name}()`,
      key: `${o.kind}|${o.target}`,
      site: siteKey(o.method, o.line, name),
      cite: o.evidence?.[0] ?? null,
    });
  }
  return by;
}

// The entry points themselves, without walking: the caller needs their files to ask git for activity before the walk.
export function flowEntries(model, endpoints = [], selected = []) {
  const entries = [];
  // A UI entry is a public action on a bean a view framework owns: the bean marker and the lifecycle annotations that
  // are not actions come from the catalog, not from names in this file.
  const uiBean = new Set(),
    lifecycle = new Set(),
    frameworkArtifact = new Set();
  for (const { catalog } of selected) {
    for (const a of catalog.annotations ?? []) {
      const fqns = a.fqns ?? (a.fqn ? [a.fqn] : []);
      if (a.means === 'ui-bean') for (const f of fqns) uiBean.add(f);
      if (a.means === 'lifecycle') for (const f of fqns) lifecycle.add(f);
    }
    // A batch artifact is @Named too (it is injected), but it is run by the scheduler, not by a view.
    for (const t of catalog.types ?? [])
      if (t.means === 'framework-artifact') for (const f of t.fqns ?? [t.fqn]) frameworkArtifact.add(f);
  }
  const ACTION_RETURNS = new Set(['void', 'String', 'java.lang.String']);
  for (const e of endpoints) {
    if (!ENTRY_VERB.has(e.verb) && e.verb !== 'GET') continue;
    const t = model.types.get(e.handlerFqn);
    const name = String(e.handler ?? '').split('.').pop();
    const m = t?.methods.find((x) => x.name === name && x.hasBody !== false);
    if (t && m) entries.push({ kind: 'endpoint', verb: e.verb, path: e.path, t, m });
  }
  for (const t of model.types.values())
    for (const m of t.methods) {
      const names = (m.ann ?? []).map((a) => a.fqn ?? a.name);
      if (names.some((n) => SCHEDULE.test(n))) entries.push({ kind: 'job', t, m });
      else if (names.some((n) => LISTENER.test(n)) || (m.name === 'onMessage' && isListener(t)))
        entries.push({ kind: 'listener', t, m });
    }
  for (const t of model.types.values()) {
    if (!(t.ann ?? []).some((a) => uiBean.has(a.fqn ?? ''))) continue;
    if ((t.supers ?? []).some((x) => frameworkArtifact.has(x.fqn ?? ''))) continue;
    for (const m of t.methods) {
      // A JSF action may take arguments (`assignItinerary(int index)`); accessors and lifecycle hooks are not actions.
      if (!m.isPublic || NOISE.test(m.name)) continue;
      if (!ACTION_RETURNS.has(String(m.returnText ?? '').trim())) continue;
      if ((m.ann ?? []).some((a) => lifecycle.has(a.fqn ?? ''))) continue;
      entries.push({ kind: 'ui-action', t, m });
    }
  }
  return entries;
}

export function buildFlows(model, { entries = [], stateWrites = [], outsideCalls = [], transactions = [], entities = [], activityOf = () => 0 } = {}) {
  const effects = effectIndex({ stateWrites, outsideCalls });
  const boundary = new Map(); // method id -> boundary kind
  for (const t of transactions) if (BOUNDARY.has(t.kind) && t.method) boundary.set(t.method, t.kind);
  const refs = new Map((entities ?? []).map((e) => [e.name, e.refs ?? 0]));

  // ---- the walk -----------------------------------------------------------------------------------------------
  // Collects, per method, the effect-bearing trails under it. Memoized per method: a shared service is walked once.
  const memo = new Map();
  const trailsOf = (t, m, depth) => {
    const key = `${m.id}|${depth}`;
    if (memo.has(key)) return memo.get(key);
    const out = [];
    memo.set(key, out); // inserted before the walk: a cyclic call graph terminates and yields what it found
    for (const c of m.calls ?? []) {
      if (c.kind === 'new' || NOISE.test(c.name)) continue;
      const eff = effects.get(siteKey(m.id, c.line, c.name));
      if (eff) {
        out.push({ ids: [], hops: [], effects: [eff] });
        continue;
      }
      for (const id of c.targets ?? []) {
        const [fqn] = id.split('#');
        const nt = model.types.get(fqn);
        const nm = nt?.methods.find((x) => x.id === id);
        if (!nm || nm.hasBody === false) continue;
        if (!depth) continue;
        for (const sub of trailsOf(nt, nm, depth - 1))
          out.push({ ids: [nm.id, ...sub.ids], hops: [`${nt.name}#${nm.name}`, ...sub.hops], effects: sub.effects });
      }
    }
    return out;
  };

  const flows = [];
  for (const { kind, verb, path, t, m } of entries) {
    const trails = trailsOf(t, m, 3);
    if (!trails.length) continue; // no effect reachable: not a flow
    // One line per entry: the union of the effect-bearing trails, in discovery order, effects named at the end.
    const hops = [];
    const found = [];
    for (const tr of trails) {
      for (const h of tr.hops) if (!hops.includes(h)) hops.push(h);
      for (const e of tr.effects) if (!found.some((x) => x.site === e.site && x.kind === e.kind)) found.push(e);
    }
    const written = [...new Set(found.filter((e) => e.kind === 'entity').map((e) => e.key))];
    const entities = Math.min(written.length, FLOW_WEIGHTS.entityCap);
    const outs = new Set(found.filter((e) => e.kind === 'outside').map((e) => e.key)).size;
    const msgs = new Set(found.filter((e) => e.kind === 'message').map((e) => e.key)).size;
    // Risk: any method on the path — the entry or a hop — carries a transaction-boundary fact.
    const pathIds = new Set([m.id]);
    for (const tr of trails) for (const id of tr.ids) pathIds.add(id);
    const withRisk = [...pathIds].map((id) => boundary.get(id)).find(Boolean);
    const central = written.filter((e) => (refs.get(e) ?? 0) >= FLOW_WEIGHTS.centralityRefs);

    const why = [];
    let score = 0;
    const add = (label, n) => {
      if (!n) return;
      score += n;
      why.push(`${label} +${n}`);
    };
    add(
      `entry ${verb ?? kind}`,
      verb ? (verb === 'GET' ? FLOW_WEIGHTS.entryGet : FLOW_WEIGHTS.entryWriteVerb) : kind === 'ui-action' ? FLOW_WEIGHTS.entryUi : FLOW_WEIGHTS.entryJob,
    );
    add(
      `entities ${written.length}${written.length > entities ? ` (cap ${entities})` : ''}${written.length ? ` (${written.join(', ')})` : ''}`,
      entities * FLOW_WEIGHTS.entityWrite,
    );
    add(`outside ${outs}`, outs * FLOW_WEIGHTS.outsideCall);
    add(`messages ${msgs}`, msgs * FLOW_WEIGHTS.message);
    add(`risk ${withRisk}`, withRisk ? FLOW_WEIGHTS.risk : 0);
    add(`centrality ${central.join(', ')}`, central.length ? FLOW_WEIGHTS.centralityEntity : 0);
    const act = activityOf(t.file);
    add(`activity ${act} commit(s)`, act > 0 ? FLOW_WEIGHTS.activity : 0);

    flows.push({
      id: `flow:${m.id}`,
      entry: { kind, verb: verb ?? null, path: path ?? null, method: m.id, cite: `${t.file}:${m.nameLine}#${m.name}` },
      steps: [...hops, ...found.map((e) => e.label)],
      effects: found,
      score,
      why,
      confidence: found.every((e) => e.cite) ? 'resolved' : 'inferred',
      evidence: [`${t.file}:${m.nameLine}#${m.name}`, ...found.map((e) => e.cite).filter(Boolean)].slice(0, 6),
      file: t.file,
    });
  }

  // Centrality through shared services is a property of the whole set, so it is a second pass.
  const through = new Map(); // type name -> flows that pass through it
  for (const f of flows) for (const h of f.steps) {
    const name = h.split('#')[0];
    through.set(name, (through.get(name) ?? 0) + 1);
  }
  for (const f of flows) {
    const shared = f.steps.filter((h, i) => i < f.steps.length - f.effects.length && (through.get(h.split('#')[0]) ?? 0) >= 3);
    if (!shared.length) continue;
    f.score += FLOW_WEIGHTS.sharedService;
    f.why.push(`shared service ${[...new Set(shared.map((h) => h.split('#')[0]))].slice(0, 2).join(', ')} +${FLOW_WEIGHTS.sharedService}`);
  }

  // Rank: score, then fact id, so two runs and two machines agree.
  return flows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const isListener = (t) => (t.supers ?? []).some((s) => /(?:^|\.)(MessageListener|MessageDrivenBean)$/.test(s.fqn ?? s.text ?? ''));

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: an effectless path is not a flow; a transaction boundary outranks an otherwise equal flow; the order is
// stable; a response envelope is not a step.
{
  const { index } = await import('../syntax/java.mjs');
  const { buildModel } = await import('../model/model.mjs');
  const { bindCalls } = await import('../model/calls.mjs');
  const L = (...x) => x.join('\n');
  const src = {
    'src/a/Order.java': L('package a;', 'public class Order {', '  public void mark() { }', '}'),
    'src/a/Repo.java': L('package a;', 'public interface Repo {', '  Order save(Order o);', '  Order find(Long id);', '}'),
    'src/a/RepoImpl.java': L('package a;', 'public class RepoImpl implements Repo {', '  public Order save(Order o) { return o; }', '  public Order find(Long id) { return null; }', '}'),
    'src/a/Quiet.java': L('package a;', 'public class Quiet {', '  public void look() { }', '}'),
    'src/a/Svc.java': L(
      'package a;',
      'public class Svc {',
      '  private Repo repo;',
      '  private Quiet quiet;',
      '  public void create(Order o) { repo.save(o); }',
      '  public void read() { quiet.look(); }',
      '}',
    ),
    'src/a/Ctl.java': L(
      'package a;',
      'import org.springframework.web.bind.annotation.PostMapping;',
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.transaction.annotation.Transactional;',
      'public class Ctl {',
      '  private Svc svc;',
      '  @PostMapping("/orders")',
      '  @Transactional',
      '  public void create(Order o) { svc.create(o); }',
      '  @GetMapping("/orders")',
      '  public void read() { svc.read(); }',
      '}',
    ),
  };
  const model = buildModel(Object.entries(src).map(([p, text]) => ({ p, text, ix: index(text) })));
  bindCalls(model, new Map());
  const endpoints = [
    { verb: 'POST', path: '/orders', handlerFqn: 'a.Ctl', handler: 'Ctl.create' },
    { verb: 'GET', path: '/orders', handlerFqn: 'a.Ctl', handler: 'Ctl.read' },
  ];
  const stateWrites = [
    { id: 'w1', family: 'state-write', entity: 'a.Order', repository: 'a.Repo', operation: 'save', method: 'a.Svc#create(Order)', line: 5, evidence: ['src/a/Svc.java:5#create'] },
  ];
  const transactions = [
    { id: 't1', family: 'transaction', kind: 'outside-in-transaction', method: 'a.Ctl#create(Order)', evidence: ['src/a/Ctl.java:9#create'] },
  ];
  const entities = [{ name: 'Order', refs: 30 }];
  const build = () =>
    buildFlows(model, { entries: flowEntries(model, endpoints), stateWrites, transactions, entities, activityOf: () => 2 });

  const flows = build();
  // Effectless entry: the GET reaches only read-only code, so it is not a flow.
  assert.deepEqual(flows.map((f) => f.entry.verb), ['POST']);
  // One effect, named at the end of the steps; the implementation is the hop, the interface is not.
  assert.deepEqual(flows[0].steps, ['Svc#create', 'writes Order']);
  // Score parts are facts, all of them listed.
  assert.deepEqual(flows[0].why, ['entry POST +3', 'entities 1 (Order) +3', 'risk outside-in-transaction +10', 'centrality Order +2', 'activity 2 commit(s) +1']);
  assert.equal(flows[0].score, 19);
  // Same inputs, same order (ties broken by id).
  assert.deepEqual(build(), build());
}

// ---------------------------------------------------------------------------------------------------------------
// The caps and the UI entry: a fan-out to the same client target is one outside effect; entity points stop at five;
// a public action on a @Named bean is a UI entry, weighted like POST.
{
  const { index } = await import('../syntax/java.mjs');
  const { buildModel } = await import('../model/model.mjs');
  const { bindCalls } = await import('../model/calls.mjs');
  const { loadCatalogs } = await import('../catalogs/catalog.mjs');
  const L = (...x) => x.join('\n');
  const methods = ['a', 'b', 'c', 'd', 'e', 'f'];
  const body = [
    'package u;',
    'import jakarta.inject.Named;',
    '@Named',
    'public class Bulk {',
    '  private W w;',
    '  private H h;',
    '  public void go(Item i) {',
    ...methods.map((m) => `    w.${m}(i);`),
    '    h.ping(i);',
    '    h.ping(i);',
    '  }',
    '}',
  ];
  const writeLine = (i) => 8 + i; // the first `w.a(i)` is line 8
  const pingLine = 8 + methods.length; // the first `h.ping(i)`
  const src = {
    'src/u/Item.java': L('package u;', 'public class Item { }'),
    'src/u/W.java': L('package u;', 'public interface W {', ...methods.map((m) => `  void ${m}(Item i);`), '}'),
    'src/u/WImpl.java': L('package u;', 'public class WImpl implements W {', ...methods.map((m) => `  public void ${m}(Item i) { }`), '}'),
    'src/u/H.java': L('package u;', 'public class H {', '  public void ping(Item i) { }', '}'),
    'src/u/Bulk.java': L(...body),
  };
  const model = buildModel(Object.entries(src).map(([p, text]) => ({ p, text, ix: index(text) })));
  bindCalls(model, new Map());
  const stateWrites = methods.map((m, i) => ({
    id: `w${i}`,
    family: 'state-write',
    entity: `u.Entity${i + 1}`,
    repository: 'u.W',
    operation: m,
    method: 'u.Bulk#go(Item)',
    line: writeLine(i),
    evidence: [`src/u/Bulk.java:${writeLine(i)}#go`],
  }));
  // Two call sites, same client kind and target: one outside effect, not two.
  const outsideCalls = [pingLine, pingLine + 1].map((line, i) => ({
    id: `o${i}`,
    family: 'outside-call',
    kind: 'HTTP',
    client: 'RestTemplate',
    target: 'RestTemplate.ping',
    method: 'u.Bulk#go(Item)',
    line,
    evidence: [`src/u/Bulk.java:${line}#go`],
  }));
  const entries = flowEntries(model, [], loadCatalogs().map((catalog) => ({ catalog })));
  const flows = buildFlows(model, { entries, stateWrites, outsideCalls, activityOf: () => 0 });
  const bulk = flows.find((f) => f.entry.method === 'u.Bulk#go(Item)');
  assert.ok(bulk, 'the UI action is a flow');
  const why = bulk.why.join(' | ');
  assert.match(why, /entry ui-action \+3/);
  assert.match(why, /entities 6 \(cap 5\)/);
  assert.match(why, /entities .* \+15/);
  assert.match(why, /outside 1 \+2/);
}
