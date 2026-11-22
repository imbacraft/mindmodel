// Facts the writer used to dig up by reading code, now stated down to the method with ready-to-copy citations:
// transaction seams, status lifecycles, schedules in plain words, and how to boot the app locally.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { index, methodAt } from './syntax/java.mjs';

// Cite methods by name only: `validate.mjs --fix` fills in the exact range, and the digest stays short. An overloaded
// name also gets its range, so two overloads don't read as one fact.
const cite = (f, m) => {
  const overloaded = f.ix.methods.some((n) => n !== m && n.name === m.name);
  return overloaded ? `${f.p}:${m.start}-${m.end}#${m.name}` : `${f.p}#${m.name}`;
};
{
  const ix = index('class S {\n  void save(int a) { save(a, 1); }\n  void save(int a, int b) {}\n  void x() {}\n}');
  const f = { p: 'S.java', ix };
  assert.deepStrictEqual(
    ix.methods.map((m) => cite(f, m)),
    ['S.java:2-2#save', 'S.java:3-3#save', 'S.java#x'],
  );
}
// Spring and Jakarta EE spellings of the same idea.
const JOB = /^(Scheduled|Schedule)\b/;
// A transaction attribute that suspends or skips the transaction.
const NO_TX = /^(Transactional|TransactionAttribute)\b.*\b(NOT_SUPPORTED|NEVER|SUPPORTS)\b/;
// --- time in plain words ----------------------------------------------------------
export function humanMs(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}
export function humanCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 6 || f[3] !== '*' || f[4] !== '*' || !['*', '?'].includes(f[5])) return `cron "${expr}"`;
  const [s, m, h] = f,
    every = (x) => /^(\*|0)\/(\d+)$/.exec(x)?.[2];
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) return `daily ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (every(m) && h === '*') return `every ${every(m)} min`;
  if (/^\d+$/.test(m) && h === '*') return 'hourly';
  if (/^\d+$/.test(m) && every(h)) return `every ${every(h)} h`;
  if (every(s) && m === '*') return `every ${every(s)} s`;
  return `cron "${expr}"`;
}
export function humanSchedule(args) {
  // EJB @Schedule: calendar attributes, each defaulting as the spec says (second 0, minute 0, hour 0, every day).
  if (/\b(second|minute|hour|dayOfMonth|month|dayOfWeek)\s*=\s*"/.test(args)) {
    const a = (k, d) => new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`).exec(args)?.[1] ?? d;
    return humanCron(
      `${a('second', '0')} ${a('minute', '0')} ${a('hour', '0')} ${a('dayOfMonth', '*')} ${a('month', '*')} ${a('dayOfWeek', '*')}`,
    );
  }
  // `fixedRate = 10 * 60 * 1000` is one value, not 10: read the arithmetic, don't take the first integer.
  const num = (k) => {
    const m = new RegExp(`\\b${k}\\s*=\\s*([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*)L?`).exec(args);
    return m ? m[1].split('*').reduce((a, b) => a * Number(b.replace(/_/g, '').trim()), 1) : null;
  };
  const parts = [];
  const cron = /cron\s*=\s*"([^"]+)"/.exec(args);
  if (cron) parts.push(/^\$\{/.test(cron[1]) ? `cron from config ${cron[1]}` : humanCron(cron[1]));
  if (num('fixedRate') != null) parts.push(`every ${humanMs(num('fixedRate'))}`);
  if (num('fixedDelay') != null) parts.push(`${humanMs(num('fixedDelay'))} after each run ends`);
  const str = /(fixedRate|fixedDelay|initialDelay)String\s*=\s*"([^"]+)"/.exec(args);
  if (str) parts.push(`${str[1]} from config ${str[2]}`);
  if (num('initialDelay') != null) parts.push(`first run after ${humanMs(num('initialDelay'))}`);
  return parts.join(', ') || args;
}
assert.equal(humanCron('0 0 3 * * *'), 'daily 03:00');
assert.equal(humanCron('0 */15 * * * *'), 'every 15 min');
assert.equal(humanSchedule('(fixedRate = 600_000)'), 'every 10 min');
assert.equal(humanSchedule('(fixedDelay = 30000)'), '30 s after each run ends');
assert.equal(humanSchedule('(minute = "*/2", hour = "*")'), 'every 2 min');
assert.equal(humanSchedule('(hour = "3")'), 'daily 03:00');

