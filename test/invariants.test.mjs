// Corpus invariants: properties the facts must have on any real app, checked against the dump the scan read, with no
// snapshots involved. These catch a fact that is wrong rather than merely changed.
// Run: node --test test/invariants.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedScan } from '../test-support/scan-cache.mjs';
import { open } from '../engine/dump.mjs';
import { parseCite } from '../engine/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'apps.json'), 'utf8'));
const root = (process.env.MINDMODEL_TEST_APPS ?? cfg.root).replace(/^~/, os.homedir());

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
    const facts = cachedScan(app.name, dir);
    // The dump the scan itself read: a fact is checked against the answer it was built from, never against source text.
    const dumpDir = path.join(dir, 'mindmodel/.work/dump');
    if (!fs.existsSync(path.join(dumpDir, 'meta.json'))) return t.skip('no dump: run the scan first');
    const db = open(dumpDir);

    // 1. Every endpoint names a handler that is a real method in that file, and the mapping line sits inside it.
    const badEndpoints = [];
    for (const e of facts.endpoints) {
      const entry = `${e.verb} ${e.path} ${e.file}:${e.line}`;
      const name = e.handler?.split('.').pop();
      if (!e.handler || !name) {
        badEndpoints.push(`${entry}: no handler method`);
        continue;
      }
      const methods = db.membersOf(e.handlerFqn ?? '') .filter((m) => m.kind === 'method');
      const own = [...db.members.values()].filter(
        (m) => m.kind === 'method' && m.name === name && m.pos?.file === e.file,
      );
      // A member's range starts at its first annotation: the mapping line sits above the declaration.
      const startOf = (m) => Math.min(m.pos?.line ?? 1, ...(m.ann ?? []).map((a) => a.line || m.pos?.line || 1));
      const holder = [...methods, ...own].find(
        (m) => m.pos && startOf(m) <= e.line && e.line <= (m.pos.endLine ?? m.pos.line),
      );
      if (!holder) badEndpoints.push(`${entry}: handler ${e.handler} does not contain the mapping line`);
    }
    show(badEndpoints, 'endpoint(s) without a valid handler method', app.name);

    // 1.ids. Two facts may share a path and a handler name (an overload), never an id.
    const ids = facts.endpoints.map((e) => e.id);
    show([...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))], 'duplicate endpoint id(s)', app.name);

    // 1a. A path is either whole or marked `{?}`: braces balance, so no `/api/v1/jobs/{` reaches a writer.
    const badPaths = facts.endpoints
      .filter((e) => (e.path.match(/\{/g) ?? []).length !== (e.path.match(/\}/g) ?? []).length)
      .map((e) => `${e.verb} ${e.path} ${e.handler}`);
    show(badPaths, 'endpoint path(s) with unbalanced braces', app.name);

    // 1b. Facts belong to the deployable: no endpoint may sit in a module the app excludes from its component scan.
    // (hertzbeat-ai-gateway is such a module in hertzbeat; the scan reports it as excluded.)
    if (app.name === 'hertzbeat') {
      const outOfScope = facts.endpoints.filter((e) => e.file.includes('hertzbeat-ai-gateway')).map((e) => e.file);
      show(outOfScope, 'endpoint(s) in an excluded module', app.name);
    }

    // 2. Every entity field is cited on a line inside the entity's own type range, as the dump writes both.
    const badFields = [];
    for (const ent of facts.entities.model) {
      const type = [...db.types.values()].find((x) => x.pos?.file === ent.file && x.fqn.split('.').pop() === ent.name);
      if (!type) {
        badFields.push(`${ent.name}: no type in ${ent.file}`);
        continue;
      }
      const end = type.pos.endLine ?? type.pos.line;
      const fields = db
        .membersOf(type.fqn)
        .filter((m) => m.kind === 'field')
        .map((m) => `${m.name}:${m.pos?.line}`);
      for (const f of [...(ent.ownKeys ?? ent.keys ?? []), ...(ent.ownRelations ?? ent.relations ?? [])]) {
        const line = Number(f.split(':').pop());
        if (!(type.pos.line <= line && line <= end))
          badFields.push(`${ent.name}.${f.split(':')[0]}: line ${line} outside ${type.pos.line}-${end}`);
      }
      // A cited line that names no field of the type is a stale citation.
      const cited = (ent.ownKeys ?? []).map((f) => f.split(':')[0]);
      for (const name of cited)
        if (!fields.some((f) => f.startsWith(`${name}:`))) badFields.push(`${ent.name}.${name}: no field row in the dump`);
    }
    show(badFields, 'entity field(s) outside their type', app.name);

    // 3. The index self-consistency check that lived here read the deleted tree-sitter index (`start <= nameLine <=
    // end`, body offsets being braces). It asserted a parser that no longer exists; the dump's own positions are
    // covered by test/dump.test.mjs and by the facts schema check in snapshots.test.mjs.

    // 4. Every citation in a map points inside its own file.
    // A scan retires an existing map to .work/previous-mindmodel.json, so a checkout with no fresh map has none to
    // check here: the citation invariants are about a map, not about the scan.
    if (app.map && fs.existsSync(path.join(dir, app.map))) {
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
