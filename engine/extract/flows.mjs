import assert from 'node:assert/strict';
import { accessFor } from './security.mjs';
import { superBindings } from '../model/type-args.mjs';

// Flow skeletons (§5.3, revised): a path from an entry point to at least one effect. An effect is a state write (a
// repository or EntityManager call, from the state family), an outside call (HTTP, mail, messaging, from the outside
// family) or a message sent (an outside call to a broker). A branch with no effect is not part of the flow, so response
// envelopes and read-only side branches disappear; a path with no effect anywhere is not a flow at all.
//
// The walk runs on the resolved call graph (`call.targets`), through an interface target to the implementation that has
// a body. Every effect and every hop is cited, and the rank is computed from facts only — never from a name — with each
// part of the score written into `why`, so a reader can check the order.
//
// Branch arms: a method's `branches` (the dump's line ranges for if/else/switch arms and catch bodies — the arm,
// never the condition) say which calls sit behind a decision. An effect reached only through such an arm is
// `conditional`: it does not happen on the entry's default path, so it is marked in its label and scored at half
// weight. An effect that one unconditional trail also reaches is not conditional at all — some path always runs it.

const ENTRY_VERB = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'ANY']);
const SCHEDULE = /(?:^|\.)(Scheduled|Schedules|Schedule)$/;
const LISTENER = /(?:^|\.)(JmsListener|RabbitListener|KafkaListener|MessageDriven|EventListener)$/;
const BOUNDARY = new Set(['requires-new', 'after-commit', 'outside-in-transaction', 'outside-then-save']);
// A consumer loop is walked further than a request: its effect is often four or five hops away.
const WORKER_DEPTH = 18;
// A request reaches the save behind a base service at five hops once the targets are exact.
const FLOW_DEPTH = 5;
// A worker is summarized by reachability, not by every trail: the alert pipeline alone has hundreds of call chains,
// and what a reader needs is the ordered first sighting of each method plus every effect it can reach.
const WORKER_METHODS = 1500;
const MESSAGING = /^(Kafka|Rabbit|RabbitMQ|JMS|SQS|PubSub|Messaging|MQ|AMQP)$/i;
// Call names that are plumbing in any program: they are never a hop and never an effect.
const NOISE =
  /^(?:(?:get|set|is|has|to|of|with|from)[A-Z_$]|name$|size$|isEmpty$|isBlank$|orElse$|ifPresent$|toString$|equals$|hashCode$|valueOf$|stream$|collect$|map$|filter$|forEach$|add$|put$|remove$|iterator$|next$|parse$|now$|split$|trim$|length$|charAt$|contains$|matches$|matcher$|test$|apply$|accept$|run$|execute$|warn$|info$|error$|debug$|trace$|lock$|unlock$|requireNonNull$|printStackTrace$|format$|append$|build$|call$)/;

// The rank, in one place. Every weight is a fact count or a fixed kind; nothing here reads a method or type name
// except the entry verb. Changing a weight changes the digest order and nothing else.
export const FLOW_WEIGHTS = {
  entityWrite: 3, // the first distinct entity written: the flow changes this aggregate
  entityFurther: 1, // each further entity: breadth, not importance — a five-table signup is not five times a checkout
  statusChange: 3, // a status set on an entity on the path: the flow moves a core object through its lifecycle
  outsideCall: 3, // per outside call (HTTP, mail, payment, and the message send below counted in addition)
  message: 2, // per message sent
  risk: 2, // a transaction-boundary fact on the path: a tie-break, never what makes a flow the main flow
  entryWriteVerb: 3, // POST/PUT/PATCH/DELETE
  entryJob: 2, // scheduled job or message listener: machinery around the product, not the product
  entryUi: 3, // a JSF action method on a UI bean (weighted like POST)
  entryWorker: 3, // a continuous worker fans out to every channel, but no user asks for it
  listenerEntry: -6, // a flow that starts only because another system sent a message is downstream by nature
  // Visibility: a public, visitor-facing path is what the product is; an admin or internal path is not. The facts
  // decide (security rules and the frontend's API calls), never the path's spelling alone.
  publicEntry: 12,
  // Visibility scales with callers: an endpoint one page calls is a feature, an endpoint four pages call is the
  // product's surface. The ladder is capped because a fifth page says nothing new about importance.
  frontendCall: 4, // exactly one distinct frontend call site reaches the endpoint
  frontendSpread: 6, // frontendSpreadAt or more distinct call sites
  frontendWide: 8, // frontendWideAt or more, and never more than this
  frontendSpreadAt: 2,
  frontendWideAt: 4,
  internalEntry: -3,
  importEntityCap: 2, // a bulk import writes many entities because it loops them, not because it is complex
  entryGet: 0, // a GET with an effect is still a flow
  // A flow that writes an entity the facts give a lifecycle (a status is set on it) moves a core object
  // through its states. A flow that only writes supporting rows — a token, a join row, a queued email — moves nothing
  // core. Once per flow, whatever its width.
  coreObject: 2,
  centralityEntity: 2, // writes an entity many other types refer to (once per flow)
  centralityRefs: 20, // "many" = referenced by at least this many types
  entityCap: 5, // entity points stop here, however many entities a flow writes
  sharedService: 1, // passes through a type that three or more flows pass through
  // An effect only a conditional arm reaches may not happen on the entry's default path, so it cannot weigh what
  // always happens: it counts at half weight, rounded down (3 -> 1, 2 -> 1, 1 -> 0). The one divisor lives here so
  // this score, the digest's `(conditional)` marker and rules §3.9 say the same thing.
  conditionalDivisor: 2,
  // Outside effects are counted per client kind and target (`JMS|JMSProducer.send`), not per call: a notification
  // fan-out to thirteen channels of the same kind is one effect, not thirteen.
  activity: 1, // a file on the path changed in the git window; small, never decisive
};

