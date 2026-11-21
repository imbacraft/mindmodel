// Facts the writer used to dig up by reading code, now stated down to the method with ready-to-copy citations:
// transaction seams, status lifecycles, schedules in plain words, and how to boot the app locally.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { index, methodAt } from './java.mjs';

// Cite methods by name only: `validate.mjs --fix` fills in the exact range, and the digest stays short.
const cite = (file, m) => `${file}#${m.name}`;
const KNOWN = { RestTemplate: 'HTTP', WebClient: 'HTTP', RestClient: 'HTTP', HttpClient: 'HTTP', JavaMailSender: 'mail', MailSender: 'mail', KafkaTemplate: 'Kafka', RabbitTemplate: 'RabbitMQ', JmsTemplate: 'JMS', SqsTemplate: 'SQS' };

// --- time in plain words ----------------------------------------------------------
export function humanMs(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}
export function humanCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 6 || f[3] !== '*' || f[4] !== '*' || !['*', '?'].includes(f[5])) return `cron "${expr}"`;
  const [s, m, h] = f, every = (x) => /^(\*|0)\/(\d+)$/.exec(x)?.[2];
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) return `daily ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (every(m) && h === '*') return `every ${every(m)} min`;
  if (/^\d+$/.test(m) && h === '*') return 'hourly';
  if (/^\d+$/.test(m) && every(h)) return `every ${every(h)} h`;
  if (every(s) && m === '*') return `every ${every(s)} s`;
  return `cron "${expr}"`;
}
export function humanSchedule(args) {
  const num = (k) => { const m = new RegExp(`\\b${k}\\s*=\\s*([\\d_]+)L?`).exec(args); return m ? Number(m[1].replace(/_/g, '')) : null; };
  const parts = [];
  const cron = /cron\s*=\s*"([^"]+)"/.exec(args); if (cron) parts.push(/^\$\{/.test(cron[1]) ? `cron from config ${cron[1]}` : humanCron(cron[1]));
  if (num('fixedRate') != null) parts.push(`every ${humanMs(num('fixedRate'))}`);
  if (num('fixedDelay') != null) parts.push(`${humanMs(num('fixedDelay'))} after each run ends`);
  const str = /(fixedRate|fixedDelay|initialDelay)String\s*=\s*"([^"]+)"/.exec(args); if (str) parts.push(`${str[1]} from config ${str[2]}`);
  if (num('initialDelay') != null) parts.push(`first run after ${humanMs(num('initialDelay'))}`);
  return parts.join(', ') || args;
}
assert.equal(humanCron('0 0 3 * * *'), 'daily 03:00');
assert.equal(humanCron('0 */15 * * * *'), 'every 15 min');
assert.equal(humanSchedule('(fixedRate = 600_000)'), 'every 10 min');
assert.equal(humanSchedule('(fixedDelay = 30000)'), '30 s after each run ends');

// Time windows and retry settings written inside a method (e.g. "older than 5 min").
const WINDOW = /(?:minus|plus)(Seconds|Minutes|Hours|Days|Weeks)\(\s*(\d+)|Duration\.of(Seconds|Minutes|Hours|Days)\(\s*(\d+)/g;
const UNIT = { Seconds: 's', Minutes: 'min', Hours: 'h', Days: 'd', Weeks: 'wk' };
const windowsIn = (lines, m) => [...new Set([...lines.slice(m.start - 1, m.end).join('\n').matchAll(WINDOW)].map((x) => `${x[2] ?? x[4]} ${UNIT[x[1] ?? x[3]]}`))];

// --- Java: seams, lifecycles, schedules -----------------------------------------------
export function javaFacts({ java, repoEntity, EXT, enums, entities, shortlist, endpoints = [] }) {
  const files = java.map((j) => ({ ...j, ix: index(j.text), lines: j.text.split('\n') }));
  const byName = new Map(files.map((f) => [f.name, f]));
  // Each type name -> the files that are it or implement it, built once (looked up for every call resolved).
  const impls = new Map();
  for (const f of files) for (const n of new Set([f.name, ...(f.implements ?? '').split(/\s*,\s*/).map((s) => s.replace(/<.*/, ''))])) if (n) impls.set(n, [...(impls.get(n) ?? []), f]);
  const implsOf = (t) => impls.get(t) ?? [];

  for (const f of files) {
    f.outside = new Map(); // simple name or field -> label of the outside system it reaches
    for (const m of f.text.matchAll(/^import\s+([\w.]+)\.(\w+);/gm)) {
      const hit = Object.entries(EXT).find(([k]) => (m[1] + '.').includes(k + '.') || m[1].startsWith(k));
      if (hit) f.outside.set(m[2], hit[1].replace(/^\((?:HTTP client: )?|\)$/g, ''));
    }
    f.fields = new Map();
    const inMethod = (pos) => f.ix.methods.some((m) => m.open < pos && pos < m.close);
    for (const m of f.ix.src.matchAll(/(?:^|[;{}])\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:private|protected|public|final|static)\s+)*([A-Z][\w.]*)(?:<[^;=(){}]*>)?\s+(\w+)\s*(?=[;=])/g))
      if (!inMethod(m.index + m[0].length)) f.fields.set(m[2], m[1].split('.').pop());
    for (const [v, t] of f.fields) { if (KNOWN[t]) f.outside.set(v, KNOWN[t]); else if (f.outside.has(t)) f.outside.set(v, f.outside.get(t)); }
    f.txClass = f.ix.types.some((t) => t.annotations.some((a) => /^Transactional\b/.test(a)));
  }
  // Calls in a method's own body (nested methods such as afterCommit() excluded: they run at another time).
  const callCache = new Map();
  const callsIn = (f, m) => callCache.get(m) ?? callCache.set(m, callsInUncached(f, m)).get(m);
  const callsInUncached = (f, m) => {
    const nested = f.ix.methods.filter((n) => n !== m && n.open > m.open && n.close < m.close);
    const body = f.ix.src.slice(m.open, m.close);
    return [...body.matchAll(/\b(\w+)\s*\.\s*(\w+)\s*\(/g)].filter((c) => !nested.some((n) => n.open - m.open < c.index && c.index < n.close - m.open))
      .map((c) => ({ recv: c[1], method: c[2], line: f.ix.lineOf(m.open + c.index) }));
  };
  const VERB = /^(create|retrieve|update|list|cancel|capture|confirm|refund|send|delete|post|put|patch|get|exchange|execute|call|publish|upload|download|invoke|search|convertAndSend)$|^(create|send|publish|upload|refund|charge|post|put)[A-Z]/;
  // Only calls that change something outside make a seam; reads (get, list, retrieve, search) leave nothing behind.
  const READ = /^(get|list|retrieve|search)$/;
  const direct = (f, m) => callsIn(f, m).filter((c) => f.outside.has(c.recv) && VERB.test(c.method) && !READ.test(c.method)).map((c) => ({ ...c, what: `${f.outside.get(c.recv)} ${c.recv}.${c.method}()` }));
  const targets = (f, c) => { const t = f.fields.get(c.recv); return t ? implsOf(t).flatMap((g) => g.ix.methods.filter((m) => m.name === c.method).map((m) => ({ g, m }))) : []; };
  const reach = (f, m, seen = new Set([m])) => {
    const body = f.ix.src.slice(m.open, m.close);
    for (const c of body.matchAll(/(?:^|[^.\w])(?:this\s*\.\s*)?(\w+)\s*\(/g)) for (const n of f.ix.methods.filter((n) => n.name === c[1] && !seen.has(n) && !(n.open > m.open && n.close < m.close))) { seen.add(n); reach(f, n, seen); }
    return [...seen];
  };
  // Outside calls a method reaches: its own, its same-class helpers', and up to two bean hops away.
  const outsideOf = (f, m, depth = 2, seen = new Set()) => {
    if (seen.has(m)) return []; seen.add(m);
    const res = [];
    for (const r of reach(f, m)) {
      for (const c of direct(f, r)) res.push({ line: c.line, what: c.what });
      if (depth) for (const c of callsIn(f, r)) for (const { g, m: t } of targets(f, c)) for (const d of outsideOf(g, t, depth - 1, seen)) res.push({ line: c.line, what: `${d.what} via ${g.name}.${t.name}` });
    }
    return res;
  };
  const savesOf = (f, m) => reach(f, m).flatMap((r) => callsIn(f, r).filter((c) => /^(save|delete|update|insert)/.test(c.method) && repoEntity.has(f.fields.get(c.recv))).map((c) => ({ line: c.line, what: `${repoEntity.get(f.fields.get(c.recv))} ${c.method}` })));
  const isTx = (f, m) => m.annotations.some((a) => /^Transactional\b/.test(a) && !/readOnly\s*=\s*true/.test(a)) || (f.txClass && m.isPublic);

  const seams = [];
  for (const f of files) for (const m of f.ix.methods) {
    if (!isTx(f, m)) continue;
    const here = cite(f.p, m), out = [], span = reach(f, m);
    const via = (r) => (r === m ? '' : ` in ${r.name}`);
    for (const r of span) for (const c of direct(f, r)) out.push(`calls ${c.what} at :${c.line}${via(r)}`);
    for (const r of span) for (const c of callsIn(f, r)) for (const { g, m: t } of targets(f, c)) {
      if (t.annotations.some((a) => /^Async\b/.test(a))) out.push(`starts @Async ${g.name}.${t.name} at :${c.line}${via(r)} (${cite(g.p, t)})`);
      else for (const d of direct(g, t)) out.push(`calls ${d.what} via ${g.name}.${t.name} at :${c.line}${via(r)} (${cite(g.p, t)})`);
    }
    if (out.length) seams.push(`OUTSIDE CALL IN TRANSACTION ${f.name}.${m.name} ${here}: ${[...new Set(out)].join('; ')}. If the transaction rolls back after this, the outside side stays done.`);
    if (m.annotations.some((a) => /REQUIRES_NEW/.test(a))) seams.push(`NEW TRANSACTION ${f.name}.${m.name} ${here}: commits on its own, even if the caller rolls back.`);
    for (const n of f.ix.methods.filter((n) => n.name === 'afterCommit' && span.some((r) => n.open > r.open && n.close < r.close))) {
      const then = callsIn(f, n).flatMap((c) => targets(f, c).map(({ g, m: t }) => `${g.name}.${t.name}${t.annotations.some((a) => /^Async\b/.test(a)) ? ' (@Async)' : ''}`));
      seams.push(`AFTER COMMIT ${f.name}.${m.name} ${here}: afterCommit at :${n.start} runs ${then.join(', ') || 'code'} only once the transaction has committed; if that fails, the commit is not undone.`);
    }
  }
  // Outside call first, then a database write, with no transaction around them: if the write fails, the outside side stays done.
  for (const f of files) for (const m of f.ix.methods) {
    if (isTx(f, m) || !m.isPublic) continue;
    const out = outsideOf(f, m).filter((o) => o.line >= m.start && o.line <= m.end), saves = savesOf(f, m).filter((x) => x.line >= m.start && x.line <= m.end);
    if (!out.length || !saves.length || Math.min(...out.map((o) => o.line)) > Math.max(...saves.map((x) => x.line))) continue;
    seams.push(`OUTSIDE CALL THEN SAVE, NO TRANSACTION ${f.name}.${m.name} ${cite(f.p, m)}: ${[...new Set(out.map((o) => `${o.what} at :${o.line}`))].slice(0, 3).join('; ')}; then ${[...new Set(saves.map((x) => `${x.what} at :${x.line}`))].slice(0, 3).join('; ')}. If a save fails, the outside side stays done.`);
  }
  for (const f of files) for (const m of f.ix.methods) {
    if (m.annotations.some((a) => /^TransactionalEventListener\b/.test(a))) seams.push(`AFTER-COMMIT LISTENER ${f.name}.${m.name} ${cite(f.p, m)}: runs after the publishing transaction commits.`);
    if (!m.annotations.some((a) => /^Scheduled\b/.test(a))) continue;
    const dels = callsIn(f, m).filter((c) => /^delete/.test(c.method) && repoEntity.has(f.fields.get(c.recv)));
    for (const c of dels) seams.push(`JOB DELETES ${repoEntity.get(f.fields.get(c.recv))} rows ${f.name}.${m.name} ${cite(f.p, m)} (${c.method} at :${c.line}): check whether an outside callback can still arrive for a deleted row.`);
  }

  // Lifecycle: every place each status value is set, by method; conditional updates vs plain saves.
  const statusEnums = new Map(enums.filter((e) => /(Status|State)$/.test(e.name)).map((e) => [e.name, e]));
  const owner = new Map(); for (const e of entities) for (const fl of e.fields) if (statusEnums.has(fl.type)) owner.set(fl.type, e.name);
  const conditionalNames = new Set(files.filter((f) => repoEntity.has(f.name)).flatMap((f) => f.lines.flatMap((l, i) => (/@Modifying/.test(l) ? [f.lines.slice(i, i + 8).join(' ').match(/\b(\w+)\s*\(\s*@Param/)?.[1]] : []))).filter(Boolean));
  const STATUS_VAR = /(\.set\w*(Status|State)|\.\w*(status|Status|state|State))\s*\(\s*[a-z]\w*\s*\)/;
  const lifecycle = [];
  for (const [en, e] of statusEnums) {
    if (!owner.has(en) || (shortlist && !shortlist.has(owner.get(en)))) continue;
    const sites = Object.fromEntries(e.values.map((v) => [v, { set: [], conditional: [], read: 0 }]));
    for (const f of files) {
      if (f.name === en) continue;
      f.lines.forEach((l, i) => {
        for (const x of l.matchAll(new RegExp(`\\b${en}\\.([A-Z][A-Z0-9_]*)\\b`, 'g'))) {
          const s = (sites[x[1]] ??= { set: [], conditional: [], read: 0 }); // values the enum parser missed still count
          const m = f.ix.methods.filter((mm) => mm.start <= i + 1 && i + 1 <= mm.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
          const where = m ? cite(f.p, m) : `${f.p}:${i + 1}`;
          const stmt = f.lines.slice(Math.max(0, i - 2), i + 1).join(' ');
          const call = [...conditionalNames].find((n) => new RegExp(`\\.${n}\\s*\\(`).test(stmt));
          if (call) { const vals = [...f.lines.slice(i, i + 3).join(' ').split(/\)\s*;/)[0].matchAll(new RegExp(`${en}\\.([A-Z][A-Z0-9_]*)`, 'g'))].map((y) => y[1]), prev = [...stmt.matchAll(new RegExp(`${en}\\.([A-Z][A-Z0-9_]*)`, 'g'))].map((y) => y[1]);
            const all = [...new Set([...prev, ...vals])]; if (all[all.length - 1] === x[1]) s.conditional.push(`${where} (from ${all.slice(0, -1).join('/') || '?'} via ${call})`); else s.read++; }
          // Direct: setXxxStatus(V), builder .xxxStatus(V), or xxxStatus = V (field default or assignment).
          else if (new RegExp(`(\\.set\\w*(Status|State)\\s*\\(\\s*|\\.\\w*(status|Status|state|State)\\s*\\(\\s*|\\w*(status|Status|state|State)\\s*=\\s*)${en}\\.${x[1]}\\b`).test(l)) s.set.push(where);
          // Chosen into a variable (ternary or assignment) in a method that sets the status from a variable.
          else if (m && !new RegExp(`[=!]=\\s*${en}\\.${x[1]}|${en}\\.${x[1]}\\s*[=!]=|case\\s+${en}|equals\\(`).test(l) && /[?:=]/.test(l.replace(/[=!]=/g, '')) && STATUS_VAR.test(f.lines.slice(m.start - 1, m.end).join('\n'))) s.set.push(`${where} (via a variable)`);
          else s.read++;
        }
      });
    }
    const hasConditional = Object.values(sites).some((s) => s.conditional.length);
    lifecycle.push(`${owner.get(en)}.${en}${hasConditional ? ' (has conditional updates: plain sets below skip that guard)' : ''}`);
    for (const [v, s] of Object.entries(sites)) {
      const parts = [s.conditional.length && `conditional update in ${[...new Set(s.conditional)].join(', ')}`, s.set.length && `${hasConditional ? 'PLAIN set' : 'set'} in ${[...new Set(s.set)].join(', ')}`].filter(Boolean);
      lifecycle.push(`  ${v}: ${parts.join('; ') || 'no set found (confirm before saying it is never set)'}`);
    }
  }

  // Status fields that hold constants instead of an enum (byte/int/String codes): every place a constant is set,
  // attributed to the entity from the receiver's declared type or the nearest Entity.builder().
  const constStatus = entities.filter((e) => (!shortlist || shortlist.has(e.name)) && e.fields.some((fl) => /^(status|state)$/i.test(fl.name) && !statusEnums.has(fl.type)));
  if (constStatus.length) {
    const names = constStatus.map((e) => e.name), sites = Object.fromEntries(names.map((n) => [n, {}]));
    const SET = /(\w+)\s*\.\s*set(?:Status|State)\s*\(\s*((?:[A-Z]\w*\.)*[A-Z][A-Z0-9_]+)\s*\)|\.(?:status|state)\s*\(\s*((?:[A-Z]\w*\.)*[A-Z][A-Z0-9_]+)\s*\)|\b(?:status|state)\s*=\s*((?:[A-Z]\w*\.)*[A-Z][A-Z0-9_]+)\s*;/;
    for (const f of files) f.lines.forEach((l, i) => {
      const x = SET.exec(l); if (!x) return;
      const m = methodAt(f.ix, i + 1), body = m ? f.lines.slice(m.start - 1, m.end).join('\n') : '';
      let ent = null;
      if (x[1]) ent = names.find((n) => new RegExp(`\\b${n}(?:<[^>]*>)?\\s+${x[1]}\\b|\\b${x[1]}\\s*=\\s*(?:new\\s+)?${n}\\b|\\b${x[1]}\\s*=\\s*${n}\\.builder`).test(body));
      else if (x[3]) ent = names.map((n) => [n, f.lines.slice(Math.max(0, i - 8), i + 1).join('\n').lastIndexOf(`${n}.builder(`)]).filter(([, k]) => k >= 0).sort((a, b) => b[1] - a[1])[0]?.[0];
      else if (x[4] && names.includes(f.name)) ent = f.name; // field default inside the entity itself
      if (!ent) return;
      const v = (x[2] ?? x[3] ?? x[4]).split('.').pop();
      ((sites[ent][v] ??= new Set())).add(m ? cite(f.p, m) : `${f.p}:${i + 1}`);
    });
    for (const [ent, vals] of Object.entries(sites)) {
      if (!Object.keys(vals).length) continue;
      const fl = constStatus.find((e) => e.name === ent).fields.find((x) => /^(status|state)$/i.test(x.name));
      lifecycle.push(`${ent}.${fl.name} (${fl.type} constants, not an enum: only values seen being set are listed)`);
      for (const [v, where] of Object.entries(vals)) lifecycle.push(`  ${v}: set in ${[...where].slice(0, 6).join(', ')}${where.size > 6 ? ` +${where.size - 6}` : ''}`);
    }
  }

  // Schedules and retries in plain words, with the time windows each job uses.
  const schedules = [];
  for (const f of files) for (const m of f.ix.methods) {
    const sch = m.annotations.find((a) => /^Scheduled\b/.test(a));
    const raw = sch && f.lines.slice(Math.max(0, m.start - 6), m.start).reverse().find((l) => /@Scheduled/.test(l));
    if (sch) { const w = windowsIn(f.lines, m); schedules.push(`${f.name}.${m.name} ${cite(f.p, m)}: ${humanSchedule(raw ?? sch)}${w.length ? ` · windows ${w.join(', ')}` : ''}`); }
    const retry = f.lines.slice(Math.max(0, m.start - 6), m.start).join(' ').match(/@Retryable\(([^@]*(@Backoff\([^)]*\))?[^)]*)\)/);
    if (retry) {
      const a = /maxAttempts\s*=\s*(\d+)/.exec(retry[1])?.[1], d = /delay\s*=\s*(\d+)/.exec(retry[1])?.[1], x = /multiplier\s*=\s*([\d.]+)/.exec(retry[1])?.[1];
      schedules.push(`RETRY ${f.name}.${m.name} ${cite(f.p, m)}: ${a ?? 3} attempts${d ? `, first wait ${humanMs(Number(d))}` : ''}${x ? ` ×${x}` : ''}`);
    }
  }
  // Flow skeletons: from each state-changing entry point (endpoint or scheduled job), the ordered chain of what
  // actually happens: outside effects, saves, status changes, async hand-offs. The writer reads only the methods it
  // needs to explain, instead of whole files. Ranked by how much of the core they touch; the top 12 go in the digest.
  const statusRe = statusEnums.size ? new RegExp(`(?:set\\w*(?:Status|State)\\s*\\(|\\.\\w*(?:status|State|state)\\s*\\(|(?:status|State|state)\\s*=\\s*)(${[...statusEnums.keys()].join('|')})\\.([A-Z][A-Z0-9_]*)`) : null;
  const walk = (f, m, depth, seen, ev) => {
    if (seen.has(m) || ev.length >= 12) return; seen.add(m);
    const calls = [...callsIn(f, m)];
    const local = [...f.ix.src.slice(m.open, m.close).matchAll(/(?:^|[^.\w])(\w+)\s*\(/g)].map((c) => ({ name: c[1], line: f.ix.lineOf(m.open + c.index) }));
    const steps = [];
    for (const c of calls) {
      if (f.outside.has(c.recv) && VERB.test(c.method) && !READ.test(c.method)) steps.push({ line: c.line, text: `${f.outside.get(c.recv)} ${c.recv}.${c.method}()` });
      else if (conditionalNames.has(c.method) && repoEntity.has(f.fields.get(c.recv))) steps.push({ line: c.line, text: `conditional ${c.method} ${repoEntity.get(f.fields.get(c.recv))}` });
      else if (/^(save|delete|update|insert)/.test(c.method) && repoEntity.has(f.fields.get(c.recv))) steps.push({ line: c.line, text: `${c.method} ${repoEntity.get(f.fields.get(c.recv))}` });
      else for (const { g, m: t } of targets(f, c).slice(0, 1)) steps.push({ line: c.line, into: () => { if (t.annotations.some((a) => /^Async\b/.test(a))) ev.push(`async ${g.name}.${t.name}`); else if (depth) walk(g, t, depth - 1, seen, ev); } });
    }
    for (const c of local) for (const n of f.ix.methods.filter((n) => n.name === c.name && n !== m && !(n.open > m.open && n.close < m.close)).slice(0, 1)) steps.push({ line: c.line, into: () => walk(f, n, depth, seen, ev) });
    if (statusRe) f.lines.slice(m.start - 1, m.end).forEach((l, i) => { const x = statusRe.exec(l); if (x) steps.push({ line: m.start + i, text: `→ ${x[2]}` }); });
    for (const n of f.ix.methods.filter((n) => n.name === 'afterCommit' && n.open > m.open && n.close < m.close)) steps.push({ line: n.start, into: () => { const at = ev.length; ev.push('after commit:'); walk(f, n, depth, seen, ev); if (ev.length === at + 1) ev.pop(); } });
    for (const st of steps.sort((a, b) => a.line - b.line)) { if (ev.length >= 12) break; if (st.text) ev.push(st.text); else st.into(); }
  };
  const entries = [];
  for (const e of endpoints.filter((e) => /POST|PUT|PATCH|DELETE|ANY/.test(e.verb))) {
    const f = files.find((x) => x.p === e.file), m = f && f.ix.methods.find((mm) => mm.start >= e.line && mm.start <= e.line + 6);
    if (m) entries.push({ label: `${e.verb} ${e.path}`, f, m });
  }
  for (const f of files) for (const m of f.ix.methods) if (m.annotations.some((a) => /^Scheduled\b/.test(a))) entries.push({ label: 'job', f, m });
  const core = shortlist ? [...shortlist] : [];
  const flows = entries.map(({ label, f, m }) => {
    const ev = []; walk(f, m, 3, new Set(), ev);
    const tx = isTx(f, m) ? ' [tx]' : '';
    const score = ev.filter((x) => /\(\)$/.test(x)).length * 3 + ev.filter((x) => /^→/.test(x)).length * 2 + ev.filter((x) => core.some((c) => x.includes(c))).length * 2 + ev.length;
    const steps = ev.reduce((acc, x) => { const last = acc[acc.length - 1]; if (last && last.x === x) last.n++; else acc.push({ x, n: 1 }); return acc; }, []).map(({ x, n }) => (n > 1 ? `${x} ×${n}` : x));
    return { score, line: `${label} ${cite(f.p, m)}${tx}: ${steps.join('; ')}`, ev, file: f.p };
  }).filter((x) => x.ev.some((e) => !/^(save|delete|update|insert) /.test(e) || core.some((c) => e.includes(c))) && x.ev.length >= 2).sort((a, b) => b.score - a.score);
  // Variety: identical chains collapse to one, and no controller contributes more than two.
  const seenChain = new Set(), perFile = {}, picked = [];
  for (const x of flows) { const sig = x.ev.join('|'); if (seenChain.has(sig) || (perFile[x.file] ?? 0) >= 2) continue; seenChain.add(sig); perFile[x.file] = (perFile[x.file] ?? 0) + 1; picked.push(x); }
  return { seams, lifecycle, schedules, flows: picked.map((x) => x.line) };
}

// --- Deployables: a repo can hold several apps; the map covers the primary one ----------
// Primary = the entry point whose module depends on the most sibling modules (the one that assembles the app).
// Code of the other deployables, and packages the primary app excludes from its component scan, is left out.
export function deployables({ java, files, rel, read }) {
  const isMain = (j) => /static\s+void\s+main\s*\(/.test(j.text) && /SpringApplication(Builder)?\b|@SpringBootApplication|@SpringBootConfiguration|@EnableAutoConfiguration/.test(j.text);
  const moduleOf = (p) => (p.includes('/src/main/java/') ? p.split('/src/main/java/')[0] : '.');
  const mods = new Set(java.map((j) => moduleOf(j.p)).filter((m) => m !== '.'));
  const deps = (m) => { const b = files.find((f) => rel(f) === `${m === '.' ? '' : m + '/'}pom.xml` || rel(f) === `${m === '.' ? '' : m + '/'}build.gradle` || rel(f) === `${m === '.' ? '' : m + '/'}build.gradle.kts`); if (!b) return 0; const t = read(b); return [...mods].filter((o) => o !== m && new RegExp(`[>:'"]${path.basename(o)}[<'"]`).test(t)).length; };
  const mains = java.filter(isMain).map((j) => ({ file: j.p, line: (j.text.split('\n').findIndex((l) => /static\s+void\s+main/.test(l)) + 1) || null, module: moduleOf(j.p), name: j.name })).map((m) => ({ ...m, deps: deps(m.module) })).sort((a, b) => b.deps - a.deps);
  if (!mains.length) return { primary: null, others: [], isExcluded: () => false };
  const primary = mains[0], others = mains.slice(1).filter((o) => o.module !== primary.module && !primary.module.startsWith(o.module + '/') && o.module !== '.');
  const mainText = java.find((j) => j.p === primary.file).text;
  const scanBlock = /@ComponentScan\s*\(([\s\S]*?)\)\s*\n\s*@|@ComponentScan\s*\(([\s\S]*?)\)\s*\n\s*(public\s+)?class/.exec(mainText);
  const patterns = scanBlock ? [...(scanBlock[1] ?? scanBlock[2]).matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => new RegExp(m[1].replace(/\\\\/g, '\\'))) : [];
  const fqn = (p) => p.split('/src/main/java/')[1]?.replace(/\.java$/, '').split('/').join('.') ?? '';
  const isExcluded = (p) => others.some((o) => p.startsWith(o.module + '/')) || patterns.some((re) => re.test(fqn(p)));
  return { primary, others, excludedPatterns: patterns.map(String), isExcluded };
}
{
  const java = [{ p: 'app/src/main/java/x/App.java', name: 'App', text: '@SpringBootConfiguration\n@ComponentScan(basePackages = {"x"}, excludeFilters = @ComponentScan.Filter(type = FilterType.REGEX, pattern = "x\\\\.gw\\\\..*"))\npublic class App { public static void main(String[] a) {} }' },
    { p: 'worker/src/main/java/x/W.java', name: 'W', text: '@SpringBootApplication\nclass W { public static void main(String[] a) {} }' }];
  const files = ['app/pom.xml', 'worker/pom.xml'], text = { 'app/pom.xml': '<artifactId>worker</artifactId>', 'worker/pom.xml': '' };
  const d = deployables({ java, files, rel: (f) => f, read: (f) => text[f] });
  assert.equal(d.primary.module, 'app');
  assert.ok(d.isExcluded('worker/src/main/java/x/W.java'));
  assert.ok(d.isExcluded('app/src/main/java/x/gw/Api.java'));
  assert.ok(!d.isExcluded('app/src/main/java/x/core/Svc.java'));
}

// --- Boot: the one way to run the whole app locally ---------------------------------
// Flat key paths of a YAML or .properties file: "server.port" -> { value, line }.
export function configKeys(text, props = false) {
  const out = new Map(), stack = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*(#|$)/.test(l)) return;
    if (props) { const m = /^\s*([\w.\-[\]]+)\s*[=:]\s*(.*)$/.exec(l); if (m) out.set(m[1], { value: m[2].trim(), line: i + 1 }); return; }
    const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(l); if (!m) return;
    while (stack.length && stack[stack.length - 1].indent >= m[1].length) stack.pop();
    stack.push({ indent: m[1].length, key: m[2] });
    if (m[3] && !m[3].startsWith('#')) out.set(stack.map((s) => s.key).join('.'), { value: m[3].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, ''), line: i + 1 });
  });
  return out;
}
{
  const k = configKeys('server:\n  port: ${PORT:8080}\nspring:\n  datasource:\n    url: ${DB_URL}\n');
  assert.deepStrictEqual(k.get('server.port'), { value: '${PORT:8080}', line: 2 });
  assert.equal(k.get('spring.datasource.url').value, '${DB_URL}');
}

export function bootFacts({ root, files, rel, git, app }) {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const lineOf = (text, re) => { const i = text.split('\n').findIndex((l) => re.test(l)); return i < 0 ? null : i + 1; };
  const build = files.filter((f) => /(^|\/)(build\.gradle(\.kts)?|pom\.xml)$/.test(rel(f))).sort((a, b) => rel(a).split('/').length - rel(b).split('/').length)[0];
  if (!build) return [];
  const b = read(build), B = rel(build), dir = path.dirname(build), gradle = !B.endsWith('pom.xml');
  const out = [];
  const wrapper = fs.existsSync(path.join(dir, gradle ? 'gradlew' : 'mvnw'));
  const prefix = path.dirname(B) === '.' ? '' : `cd ${path.dirname(B)} && `;
  // A separate module only if it has its own build file; otherwise it is just a source folder of the root build.
  const ownBuild = (m) => files.some((f) => new RegExp(`^${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(pom\\.xml|build\\.gradle(\\.kts)?)$`).test(rel(f)));
  const mod = app?.primary && app.primary.module !== '.' && app.primary.module !== path.dirname(B) && ownBuild(app.primary.module) ? app.primary.module : null;
  if (mod) out.push(`app: ${mod} (main ${app.primary.file}${app.primary.line ? ':' + app.primary.line : ''}); multi-module build, so confirm the exact command in the README. Usually: ${gradle ? `./gradlew :${path.basename(mod)}:bootRun` : `${wrapper ? './mvnw' : 'mvn'} -pl ${mod} -am spring-boot:run`}`);
  else out.push(`run: ${prefix}${gradle ? (wrapper ? './gradlew' : 'gradle') + ' bootRun' : (wrapper ? './mvnw' : 'mvn') + ' spring-boot:run'} (${B}${gradle && lineOf(b, /\bbootRun\b/) ? ':' + lineOf(b, /\bbootRun\b/) : ''})`);
  if (app?.others.length) out.push(`other deployables in this repo (not mapped): ${app.others.map((o) => `${o.name} (${o.module})`).join(', ')}${app.excludedPatterns.length ? `; also excluded from the app's component scan: ${app.excludedPatterns.join(', ')}` : ''}`);

  // Profile the run command activates.
  let profile = null, profileAt = null;
  const lit = /spring\.profiles\.active\s*=\s*([\w-]+)/.exec(b) ?? /<profiles>\s*<profile>([\w-]+)</.exec(b) ?? /systemProperty\s*\(?\s*['"]spring\.profiles\.active['"]\s*,\s*['"]([\w-]+)['"]/.exec(b);
  if (lit) { profile = lit[1]; profileAt = lineOf(b, new RegExp(lit[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); }
  else { const v = /spring\.profiles\.active=?["']?\s*\+\s*(\w+)/.exec(b); const def = v && new RegExp(`\\b${v[1]}\\s*=\\s*[^\\n]*?['"]([\\w-]+)['"]`).exec(b); if (def) { profile = def[1]; profileAt = lineOf(b, new RegExp(`\\b${v[1]}\\s*=`)); } }

  const cfg = files.filter((f) => /src\/main\/resources\/application(-[\w-]+)?\.(ya?ml|properties)$/.test(rel(f)) && (!mod || rel(f).startsWith(mod + '/')));
  const load = (name) => { const f = cfg.find((c) => new RegExp(`/application${name ? '-' + name : ''}\\.(ya?ml|properties)$`).test(rel(c))); return f ? { file: rel(f), keys: configKeys(read(f), f.endsWith('.properties')) } : null; };
  const base = load(null);
  if (!profile && base?.keys.get('spring.profiles.active')) { const k = base.keys.get('spring.profiles.active'); profile = k.value.replace(/^\$\{[^:}]*:?([^}]*)\}$/, '$1') || null; profileAt = `${base.file}:${k.line}`; }
  const prof = profile ? load(profile) : null;
  if (profile) {
    let where = 'no profile config file found';
    if (prof) {
      const tracked = git(root, ['ls-files', '--error-unmatch', prof.file]) != null;
      const ign = !tracked && git(root, ['check-ignore', '-v', prof.file]);
      where = tracked ? `${prof.file} (in git)` : `${prof.file} is NOT in git${ign ? ` (ignored by ${ign.split('\t')[0].replace(/:[^:]*$/, '')})` : ''}: a new developer must create it`;
    }
    out.push(`profile: ${profile} (${typeof profileAt === 'number' ? `${B}:${profileAt}` : profileAt}); ${where}`);
  }
  const port = (k) => k?.keys.get('server.port') && { ...k.keys.get('server.port'), file: k.file };
  const p = port(prof) ?? port(base);
  if (p) { const d = /^\$\{(\w+):(\d+)\}$/.exec(p.value); out.push(`port: ${d ? `${d[2]} unless ${d[1]} is set` : p.value} (${p.file}:${p.line})`); } else out.push('port: 8080 (Spring default; no server.port)');

  // Does the backend build also build and serve the frontend?
  const fe = /NpmTask|node-gradle|com\.github\.node|frontend-maven-plugin|npm\s+run|yarnBuild/.exec(b), hook = /(processResources|bootJar|generate-resources|prepare-package)[^\n]*/.exec(b);
  if (fe && hook) out.push(`frontend: built and served by the backend, so the run command starts the whole app (${B}:${lineOf(b, new RegExp(fe[0]))}, ${B}:${lineOf(b, new RegExp(hook[1]))})`);

  // Settings with no default in the base config, and whether the profile file supplies them.
  if (base) {
    const need = [...base.keys].filter(([, v]) => /\$\{\w+\}/.test(v.value));
    const missing = need.filter(([k]) => !prof?.keys.has(k)), covered = need.filter(([k]) => prof?.keys.has(k));
    if (missing.length) out.push(`required, no default anywhere: ${missing.map(([k, v]) => `${/\$\{(\w+)\}/.exec(v.value)[1]} (${k}, ${base.file}:${v.line})`).join(', ')}`);
    if (covered.length) out.push(`set by the ${profile} profile file instead of env vars: ${covered.map(([k]) => k).join(', ')}`);
  }
  return out;
}