// Time windows and retry settings written inside a method (e.g. "older than 5 min").
const WINDOW =
  /(?:minus|plus)(Seconds|Minutes|Hours|Days|Weeks)\(\s*(\d+)|Duration\.of(Seconds|Minutes|Hours|Days)\(\s*(\d+)/g;
const UNIT = { Seconds: 's', Minutes: 'min', Hours: 'h', Days: 'd', Weeks: 'wk' };
const windowsIn = (lines, m) => [
  ...new Set(
    [
      ...lines
        .slice(m.start - 1, m.end)
        .join('\n')
        .matchAll(WINDOW),
    ].map((x) => `${x[2] ?? x[4]} ${UNIT[x[1] ?? x[3]]}`),
  ),
];

// --- Java: seams, lifecycles, schedules -----------------------------------------------
export function javaFacts({ java, repoEntity, enums, entities, shortlist }) {
  const files = java.map((j) => ({ ...j, ix: j.ix ?? index(j.text), lines: j.text.split('\n') }));
  const byName = new Map(files.map((f) => [f.name, f]));
  // Each type name -> the files that are it or implement it, built once (looked up for every call resolved).
  const impls = new Map();
  for (const f of files)
    for (const n of new Set([f.name, ...(f.implements ?? '').split(/\s*,\s*/).map((s) => s.replace(/<.*/, ''))]))
      if (n) impls.set(n, [...(impls.get(n) ?? []), f]);
  const implsOf = (t) => impls.get(t) ?? [];

  for (const f of files) {
    // Fields of this class with their declared type: what a receiver is (repository, client, bean).
    f.fields = new Map(
      f.ix.fields
        .filter((x) => x.owner === f.name && /^[A-Z]/.test(x.type))
        .map((x) => [x.name, x.type.replace(/<.*/, '').replace(/\[\]/g, '').split('.').pop()]),
    );
    f.txClass = f.ix.types.some((t) => t.annotations.some((a) => /^Transactional\b/.test(a) && !NO_TX.test(a)));
    // EJBs are transactional by default (container-managed, REQUIRED) unless the class opts out.
    // Read from the text: an activationConfig = { ... } array hides the class's own annotations from the brace index.
    const ejb =
      /import\s+(jakarta|javax)\.ejb\.(\*|Stateless|Stateful|Singleton|MessageDriven)\b/.test(f.text) &&
      /@(Stateless|Stateful|Singleton|MessageDriven)\b/.test(f.text);
    f.mdb = ejb && /@MessageDriven\b/.test(f.text);
    if (
      ejb &&
      !f.ix.types.some((t) => t.annotations.some((a) => NO_TX.test(a) || /^TransactionManagement\b.*\bBEAN\b/.test(a)))
    )
      f.txClass = true;
    // Under JTA (EJBs, jakarta.transaction) a JMS send joins the transaction: it is delivered only on commit.
    f.jta = ejb || /import\s+(jakarta|javax)\.transaction\.(Transactional|\*)/.test(f.text);
  }
  const isTx = (f, m) =>
    !m.annotations.some((a) => NO_TX.test(a)) &&
    (m.annotations.some((a) => /^(Transactional|TransactionAttribute)\b/.test(a) && !/readOnly\s*=\s*true/.test(a)) ||
      (f.txClass && m.isPublic));

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
      lifecycle.push(`  ${v}: ${parts.join('; ') || 'no set found (confirm before saying it is never set)'}`);
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

  // Schedules and retries in plain words, with the time windows each job uses.
  const schedules = [];
  for (const f of files)
    for (const m of f.ix.methods) {
      const header = f.lines.slice(m.start - 1, m.nameLine),
        sch = m.annotations.find((a) => JOB.test(a)),
        raw = sch && header.find((l) => /@Schedul(e|ed)\b/.test(l));
      if (sch) {
        const w = windowsIn(f.lines, m);
        schedules.push(
          `${f.name}.${m.name} ${cite(f, m)}: ${humanSchedule(raw ?? sch)}${w.length ? ` · windows ${w.join(', ')}` : ''}`,
        );
      }
      const retry = header.join(' ').match(/@Retryable\(([^@]*(@Backoff\([^)]*\))?[^)]*)\)/);
      if (retry) {
        const a = /maxAttempts\s*=\s*(\d+)/.exec(retry[1])?.[1],
          d = /delay\s*=\s*(\d+)/.exec(retry[1])?.[1],
          x = /multiplier\s*=\s*([\d.]+)/.exec(retry[1])?.[1];
        schedules.push(
          `RETRY ${f.name}.${m.name} ${cite(f, m)}: ${a ?? 3} attempts${d ? `, first wait ${humanMs(Number(d))}` : ''}${x ? ` ×${x}` : ''}`,
        );
      }
    }
  return { lifecycle, schedules };
}

