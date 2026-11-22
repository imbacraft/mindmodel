// Compare the committed engine with the working tree on every corpus app and every system service: per family, how
// many facts each side produced, which ones were added, removed or changed, and a few examples. This is the evidence
// a slice's report quotes — the snapshot diff alone cannot show what the old engine believed.
//
//   node test/compare.mjs [app-or-system ...]
//
// The committed engine runs from a throwaway `git worktree` of HEAD, removed afterwards. Nothing is written to the
// corpus apps: both engines only read them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
// `node --test` discovers every .mjs under test/; this is a tool, not a test, and it scans the whole corpus twice.
// Run it directly (`node test/compare.mjs`) or set COMPARE_IN_TEST=1 to force it inside the runner.
if (process.env.NODE_TEST_CONTEXT && !process.env.COMPARE_IN_TEST) {
  console.log('test/compare.mjs: skipped under node --test (run it directly)');
  process.exit(0);
}
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'apps.json'), 'utf8'));
const root = (process.env.MINDMODEL_TEST_APPS ?? cfg.root).replace(/^~/, os.homedir());
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const only = new Set(args.filter((a) => a !== '--all'));

// One family per entry: how to list it, how to key a fact, and (optionally) how to compare a fact's value.
// Envelope families compare by `id`; the ones the scan has not ported yet use the key the writer would recognise.
// `key` identifies a fact; `value` is what "changed" means for it. Envelope fields (id, why, evidence) are not
// compared: the old engine has no such fields, and every fact would look changed.
const FAMILIES = [
  {
    name: 'endpoints',
    list: (f) => f.endpoints ?? [],
    key: (e) => `${e.verb} ${e.path} ${e.handler}`,
    value: (e) => `${e.path}|${e.line}|${e.handler}`,
  },
  { name: 'entities', list: (f) => f.entities?.funnel ?? [], key: (e) => e.name },
  {
    // Slice 2: repository writes as facts; the committed engine recorded them as a map of entity -> files.
    name: 'state',
    list: (f) => (f.stateWrites ? f.stateWrites.map((w) => ({ key: `${w.entity ?? '?'} ${w.operation}`, v: w.method })) : Object.entries(f.state?.writes ?? {}).map(([k, v]) => ({ key: k, v: String(v) }))),
    key: (x) => x.key,
    value: (x) => x.v,
  },
  {
    name: 'background',
    list: (f) => f.background?.scheduledAsyncListeners ?? [],
    key: (b) => `${b.kind} ${b.file}:${b.line}`,
    value: (b) => `${b.kind}|${b.args}|${b.file}|${b.line}`,
  },
  { name: 'schedules', list: (f) => f.schedules ?? [], key: (s) => `${s.kind} ${s.file ?? ''}:${s.line ?? ''}` },
  {
    // Seams were prose in the committed engine; slice 2 makes them facts with kinds.
    name: 'transactions',
    list: (f) => (f.transactions ? f.transactions.filter((t) => t.kind !== 'transactional').map((t) => ({ key: `${t.kind} ${t.method}`, v: '' })) : (f.seams ?? []).map((s) => ({ key: String(s).slice(0, 60), v: '' }))),
    key: (x) => x.key,
    value: (x) => x.v,
  },
  { name: 'outside', list: (f) => (f.outsideCalls ?? []).map((o) => ({ key: `${o.kind} ${o.target}@${o.method}`, v: '' })), key: (x) => x.key, value: (x) => x.v },
  {
    // Slice 2 (revised) makes flows objects with a rank; compare by id and show the score and steps.
    name: 'flows',
    list: (f) => (f.flows ?? []).map((x) => ({ key: x.id ?? String(x), v: `${x.score ?? ''} ${(x.steps ?? []).join('; ')}` })),
    key: (x) => x.key,
    value: (x) => x.v,
  },
  { name: 'lifecycle', list: (f) => f.lifecycle ?? [], key: (l) => `${l.what ?? l.name ?? ''} ${l.file ?? ''}:${l.line ?? ''}` },
  {
    // The build reader (slice 1): the committed engine read build files with regexes into string lists, the working
    // tree reads them into coordinates. Keyed by file, compared by the coordinates it declares.
    name: 'build',
    list: (f) => f.build ?? [],
    key: (b) => b.file,
    value: (b) => (b.deps ?? []).map((d) => (typeof d === 'string' ? d : `${d.group}:${d.artifact}`)).join(', '),
  },
];

