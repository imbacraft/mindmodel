// The code the writer will need, handed over once: the top ranked flows' method bodies, every lifecycle setter with
// context, and the filters that read the caller. Each block is headed `path:start-end#method`, which is already a
// citation, so the writer quotes it without opening the file. Written to `mindmodel/.work/excerpts.md` at the end of a
// scan, capped so it costs about 10k tokens of the writer's context and no more.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

export const FLOWS = 6; // the top ranked flows: the rest rarely earn their place in a context
export const FLOW_LINES = 25; // one method body inside a flow
export const SETTER_LINES = 3; // ±3 around a lifecycle setter: the call and what surrounds it
export const FILTER_LINES = 40; // a request filter's whole method
export const BUDGET = 40_000; // the whole file, in characters: about 10k tokens
const CUT = '…';

/**
 * The model's methods, indexed three ways: by id, by `Type#name` (how a flow's steps name a method, with no
 * parameters) and by `file#name` (how a security fact cites one). The dump's own ranges, never a second parse.
 */
export function methodIndex(model) {
  const byId = new Map();
  for (const t of model?.types?.values() ?? [])
    for (const m of t.methods ?? [])
      if (m.id && Number.isFinite(m.start) && Number.isFinite(m.end) && m.end >= m.start)
        byId.set(m.id, { file: t.file, name: m.name, start: m.start, end: m.end });
  // A name that fits two methods answers nothing: a citation must resolve to one body or not at all.
  const unique = (key) => !key || !byId.has(key);
  const byType = new Map();
  const byFile = new Map();
  for (const [id, m] of byId)
    for (const [map, key] of [
      [byType, `${String(id.split('#')[0]).split('.').pop()}#${m.name}`],
      [byFile, `${m.file}#${m.name}`],
    ]) {
      if (!map.has(key)) map.set(key, id);
      else if (map.get(key) !== id) map.set(key, null);
    }
  return {
    byId,
    method: (id) => byId.get(id) ?? null,
    named: (key) => (unique(byType.get(key)) ? byType.get(key) : null),
    cited: (file, name) => (unique(byFile.get(`${file}#${name}`)) ? byFile.get(`${file}#${name}`) : null),
  };
}

/** The method's lines, numbered, cut in the middle when longer than `cap`, so both ends survive. */
export function body(text, from, to, cap) {
  const lines = text.split('\n');
  const first = Math.max(1, from);
  const last = Math.min(lines.length, to);
  if (last < first) return [];
  const pad = String(last).length;
  const row = (n) => `${String(n).padStart(pad)}| ${lines[n - 1]}`;
  if (last - first + 1 <= cap) return Array.from({ length: last - first + 1 }, (_, i) => row(first + i));
  const head = Math.ceil((cap - 1) / 2);
  const tail = cap - 1 - head;
  return [
    ...Array.from({ length: head }, (_, i) => row(first + i)),
    CUT.padStart(pad + 1),
    ...Array.from({ length: tail }, (_, i) => row(last - tail + 1 + i)),
  ];
}

/** One method, as a block headed by its citation. `around` narrows it to ±`SETTER_LINES` of that line. */
function methodBlock(index, read, methodId, cap, around = null) {
  const m = index.method(methodId);
  if (!m) return null;
  const text = read(m.file);
  if (text === null) return null;
  const start = around === null ? m.start : Math.max(m.start, around - SETTER_LINES);
  const end = around === null ? m.end : Math.min(m.end, around + SETTER_LINES);
  const rows = body(text, start, end, cap);
  if (!rows.length) return null;
  return [`#### ${m.file}:${start}-${end}#${m.name}`, '```java', ...rows, '```'].join('\n');
}

const HEAD = [
  '# Code excerpts',
  '',
  'Read this once, after the digest, and cite from it: every heading is `path:start-end#method`. It holds the ranked',
  "flows' steps, each lifecycle setter with context, and the filters that read the caller. Anything else is a question",
  'for `ask.mjs`; nothing here replaces looking around.',
].join('\n');

/**
 * The excerpt file's text: flows in rank order, then the lifecycle setters, then the filters. Nothing is read from disk
 * until a block is written, and each file is read once however many blocks cite it. Over the budget, the
 * lowest-ranked flow goes first — the filters and the setters are never dropped.
 */