const simple = (s) => String(s ?? '').split('.').pop();

// Queue polls and executor hand-offs, from catalog data or the receiver's type name (a project's own `…Queue`,
// `…WorkerPool`). One classifier so the entry detector and the walk agree on what is a boundary.
function callClassifier(selected = []) {
  const means = [];
  for (const { catalog } of selected)
    for (const c of catalog.calls ?? [])
      means.push({ types: new Set(c.types ?? (c.type ? [c.type] : [])), methods: new Set(c.methods ?? []), means: c.means });
  const meansOf = (fqn, name) => {
    if (!fqn) return null;
    const hit = means.find((x) => x.types.has(fqn) && (!x.methods.size || x.methods.has(name)));
    return hit?.means ?? null;
  };
  const isPoll = (c) => meansOf(c.recvFqn, c.name) === 'queue-poll' || /Queue$/.test(simple(c.recvFqn ?? ''));
  const isExecutor = (c) =>
    meansOf(c.recvFqn, c.name) === 'executor' || /(?:Executor|Pool)$/.test(simple(c.recvFqn ?? ''));
  return { isPoll, isExecutor, meansOf };
}
const siteKey = (methodId, line, name) => `${methodId}|${line}|${name}`;
// One frontend call site: the line when the fact carries one, the file alone when it does not, so the same page
// fetching an endpoint twice is still one caller.
const callSite = (c) => (Number.isFinite(c.line) ? `${c.file}|${c.line}` : String(c.file ?? ''));
// The visibility ladder: 0 sites -> nothing, 1 -> frontendCall, 2-3 -> frontendSpread, 4+ -> frontendWide.
const frontendPoints = (sites) =>
  sites >= FLOW_WEIGHTS.frontendWideAt
    ? FLOW_WEIGHTS.frontendWide
    : sites >= FLOW_WEIGHTS.frontendSpreadAt
      ? FLOW_WEIGHTS.frontendSpread
      : sites > 0
        ? FLOW_WEIGHTS.frontendCall
        : 0;

