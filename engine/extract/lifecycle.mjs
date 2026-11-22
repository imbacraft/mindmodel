import { index, methodAt } from '../syntax/java.mjs';
import { scheduleFacts } from './schedules.mjs';
// Lifecycle helpers moved out of deep.mjs (which is meant to disappear). A status chosen inline
// (`cond ? ENUM.A : ENUM.B`, possibly across lines) inside a method that sets a status sets both values.
import assert from 'node:assert/strict';

export function chosenInline({ enumName, value, stmt, methodText }) {
  if (!stmt.includes('?')) return false;
  if (!new RegExp(`\\b${enumName}\\.${value}\\b`).test(stmt)) return false;
  return /\.(set\w*Status|status)\s*\(/.test(methodText ?? '');
}

assert.equal(chosenInline({ enumName: 'S', value: 'A', stmt: 'x ? S.A : S.B', methodText: 'o.setStatus(x)' }), true);
assert.equal(chosenInline({ enumName: 'S', value: 'A', stmt: 'x ? S.A : S.B', methodText: 'return 1;' }), false);


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
  for (const [en, e] of statusEnums) {
    if (!owner.has(en)) continue; // every status enum with an owner, not only the shortlisted entities
    const sites = Object.fromEntries(e.values.map((v) => [v, { set: [], conditional: [], read: 0 }]));
    for (const f of files) {
      if (f.name === en) continue;
      f.lines.forEach((l, i) => {
        for (const x of l.matchAll(new RegExp(`\\b${en}\\.([A-Z][A-Z0-9_]*)\\b`, 'g'))) {
          const s = (sites[x[1]] ??= { set: [], conditional: [], read: 0 }); // values the enum parser missed still count
          const m = f.ix.methods
            .filter((mm) => mm.start <= i + 1 && i + 1 <= mm.end)
            .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
          const where = m ? cite(f, m) : `${f.p}:${i + 1}`;
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
            s.set.push(where);
          // Chosen into a variable (ternary or assignment) in a method that sets the status from a variable.
          // A status chosen inline (`cond ? ENUM.A : ENUM.B`) sets both values (extract/lifecycle.mjs).
          else if (m && chosenInline({ enumName: en, value: x[1], stmt, methodText: f.lines.slice(m.start - 1, m.end).join('\n') }))
            s.set.push(`${where} (chosen inline)`);
          else if (
            m &&
            /\?[^;]*\b${en}\b/.test(l) &&
            STATUS_VAR.test(f.lines.slice(m.start - 1, m.end).join('\n')) &&
            new RegExp(`\\?[^;]*${en}\\.${x[1]}\\b`).test(l)
          )
            s.set.push(`${where} (chosen inline)`);
          else if (
            m &&
            !new RegExp(`[=!]=\\s*${en}\\.${x[1]}|${en}\\.${x[1]}\\s*[=!]=|case\\s+${en}|equals\\(`).test(l) &&
            // The literal itself must be what is being chosen: `status = X`, `x ? A : X`. A query argument such as
            // `List.of(Status.TRIAL)` is a read, even when the method sets a status somewhere else.
            new RegExp(`[?:=]\\s*[^;]*\\b${en}\\.${x[1]}\\b`).test(l.replace(/[=!]=/g, '')) &&
            STATUS_VAR.test(f.lines.slice(m.start - 1, m.end).join('\n'))
          )
            s.set.push(`${where} (via a variable)`);
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
        const m = f.ix.methods.find((mm) => mm.start <= i + 1 && i + 1 <= mm.end);
        if (!m) return;
        const body = f.lines.slice(m.start - 1, m.end).join('\n');
        const from = new RegExp('\\b' + call[1] + '\\s*=\\s*([A-Za-z0-9_]+)\\s*\\(').exec(body)?.[1];
        if (!from) return;
        const helper = f.ix.methods.find((mm) => mm.name === from);
        if (!helper) return;
        const helperText = f.lines.slice(helper.start - 1, helper.end).join('\\n');
        for (const v of helperText.matchAll(
          new RegExp('(?:case[^:]*->\\s*|return\\s+)' + en + '\\.([A-Z][A-Z0-9_]*)', 'g'),
        )) {
          const st = (sites[v[1]] ??= { set: [], conditional: [], read: 0 });
          st.set.push(`${cite(f, m)} (chosen in ${cite(f, helper)})`);
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
        const m = methodAt(f.ix, i + 1),
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

  return lifecycle;
}


// The fact families this module owns, over the scanned files (moved out of deep.mjs in slice 6, R3). Only what the two
// families read is prepared here: fields, lines and the syntax index.
const cite = (f, m) => {
  const overloaded = f.ix.methods.some((n) => n !== m && n.name === m.name);
  return overloaded ? `${f.p}:${m.start}-${m.end}#${m.name}` : `${f.p}#${m.name}`;
};

export function javaFacts({ java, repoEntity, enums, entities, shortlist }) {
  const files = java.map((j) => ({ ...j, ix: j.ix ?? index(j.text), lines: j.text.split('\n') }));
  for (const f of files)
    f.fields = new Map(
      f.ix.fields
        .filter((x) => x.owner === f.name && /^[A-Z]/.test(x.type))
        .map((x) => [x.name, x.type.replace(/<.*/, '').replace(/\[\]/g, '').split('.').pop()]),
    );
  const lifecycle = lifecycleFacts({ files, enums, entities, shortlist, cite, repoEntity });
  const schedules = scheduleFacts({ files, cite });
  return { lifecycle, schedules };
}