export function excerpts(root, facts = {}, model = null, { budget = BUDGET } = {}) {
  const index = methodIndex(model);
  const files = new Map();
  const read = (file) => {
    if (!files.has(file)) {
      try {
        files.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
      } catch {
        files.set(file, null);
      }
    }
    return files.get(file);
  };

  const flowBlocks = [];
  for (const flow of (facts.flows ?? []).slice(0, FLOWS)) {
    const head = flow.entry?.verb ? `${flow.entry.verb} ${flow.entry.path}` : flow.entry?.kind;
    const blocks = [];
    const seen = new Set();
    const take = (id) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const block = methodBlock(index, read, id, FLOW_LINES);
      if (block) blocks.push(block);
    };
    if (flow.entry?.method) take(flow.entry.method);
    for (const step of flow.steps ?? []) take(index.named(step));
    for (const effect of flow.effects ?? []) take(String(effect.site ?? '').split('|')[0]);
    if (blocks.length) flowBlocks.push([`### ${head} [${flow.score}] ${flow.entry?.cite ?? ''}`, ...blocks].join('\n\n'));
  }

  const setters = [];
  const setterSeen = new Set();
  for (const s of facts.statusSets ?? []) {
    const key = `${s.method}|${s.line}`;
    if (!s.method || !Number.isFinite(s.line) || setterSeen.has(key)) continue;
    setterSeen.add(key);
    const block = methodBlock(index, read, s.method, SETTER_LINES * 2 + 1, s.line);
    if (block) setters.push(block);
  }

  const filters = [];
  const filterSeen = new Set();
  // A user source and a tenant source cite the filter's method as `file:line#name`: the file and the name are the
  // join, and the index answers only when one method fits.
  const cites = [
    ...(facts.securityModel?.userSources ?? []).map((u) => u.cites?.[0]),
    ...(facts.tenantSources ?? []).map((t) => t.evidence?.[0]),
  ];
  for (const cite of cites) {
    const [where, name] = String(cite ?? '').split('#');
    const file = where?.split(':')[0];
    const id = file && name ? index.cited(file, name) : null;
    if (!id || filterSeen.has(id)) continue;
    filterSeen.add(id);
    const block = methodBlock(index, read, id, FILTER_LINES);
    if (block) filters.push(block);
  }

  const section = (title, blocks) => (blocks.length ? [`## ${title}`, '', blocks.join('\n\n')] : []);
  let kept = [...flowBlocks];
  const render = () =>
    [HEAD, ...section('Flows, ranked', kept), ...section('Lifecycle writes', setters), ...section('Filters that read the caller', filters)]
      .join('\n\n') + '\n';
  let text = render();
  while (text.length > budget && kept.length) {
    kept = kept.slice(0, -1);
    text = render();
  }
  return text;
}

/** Writes the excerpt file for one scan. Returns what was written, for the summary line and `timings`. */
export function writeExcerpts(root, facts, model) {
  const text = excerpts(root, facts, model);
  const dir = path.join(root, 'mindmodel', '.work');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'excerpts.md');
  fs.writeFileSync(file, text);
  return { file, bytes: Buffer.byteLength(text) };
}

{
  // Self-checks on a written-out model and source: ranges head every block, the cut keeps both ends, a citation the
  // model cannot place is skipped rather than guessed, and the budget drops flows from the weakest up.
  const model = {
    types: new Map([
      [
        'a.A',
        {
          fqn: 'a.A',
          file: 'src/a/A.java',
          methods: [
            { id: 'a.A#run()', name: 'run', start: 1, end: 45 },
            { id: 'a.A#other()', name: 'other', start: 46, end: 48 },
          ],
        },
      ],
    ]),
  };
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mindmodel-excerpts-'));
  try {
    fs.mkdirSync(path.join(dir, 'src', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'a', 'A.java'),
      ['package a;', 'class A {']
        .concat(Array.from({ length: 40 }, (_, i) => `  // ${i}`))
        .concat(['}', '', '}', ''])
        .join('\n'),
    );
    const best = { entry: { kind: 'endpoint', method: 'a.A#run()', cite: 'src/a/A.java:1#run' }, steps: ['A#missing'], effects: [], score: 9 };
    const weak = { ...best, entry: { ...best.entry, method: 'a.A#other()', cite: 'src/a/A.java:46#other' }, score: 1 };
    const facts = {
      flows: [best, weak],
      statusSets: [{ method: 'a.A#run()', line: 40 }],
      securityModel: { userSources: [{ kind: 'cookie x', cites: ['src/a/A.java:47#other'] }] },
    };
    const text = excerpts(dir, facts, model);
    assert.match(text, /#### src\/a\/A\.java:1-45#run/, 'a flow step is headed by its range');
    assert.match(text, /^ *1\| package a;$/m, 'lines carry their own numbers');
    assert.match(text, /…/, 'a body over the cap is cut in the middle');
    assert.match(text, /#### src\/a\/A\.java:37-43#run/, 'a lifecycle setter is narrowed to ±3 lines of the setter');
    assert.match(text, /#### src\/a\/A\.java:46-48#other/, 'a cited filter method is found by file and name');
    assert.ok(!/A#missing|#missing$/.test(text.split('## ')[1] ?? ''), 'a step the model cannot place is skipped');
    // The budget drops the weaker flow first, and nothing else: the same text as if only the best one had ranked.
    const one = excerpts(dir, { ...facts, flows: [best] }, model);
    assert.equal(excerpts(dir, facts, model, { budget: one.length }), one);
    assert.match(one, /#run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