// Overloads legitimately share a path and a handler name; when a key repeats, the line disambiguates it.
const keyed = (list, fam) => {
  const counts = new Map();
  for (const x of list) counts.set(fam.key(x), (counts.get(fam.key(x)) ?? 0) + 1);
  const key = (x) => (counts.get(fam.key(x)) > 1 ? `${fam.key(x)} @${x.line ?? x.file ?? ''}` : fam.key(x));
  return new Map(list.map((x) => [key(x), fam.value ? fam.value(x) : JSON.stringify(x)]));
};
const short = (s) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);

function compareFamily(fam, before, after) {
  const a = keyed(fam.list(before), fam),
    b = keyed(fam.list(after), fam);
  const added = [...b].filter(([k]) => !a.has(k)),
    removed = [...a].filter(([k]) => !b.has(k)),
    changed = [...b].filter(([k, v]) => a.has(k) && a.get(k) !== v);
  if (!added.length && !removed.length && !changed.length) return null;
  const rows = [`  ${fam.name}: ${a.size} → ${b.size}  (+${added.length}  −${removed.length}  ~${changed.length})`];
  const show = (label, list) =>
    list
      .slice(0, ALL ? 1000 : 5)
      .forEach(([k, v]) => rows.push(`    ${label} ${short(k)}${ALL ? '' : v ? `  ${short(v)}` : ''}`));
  show('+', added);
  show('−', removed);
  show('~', changed);
  if (added.length + removed.length + changed.length > 15) rows.push('    … more in the per-app JSON');
  return rows.join('\n');
}

// Scan one tree with one engine in a child process: the two engines must not share module state.
function scanWith(engineDir, dir, kind) {
  const entry = path.join(engineDir, 'engine', kind === 'app' ? 'scan.mjs' : 'system.mjs');
  const fn = kind === 'app' ? 'scan' : 'systemScan';
  const script = `import { ${fn} } from ${JSON.stringify(entry)}; process.stdout.write(JSON.stringify(${fn}(process.argv[1])));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, dir], { maxBuffer: 1 << 30 }));
}

function report(label, before, after) {
  const parts = FAMILIES.map((fam) => compareFamily(fam, before, after)).filter(Boolean);
  console.log(`${label}: ${parts.length ? '' : 'no family changed'}`);
  for (const p of parts) console.log(p);
  // Coverage is a summary, not a fact family; print its rates when both engines have them.
  if (after.coverage?.rates) {
    const old = new Map((before.coverage?.rates ?? []).map((r) => [r.id, r]));
    const rows = after.coverage.rates.map((r) => {
      const was = old.get(r.id);
      return `${r.id} ${was ? `${was.percent}% → ` : '(new) '}${r.percent}%`;
    });
    console.log(`  coverage: ${rows.join('; ')}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmodel-compare-'));
const head = path.join(tmp, 'head');
let worktree = false;
try {
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', head, 'HEAD']);
  worktree = true;
  const targets = [
    ...cfg.apps.map((a) => ({ kind: 'app', name: a.name, dir: path.join(root, a.name) })),
    ...cfg.systems.map((s) => ({ kind: 'system', name: s.name, dir: path.join(root, s.name) })),
  ].filter((t) => !only.size || only.has(t.name));
  console.log(`committed engine: ${execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).toString().trim()}`);
  console.log(`working tree:     ${repo}\n`);
  for (const t of targets) {
    if (!fs.existsSync(t.dir)) {
      console.log(`${t.kind} ${t.name}: not found, skipped`);
      continue;
    }
    const before = scanWith(head, t.dir, t.kind),
      after = scanWith(repo, t.dir, t.kind);
    if (t.kind === 'app') report(`app ${t.name}`, before, after);
    else
      for (const s of after.services ?? []) {
        const old = (before.services ?? []).find((x) => x.name === s.name);
        report(`system ${t.name}/${s.name}`, old?.facts ?? {}, s.facts ?? {});
      }
  }
} finally {
  if (worktree) execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', head]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
