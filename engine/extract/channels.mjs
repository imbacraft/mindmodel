// Channels: the queues and topics a service listens to or sends on, from the model — a listener is an
// annotation with a destination argument, a send is a call on a messaging client with a channel argument. The name is
// the argument when it is a literal or a resolvable static constant, else the argument text.

import { placeholderOf } from '../core/placeholders.mjs';
import { push } from '../core/collections.mjs';
import { annotationOn } from '../core/annotations.mjs';
import { listOf, patternOf, tableOf } from '../catalogs/catalog.mjs';

// The messaging rules (messaging.json's channel-rules), one table for this module and the system map: a listener
// annotation, a client's send or consume call, a publisher, and the fluent and stream calls.
const RULES = tableOf('channel-rules');
const LISTENER_RULES = RULES.filter((r) => r.annotation);
const CONSUMER_RULES = RULES.filter((r) => r.consumer);
const SEND_RULES = RULES.filter((r) => r.dir === 'out' && r.recv && r.names && !r.publisher && !r.consumer);
const PUBLISHER_RULES = RULES.filter((r) => r.publisher);
const FLUENT_RULES = RULES.filter((r) => r.via === 'eventuate');
const AGGREGATE_RULES = RULES.filter((r) => r.via === 'aggregate');
const NAMED_RULES = RULES.filter((r) => r.named);
const recvOf = (c) => (c.recvFqn ?? '').split('.').pop() ?? '';

export const firstString = (args = []) => args.map((a) => String(a).trim()).find((a) => /^".*"$/.test(a));