// Effects by call site: the fact families already decided what a write and an outside call are; this only indexes them.
function effectIndex({ stateWrites = [], outsideCalls = [] }) {
  const by = new Map();
  for (const w of stateWrites) {
    if (!w.method || w.line == null) continue;
    // An EntityManager write names no entity (the argument is a local); it still counts as a state write, under the
    // persistence API that performed it. A write through a type parameter names the parameter; the flow binds it.
    const what = w.entity ? simple(w.entity) : `via ${simple(w.repository ?? 'state')}`;
    by.set(siteKey(w.method, w.line, w.operation), {
      kind: 'entity',
      label: `writes ${what}`,
      key: what,
      ...(w.entityVar ? { entityVar: w.entityVar, entityOwner: w.entityOwner } : {}),
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

// Status sets by method: the lifecycle family already says which entity's status each site sets, so a flow that walks
// that method moves the entity through its lifecycle. Keyed by method, not by call site — a status set is a
// statement, not a call, and the walk knows it reached the method.
function statusIndex(statusSets = []) {
  const by = new Map();
  for (const s of statusSets) {
    if (!s.method || !s.entity) continue;
    const site = siteKey(s.method, s.line ?? 0, `status:${s.value}`);
    const list = by.get(s.method) ?? [];
    if (!list.some((x) => x.site === site)) {
      list.push({
        kind: 'status',
        label: `sets ${s.entity} status ${s.value}`,
        key: `${s.entity}|${s.value}`,
        entity: s.entity,
        value: s.value,
        // The line is what says whether the set sits inside a branch arm of the method that writes it.
        line: s.line ?? null,
        site,
        cite: s.evidence?.[0] ?? null,
      });
    }
    by.set(s.method, list);
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
    startup = new Set(),
    frameworkArtifact = new Set();
  for (const { catalog } of selected) {
    for (const a of catalog.annotations ?? []) {
      const fqns = a.fqns ?? (a.fqn ? [a.fqn] : []);
      if (a.means === 'ui-bean') for (const f of fqns) uiBean.add(f);
      if (a.means === 'lifecycle' || a.means === 'startup') for (const f of fqns) lifecycle.add(f);
      if (a.means === 'startup') for (const f of fqns) startup.add(f);
    }

    // A batch artifact is @Named too (it is injected), but it is run by the scheduler, not by a view.
    for (const t of catalog.types ?? [])
      if (t.means === 'framework-artifact') for (const f of t.fqns ?? [t.fqn]) frameworkArtifact.add(f);
  }
  const ACTION_RETURNS = new Set(['void', 'String', 'java.lang.String']);
  for (const e of endpoints) {
    if (!ENTRY_VERB.has(e.verb) && e.verb !== 'GET') continue;
    const t = model.types.get(e.handlerFqn);
    // An inherited mapping runs the declaring class's method, for this controller: the context is the controller.
    const owner = model.types.get(e.declaredIn ?? e.handlerFqn) ?? t;
    const name = String(e.handler ?? '').split('.').pop();
    const m = owner?.methods.find((x) => x.name === name && x.hasBody !== false);
    if (t && m) entries.push({ kind: 'endpoint', verb: e.verb, path: e.path, t, m, owner, ctx: t.fqn });
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

  // A worker: a loop that polls a queue, started by the application. The queue and the executor are recognised from
  // catalog data (`means: 'queue-poll'` / `'executor'`) or, for a project's own abstraction, by the receiver's type
  // name ending in Queue / Executor / Pool. It is started when the method is itself a lifecycle hook, when it hands a
  // Runnable to an executor (the loop is in the lambda), or when a lifecycle method calls it.
  const { isPoll, isExecutor } = callClassifier(selected);
  const inLoop = (m, line) => (m.loops ?? []).some((l) => l.start <= line && line <= l.end);
  const pollsInLoop = (m) => (m.calls ?? []).some((c) => inLoop(m, c.line) && isPoll(c));
  // The Runnable may be handed over inline or through a local (`Runnable r = () -> …; pool.execute(r)`); either way the
  // method that both polls and talks to an executor is the one that starts the loop.
  const startsLoop = (m) =>
    (m.calls ?? []).some(isExecutor) || (m.ann ?? []).some((a) => lifecycle.has(a.fqn ?? ''));
  const calledFromStartup = (id) =>
    [...model.types.values()].some(
      (t) =>
        (t.ann ?? []).some((a) => startup.has(a.fqn ?? '')) &&
        t.methods.some((x) => (x.calls ?? []).some((c) => (c.targets ?? []).includes(id) || (c.name === id.split('#')[1]?.split('(')[0] && !c.recv))),
    );
  const cls = callClassifier(selected);
  const pollsByCatalog = (m) =>
    (m.calls ?? []).some((c) => inLoop(m, c.line) && cls.meansOf(c.recvFqn, c.name) === 'queue-poll');
  const startsByCatalog = (m) => (m.calls ?? []).some((c) => cls.meansOf(c.recvFqn, c.name) === 'executor');
  for (const t of model.types.values())
    for (const m of t.methods)
      if (m.id && pollsInLoop(m) && (startsLoop(m) || calledFromStartup(m.id)))
        entries.push({
          kind: 'worker',
          t,
          m,
          // A queue or a pool recognised only by its name is a guess; the fact says so.
          inferred: !(pollsByCatalog(m) && startsByCatalog(m)),
        });
  return entries;
}

export function buildFlows(
  model,
  {
    entries = [],
    stateWrites = [],
    outsideCalls = [],
    statusSets = [],
    transactions = [],
    entities = [],
    activityOf = () => 0,
    selected = [],
    securityRules = [],
    frontendPaths = [],
    // Depth 5 needs exact targets; while the Node resolver still guesses, ambiguous targets would multiply instead.
    exactTargets = false,
  } = {},
) {
  const { isPoll, isExecutor } = callClassifier(selected);
  const effects = effectIndex({ stateWrites, outsideCalls });
  const statuses = statusIndex(statusSets);
  // The entities the facts give a lifecycle: some site in the code sets a status on them. A flow that writes one moves
  // a core object. Read from the lifecycle family, never from a name.
  const lifecycleEntities = new Set(statusSets.filter((s) => s.method && s.entity).map((s) => simple(s.entity)));
  const boundary = new Map(); // method id -> boundary kind
  for (const t of transactions) if (BOUNDARY.has(t.kind) && t.method) boundary.set(t.method, t.kind);
  const refs = new Map((entities ?? []).map((e) => [e.name, e.refs ?? 0]));

  // ---- branch arms ---------------------------------------------------------------------------------------------
  // A method's `branches` are the line ranges of its if/else/switch arms and catch bodies (the arm's body, never the
  // condition, so a call written in `if (repo.exists())` stays unconditional). A call whose line falls inside one is
  // conditional, and so is everything that call reaches: the effect below it only runs when that arm runs.
  const branchMemo = new Map();
  const branchRanges = (m) => {
    if (branchMemo.has(m)) return branchMemo.get(m);
    const ranges = (m?.branches ?? []).filter((b) => Number.isFinite(b?.start) && Number.isFinite(b?.end));
    branchMemo.set(m, ranges);
    return ranges;
  };
  const insideBranch = (m, line) =>
    Number.isFinite(line) && branchRanges(m).some((b) => b.start <= line && line <= b.end);
  // One marker for the fact, the digest line and the rules: the label carries it, `conditional` states it.
  const marked = (eff, cond) =>
    cond && !eff.conditional ? { ...eff, conditional: true, label: `${eff.label} (conditional)` } : eff;

  // ---- the walk -----------------------------------------------------------------------------------------------
  // The class the code runs for. An inherited mapping runs for the concrete controller, and the Java engine's
  // per-class answers (`call.targetsIn[ctx]`) say what the call reaches there. Entering a concrete class switches the
  // context; abstract parents keep it, because their code is the subclass's code.
  const targetsOf = (c, ctx) => (ctx && c.targetsIn?.[ctx]) || c.targets || [];
  const ctxAfter = (nt, ctx) => (nt.kind === 'class' && !nt.abstract ? nt.fqn : ctx);
  const DEPTH = exactTargets ? FLOW_DEPTH : 3;
  // Collects, per method and context, the effect-bearing trails under it. Memoized: a shared service is walked once.
  const memo = new Map();
  // A write found through a class's type parameter (`GenericRepo<T>.save` in a generic base) names its entity only
  // where the base is bound; the concrete type is what the flow changes.
  const concrete = (eff, bind) => {
    const fqn = eff?.entityVar ? bind.get(eff.entityOwner)?.get(eff.entityVar) : null;
    if (!fqn || !model.types.has(fqn)) return eff;
    return { ...eff, entity: fqn, key: simple(fqn), label: `writes ${simple(fqn)}` };
  };
  const bindKey = (bind) =>
    !bind.size
      ? ''
      : [...bind].map(([k, v]) => `${k}:${[...v].map(([a, b]) => `${a}=${simple(b)}`).join(',')}`).join(';');
  // The bindings a hop into a supertype opens: `VoucherService extends AbstractVersionService<Voucher>` binds T there.
  const bindInto = (bind, from, to) => {
    if (from === to.fqn) return bind;
    const opened = superBindings(model, from, to.fqn, bind);
    return opened.size ? new Map(bind).set(to.fqn, opened) : bind;
  };
  // A port declaration has no body: when exactly one project type implements it, the port call runs there. Two
  // implementations would be a guess, so the walk stops at the declaration exactly as it did before.
  const implMemo = new Map();
  const implementationsOf = (fqn) => {
    if (implMemo.has(fqn)) return implMemo.get(fqn);
    const out = [],
      seen = new Set([fqn]),
      queue = [fqn];
    while (queue.length)
      for (const sub of model.implsOf?.get(queue.shift()) ?? []) {
        if (seen.has(sub)) continue;
        seen.add(sub);
        const t = model.types.get(sub);
        if (!t) continue;
        // An abstract adapter or a further interface is not the code that runs; its own subtypes are still walked.
        if (t.kind !== 'interface' && !isAbstract(t)) out.push(sub);
        queue.push(sub);
      }
    implMemo.set(fqn, out);
    return out;
  };
  const soleImplMemo = new Map();
  const soleImpl = (nt, nm) => {
    const key = `${nt.fqn}#${nm.name}/${nm.params?.length ?? 0}`;
    if (soleImplMemo.has(key)) return soleImplMemo.get(key);
    const impls = implementationsOf(nt.fqn);
    let hit = null;
    if (impls.length === 1) {
      const impl = model.types.get(impls[0]);
      const m = impl?.methods.find(
        (x) => x.name === nm.name && (x.params?.length ?? 0) === (nm.params?.length ?? 0) && x.hasBody !== false,
      );
      if (m) hit = { t: impl, m };
    }
    soleImplMemo.set(key, hit);
    return hit;
  };
  // The method a target id reaches: the declaration itself, or the only implementation of an open declaration.
  const bodyAt = (id) => {
    const nt = model.types.get(id.split('#')[0]);
    const nm = nt?.methods.find((x) => x.id === id);
    if (!nm) return null;
    if (nm.hasBody !== false) return { t: nt, m: nm };
    return nt.kind === 'interface' || isAbstract(nt) ? soleImpl(nt, nm) : null;
  };
  const trailsOf = (t, m, ctx, depth, bind, cond = false) => {
    const key = `${ctx}|${m.id}|${depth}|${bindKey(bind)}|${cond ? 'c' : ''}`;
    if (memo.has(key)) return memo.get(key);
    const out = [];
    memo.set(key, out); // inserted before the walk: a cyclic call graph terminates and yields what it found
    // A status set in this method is an effect of reaching it, whether or not the method calls anything else.
    for (const eff of statuses.get(m.id) ?? [])
      out.push({ ids: [], hops: [], effects: [marked(eff, cond || insideBranch(m, eff.line))] });
    for (const c of m.calls ?? []) {
      if (c.kind === 'new' || NOISE.test(c.name)) continue;
      const eff = concrete(effects.get(siteKey(m.id, c.line, c.name)), bind);
      // The call site decides for itself: a call written inside an arm runs only when that arm runs.
      const nextCond = cond || insideBranch(m, c.line);
      if (eff) {
        out.push({ ids: [], hops: [], effects: [marked(eff, nextCond)] });
        continue;
      }
      for (const id of targetsOf(c, ctx)) {
        const hit = bodyAt(id);
        if (!hit) continue;
        const { t: nt, m: nm } = hit;
        // A super call to the same name continues this method in its parent: a pass-through, not a hop deeper. Only
        // with exact targets, because an ambiguous super target would branch without ever using a depth step.
        const step = exactTargets && c.recvHow === 'super' && nm.name === m.name ? 0 : 1;
        if (depth < step) continue;
        // The context only changes where the engine gave a per-class answer; without one, switching it per hop
        // would split the memo for no gain.
        const nextCtx = c.targetsIn?.[ctx] ? ctxAfter(nt, ctx) : ctx;
        const nextBind = bindInto(bind, m.id.split('#')[0], nt);
        for (const sub of trailsOf(nt, nm, nextCtx, depth - step, nextBind, nextCond))
          out.push({ ids: [nm.id, ...sub.ids], hops: [`${nt.name}#${nm.name}`, ...sub.hops], effects: sub.effects });
      }
    }
    return out;
  };

  // Worker reachability: breadth-first with parent links, so the hop list is the path to an effect rather than every
  // method the loop touches. An executor call is not a wall: the calls inside the Runnable handed to it belong to the
  // same method and run in the worker, so they are walked too (hertzbeat's `pool.executeNotify(type, () -> send(...))`).
  const workerReach = (t, m, ctx) => {
    const parent = new Map([[m.id, null]]);
    const hops = [],
      found = [],
      foundAt = new Map(),
      seenCond = new Map();
    const record = (mm) => {
      const path = [];
      for (let id = mm.id; id && id !== m.id; id = parent.get(id)?.id) {
        const p = parent.get(id);
        if (p) path.unshift(`${p.t.name}#${p.m.name}`);
      }
      for (const h of path) if (h !== `${t.name}#${m.name}` && !hops.includes(h)) hops.push(h);
    };
    // One effect, seen once: a conditional sighting is upgraded to unconditional when a later trail always runs it.
    const note = (e, mm, cond) => {
      const full = marked(e, cond);
      const at = foundAt.get(e.site);
      if (at == null) {
        foundAt.set(e.site, found.length);
        found.push(full);
        record(mm);
      } else if (found[at].conditional && !full.conditional) found[at] = full;
    };
    // Returns the calls to enqueue.
    const process = (tt, mm, c, cond) => {
      const nextCond = cond || insideBranch(mm, c.line);
      // `seenCond` keeps the least conditional sighting: a call first found behind a branch and later found
      // unconditionally is walked again, so its effects lose the marker.
      const seen = seenCond.get(c);
      if (seen === false || (seen === true && nextCond)) return [];
      seenCond.set(c, nextCond);
      const eff = effects.get(siteKey(mm.id, c.line, c.name));
      if (eff) {
        note(eff, mm, nextCond);
        return [];
      }
      const out = [];
      for (const id of targetsOf(c, ctx)) {
        if (parent.has(id)) continue;
        const [fqn] = id.split('#');
        const nt = model.types.get(fqn);
        const nm = nt?.methods.find((x) => x.id === id);
        if (!nm || nm.hasBody === false) continue;
        parent.set(id, { id: mm.id, t: tt, m: mm });
        out.push([nt, nm]);
      }
      return out;
    };
    // The Runnable: its calls sit in this method's digest but inside the lambda's line range.
    const inRunnable = (mm, c) => {
      const ranges = (c.lambdas ?? []).map((l) => [l.line, l.endLine]);
      const all = ranges.length ? ranges : (mm.lambdas ?? []).map((l) => [l.start, l.end]);
      return (mm.calls ?? []).filter((c2) => c2 !== c && all.some(([a, b]) => a <= c2.line && c2.line <= b));
    };
    let queue = [[t, m, false]];
    for (let d = 0; d < WORKER_DEPTH && queue.length && parent.size < WORKER_METHODS; d++) {
      const next = [];
      for (const [tt, mm, cond] of queue) {
        for (const eff of statuses.get(mm.id) ?? []) note(eff, mm, cond || insideBranch(mm, eff.line));
        for (const c of mm.calls ?? []) {
          if (isPoll(c)) continue;
          if (isExecutor(c)) {
            next.push(...inRunnable(mm, c).flatMap((c2) => process(tt, mm, c2, cond)));
            continue;
          }
          next.push(...process(tt, mm, c, cond));
        }
      }
      queue = next;
      if (found.length >= 6) break;
    }
    return { hops, effects: found };
  };

  const flows = [];
  for (const { kind, verb, path, t, m, owner, ctx: entryCtx, inferred: entryInferred } of entries) {
    // The context is the concrete class the entry runs for; an inherited mapping runs the owner's method for it.
    const ctx = entryCtx ?? t.fqn;
    const codeOf = owner ?? t;
    const trails = kind === 'worker' ? null : trailsOf(t, m, ctx, DEPTH, new Map());
    if (kind !== 'worker' && !trails.length) continue; // no effect reachable: not a flow
    // One line per entry: the union of the effect-bearing trails, in discovery order, effects named at the end.
    let hops = [],
      found = [];
    if (trails) {
      for (const tr of trails) {
        for (const h of tr.hops) if (!hops.includes(h)) hops.push(h);
        for (const e of tr.effects) {
          const at = found.findIndex((x) => x.site === e.site && x.kind === e.kind);
          // An effect one unconditional trail reaches is not conditional: some path always runs it, so the
          // unconditional sighting replaces the conditional one.
          if (at < 0) found.push(e);
          else if (found[at].conditional && !e.conditional) found[at] = e;
        }
      }
    } else {
      const r = workerReach(t, m, ctx);
      hops = r.hops.slice(0, 20);
      found = r.effects;
      if (!found.length) continue; // a loop that reaches no effect is not a flow
    }
    // An effect key is conditional only when every site of it is: one unconditional site means the effect happens on
    // the default path, so no label may still say `(conditional)` and the score must weigh it in full.
    const alwaysRuns = new Set(found.filter((e) => !e.conditional).map((e) => `${e.kind}|${e.key}`));
    found = found.map((e) => {
      if (!e.conditional || !alwaysRuns.has(`${e.kind}|${e.key}`)) return e;
      const plain = { ...e };
      delete plain.conditional;
      plain.label = plain.label.replace(/ \(conditional\)$/, '');
      return plain;
    });

    // Which effects happen on the default path and which only inside an arm: per key (an entity, a client target, a
    // status), the effect is conditional only when every site that produces it is conditional. `save()` unconditional
    // and a `charge()` inside `if (trial)` therefore leave the write full-weight and the charge marked.
    const byKey = (kind) => {
      const out = new Map();
      for (const e of found)
        if (e.kind === kind && e.key != null)
          out.set(e.key, out.has(e.key) ? out.get(e.key) && !!e.conditional : !!e.conditional);
      return out;
    };
    const entityCond = byKey('entity');
    const written = [...entityCond.keys()];
    // A bulk import writes one row per loop iteration; its entity count says nothing about the flow's importance.
    const importish =
      /^(?:import|bulk|batch|seed)/i.test(m.name) || hops.some((h) => /^(?:DataImport|Import|Template|Seed|Bulk)/.test(h.split('#')[0]));
    const importCap = importish ? FLOW_WEIGHTS.importEntityCap : FLOW_WEIGHTS.entityCap;
    const counted = written.slice(0, importCap);
    // A lifecycle change is one fact about the flow: it moves a core object through its statuses, however many sites
    // on the path set it. Weighted once, like centrality, so a CRUD sweep cannot outrank a real transition.
    // Only a status change on an entity the flow itself writes moves a core object through its lifecycle. Every flow
    // touches a notification or email row whose status it sets; counting those adds the same points to all of them.
    const writtenSet = new Set(written);
    const statusCond = new Map();
    for (const e of found)
      if (e.kind === 'status' && writtenSet.has(e.entity)) {
        const key = `${e.entity}.${e.value}`;
        statusCond.set(key, statusCond.has(key) ? statusCond.get(key) && !!e.conditional : !!e.conditional);
      }
    const statusesSet = [...statusCond.keys()];
    const outsideCond = byKey('outside');
    const messageCond = byKey('message');
    // Half weight, rounded down, for an effect that only a conditional arm reaches.
    const half = (w) => Math.floor(w / FLOW_WEIGHTS.conditionalDivisor);
    const weigh = (weight, conditional) => (conditional ? half(weight) : weight);
    const entityPoints = counted.reduce(
      (n, k, i) => n + weigh(i === 0 ? FLOW_WEIGHTS.entityWrite : FLOW_WEIGHTS.entityFurther, entityCond.get(k)),
      0,
    );
    // The `why` note: how many of the counted effects may not happen on the default path.
    const condNote = (map) => {
      const n = [...map.values()].filter(Boolean).length;
      return n ? `${n} conditional` : '';
    };
    // Risk: any method on the path — the entry or a hop — carries a transaction-boundary fact.
    const pathIds = new Set([m.id]);
    for (const tr of trails ?? []) for (const id of tr.ids) pathIds.add(id);
    const withRisk = [...pathIds].map((id) => boundary.get(id)).find(Boolean);
    const central = written.filter((e) => (refs.get(e) ?? 0) >= FLOW_WEIGHTS.centralityRefs);
    // Core object: does this flow write an entity the facts give a lifecycle? Supporting rows — a token, a queued
    // email, a join row — have none, so a flow that only writes those moves nothing core.
    const coreWritten = written.filter((e) => lifecycleEntities.has(simple(e)));
    const coreUnconditional = coreWritten.some((e) => !entityCond.get(e));

    const why = [];
    let score = 0;
    const add = (label, n, whyNote = '') => {
      if (!n) return;
      score += n;
      why.push(`${label} ${n > 0 ? '+' : ''}${n}${whyNote ? `, ${whyNote}` : ''}`);
    };
    add(
      `entry ${verb ?? kind}`,
      verb
        ? verb === 'GET'
          ? FLOW_WEIGHTS.entryGet
          : FLOW_WEIGHTS.entryWriteVerb
        : kind === 'ui-action'
          ? FLOW_WEIGHTS.entryUi
          : kind === 'worker'
            ? FLOW_WEIGHTS.entryWorker
            : FLOW_WEIGHTS.entryJob,
    );
    // Nobody in the product asks for a listener: it runs because another system spoke. Its entity writes and messages
    // still count, so a consequential consumer stays visible — it just cannot outrank a flow a person starts.
    if (kind === 'listener') add('listener', FLOW_WEIGHTS.listenerEntry);
    add(
      `entities ${written.length}${written.length > counted.length ? ` (cap ${counted.length})` : ''}${written.length ? ` (${written.join(', ')})` : ''}`,
      entityPoints,
      condNote(entityCond),
    );
    // A flow that writes a lifecycle entity moves a core object; one that only writes supporting rows does not.
    add(
      `core object ${coreWritten.slice(0, 3).join(', ')}`,
      coreWritten.length ? weigh(FLOW_WEIGHTS.coreObject, !coreUnconditional) : 0,
      coreUnconditional || !coreWritten.length ? '' : 'conditional',
    );
    // A lifecycle change is unconditional when any status set on the path runs on it; a transition that only one arm
    // performs counts at half weight, like any other conditional effect.
    const statusUnconditional = statusesSet.some((k) => !statusCond.get(k));
    add(
      `status ${statusesSet.slice(0, 3).join(', ')}`,
      statusesSet.length ? weigh(FLOW_WEIGHTS.statusChange, !statusUnconditional) : 0,
      statusUnconditional ? '' : `${statusesSet.length} conditional`,
    );
    const outsidePoints = [...outsideCond.values()].reduce((n, c) => n + weigh(FLOW_WEIGHTS.outsideCall, c), 0);
    const messagePoints = [...messageCond.values()].reduce((n, c) => n + weigh(FLOW_WEIGHTS.message, c), 0);
    add(`outside ${outsideCond.size}`, outsidePoints, condNote(outsideCond));
    add(`messages ${messageCond.size}`, messagePoints, condNote(messageCond));
    add(`risk ${withRisk}`, withRisk ? FLOW_WEIGHTS.risk : 0);
    add(`centrality ${central.join(', ')}`, central.length ? FLOW_WEIGHTS.centralityEntity : 0);
    // Visibility, from facts: the security rule that governs the path, and whether the public frontend calls it.
    if (verb) {
      const access = accessFor(securityRules, path ?? '');
      // A visitor-facing call is one the public site makes, not the admin panel: the frontend facts carry the page,
      // so a call from an admin/dashboard page does not count, however the API path is spelled.
      const calls = frontendPaths.filter((p) => p.path === path || p.path === path?.replace(/\{\}/g, '*'));
      const visitorCalls = calls.filter((c) => !/(?:^|\/)(?:admin|dashboard|internal)(?:\/|$)/i.test(c.file ?? ''));
      const publicPage = visitorCalls.length > 0;
      // Distinct call sites, not calls: one page with two fetches is one caller; four pages are the product's surface.
      const sites = new Set(visitorCalls.map(callSite)).size;
      const anonymous = access === 'anonymous';
      // Staff APIs live under the tenant/admin/internal prefixes; a chain that permits them all does not make the
      // staff panel a visitor-facing surface.
      const staffApi = /^\/api\/(?:tenant|admin|internal|staff|dashboard)\b/.test(path ?? '');
      const visitor = anonymous && !staffApi && (publicPage || /^\/api\/public\b/.test(path ?? ''));
      add(visitor ? 'visibility public' : anonymous ? 'visibility anonymous (staff UI)' : access === 'authenticated' || access.startsWith('role:') ? 'visibility internal' : '',
        visitor ? FLOW_WEIGHTS.publicEntry : access === 'authenticated' || access.startsWith('role:') ? FLOW_WEIGHTS.internalEntry : 0);
      add(`frontend-called${sites > 1 ? ` ${sites} sites` : ''}`, frontendPoints(sites));
    }
    const act = activityOf(codeOf.file);
    add(`activity ${act} commit(s)`, act > 0 ? FLOW_WEIGHTS.activity : 0);

    flows.push({
      // The same inherited method serves many controllers: the context keeps their flows apart.
      id: `flow:${m.id}${codeOf !== t ? `@${t.fqn}` : ''}`,
      entry: { kind, verb: verb ?? null, path: path ?? null, method: m.id, cite: `${codeOf.file}:${m.signatureLine ?? m.nameLine}#${m.name}` },
      steps: [...hops, ...found.map((e) => e.label)],
      effects: found,
      score,
      why,
      confidence: entryInferred ? 'inferred' : found.every((e) => e.cite) ? 'resolved' : 'inferred',
      evidence: [`${codeOf.file}:${m.signatureLine ?? m.nameLine}#${m.name}`, ...found.map((e) => e.cite).filter(Boolean)].slice(0, 6),
      file: codeOf.file,
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

  // Rank: score, then breadth, then fact id. A tie must not fall through to alphabetical order, which would put
  // `forgotPassword` above `activateLoan` for no reason a reader can see.
  return flows.sort((a, b) => b.score - a.score || b.steps.length - a.steps.length || a.id.localeCompare(b.id));
}

const isListener = (t) => (t.supers ?? []).some((s) => /(?:^|\.)(MessageListener|MessageDrivenBean)$/.test(s.fqn ?? s.text ?? ''));
// A model built from source carries `abstract`; one built from the dump carries the modifier list.
const isAbstract = (t) => !!t?.abstract || (t?.modifiers ?? []).includes('abstract');

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: an effectless path is not a flow; a transaction boundary outranks an otherwise equal flow; the order is
// stable; a response envelope is not a step.
{
  const { index } = await import('../../test/fixtures/syntax-java.mjs');
  const { buildModel } = await import('../../test/fixtures/model-from-source.mjs');
  const { linkCalls } = await import('../model/link-for-tests.mjs');
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
  linkCalls(model);
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
  assert.deepEqual(flows[0].why, ['entry POST +3', 'entities 1 (Order) +3', 'risk outside-in-transaction +2', 'centrality Order +2', 'activity 2 commit(s) +1']);
  assert.equal(flows[0].score, 11);
  // Same inputs, same order (ties broken by id).
  assert.deepEqual(build(), build());
}

// ---------------------------------------------------------------------------------------------------------------
// The caps and the UI entry: a fan-out to the same client target is one outside effect; entity points stop at five;
// a public action on a @Named bean is a UI entry, weighted like POST.
{
  const { index } = await import('../../test/fixtures/syntax-java.mjs');
  const { buildModel } = await import('../../test/fixtures/model-from-source.mjs');
  const { linkCalls } = await import('../model/link-for-tests.mjs');
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
  linkCalls(model);
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
  assert.match(why, /entities .* \+7/, 'five entities: three for the aggregate, one for each further table');
  assert.match(why, /outside 1 \+3/);
}

// ---------------------------------------------------------------------------------------------------------------
// An inherited endpoint: one base method serves two controllers, so the context keeps the two flows apart and the
// citation points at the code that runs.
{
  const { index } = await import('../../test/fixtures/syntax-java.mjs');
  const { buildModel } = await import('../../test/fixtures/model-from-source.mjs');
  const { linkCalls } = await import('../model/link-for-tests.mjs');
  const L = (...x) => x.join('\n');
  const src = {
    'src/b/Order.java': L('package b;', 'public class Order { }'),
    'src/b/Repo.java': L('package b;', 'public interface Repo {', '  void save(Order o);', '}'),
    'src/b/RepoImpl.java': L('package b;', 'public class RepoImpl implements Repo {', '  public void save(Order o) { }', '}'),
    'src/b/Base.java': L(
      'package b;',
      'public abstract class Base {',
      '  private Repo repo;',
      '  public void publish(Order o) { repo.save(o); }',
      '}',
    ),
    'src/b/OrderCtl.java': L('package b;', 'public class OrderCtl extends Base { }'),
    'src/b/InvoiceCtl.java': L('package b;', 'public class InvoiceCtl extends Base { }'),
  };
  const model = buildModel(Object.entries(src).map(([p, text]) => ({ p, text, ix: index(text) })));
  linkCalls(model);
  const endpoints = ['b.OrderCtl', 'b.InvoiceCtl'].map((fqn) => ({
    verb: 'POST',
    path: '/publish',
    handlerFqn: fqn,
    handler: `${fqn.split('.').pop()}.publish`,
    declaredIn: 'b.Base',
  }));
  const stateWrites = [
    { id: 'w1', family: 'state-write', entity: 'b.Order', repository: 'b.Repo', operation: 'save', method: 'b.Base#publish(Order)', line: 4, evidence: ['src/b/Base.java:4#publish'] },
  ];
  const flows = buildFlows(model, { entries: flowEntries(model, endpoints), stateWrites, activityOf: () => 0 });
  assert.equal(flows.length, 2, 'both controllers serve the inherited endpoint');
  assert.deepEqual(flows.map((f) => f.id).sort(), ['flow:b.Base#publish(Order)@b.InvoiceCtl', 'flow:b.Base#publish(Order)@b.OrderCtl']);
  assert.ok(flows.every((f) => f.entry.cite.startsWith('src/b/Base.java:4')), 'the citation is the code that runs');
  assert.ok(flows.every((f) => f.steps[0] === 'writes Order'), 'the write on the inherited body is the effect');
}

// ---------------------------------------------------------------------------------------------------------------
// Branch arms: one entry method, one unconditional save and one charge inside `if (flag)`. The arm's line range is the
// fact (`branches`, as the dump will write it); without it the charge counts full, with it the charge is conditional
// and counts at half weight (3 -> 1, rounded down). The save is unconditional in both runs.
{
  const { index } = await import('../../test/fixtures/syntax-java.mjs');
  const { buildModel } = await import('../../test/fixtures/model-from-source.mjs');
  const { linkCalls } = await import('../model/link-for-tests.mjs');
  const L = (...x) => x.join('\n');
  const body = [
    'package c;',
    'import org.springframework.web.bind.annotation.PostMapping;',
    'public class Ctl {',
    '  private Repo repo;',
    '  private Charge charge;',
    '  @PostMapping("/orders")',
    '  public void create(Order o, boolean flag) {',
    '    repo.save(o);',
    '    if (flag) {',
    '      charge.send(o);',
    '    }',
    '  }',
    '}',
  ];
  const src = {
    'src/c/Order.java': L('package c;', 'public class Order { }'),
    'src/c/Repo.java': L('package c;', 'public interface Repo {', '  void save(Order o);', '}'),
    'src/c/RepoImpl.java': L('package c;', 'public class RepoImpl implements Repo {', '  public void save(Order o) { }', '}'),
    'src/c/Charge.java': L('package c;', 'public class Charge {', '  public void send(Order o) { }', '}'),
    'src/c/Ctl.java': L(...body),
  };
  const model = buildModel(Object.entries(src).map(([p, text]) => ({ p, text, ix: index(text) })));
  linkCalls(model);
  const lineOf = (needle) => body.findIndex((l) => l.includes(needle)) + 1;
  const endpoints = [{ verb: 'POST', path: '/orders', handlerFqn: 'c.Ctl', handler: 'Ctl.create' }];
  const stateWrites = [
    { id: 'w1', family: 'state-write', entity: 'c.Order', repository: 'c.Repo', operation: 'save', method: 'c.Ctl#create(Order,boolean)', line: lineOf('repo.save'), evidence: ['src/c/Ctl.java:8#create'] },
  ];
  const outsideCalls = [
    { id: 'o1', family: 'outside-call', kind: 'HTTP', client: 'Charge', target: 'Charge.send', method: 'c.Ctl#create(Order,boolean)', line: lineOf('charge.send'), evidence: ['src/c/Ctl.java:10#create'] },
  ];
  const build = () => buildFlows(model, { entries: flowEntries(model, endpoints), stateWrites, outsideCalls, activityOf: () => 0 });

  // No branch facts: every effect is unconditional and the score is the full 3 + 3 + 3.
  const plain = build()[0];
  assert.deepEqual(plain.why, ['entry POST +3', 'entities 1 (Order) +3', 'outside 1 +3']);
  assert.equal(plain.score, 9);
  assert.ok(plain.effects.every((e) => !e.conditional));
  assert.deepEqual(plain.steps, ['writes Order', 'HTTP send()']);

  // The dump's arm range: the charge line sits inside it, the save line does not.
  const create = model.types.get('c.Ctl').methods.find((x) => x.name === 'create');
  create.branches = [{ start: lineOf('charge.send'), end: lineOf('charge.send'), kind: 'if' }];
  const arm = build()[0];
  assert.deepEqual(arm.why, ['entry POST +3', 'entities 1 (Order) +3', 'outside 1 +1, 1 conditional']);
  assert.equal(arm.score, 7, 'the conditional charge weighs half of 3, rounded down');
  const charge = arm.effects.find((e) => e.kind === 'outside');
  const save = arm.effects.find((e) => e.kind === 'entity');
  assert.equal(charge.conditional, true);
  assert.equal(charge.label, 'HTTP send() (conditional)');
  assert.ok(!save.conditional, 'the unconditional save stays full weight');
  assert.ok(arm.steps.includes('HTTP send() (conditional)'), arm.steps.join('; '));
}