// --- Deployables: a repo can hold several apps; the map covers the primary one ----------
// Primary = the entry point whose module depends on the most sibling modules (the one that assembles the app).
// Code of the other deployables, and packages the primary app excludes from its component scan, is left out.
export function deployables({ java, files, rel, read }) {
  const isMain = (j) =>
    /static\s+void\s+main\s*\(/.test(j.text) &&
    /SpringApplication(Builder)?\b|@SpringBootApplication|@SpringBootConfiguration|@EnableAutoConfiguration/.test(
      j.text,
    );
  const moduleOf = (p) => (p.includes('/src/main/java/') ? p.split('/src/main/java/')[0] : '.');
  const mods = new Set(java.map((j) => moduleOf(j.p)).filter((m) => m !== '.'));
  const deps = (m) => {
    const b = files.find(
      (f) =>
        rel(f) === `${m === '.' ? '' : m + '/'}pom.xml` ||
        rel(f) === `${m === '.' ? '' : m + '/'}build.gradle` ||
        rel(f) === `${m === '.' ? '' : m + '/'}build.gradle.kts`,
    );
    if (!b) return 0;
    const t = read(b);
    return [...mods].filter((o) => o !== m && new RegExp(`[>:'"]${path.basename(o)}[<'"]`).test(t)).length;
  };
  const mains = java
    .filter(isMain)
    .map((j) => ({
      file: j.p,
      line: j.text.split('\n').findIndex((l) => /static\s+void\s+main/.test(l)) + 1 || null,
      module: moduleOf(j.p),
      name: j.name,
    }))
    .map((m) => ({ ...m, deps: deps(m.module) }))
    .sort((a, b) => b.deps - a.deps);
  if (!mains.length) return { primary: null, others: [], isExcluded: () => false };
  const primary = mains[0],
    others = mains
      .slice(1)
      .filter((o) => o.module !== primary.module && !primary.module.startsWith(o.module + '/') && o.module !== '.');
  const mainText = java.find((j) => j.p === primary.file).text;
  const scanBlock =
    /@ComponentScan\s*\(([\s\S]*?)\)\s*\n\s*@|@ComponentScan\s*\(([\s\S]*?)\)\s*\n\s*(public\s+)?class/.exec(mainText);
  const patterns = scanBlock
    ? [...(scanBlock[1] ?? scanBlock[2]).matchAll(/pattern\s*=\s*"([^"]+)"/g)].map(
        (m) => new RegExp(m[1].replace(/\\\\/g, '\\')),
      )
    : [];
  const fqn = (p) =>
    p
      .split('/src/main/java/')[1]
      ?.replace(/\.java$/, '')
      .split('/')
      .join('.') ?? '';
  const isExcluded = (p) => others.some((o) => p.startsWith(o.module + '/')) || patterns.some((re) => re.test(fqn(p)));
  return { primary, others, excludedPatterns: patterns.map(String), isExcluded };
}
{
  const java = [
    {
      p: 'app/src/main/java/x/App.java',
      name: 'App',
      text: '@SpringBootConfiguration\n@ComponentScan(basePackages = {"x"}, excludeFilters = @ComponentScan.Filter(type = FilterType.REGEX, pattern = "x\\\\.gw\\\\..*"))\npublic class App { public static void main(String[] a) {} }',
    },
    {
      p: 'worker/src/main/java/x/W.java',
      name: 'W',
      text: '@SpringBootApplication\nclass W { public static void main(String[] a) {} }',
    },
  ];
  const files = ['app/pom.xml', 'worker/pom.xml'],
    text = { 'app/pom.xml': '<artifactId>worker</artifactId>', 'worker/pom.xml': '' };
  const d = deployables({ java, files, rel: (f) => f, read: (f) => text[f] });
  assert.equal(d.primary.module, 'app');
  assert.ok(d.isExcluded('worker/src/main/java/x/W.java'));
  assert.ok(d.isExcluded('app/src/main/java/x/gw/Api.java'));
  assert.ok(!d.isExcluded('app/src/main/java/x/core/Svc.java'));
}

