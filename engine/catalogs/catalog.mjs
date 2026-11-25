// L4: framework meaning as data. Catalogs are JSON, validated on load, selected by the build (or imports until the
// build reader exists), and matched by resolved annotation FQN. Extractors branch on `means`, never on the framework.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { checkSchema } from '../core/schema.mjs';
import { simple } from '../core/names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '../../schema/catalog.schema.json'), 'utf8'));

function validateCatalog(cat) {
  const errors = [];
  checkSchema(cat, SCHEMA, SCHEMA.$defs ?? {}, '$', (m) => errors.push(m));
  return errors;
}

function loadCatalog(file) {
  const cat = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateCatalog(cat);
  if (errors.length) throw new Error(`${path.basename(file)}: ${errors.slice(0, 3).join('; ')}`);
  return cat;
}

export function loadCatalogs(dir = HERE) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => loadCatalog(path.join(dir, f)));
}

// An entry may name one FQN or the Spring/Jakarta spellings of the same idea.
const fqnsOf = (entry) => entry.fqns ?? (entry.fqn ? [entry.fqn] : []);

// A catalog applies when the build declares one of its deps, when a source import matches one of its prefixes, or —
// for a catalog with no `when` rule at all — always (the `ignore` catalog: annotations known to carry no fact, whose
// absence of meaning is not a blind spot). `why` is what a fact's trace quotes.
export function selectCatalogs(catalogs, { deps = [], imports = [] } = {}) {
  const selected = [];
  for (const catalog of catalogs) {
    const when = catalog.when ?? {};
    if (!(when.deps ?? []).length && !(when.imports ?? []).length) {
      selected.push({ catalog, why: 'selected always' });
      continue;
    }
    const byDep = (when.deps ?? []).find((d) => deps.includes(d));
    // Prefixes are written with a trailing dot ("jakarta.ws.rs."), imports are full names ("jakarta.ws.rs.GET").
    const byImport = (when.imports ?? [])
      .map((p) => p.replace(/\.$/, ''))
      .find((p) => imports.some((i) => i === p || i.startsWith(p + '.')));
    if (byDep) selected.push({ catalog, why: `selected by dep ${byDep}` });
    else if (byImport) selected.push({ catalog, why: `selected by import ${byImport}` });
  }
  return selected;
}

// Select once per scan: the build says which frameworks are installed, the imports confirm what the code uses.
function selectForModel(model, catalogs, { deps = [] } = {}) {
  const imports = [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  return selectCatalogs(catalogs, { deps, imports });
}

/** Every FQN the selected catalogs name (annotations and explained types): what a framework package contains. */
export function annotationFqns(selected) {
  const out = new Set();
  for (const { catalog } of selected)
    for (const group of [catalog.annotations ?? [], catalog.types ?? []])
      for (const entry of group) for (const fqn of fqnsOf(entry)) out.add(fqn);
  return out;
}

// fqn -> [{ entry, catalog }] across the selected catalogs. One FQN can carry several meanings by placement:
// @RequestMapping on a type is a base path, on a method it is an endpoint.
export function annotationIndex(selected) {
  const byFqn = new Map(),
    bySimple = new Map();
  for (const { catalog } of selected)
    for (const entry of catalog.annotations ?? [])
      for (const fqn of fqnsOf(entry)) {
        if (!byFqn.has(fqn)) byFqn.set(fqn, []);
        byFqn.get(fqn).push({ entry, catalog });
        const short = simple(fqn);
        if (!bySimple.has(short)) bySimple.set(short, []);
        bySimple.get(short).push({ entry, catalog, fqn });
      }
  return { byFqn, bySimple };
}

// The matching entry and its catalog: a fact's meaning and the framework that supplied it.
export const meanHit = (index, fqn, on) => {
  if (!fqn) return null;
  const hits = index.byFqn.get(fqn) ?? [];
  return hits.find((h) => !h.entry.on || h.entry.on.includes(on)) ?? hits[0] ?? null;
};

// The catalog meaning of a resolved annotation FQN at a placement (type, method, field, parameter), or null.
// Entries without `on` apply anywhere.
export const meanOf = (index, fqn, on) => meanHit(index, fqn, on)?.entry ?? null;

// Types (supertypes, mostly) a catalog explains. Coverage uses it to name the base classes nobody understands.
export function typeIndex(selected) {
  const byFqn = new Map();
  for (const { catalog } of selected)
    for (const entry of catalog.types ?? [])
      for (const fqn of fqnsOf(entry)) if (!byFqn.has(fqn)) byFqn.set(fqn, { entry, catalog });
  return byFqn;
}

// Simple-name matches, used only when the FQN could not be resolved (that fact is then `inferred`).
export const simpleMeans = (index, name, on) =>
  (index.bySimple.get(name) ?? []).filter((h) => !h.entry.on || h.entry.on.includes(on));

{
  const catalogs = loadCatalogs();
  assert.ok(catalogs.length >= 2, 'the shipped catalogs load');
  const index = annotationIndex(selectCatalogs(catalogs, { imports: ['org.springframework.web.bind.annotation.GetMapping'] }));
  const get = 'org.springframework.web.bind.annotation.GetMapping';
  assert.equal(meanOf(index, get, 'method')?.means, 'endpoint');
  assert.equal(meanOf(index, get, 'method')?.verb, 'GET');
  assert.equal(meanOf(index, get, 'method')?.path.args[0], 'value');
  const req = 'org.springframework.web.bind.annotation.RequestMapping';
  assert.equal(meanOf(index, req, 'method')?.means, 'endpoint');
  assert.equal(meanOf(index, req, 'type')?.means, 'endpoint-base');

  const jaxrs = annotationIndex(selectCatalogs(catalogs, { imports: ['jakarta.ws.rs.GET', 'javax.ws.rs.Path'] }));
  assert.equal(meanOf(jaxrs, 'jakarta.ws.rs.GET', 'method')?.verb, 'GET');
  assert.equal(meanOf(jaxrs, 'javax.ws.rs.Path', 'type')?.means, 'endpoint-base');
  assert.equal(meanOf(jaxrs, 'javax.ws.rs.Path', 'method')?.means, 'endpoint-path');

  // A catalog that no import selects contributes nothing; the always-on catalogs are the only ones selected.
  const none = selectCatalogs(catalogs, { imports: ['com.example.internal'] });
  assert.deepStrictEqual(none.map((s) => s.catalog.id), ['ignore', 'jdk'], 'only the always-on catalogs apply');
  assert.ok(none.every((s) => s.why === 'selected always'));

  // Base classes a catalog explains are not blind spots; the index answers by resolved FQN.
  const types = typeIndex(selectCatalogs(catalogs, { deps: ['org.springframework.boot:spring-boot-starter-data-jpa'] }));
  assert.equal(types.get('org.springframework.data.repository.CrudRepository')?.entry.means, 'repository');
}
