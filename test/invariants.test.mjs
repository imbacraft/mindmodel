// Corpus invariants: properties the facts must have on any real app, checked against the source itself, with no
// snapshots involved. These catch a fact that is wrong rather than merely changed.
// Run: node --test test/invariants.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../engine/scan.mjs';
import { index } from '../engine/java.mjs';
import { parseCite } from '../engine/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'apps.json'), 'utf8'));
const root = (process.env.MINDMODEL_TEST_APPS ?? cfg.root).replace(/^~/, os.homedir());
const SKIP = new Set(['node_modules', 'target', 'build', '.git', 'mindmodel', 'mindmodel-system']);

function javaFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) javaFiles(p, out);
    } else if (p.endsWith('.java') && !/[\\/]test[\\/]/.test(p)) out.push(p);
  }
  return out;
}

// Every array of citations in a map, wherever it sits.
function citesOf(map) {
  const out = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'cites' && Array.isArray(v)) v.forEach((c) => typeof c === 'string' && out.push(c));
      walk(v);
    }
  })(map);
  return out;
}

const show = (bad, what, name) => assert.deepStrictEqual(bad.slice(0, 10), [], `${name}: ${bad.length} ${what}`);

for (const app of cfg.apps.filter((a) => fs.existsSync(path.join(root, a.name)))) {
  test(`invariants ${app.name}`, (t) => {
    const dir = path.join(root, app.name);
    const facts = scan(dir);
    const cache = new Map();
    const at = (rel) => {
      if (!cache.has(rel)) {
        const text = fs.readFileSync(path.join(dir, rel), 'utf8');
        cache.set(rel, { text, ix: index(text) });
      }
      return cache.get(rel);
    };

    // 1. Every endpoint names a handler that is a real method in that file, and the mapping line sits inside it.
    const badEndpoints = [];
    for (const e of facts.endpoints) {
      const entry = `${e.verb} ${e.path} ${e.file}:${e.line}`;
      const name = e.handler?.split('.').pop();
      if (!e.handler || !name) {
        badEndpoints.push(`${entry}: no handler method`);
        continue;
      }
      if (!fs.existsSync(path.join(dir, e.file))) {
        badEndpoints.push(`${entry}: file missing`);
        continue;
      }
      const { ix } = at(e.file);
      if (!ix.methods.some((m) => m.name === name && m.start <= e.line && e.line <= m.end))
        badEndpoints.push(`${entry}: handler ${e.handler} does not contain the mapping line`);
    }
    show(badEndpoints, 'endpoint(s) without a valid handler method', app.name);

    // 2. Every entity field is cited on a line inside the entity's own type range.
    const badFields = [];
    for (const ent of facts.entities.funnel) {
      const { ix } = at(ent.file);
      const type = ix.types.find((x) => x.name === ent.name);
      if (!type) {
        badFields.push(`${ent.name}: no type in ${ent.file}`);
        continue;
      }
      for (const f of [...ent.keyFields, ...ent.relations]) {
        const line = Number(f.split(':').pop());
        if (!(type.start <= line && line <= type.end))
          badFields.push(`${ent.name}.${f.split(':')[0]}: line ${line} outside ${type.start}-${type.end}`);
      }
    }
    show(badFields, 'entity field(s) outside their type', app.name);

    // 3. The index itself: ranges are ordered, bodies are braces, every field has an owner.
    const badIndex = [];
    let methods = 0,
      fields = 0,
      degraded = 0;
    for (const p of javaFiles(dir)) {
      const rel = path.relative(dir, p).split(path.sep).join('/');
      // Indexed and dropped one at a time: keeping every index of a 27 MB corpus would double the test's memory.
      const text = fs.readFileSync(p, 'utf8');
      const ix = index(text);
      if (ix.degraded) degraded++;
      methods += ix.methods.length;
      fields += (ix.fields ?? []).length;
      for (const m of ix.methods) {
        const nameLine = m.nameLine ?? m.start;
        if (!(m.start <= nameLine && nameLine <= m.end))
          badIndex.push(`${rel}#${m.name}: start ${m.start}, name ${nameLine}, end ${m.end}`);
        if (!(m.open < m.close)) badIndex.push(`${rel}#${m.name}: open ${m.open} >= close ${m.close}`);
        else if (text[m.open] !== '{' || text[m.close] !== '}')
          badIndex.push(`${rel}#${m.name}: body offsets are not braces`);
      }
      for (const x of ix.types) {
        const nameLine = x.nameLine ?? x.start;
        if (!(x.start <= nameLine && nameLine <= x.end)) badIndex.push(`${rel}#${x.name}: type range`);
      }
      for (const f of ix.fields ?? [])
        if (!ix.types.some((x) => x.name === f.owner)) badIndex.push(`${rel}.${f.name}: owner ${f.owner} is no type`);
    }
    t.diagnostic(`${app.name}: ${methods} methods, ${fields} fields, ${degraded} parsed with errors`);
    assert.equal(degraded, 0, `${app.name}: ${degraded} file(s) did not parse`);
    show(badIndex, 'index violation(s)', app.name);

    // 4. Every citation in a map points inside its own file.
    if (app.map) {
      const map = JSON.parse(fs.readFileSync(path.join(dir, app.map), 'utf8'));
      const cites = citesOf(map);
      const badCites = [];
      for (const c of cites) {
        const pc = parseCite(c);
        if (!pc) {
          badCites.push(`unparsable citation ${c}`);
          continue;
        }
        const abs = path.join(dir, pc.file);
        if (!fs.existsSync(abs)) {
          badCites.push(`missing file ${c}`);
          continue;
        }
        if (fs.statSync(abs).isDirectory()) continue; // a directory has no lines to be outside of
        const n = fs.readFileSync(abs, 'utf8').split('\n').length,
          start = pc.start ?? 1,
          end = pc.end ?? start;
        if (start < 1 || end < start || end > n) badCites.push(`${c}: lines ${start}-${end} outside 1-${n}`);
      }
      show(badCites, `citation(s) outside their file (${cites.length} checked)`, app.name);
    }
  });
}