// --- Boot: the one way to run the whole app locally ---------------------------------
// Flat key paths of a YAML or .properties file: "server.port" -> { value, line }.
export function configKeys(text, props = false) {
  const out = new Map(),
    stack = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*(#|$)/.test(l)) return;
    if (props) {
      const m = /^\s*([\w.\-[\]]+)\s*[=:]\s*(.*)$/.exec(l);
      if (m) out.set(m[1], { value: m[2].trim(), line: i + 1 });
      return;
    }
    const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(l);
    if (!m) return;
    while (stack.length && stack[stack.length - 1].indent >= m[1].length) stack.pop();
    stack.push({ indent: m[1].length, key: m[2] });
    if (m[3] && !m[3].startsWith('#'))
      out.set(stack.map((s) => s.key).join('.'), {
        value: m[3].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, ''),
        line: i + 1,
      });
  });
  return out;
}
{
  const k = configKeys('server:\n  port: ${PORT:8080}\nspring:\n  datasource:\n    url: ${DB_URL}\n');
  assert.deepStrictEqual(k.get('server.port'), { value: '${PORT:8080}', line: 2 });
  assert.equal(k.get('spring.datasource.url').value, '${DB_URL}');
}

// Jakarta EE and MicroProfile apps have no main(): a server plugin in the build runs them. Profiles that are not
// active by default hold alternative servers, not the default run.
const RUNTIMES = [
  [/quarkus-maven-plugin/, 'quarkus:dev', 'Quarkus', 8080],
  [/liberty-maven-plugin/, 'liberty:run', 'Open Liberty', 9080],
  [/wildfly(-jar)?-maven-plugin/, 'wildfly:run', 'WildFly', 8080],
  [/payara-micro-maven-plugin/, 'payara-micro:start', 'Payara Micro', 8080],
  [/tomee-maven-plugin/, 'tomee:run', 'TomEE', 8080],
  [/cargo-maven\d?-plugin/, 'cargo:run', null, 8080],
];
export function eeBoot(pom, B, mvn, prefix = '') {
  const profiles = [...pom.matchAll(/<profile>[\s\S]*?<\/profile>/g)].map((m) => ({
    text: m[0],
    from: m.index,
    to: m.index + m[0].length,
    id: /<id>([^<]+)/.exec(m[0])?.[1],
    on: /<activeByDefault>\s*true/.test(m[0]),
  }));
  const off = profiles.filter((p) => !p.on),
    inOff = (i) => off.some((p) => i >= p.from && i < p.to);
  const first = (re) => [...pom.matchAll(new RegExp(re.source, 'g'))].find((m) => !inOff(m.index));
  const rt = RUNTIMES.map((r) => ({ r, m: first(r[0]) }))
    .filter((x) => x.m)
    .sort((a, b) => a.m.index - b.m.index)[0];
  const packaging = /<packaging>\s*(war|ear)\s*</.exec(pom)?.[1];
  if (!rt && !packaging) return null;
  const own = pom.replace(/<parent>[\s\S]*?<\/parent>/, ''),
    fin = /<finalName>([^<$]+)<\/finalName>/.exec(own)?.[1],
    name = fin ?? /<artifactId>([^<]+)<\/artifactId>/.exec(own)?.[1] ?? 'the app';
  if (!rt)
    return [
      `run: no server plugin in ${B}: build with ${prefix}${mvn} clean package and deploy target/${name}.${packaging} to a Jakarta EE server`,
    ];
  const [, goal, label, port] = rt.r,
    line = pom.slice(0, rt.m.index).split('\n').length;
  const c = /<containerId>\s*([a-z]+)/.exec(pom.slice(rt.m.index, rt.m.index + 2000))?.[1],
    server = label ?? (c ? c[0].toUpperCase() + c.slice(1) : 'the configured server');
  const out = [
    `run: ${prefix}${mvn} ${/:dev$/.test(goal) ? '' : 'clean package '}${goal} (${B}:${line}): runs the app in ${server}`,
    `url: http://localhost:${port}/${label === 'Quarkus' ? '' : `${name}/`} (${server}'s default port${label === 'Quarkus' ? '' : '; context root = the WAR name'})`,
  ];
  const alt = off
    .filter((p) => p.id)
    .map((p) => ({ p, r: RUNTIMES.find((r) => r[0].test(p.text)) }))
    .filter((x) => x.r);
  if (alt.length) out.push(`other servers (Maven profiles): ${alt.map(({ p, r }) => `-P${p.id} ${r[1]}`).join(', ')}`);
  return out;
}
{
  const pom =
    '<project><artifactId>shop</artifactId><packaging>war</packaging><build><finalName>shop</finalName></build><profiles>\n<profile><id>payara</id><activation><activeByDefault>true</activeByDefault></activation>\n<plugin><artifactId>cargo-maven3-plugin</artifactId><containerId>payara</containerId></plugin></profile>\n<profile><id>openliberty</id><plugin><artifactId>liberty-maven-plugin</artifactId></plugin></profile></profiles></project>';
  assert.deepStrictEqual(eeBoot(pom, 'pom.xml', './mvnw'), [
    'run: ./mvnw clean package cargo:run (pom.xml:3): runs the app in Payara',
    "url: http://localhost:8080/shop/ (Payara's default port; context root = the WAR name)",
    'other servers (Maven profiles): -Popenliberty liberty:run',
  ]);
  assert.equal(eeBoot('<project><packaging>jar</packaging></project>', 'pom.xml', 'mvn'), null);
}

