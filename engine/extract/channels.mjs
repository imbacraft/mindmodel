// Channels: the queues and topics a service listens to or sends on, from the model — a listener is an
// annotation with a destination argument, a send is a call on a messaging client with a channel argument. The name is
// the argument when it is a literal or a resolvable static constant, else the argument text.

const LISTENERS = new Set(['KafkaListener', 'JmsListener', 'RabbitListener', 'StreamListener', 'MessageDriven', 'SqsListener']);
const CLIENTS = /(KafkaTemplate|JmsTemplate|RabbitTemplate|StreamBridge|JMSProducer|JMSContext|KafkaProducer|MessageProducer|SqsClient)$/;
const SENDS = new Set(['send', 'convertAndSend', 'publish', 'sendAndReceive', 'convertSendAndReceive', 'syncSend']);

export const firstString = (args = []) => args.map((a) => String(a).trim()).find((a) => /^".*"$/.test(a));

export function channelFacts(model, { config = new Map(), extraConstants = new Map() } = {}) {
  const facts = [];
  const consts = model.constants ?? new Map();
  const lookupOf = (file, simple) => {
    const t = [...model.types.values()].find((x) => x.file === file && (x.fields ?? []).some((f) => f.name === simple));
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
      const spel = /^\$\{([^:}]+)(?::([^}]*))?\}$/.exec(lit[1].trim());
      if (spel) {
        const norm = (x) => String(x).toLowerCase().replace(/[-_.]/g, '');
        const want = norm(spel[1]);
        for (const [k, v] of config) if (norm(k) === want || norm(k).endsWith(want)) return v;
        return spel[2] || spel[1];
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
    const mdb = (t.ann ?? []).find((a) => a.name === 'MessageDriven');
    if (mdb) {
      const dest = /propertyName\s*=\s*"(?:destinationLookup|destination)"\s*,\s*propertyValue\s*=\s*"([^"]+)"/.exec(mdb.args ?? '')?.[1]
        ?? /propertyValue\s*=\s*"([^"]+)"\s*,\s*propertyName\s*=\s*"(?:destinationLookup|destination)"/.exec(mdb.args ?? '')?.[1]
        ?? /mappedName\s*=\s*"([^"]+)"/.exec(mdb.args ?? '')?.[1];
      if (dest) {
        const on = (t.methods ?? []).find((m) => m.name === 'onMessage');
        facts.push({ id: `channel:in:jms:${dest}@${t.name}`, family: 'channel', confidence: 'resolved', direction: 'in', kind: 'jms', channel: dest, method: `${t.name}#onMessage`, evidence: [`${t.file}:${mdb.line ?? t.nameLine}#${t.name}`], why: [`@MessageDriven destinationLookup ${dest}`] });
      }
    }
    const cond = (t.ann ?? []).find((a) => /^(ConditionalOnProperty|Profile)$/.test(a.name));
    const condition = cond ? `${cond.name}${cond.args || ''}`.replace(/\s+/g, ' ').slice(0, 160) : null;
    for (const m of t.methods ?? []) {
      // Plain clients: `consumer.subscribe(topics)`, `channel.basicConsume(queue, …)`, `session.createConsumer(queue)`.
      for (const c of m.calls ?? []) {
        const recv = (c.recvFqn ?? '').split('.').pop() ?? '';
        const inbound = /^(subscribe|basicConsume|createConsumer)$/.test(c.name ?? '') && /(KafkaConsumer|Channel|Session|JMSContext|MessageConsumer)$/.test(recv);
        if (!inbound) continue;
        const argText = (c.args ?? [])[0] ?? '';
        const channel = nameOf(t.file, t.fqn, argText) ?? 'unknown';
        // Its handler is the method that polls the same consumer.
        const poller = (t.methods ?? []).find((x) => (x.calls ?? []).some((y) => /^(poll|nextDelivery|receive|receiveNoWait)$/.test(y.name ?? '') && (y.recv?.text ?? '') === (c.recv?.text ?? '')));
        facts.push({ id: `channel:in:kafka:${channel}@${t.name}`, family: 'channel', confidence: channel === 'unknown' ? 'inferred' : 'resolved', direction: 'in', kind: /Channel|Session|JMS/.test(recv) ? 'jms' : 'kafka', channel, method: `${t.name}#${m.name}`, handler: poller ? `${t.name}#${poller.name}` : null, condition, evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`], why: [`${recv}.${c.name}(${argText.slice(0, 80)})${condition ? ` under ${condition}` : ''}`] });
      }
      const ann = (m.ann ?? []).find((a) => LISTENERS.has(a.name));
      if (ann) {
        const kind = /Kafka/.test(ann.name) ? 'kafka' : /Rabbit/.test(ann.name) ? 'rabbit' : /Sqs/.test(ann.name) ? 'sqs' : 'jms';
        // The destination may be a named argument, a list, or a placeholder: `destination = "${q.name}"`.
        const args = ann.args ?? '';
        const named = /\b(?:destination|topics|queues|value)\s*=\s*(\{[^}]*\}|"[^"]*"|[\w.$:{}]+)/.exec(args)?.[1] ?? args;
        const names = [...named.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        const bare = names.length ? names : [named.trim()];
        for (const raw of bare) {
          const channel = nameOf(t.file, t.fqn, /^\$\{/.test(raw) ? `"${raw}"` : raw) ?? (raw || 'unknown');
          facts.push({ id: `channel:in:${kind}:${channel}@${m.name}`, family: 'channel', confidence: channel === 'unknown' ? 'inferred' : 'resolved', direction: 'in', kind, channel, method: `${t.name}#${m.name}`, evidence: [`${t.file}:${ann.line ?? m.nameLine}#${m.name}`], why: [`@${ann.name}(${args.slice(0, 80)})`] });
        }
      }
      // Eventuate Tram and Spring Cloud Stream: the channel rides a fluent chain or a binding call.
      for (const c of m.calls ?? []) {
        const nm = c.name ?? '';
        const evt = nm === 'withChannel' ? 'out' : nm === 'fromChannel' ? 'in' : null;
        if (evt) {
          const channel = nameOf(t.file, t.fqn, (c.args ?? [])[0] ?? '') ?? 'unknown';
          facts.push({ id: `channel:${evt}:kafka:${channel}@${m.name}`, family: 'channel', confidence: channel === 'unknown' ? 'inferred' : 'resolved', direction: evt, kind: 'kafka', channel, method: `${t.name}#${m.name}`, via: 'eventuate', evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`], why: [`${t.name}#${m.name} ${nm}(${(c.args ?? [])[0] ?? ''})`] });
          continue;
        }
        if (nm === 'andForAggregateType') {
          const agg = String((c.args ?? [])[0] ?? '').replace(/\.class$/, '').split('.').pop();
          facts.push({ id: `channel:in:kafka:${agg}@${m.name}`, family: 'channel', confidence: 'inferred', direction: 'in', kind: 'kafka', channel: agg, method: `${t.name}#${m.name}`, via: 'aggregate', evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`], why: [`subscribes to aggregate ${agg}`] });
          continue;
        }
        if (/^(stream|to)$/.test(nm)) {
          // `.stream(...)` is a channel only when the receiver is one, or when the name is written at the call:
          // an AI client's `stream(config.getMaxTokens())` is not a topic, and a getter inside an expression is
          // not a name. Both conditions are facts from the model, not a name list of frameworks.
          const recv = (c.recvFqn ?? '').split('.').pop() ?? '';
          const messaging = /(MessageChannel|StreamBridge|MessageProducer|SubscribableChannel|DirectChannel|Source|Sink)$/.test(recv);
          const argText = String((c.args ?? [])[0] ?? '').trim();
          const written = /^"[^"]*"$/.test(argText) || /^[A-Za-z_$][\w$.]*$/.test(argText);
          if (!messaging && !written) continue;
          const channel = nameOf(t.file, t.fqn, (c.args ?? [])[0] ?? '') ?? 'unknown';
          if (channel === 'unknown') continue;
          facts.push({ id: `channel:${nm === 'to' ? 'out' : 'in'}:kafka:${channel}@${m.name}`, family: 'channel', confidence: 'resolved', direction: nm === 'to' ? 'out' : 'in', kind: 'kafka', channel, method: `${t.name}#${m.name}`, via: 'stream', evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`], why: [`${t.name}#${m.name}.${nm}(${channel})`] });
          continue;
        }
        if (nm === 'publish' && /Publisher$/.test((c.recvFqn ?? '').split('.').pop() ?? '')) {
          // Eventuate publishes carry the channel in the fluent `withChannel`, recorded above; the aggregate is the type.
          const aggSimple = /<\s*(\w+)/.exec((t.supers ?? []).find((x) => /Publisher/.test(x.text ?? ''))?.text ?? '')?.[1];
          const aggFqn = aggSimple ? model.resolveIn(t.file, aggSimple) ?? aggSimple : null;
          const withCh = (m.calls ?? []).find((x) => x.name === 'withChannel');
          const channel = withCh ? nameOf(t.file, t.fqn, (withCh.args ?? [])[0] ?? '') ?? 'unknown' : (aggFqn ?? 'unknown');
          facts.push({ id: `channel:out:kafka:${channel}@${m.name}`, family: 'channel', confidence: 'inferred', direction: 'out', kind: 'kafka', channel, method: `${t.name}#${m.name}`, via: 'eventuate', evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`], why: [`${t.name}#${m.name} publishes (aggregate ${aggFqn ?? 'unknown'})`] });
          continue;
        }
        if (!SENDS.has(c.name ?? '')) continue;
        const client = (c.recvFqn ?? '').split('.').pop();
        if (!CLIENTS.test(client ?? '')) continue;
        const kind = /Kafka|Stream/.test(client) ? 'kafka' : /Rabbit/.test(client) ? 'rabbit' : 'jms';
        const channel = nameOf(t.file, t.fqn, (c.args ?? [])[0] ?? '') ?? 'unknown';
        facts.push({ id: `channel:out:${kind}:${channel}@${m.name}`, family: 'channel', confidence: channel === 'unknown' ? 'inferred' : 'resolved', direction: 'out', kind, channel, client, method: `${t.name}#${m.name}`, evidence: [`${t.file}:${c.line ?? m.nameLine}#${m.name}`], why: [`${client}.${c.name}(${(c.args ?? [])[0] ?? ''})${condition ? ` under ${condition}` : ''}`], condition });
      }
    }
  }
  const seen = new Set();
  return facts.filter((f) => !seen.has(f.id) && seen.add(f.id));
}