export function channelFacts(model, { config = new Map(), extraConstants = new Map() } = {}) {
  const facts = [];
  const consts = model.constants ?? new Map();
  // The types of each file, in model order: a resource's field is looked up in its own file, not in every type.
  const typesByFile = new Map();
  for (const x of model.types.values()) push(typesByFile, x.file, x);
  const lookupOf = (file, simple) => {
    const t = (typesByFile.get(file) ?? []).find((x) => (x.fields ?? []).some((f) => f.name === simple));
    const f = t?.fields?.find((x) => x.name === simple);
    const res = (f?.ann ?? []).find((a) => /Resource|Inject/.test(a.name));
    return /lookup\s*=\s*"([^"]+)"/.exec(res?.args ?? '')?.[1] ?? null;
  };
  const kebab = (noun) => noun.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase();
  // A topic passed as a getter on a @ConfigurationProperties bean: property key, then the configured value.
  const propertyOf = (arg) => {
    const getter = /(?:[\w.]+\.)?get([A-Z]\w*)\s*\(\s*\)/.exec(arg ?? '');
    if (!getter) return null;
    let key = kebab(getter[1]);
    if (!/-topic$|-queue$/.test(key)) key = `${key}-topic`;
    for (const [k, v] of config) if (k === key || k.endsWith(`.${key}`) || k.endsWith(`-${key}`)) return v;
    return key; // no configured value: the key itself is still a name
  };
  const nameOf = (file, owner, arg) => {
    if (!arg) return null;
    const prop = propertyOf(arg);
    if (prop) return prop;
    const lit = /^"([^"]+)"$/.exec(arg.trim());
    if (lit) {
      // `${key:default}` in a topic annotation: the configured value, else the default, else the key.
      const spel = placeholderOf(lit[1]);
      if (spel) {
        const normChannelName = (x) => String(x).toLowerCase().replace(/[-_.]/g, '');
        const want = normChannelName(spel.key);
        for (const [k, v] of config) if (normChannelName(k) === want || normChannelName(k).endsWith(want)) return v;
        return spel.def || spel.key;
      }
      return lit[1];
    }
    const shared = extraConstants.get(arg.trim());
    if (shared) return shared;
    const ref = /^([\w.]+)$/.exec(arg.trim());
    if (!ref) return null;
    const looked = lookupOf(file, ref[1].split('.').pop());
    if (looked) return looked;
    const [qual, simple] = ref[1].includes('.') ? [ref[1].slice(0, ref[1].lastIndexOf('.')), ref[1].split('.').pop()] : [null, ref[1]];
    const fqn = qual ? model.resolveIn(file, qual) : owner;
    const hit = fqn ? consts.get(`${fqn}.${simple}`) ?? model.resolveConst?.(file, owner, simple) : null;
    return typeof hit === 'string' ? hit : null;
  };
  for (const t of model.types.values()) {
    const mdb = annotationOn(t, ...listOf('message-driven-annotations'));
    if (mdb) {
      const dest = /propertyName\s*=\s*"(?:destinationLookup|destination)"\s*,\s*propertyValue\s*=\s*"([^"]+)"/.exec(mdb.args ?? '')?.[1]
        ?? /propertyValue\s*=\s*"([^"]+)"\s*,\s*propertyName\s*=\s*"(?:destinationLookup|destination)"/.exec(mdb.args ?? '')?.[1]
        ?? /mappedName\s*=\s*"([^"]+)"/.exec(mdb.args ?? '')?.[1];
      if (dest) {
        const on = (t.methods ?? []).find((m) => m.name === 'onMessage');
        facts.push({
          id: `channel:in:jms:${dest}@${t.name}`,
          family: 'channel',
          confidence: 'resolved',
          direction: 'in',
          kind: 'jms',
          channel: dest,
          method: `${t.name}#onMessage`,
          evidence: [`${t.file}:${mdb.line ?? t.nameLine}#${t.name}`],
          why: [`@MessageDriven destinationLookup ${dest}`],
        });
      }
    }
    const cond = (t.ann ?? []).find((a) => listOf('conditional-annotations').has(a.name));
    const condition = cond ? `${cond.name}${cond.args || ''}`.replace(/\s+/g, ' ').slice(0, 160) : null;
    for (const m of t.methods ?? []) {
      // Plain clients that consume: `consumer.subscribe(topics)`, `channel.basicConsume(queue, …)`, and the like.
      for (const c of m.calls ?? []) {
        const recv = recvOf(c);
        const rule = CONSUMER_RULES.find((r) => r.names.includes(c.name ?? '') && recv.endsWith(r.recv));
        if (!rule) continue;
        const argText = (c.args ?? [])[0] ?? '';
        const channel = nameOf(t.file, t.fqn, argText) ?? 'unknown';
        // Its handler is the method that polls the same consumer.
        const polls = listOf('consumer-poll-methods');
        const poller = (t.methods ?? []).find((x) =>
          (x.calls ?? []).some((y) => polls.has(y.name ?? '') && (y.recv?.text ?? '') === (c.recv?.text ?? '')),
        );
        facts.push({
          id: `channel:in:${rule.kind}:${channel}@${t.name}`,
          family: 'channel',
          confidence: channel === 'unknown' ? 'inferred' : 'resolved',
          direction: 'in',
          kind: rule.kind,
          channel,
          method: `${t.name}#${m.name}`,
          handler: poller ? `${t.name}#${poller.name}` : null,
          condition,
          evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`],
          why: [`${recv}.${c.name}(${argText.slice(0, 80)})${condition ? ` under ${condition}` : ''}`],
        });
      }
      const listen = (m.ann ?? [])
        .map((a) => ({ a, rule: LISTENER_RULES.find((r) => r.annotation === a.name) }))
        .find((x) => x.rule);
      if (listen) {
        const { a: ann, rule } = listen;
        // The destination may be a named argument, a list, or a placeholder: `destination = "${q.name}"`.
        const args = ann.args ?? '';
        const destination = new RegExp(`\\b(?:${rule.arg}|value)\\s*=\\s*(\\{[^}]*\\}|"[^"]*"|[\\w.$:{}]+)`);
        const named = destination.exec(args)?.[1] ?? args;
        const names = [...named.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        const bare = names.length ? names : [named.trim()];
        for (const raw of bare) {
          const channel = nameOf(t.file, t.fqn, /^\$\{/.test(raw) ? `"${raw}"` : raw) ?? (raw || 'unknown');
          facts.push({
            id: `channel:in:${rule.kind}:${channel}@${m.name}`,
            family: 'channel',
            confidence: channel === 'unknown' ? 'inferred' : 'resolved',
            direction: 'in',
            kind: rule.kind,
            channel,
            method: `${t.name}#${m.name}`,
            evidence: [`${t.file}:${ann.line ?? m.nameLine}#${m.name}`],
            why: [`@${ann.name}(${args.slice(0, 80)})`],
          });
        }
      }
      // Eventuate Tram and Spring Cloud Stream: the channel rides a fluent chain or a binding call.
      for (const c of m.calls ?? []) {
        const nm = c.name ?? '';
        const fluent = FLUENT_RULES.find((r) => r.name === nm);
        if (fluent) {
          const channel = nameOf(t.file, t.fqn, (c.args ?? [])[0] ?? '') ?? 'unknown';
          facts.push({
            id: `channel:${fluent.dir}:${fluent.kind}:${channel}@${m.name}`,
            family: 'channel',
            confidence: channel === 'unknown' ? 'inferred' : 'resolved',
            direction: fluent.dir,
            kind: fluent.kind,
            channel,
            method: `${t.name}#${m.name}`,
            via: 'eventuate',
            evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`],
            why: [`${t.name}#${m.name} ${nm}(${(c.args ?? [])[0] ?? ''})`],
          });
          continue;
        }
        const aggregate = AGGREGATE_RULES.find((r) => r.name === nm);
        if (aggregate) {
          // A literal names the aggregate by its FQN in quotes; the simple name is the channel, quotes never are.
          const agg = String((c.args ?? [])[0] ?? '').replace(/^"|"$/g, '').replace(/\.class$/, '').split('.').pop();
          facts.push({
            id: `channel:${aggregate.dir}:${aggregate.kind}:${agg}@${m.name}`,
            family: 'channel',
            confidence: 'inferred',
            direction: aggregate.dir,
            kind: aggregate.kind,
            channel: agg,
            method: `${t.name}#${m.name}`,
            via: 'aggregate',
            evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`],
            why: [`subscribes to aggregate ${agg}`],
          });
          continue;
        }
        const named = NAMED_RULES.find((r) => r.name === nm);
        if (named) {
          // `.stream(...)` is a channel only when the receiver is one, or when the name is written at the call:
          // an AI client's `stream(config.getMaxTokens())` is not a topic, and a getter inside an expression is
          // not a name. Both conditions are facts from the model, not a name list of frameworks.
          const messaging = patternOf('messaging-receivers').test(recvOf(c));
          const argText = String((c.args ?? [])[0] ?? '').trim();
          const written = /^"[^"]*"$/.test(argText) || /^[A-Za-z_$][\w$.]*$/.test(argText);
          if (!messaging && !written) continue;
          const channel = nameOf(t.file, t.fqn, (c.args ?? [])[0] ?? '') ?? 'unknown';
          if (channel === 'unknown') continue;
          facts.push({
            id: `channel:${named.dir}:${named.kind}:${channel}@${m.name}`,
            family: 'channel',
            confidence: 'resolved',
            direction: named.dir,
            kind: named.kind,
            channel,
            method: `${t.name}#${m.name}`,
            via: 'stream',
            evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`],
            why: [`${t.name}#${m.name}.${nm}(${channel})`],
          });
          continue;
        }
        const publisher = PUBLISHER_RULES.find((r) => r.names.includes(nm) && recvOf(c).endsWith(r.recv));
        if (publisher) {
          // Eventuate publishes carry the channel in the fluent `withChannel`, recorded above; the aggregate is the type.
          const aggSimple = /<\s*(\w+)/.exec((t.supers ?? []).find((x) => /Publisher/.test(x.text ?? ''))?.text ?? '')?.[1];
          const aggFqn = aggSimple ? model.resolveIn(t.file, aggSimple) ?? aggSimple : null;
          const withCh = (m.calls ?? []).find((x) => x.name === 'withChannel');
          const channel = withCh ? nameOf(t.file, t.fqn, (withCh.args ?? [])[0] ?? '') ?? 'unknown' : (aggFqn ?? 'unknown');
          facts.push({
            id: `channel:out:${publisher.kind}:${channel}@${m.name}`,
            family: 'channel',
            confidence: 'inferred',
            direction: 'out',
            kind: publisher.kind,
            channel,
            method: `${t.name}#${m.name}`,
            via: 'eventuate',
            evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`],
            why: [`${t.name}#${m.name} publishes (aggregate ${aggFqn ?? 'unknown'})`],
          });
          continue;
        }
        const send = SEND_RULES.find((r) => r.names.includes(nm) && recvOf(c).endsWith(r.recv));
        if (!send) continue;
        const client = recvOf(c);
        const channel = nameOf(t.file, t.fqn, (c.args ?? [])[0] ?? '') ?? 'unknown';
        facts.push({
          id: `channel:out:${send.kind}:${channel}@${m.name}`,
          family: 'channel',
          confidence: channel === 'unknown' ? 'inferred' : 'resolved',
          direction: 'out',
          kind: send.kind,
          channel,
          client,
          method: `${t.name}#${m.name}`,
          evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`],
          why: [`${client}.${c.name}(${(c.args ?? [])[0] ?? ''})${condition ? ` under ${condition}` : ''}`],
          condition,
        });
      }
    }
  }
  const seen = new Set();
  return facts.filter((f) => !seen.has(f.id) && seen.add(f.id));
}