export function bootFacts({ root, files, rel, git, app }) {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const lineOf = (text, re) => {
    const i = text.split('\n').findIndex((l) => re.test(l));
    return i < 0 ? null : i + 1;
  };
  const build = files
    .filter((f) => /(^|\/)(build\.gradle(\.kts)?|pom\.xml)$/.test(rel(f)))
    .sort((a, b) => rel(a).split('/').length - rel(b).split('/').length)[0];
  if (!build) return [];
  const b = read(build),
    B = rel(build),
    dir = path.dirname(build),
    gradle = !B.endsWith('pom.xml');
  const out = [];
  const wrapper = fs.existsSync(path.join(dir, gradle ? 'gradlew' : 'mvnw'));
  const prefix = path.dirname(B) === '.' ? '' : `cd ${path.dirname(B)} && `;
  if (!app?.primary && !gradle) {
    const ee = eeBoot(b, B, wrapper ? './mvnw' : 'mvn', prefix);
    if (ee) return ee;
  }
  // A separate module only if it has its own build file; otherwise it is just a source folder of the root build.
  const ownBuild = (m) =>
    files.some((f) =>
      new RegExp(`^${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(pom\\.xml|build\\.gradle(\\.kts)?)$`).test(rel(f)),
    );
  const mod =
    app?.primary && app.primary.module !== '.' && app.primary.module !== path.dirname(B) && ownBuild(app.primary.module)
      ? app.primary.module
      : null;
  if (mod)
    out.push(
      `app: ${mod} (main ${app.primary.file}${app.primary.line ? ':' + app.primary.line : ''}); multi-module build, so confirm the exact command in the README. Usually: ${gradle ? `./gradlew :${path.basename(mod)}:bootRun` : `${wrapper ? './mvnw' : 'mvn'} -pl ${mod} -am spring-boot:run`}`,
    );
  else
    out.push(
      `run: ${prefix}${gradle ? (wrapper ? './gradlew' : 'gradle') + ' bootRun' : (wrapper ? './mvnw' : 'mvn') + ' spring-boot:run'} (${B}${gradle && lineOf(b, /\bbootRun\b/) ? ':' + lineOf(b, /\bbootRun\b/) : ''})`,
    );
  if (app?.others.length)
    out.push(
      `other deployables in this repo (not mapped): ${app.others.map((o) => `${o.name} (${o.module})`).join(', ')}${app.excludedPatterns.length ? `; also excluded from the app's component scan: ${app.excludedPatterns.join(', ')}` : ''}`,
    );

  // Profile the run command activates.
  let profile = null,
    profileAt = null;
  const lit =
    /spring\.profiles\.active\s*=\s*([\w-]+)/.exec(b) ??
    /<profiles>\s*<profile>([\w-]+)</.exec(b) ??
    /systemProperty\s*\(?\s*['"]spring\.profiles\.active['"]\s*,\s*['"]([\w-]+)['"]/.exec(b);
  if (lit) {
    profile = lit[1];
    profileAt = lineOf(b, new RegExp(lit[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } else {
    const v = /spring\.profiles\.active=?["']?\s*\+\s*(\w+)/.exec(b);
    const def = v && new RegExp(`\\b${v[1]}\\s*=\\s*[^\\n]*?['"]([\\w-]+)['"]`).exec(b);
    if (def) {
      profile = def[1];
      profileAt = lineOf(b, new RegExp(`\\b${v[1]}\\s*=`));
    }
  }

  const cfg = files.filter(
    (f) =>
      /src\/main\/resources\/application(-[\w-]+)?\.(ya?ml|properties)$/.test(rel(f)) &&
      (!mod || rel(f).startsWith(mod + '/')),
  );
  const load = (name) => {
    const f = cfg.find((c) => new RegExp(`/application${name ? '-' + name : ''}\\.(ya?ml|properties)$`).test(rel(c)));
    return f ? { file: rel(f), keys: configKeys(read(f), f.endsWith('.properties')) } : null;
  };
  const base = load(null);
  if (!profile && base?.keys.get('spring.profiles.active')) {
    const k = base.keys.get('spring.profiles.active');
    profile = k.value.replace(/^\$\{[^:}]*:?([^}]*)\}$/, '$1') || null;
    profileAt = `${base.file}:${k.line}`;
  }
  const prof = profile ? load(profile) : null;
  if (profile) {
    let where = 'no profile config file found';
    if (prof) {
      const tracked = git(root, ['ls-files', '--error-unmatch', prof.file]) != null;
      const ign = !tracked && git(root, ['check-ignore', '-v', prof.file]);
      where = tracked
        ? `${prof.file} (in git)`
        : `${prof.file} is NOT in git${ign ? ` (ignored by ${ign.split('\t')[0].replace(/:[^:]*$/, '')})` : ''}: a new developer must create it`;
    }
    out.push(`profile: ${profile} (${typeof profileAt === 'number' ? `${B}:${profileAt}` : profileAt}); ${where}`);
  }
  const port = (k) => k?.keys.get('server.port') && { ...k.keys.get('server.port'), file: k.file };
  const p = port(prof) ?? port(base);
  if (p) {
    const d = /^\$\{(\w+):(\d+)\}$/.exec(p.value);
    out.push(`port: ${d ? `${d[2]} unless ${d[1]} is set` : p.value} (${p.file}:${p.line})`);
  } else out.push('port: 8080 (Spring default; no server.port)');

  // Does the backend build also build and serve the frontend?
  const fe = /NpmTask|node-gradle|com\.github\.node|frontend-maven-plugin|npm\s+run|yarnBuild/.exec(b),
    hook = /(processResources|bootJar|generate-resources|prepare-package)[^\n]*/.exec(b);
  if (fe && hook)
    out.push(
      `frontend: built and served by the backend, so the run command starts the whole app (${B}:${lineOf(b, new RegExp(fe[0]))}, ${B}:${lineOf(b, new RegExp(hook[1]))})`,
    );

  // Settings with no default in the base config, and whether the profile file supplies them.
  if (base) {
    const need = [...base.keys].filter(([, v]) => /\$\{\w+\}/.test(v.value));
    const missing = need.filter(([k]) => !prof?.keys.has(k)),
      covered = need.filter(([k]) => prof?.keys.has(k));
    if (missing.length)
      out.push(
        `required, no default anywhere: ${missing.map(([k, v]) => `${/\$\{(\w+)\}/.exec(v.value)[1]} (${k}, ${base.file}:${v.line})`).join(', ')}`,
      );
    if (covered.length)
      out.push(`set by the ${profile} profile file instead of env vars: ${covered.map(([k]) => k).join(', ')}`);
  }
  return out;
}
