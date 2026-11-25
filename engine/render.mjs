#!/usr/bin/env node
// Renders mindmodel.json into a single offline index.html using the fixed template. Refuses to render an invalid map.
// Usage: node render.mjs <mindmodel.json> [projectRoot] [--web <base URL> --out <file>]
// --web publishes a shareable page: citations link to the code on the web (e.g. a GitHub blob URL at a commit)
// and no local path is embedded.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFacts, validate } from './validate.mjs';
import { inlineBase } from './base.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// What the page was built from, and how much of the project the engine understood. Kept short: the page states its
// own evidence, and the long form lives in facts.json.
function provenanceOf(facts) {
  if (!facts) return null;
  return {
    scannedAt: facts.scannedAt ?? null,
    commit: facts.git?.head ?? null,
    endpoints: Array.isArray(facts.endpoints) ? facts.endpoints.length : null,
    entities: facts.entities?.count ?? null,
    scheduled: Array.isArray(facts.background?.scheduledAsyncListeners)
      ? facts.background.scheduledAsyncListeners.length
      : null,
  };
}

// Facts describe one commit. A page must never mix a map written from one commit with facts from another: the
// derived sections would cite code the map never saw. A short commit on either side matches its longer form.
function factsForMap(map, facts) {
  if (!facts) return null;
  const head = facts.git?.head,
    commit = map.project?.commit;
  if (!head || !commit) return facts;
  return head.startsWith(commit) || commit.startsWith(head) ? facts : null;
}

// Sections the page renders straight from facts instead of asking the writer to transcribe them. Each row is a fact
// plus its citation; the map supplies only the paragraph that says what they mean.
function derivedOf(facts) {
  if (!facts) return null;
  const jobs = (facts.background?.scheduledAsyncListeners ?? []).map((x) => ({
    name: x.method ? `${x.cls}.${x.method}` : x.cls || x.file,
    kind: x.kind,
    args: x.args ?? '',
    cite: `${x.file}:${x.line}`,
  }));
  const sockets = (facts.background?.sockets ?? []).map((x) => ({
    name: 'socket handler',
    kind: 'STOMP',
    args: x.path ?? '',
    cite: `${x.file}:${x.line}`,
  }));
  const rows = [...jobs, ...sockets];
  return {
    provenance: provenanceOf(facts),
    background: { total: rows.length, rows: rows.slice(0, 40), more: Math.max(0, rows.length - 40) },
  };
}

// The page for a map that has already passed validate(). `web` replaces the local root in citation links; `facts`
// adds the provenance footer (the page says what it was built from).
export function renderPage(map, root, web = null, facts = null) {
  const template = inlineBase(fs.readFileSync(path.join(here, '../template/template.html'), 'utf8'));
  // '<' is escaped so map text can never close the <script> tag it lives in.
  const data = JSON.stringify(map).replace(/</g, '\\u003c');
  const derived = JSON.stringify(derivedOf(factsForMap(map, facts))).replace(/</g, '\\u003c');
  return template
    .replace('/*__MINDMODEL_DATA__*/', () => data)
    .replace('/*__MINDMODEL_DERIVED__*/', () => derived)
    .replace('__MINDMODEL_ROOT__', () => (web ?? root).replace(/\\/g, '/').replace(/"/g, '\\"'));
}

// Self-check: the provenance block is derived from facts, and a page without facts still renders.
{
  const html = renderPage({ project: { commit: 'abc1234' } }, '/tmp/project', null, {
    scannedAt: '2026-01-01',
    git: { head: 'abc1234' },
    endpoints: [1, 2],
    entities: { count: 3 },
    background: { scheduledAsyncListeners: [{ kind: 'Scheduled', args: '(fixedRate = 1)', file: 'a/B.java', line: 1, cls: 'B', method: 'tick' }] },

  });
  const block = (h) => /<script id="mindmodel-derived"[^>]*>([\s\S]*?)<\/script>/.exec(h)[1];
  const derived = JSON.parse(block(html));
  assert.deepStrictEqual(derived.provenance, {
    scannedAt: '2026-01-01',
    commit: 'abc1234',
    endpoints: 2,
    entities: 3,
    scheduled: 1,
  });
  // Same commit, short form on the map: facts are used. Different commit: the page renders without them.
  assert.ok(factsForMap({ project: { commit: 'abc1234' } }, { git: { head: 'abc1234' } }));
  assert.ok(factsForMap({ project: { commit: 'abc12' } }, { git: { head: 'abc1234' } }));
  assert.equal(factsForMap({ project: { commit: 'abc1234' } }, { git: { head: 'def5678' } }), null);
  assert.equal(block(renderPage({ project: { commit: 'abc' } }, '/tmp/p', null, { git: { head: 'zzz' } })), 'null');
  assert.deepStrictEqual(derived.background, {
    total: 1,
    rows: [{ name: 'B.tick', kind: 'Scheduled', args: '(fixedRate = 1)', cite: 'a/B.java:1' }],
    more: 0,
  });
  const withJob = derivedOf({
    background: { scheduledAsyncListeners: [{ kind: 'Scheduled', args: '(fixedRate = 60000)', file: 'a/B.java', line: 7, cls: 'B', method: 'tick' }] },
  });
  assert.deepStrictEqual(withJob.background.rows, [
    { name: 'B.tick', kind: 'Scheduled', args: '(fixedRate = 60000)', cite: 'a/B.java:7' },
  ]);
  assert.equal(block(renderPage({ project: { commit: 'abc' } }, '/tmp/p')), 'null');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args.splice(i, 2)[1] : null;
  };
  const web = opt('--web'),
    outArg = opt('--out');
  const file = path.resolve(args[0] ?? 'mindmodel/mindmodel.json');
  const root = path.resolve(args[1] ?? path.join(path.dirname(file), '..'));
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));

  // The facts are read once, here, and handed to validate() and to the page alike.
  const factsFile = path.join(path.dirname(file), '.work/facts.json');
  const read = readFacts(factsFile);
  const facts = read.facts;
  const { errors, warnings } = validate(map, root, undefined, facts);
  if (read.warning) console.log(`warn  ${read.warning}`);
  warnings.forEach((w) => console.log(`warn  ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.log(`ERROR ${e}`));
    process.exit(1);
  }

  if (!facts) console.log(`note  no ${path.relative(root, factsFile)}; the page omits its provenance line`);
  else if (!factsForMap(map, facts))
    console.log(
      `warn  facts are from ${facts.git?.head ?? 'an unknown commit'}, the map from ${map.project?.commit ?? 'an unknown commit'}: ` +
        'the page omits the fact-derived sections',
    );
  const html = renderPage(map, root, web, facts);
  const out = outArg ? path.resolve(outArg) : path.join(path.dirname(file), 'index.html');
  fs.writeFileSync(out, html);
  console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
}
