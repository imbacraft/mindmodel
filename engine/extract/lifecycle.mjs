import { scheduleFacts } from './schedules.mjs';
// Lifecycle helpers moved out of deep.mjs (which is meant to disappear). A status chosen inline
// (`cond ? ENUM.A : ENUM.B`, possibly across lines) inside a method that sets a status sets both values.
import assert from 'node:assert/strict';

export function chosenInline({ enumName, value, stmt, methodText }) {
  if (!stmt.includes('?')) return false;
  if (!new RegExp(`\\b${enumName}\\.${value}\\b`).test(stmt)) return false;
  return /\.(set\w*Status|status)\s*\(/.test(methodText ?? '');
}


// The calls on one line, with their argument lists split at top-level commas. A status literal that sits in one of
// those arguments is handed to a method, and only what the callee does with that parameter decides set or read.
export function callArgs(line) {
  const out = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(line))) {
    let depth = 0,
      i = re.lastIndex - 1;
    for (; i < line.length; i++) {
      if (line[i] === '(') depth++;
      else if (line[i] === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue; // an unclosed call on this line: its arguments are on the next one
    const args = [];
    let cur = '',
      d = 0;
    for (const ch of line.slice(re.lastIndex, i)) {
      if (ch === '(' || ch === '<') d++;
      else if (ch === ')' || ch === '>') d--;
      if (ch === ',' && d === 0) {
        args.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push({ name: m[1], args, at: re.lastIndex - 1 });
  }
  return out;
}

// True when the callee writes that parameter into a status (`setXStatus(param)`, `.status(param)`); false when it
// does not (`change(model, NEW, previous)` passes the value on, it is the previous status and a read); null when the
// literal is not an argument of any call on the line.
export function setByArgument(methodsByName, line, enumName, value) {
  const literal = new RegExp(`\\b${enumName}\\.${value}\\b`);
  for (const call of callArgs(line)) {
    const at = call.args.findIndex((a) => literal.test(a));
    if (at < 0) continue;
    const candidates = methodsByName.get(`${call.name}/${call.args.length}`) ?? [];
    return candidates.some(({ f, m }) => {
      const param = m.params?.[at]?.name;
      if (!param) return false;
      const body = f.lines.slice(m.start - 1, m.end).join('\n');
      // A setter, a builder field, or a plain assignment into the status field.
      const write = new RegExp(`(?:set\\w*(?:Status|State)|(?:status|state))\\s*\\(\\s*${param}\\s*\\)`);
      const assign = new RegExp(`(?:status|state)\\s*=\\s*${param}\\b`);
      return write.test(body) || assign.test(body);
    });
  }
  return null;
}

{
  const line = 'service.change(model, Status.NEW, previous);';
  assert.deepEqual(callArgs(line).map((c) => [c.name, c.args.length]), [['change', 3]]);
  assert.deepEqual(callArgs('repo.save(Order.builder().status(Status.OPEN).build());').map((c) => c.name), [
    'save',
    'builder',
    'status',
    'build',
  ]);
  const methods = new Map([
    ['change/3', [{ f: { lines: ['void change(E m, S s, S prev) { }'] }, m: { start: 1, end: 1, params: [{ name: 'm' }, { name: 's' }, { name: 'prev' }] } }]],
    ['mark/1', [{ f: { lines: ['void mark(S s) { this.status = s; }'] }, m: { start: 1, end: 1, params: [{ name: 's' }] } }]],
  ]);
  // The previous status is an argument the callee never writes: a read.
  assert.equal(setByArgument(methods, line, 'Status', 'NEW'), false);
  assert.equal(setByArgument(methods, 'x.mark(Status.DONE);', 'Status', 'DONE'), true); // the callee assigns it
  assert.equal(setByArgument(methods, 'String s = "Status.NEW";', 'Status', 'NEW'), null);
}


// A status enum declared in the organisation's shared library: imported from a package under the project's root
// package (the first three segments of the most common package), declared by no scanned file, and not an entity
// field type — the constants pass reads those. The map is keyed by the enum's full name and lists the files that
// import it, because `State` in one class is not the `State` of another. Only values this repo sets are listed.
export function outsideEnums(files, entities = []) {
  const declared = new Set();
  for (const f of files) {
    const pkg = f.ix?.pkg ?? '';
    for (const t of f.ix?.types ?? []) declared.add(t.owner ? `${pkg}.${t.owner}.${t.name}` : `${pkg}.${t.name}`);
  }
  const fieldTypes = new Set(
    entities.flatMap((e) => (e.fields ?? []).map((fl) => String(fl.type ?? '').replace(/<.*/, '').split('.').pop())),
  );
  const counts = new Map();
  for (const f of files) {
    const root = String(f.ix?.pkg ?? '').split('.').slice(0, 3).join('.');
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  const root = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (!root) return new Map();
  const out = new Map();
  for (const f of files)
    for (const i of f.ix?.imports ?? []) {
      if (i.wildcard || i.isStatic) continue;
      const simple = i.name.split('.').pop();
      if (!/(Status|State)$/.test(simple) || declared.has(i.name) || fieldTypes.has(simple)) continue;
      if (i.name.split('.').slice(0, 3).join('.') !== root) continue;
      const hit = out.get(i.name) ?? { simple, files: new Set() };
      hit.files.add(f);
      out.set(i.name, hit);
    }
  return out;
}

{
  const own = { name: 'Local', ix: { pkg: 'com.acme.orders.api', types: [{ name: 'Order' }], imports: [] } };
  const foreign = { name: 'Elsewhere', ix: { pkg: 'com.acme.orders.shared', types: [{ name: 'Elsewhere' }], imports: [] } };
  const declare = {
    name: 'Holder',
    ix: { pkg: 'com.acme.orders.shared', types: [{ name: 'Holder' }, { name: 'Status', owner: 'Holder' }], imports: [] },
  };
  const files = [
    own,
    {
      name: 'Use',
      ix: {
        pkg: 'com.acme.orders.api',
        types: [{ name: 'Use' }],
        imports: [
          { name: 'com.acme.orders.shared.OrderStatus', wildcard: false, isStatic: false },
          { name: 'com.acme.orders.shared.Holder.Status', wildcard: false, isStatic: false },
          { name: 'com.other.Status', wildcard: false, isStatic: false },
        ],
      },
    },
    foreign,
    declare,
  ];
  const found = outsideEnums(files, [{ fields: [{ name: 'code', type: 'String' }] }]);
  // Declared in the project (a nested enum) or outside its root package: neither is an outside enum.
  assert.deepEqual([...found.keys()], ['com.acme.orders.shared.OrderStatus']);
  assert.deepEqual([...found.get('com.acme.orders.shared.OrderStatus').files].map((f) => f.name), ['Use']);
  // A status held as another type's field belongs to the constants pass, not to this list.
  assert.equal(outsideEnums(files, [{ fields: [{ name: 'status', type: 'OrderStatus' }] }]).size, 0);
}

// Status lifecycles, moved unchanged from deep.mjs (slice 6, R2). Every place each value is set, by method;
// conditional updates vs plain sets; a value chosen inline counts as set.
export function lifecycleFacts({ files, enums, entities, shortlist, cite, repoEntity }) {
  // Lifecycle: every place each status value is set, by method; conditional updates vs plain saves.
  const statusEnums = new Map(enums.filter((e) => /(Status|State)$/.test(e.name)).map((e) => [e.name, e]));
  const owner = new Map();
  for (const e of entities) for (const fl of e.fields) if (statusEnums.has(fl.type)) owner.set(fl.type, e.name);
  const conditionalNames = new Set(
    files
      .filter((f) => repoEntity.has(f.name))
      .flatMap((f) =>
        f.lines.flatMap((l, i) =>
          /@Modifying/.test(l)
            ? [
                f.lines
                  .slice(i, i + 8)
                  .join(' ')
                  .match(/\b(\w+)\s*\(\s*@Param/)?.[1],
              ]
            : [],
        ),
      )
      .filter(Boolean),
  );
  const STATUS_VAR = /(\.set\w*(Status|State)|\.\w*(status|Status|state|State))\s*\(\s*[a-z]\w*\s*\)/;
  const lifecycle = [];
  // The same sets, as facts: entity, value, and the method that performs them. The flow rank reads these — a flow
  // that sets a status moves that entity through its lifecycle — while the lines above stay the digest's wording.
  const statusSites = [];
  // Every project method by name and arity, so a status literal handed to a call can be followed into the callee.
  const methodsByName = new Map();
  for (const f of files)
    for (const m of f.methods ?? []) {
      const key = `${m.name}/${m.params?.length ?? 0}`;
      methodsByName.set(key, [...(methodsByName.get(key) ?? []), { f, m }]);
    }
  for (const [en, e] of statusEnums) {
    if (!owner.has(en)) continue; // every status enum with an owner, not only the shortlisted entities
    const sites = Object.fromEntries(e.values.map((v) => [v, { set: [], conditional: [], read: 0 }]));
    for (const f of files) {
      if (f.name === en) continue;
      f.lines.forEach((l, i) => {
        for (const x of l.matchAll(new RegExp(`\\b${en}\\.([A-Z][A-Z0-9_]*)\\b`, 'g'))) {
          const s = (sites[x[1]] ??= { set: [], conditional: [], read: 0 }); // values the enum parser missed still count
          const m = f.methods
            .filter((mm) => mm.start <= i + 1 && i + 1 <= mm.end)
            .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
          const where = m ? cite(f, m) : `${f.p}:${i + 1}`;
          // A plain set is one status fact at this method and line; the digest's wording (`where`) rides along.
          const markSet = (wording) => {
            s.set.push(wording);
            statusSites.push({
              entity: owner.get(en),
              value: x[1],
              method: m?.id ?? null,
              line: i + 1,
              evidence: [m ? cite(f, m) : `${f.p}:${i + 1}`],
            });
          };
          const stmt = f.lines.slice(Math.max(0, i - 2), i + 1).join(' ');
          // The call and the value must share a line: a transition on one line and a status literal three lines
          // later (a repository query argument) are not the same statement.
          const call = [...conditionalNames].find((n) => new RegExp(`\\.${n}\\s*\\(`).test(l));
          if (call) {
            const vals = [
                ...f.lines
                  .slice(i, i + 3)
                  .join(' ')
                  .split(/\)\s*;/)[0]
                  .matchAll(new RegExp(`${en}\\.([A-Z][A-Z0-9_]*)`, 'g')),
              ].map((y) => y[1]),
              prev = [...l.matchAll(new RegExp(`${en}\\.([A-Z][A-Z0-9_]*)`, 'g'))].map((y) => y[1]);
            const all = [...new Set([...prev, ...vals])];
            if (all[all.length - 1] === x[1])
              s.conditional.push(`${where} (from ${all.slice(0, -1).join('/') || '?'} via ${call})`);
            else s.read++;
          }
          // Direct: setXxxStatus(V), builder .xxxStatus(V), or xxxStatus = V (field default or assignment).
          else if (
            new RegExp(
              // A setter (`setStatus`), a builder field (`status(`), or an assignment. Not every method whose name ends
              // in Status: `findAllByStatus(X)` is a query, and counting it made a read look like a write.
              `(\\.set\\w*(Status|State)\\s*\\(\\s*|\\.(status|state)\\s*\\(\\s*|\\w*(status|Status|state|State)\\s*=\\s*)${en}\\.${x[1]}\\b`,
            ).test(l)
          )
            markSet(where);
          // Handed to a method: a set only when the callee writes that parameter into a status. The previous status in
          // `change(model, NEW, previous)` is an argument the callee reads, so it is a read.
          else if (setByArgument(methodsByName, l, en, x[1]) === true)
            markSet(`${where} (set by the callee from the argument)`);
          else if (setByArgument(methodsByName, l, en, x[1]) === false) s.read++;
          // Chosen into a variable (ternary or assignment) in a method that sets the status from a variable.
          // A status chosen inline (`cond ? ENUM.A : ENUM.B`) sets both values (extract/lifecycle.mjs).
          else if (m && chosenInline({ enumName: en, value: x[1], stmt, methodText: f.lines.slice(m.start - 1, m.end).join('\n') }))
            markSet(`${where} (chosen inline)`);
          else if (
            m &&
            /\?[^;]*\b${en}\b/.test(l) &&
            STATUS_VAR.test(f.lines.slice(m.start - 1, m.end).join('\n')) &&
            new RegExp(`\\?[^;]*${en}\\.${x[1]}\\b`).test(l)
          )
            markSet(`${where} (chosen inline)`);
          else if (
            m &&
            !new RegExp(`[=!]=\\s*${en}\\.${x[1]}|${en}\\.${x[1]}\\s*[=!]=|case\\s+${en}|equals\\(`).test(l) &&
            // The literal itself must be what is being chosen: `status = X`, `x ? A : X`. A query argument such as
            // `List.of(Status.TRIAL)` is a read, even when the method sets a status somewhere else.
            new RegExp(`[?:=]\\s*[^;]*\\b${en}\\.${x[1]}\\b`).test(l.replace(/[=!]=/g, '')) &&
            STATUS_VAR.test(f.lines.slice(m.start - 1, m.end).join('\n'))
          )
            markSet(`${where} (via a variable)`);
          else s.read++;
        }
      });
    }
    // A status chosen by a helper and handed to a builder: `.status(initialStatus)`, where `initialStatus` came
    // from a method that returns constants through a switch. The literal never appears at the builder line.
    for (const f of files) {
      f.lines.forEach((l, i) => {
        const call = /\.status\(\s*(\w+)\s*\)/.exec(l);
        if (!call) return;
        const m = f.methods.find((mm) => mm.start <= i + 1 && i + 1 <= mm.end);
        if (!m) return;
        const body = f.lines.slice(m.start - 1, m.end).join('\n');
        const from = new RegExp('\\b' + call[1] + '\\s*=\\s*([A-Za-z0-9_]+)\\s*\\(').exec(body)?.[1];
        if (!from) return;
        const helper = f.methods.find((mm) => mm.name === from);
        if (!helper) return;
        const helperText = f.lines.slice(helper.start - 1, helper.end).join('\\n');
        for (const v of helperText.matchAll(
          new RegExp('(?:case[^:]*->\\s*|return\\s+)' + en + '\\.([A-Z][A-Z0-9_]*)', 'g'),
        )) {
          const st = (sites[v[1]] ??= { set: [], conditional: [], read: 0 });
          st.set.push(`${cite(f, m)} (chosen in ${cite(f, helper)})`);
          statusSites.push({
            entity: owner.get(en),
            value: v[1],
            method: m?.id ?? null,
            line: i + 1,
            evidence: [cite(f, m)],
          });
        }
      });
    }
    const hasConditional = Object.values(sites).some((s) => s.conditional.length);
    lifecycle.push(
      `${owner.get(en)}.${en}${hasConditional ? ' (has conditional updates: plain sets below skip that guard)' : ''}`,
    );
    for (const [v, s] of Object.entries(sites)) {
      const parts = [
        s.conditional.length && `conditional update in ${[...new Set(s.conditional)].join(', ')}`,
        s.set.length && `${hasConditional ? 'PLAIN set' : 'set'} in ${[...new Set(s.set)].join(', ')}`,
      ].filter(Boolean);
      lifecycle.push(`  ${v}: ${parts.join('; ') || 'no setter found by the engine (check the code before saying it is never set)'}`);
    }
  }

  // Status fields that hold constants instead of an enum (byte/int/String codes): every place a constant is set,
  // attributed to the entity from the receiver's declared type or the nearest Entity.builder().
  const constStatus = entities.filter(
    (e) =>
      (!shortlist || shortlist.has(e.name)) &&
      e.fields.some((fl) => /^(status|state)$/i.test(fl.name) && !statusEnums.has(fl.type)),
  );
  if (constStatus.length) {
    const names = constStatus.map((e) => e.name),
      sites = Object.fromEntries(names.map((n) => [n, {}]));
    const SET =
      /(\w+)\s*\.\s*set(?:Status|State)\s*\(\s*((?:[A-Z]\w*\.)*[A-Z][A-Z0-9_]+)\s*\)|\.(?:status|state)\s*\(\s*((?:[A-Z]\w*\.)*[A-Z][A-Z0-9_]+)\s*\)|\b(?:status|state)\s*=\s*((?:[A-Z]\w*\.)*[A-Z][A-Z0-9_]+)\s*;/;
    for (const f of files)
      f.lines.forEach((l, i) => {
        const x = SET.exec(l);
        if (!x) return;
        const m = enclosing(f, i + 1),
          body = m ? f.lines.slice(m.start - 1, m.end).join('\n') : '';
        let ent = null;
        if (x[1])
          ent = names.find((n) =>
            new RegExp(
              `\\b${n}(?:<[^>]*>)?\\s+${x[1]}\\b|\\b${x[1]}\\s*=\\s*(?:new\\s+)?${n}\\b|\\b${x[1]}\\s*=\\s*${n}\\.builder`,
            ).test(body),
          );
        else if (x[3])
          ent = names
            .map((n) => [
              n,
              f.lines
                .slice(Math.max(0, i - 8), i + 1)
                .join('\n')
                .lastIndexOf(`${n}.builder(`),
            ])
            .filter(([, k]) => k >= 0)
            .sort((a, b) => b[1] - a[1])[0]?.[0];
        else if (x[4] && names.includes(f.name)) ent = f.name; // field default inside the entity itself
        if (!ent) return;
        const v = (x[2] ?? x[3] ?? x[4]).split('.').pop();
        (sites[ent][v] ??= new Set()).add(m ? cite(f, m) : `${f.p}:${i + 1}`);
        statusSites.push({
          entity: ent,
          value: v,
          method: m?.id ?? null,
          line: i + 1,
          evidence: [m ? cite(f, m) : `${f.p}:${i + 1}`],
        });
      });
    for (const [ent, vals] of Object.entries(sites)) {
      if (!Object.keys(vals).length) continue;
      const fl = constStatus.find((e) => e.name === ent).fields.find((x) => /^(status|state)$/i.test(x.name));
      lifecycle.push(`${ent}.${fl.name} (${fl.type} constants, not an enum: only values seen being set are listed)`);
      for (const [v, where] of Object.entries(vals))
        lifecycle.push(
          `  ${v}: set in ${[...where].slice(0, 6).join(', ')}${where.size > 6 ? ` +${where.size - 6}` : ''}`,
        );
    }
  }

  // A status enum from the organisation's shared library: listed only when this repo sets it, and only the values it
  // sets, so the section says what happens here rather than what the library allows. Test code sets a status for a
  // fixture, never for the app, so it is not a site of this lifecycle.
  const isTest = (p) => /(?:^|\/)(?:test|integration-test|it)\//.test(String(p));
  for (const [, { simple: en, files: users }] of outsideEnums(files, entities)) {
    const sites = new Map();
    for (const f of users) {
      if (isTest(f.p)) continue;
      f.lines.forEach((l, i) => {
        for (const hit of l.matchAll(new RegExp(`\\b${en}\\.([A-Z][A-Z0-9_]*)\\b`, 'g'))) {
          const v = hit[1];
          const direct = new RegExp(
            `(?:\\.set\\w*(?:Status|State)\\s*\\(\\s*|\\.(?:status|state)\\s*\\(\\s*|` +
              `\\w*(?:status|Status|state|State)\\s*=\\s*)${en}\\.${v}\\b`,
          ).test(l);
          if (!direct && setByArgument(methodsByName, l, en, v) !== true) continue;
          const m = enclosing(f, i + 1);
          if (!sites.has(v)) sites.set(v, new Set());
          sites.get(v).add(m ? cite(f, m) : `${f.p}:${i + 1}`);
        }
      });
    }
    if (!sites.size) continue; // nothing here sets it: that is not a lifecycle of this repo
    lifecycle.push(`${en} (declared outside this repo)`);
    for (const [v, where] of sites)
      lifecycle.push(`  ${v}: set in ${[...where].slice(0, 6).join(', ')}${where.size > 6 ? ` +${where.size - 6}` : ''}`);
  }

  return { lifecycle, sites: statusSites };
}



/** The innermost model method whose range covers a line: what `methodAt` read from the syntax index. */
const enclosing = (f, line) =>
  (f.methods ?? [])
    .filter((m) => m.start <= line && line <= m.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null;

// The fact families this module owns, over the scanned files (moved out of deep.mjs in slice 6, R3). Only what the two
// families read is prepared here: fields, lines and the syntax index.
const cite = (f, m) => {
  const overloaded = (f.methods ?? f.ix?.methods ?? []).some((n) => n !== m && n.name === m.name);
  return overloaded ? `${f.p}:${m.start}-${m.end}#${m.name}` : `${f.p}#${m.name}`;
};

export function javaFacts({ java, repoEntity, enums, entities, shortlist }) {
  const files = java.map((j) => ({ ...j, lines: j.text.split('\n') }));
  for (const f of files)
    f.fields = new Map(
      f.fields
        .filter((x) => /^[A-Z]/.test(x.type))
        .map((x) => [x.name, x.type.replace(/<.*/, '').replace(/\[\]/g, '').split('.').pop()]),
    );
  const { lifecycle, sites } = lifecycleFacts({ files, enums, entities, shortlist, cite, repoEntity });
  const schedules = scheduleFacts({ files, cite });
  return { lifecycle, statusSets: sites, schedules };
}
