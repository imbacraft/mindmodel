// L4: framework meaning as data. Catalogs are JSON, validated on load, selected by the build (or imports until the
// build reader exists), and matched by resolved annotation FQN. Extractors branch on `means`, never on the framework.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { checkSchema } from '../validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '../../schema/catalog.schema.json'), 'utf8'));

export function validateCatalog(cat) {
  const errors = [];
  checkSchema(cat, SCHEMA, SCHEMA.$defs ?? {}, '$', (m) => errors.push(m));
  return errors;
}

export function loadCatalog(file) {
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
export const fqnsOf = (entry) => entry.fqns ?? (entry.fqn ? [entry.fqn] : []);

// Members a framework writes without a declaration, as catalog data: @Slf4j's `log` field and @Data's accessors. The
// resolver reads this instead of carrying a list of Lombok annotation names of its own.
export function generatedRules(selected) {
  const rules = { loggers: [], getters: new Set(), setters: new Set() };
  for (const { catalog: cat } of selected) {
    const g = cat?.generates;
    if (!g) continue;
    for (const l of g.loggers ?? []) rules.loggers.push(l);
    for (const a of g.getters ?? []) rules.getters.add(a);
    for (const a of g.setters ?? []) rules.setters.add(a);
  }
  return rules;
}

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
export function selectForModel(model, catalogs, { deps = [] } = {}) {
  const imports = [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name));
  return selectCatalogs(catalogs, { deps, imports });
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
        const simple = fqn.split('.').pop();
        if (!bySimple.has(simple)) bySimple.set(simple, []);
        bySimple.get(simple).push({ entry, catalog, fqn });
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

// JDK signatures: return types (and their type variables) for the APIs a call chain goes through. One entry per type;
// a later catalog never overrides the JDK's own knowledge.
export function signatureIndex(selected) {
  const byType = new Map();
  for (const { catalog } of selected)
    for (const sig of catalog.signatures ?? []) if (!byType.has(sig.type)) byType.set(sig.type, sig);
  return byType;
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

  // The JDK signature catalog is data: a chain through List.get knows what it returns.
  const sigs = signatureIndex(none);
  assert.equal(sigs.get('java.util.List')?.methods.get, 'E');
  assert.deepStrictEqual(sigs.get('java.util.stream.Stream')?.byArg.collect[0].returns, 'java.util.List<E>');

  // Base classes a catalog explains are not blind spots; the index answers by resolved FQN.
  const types = typeIndex(selectCatalogs(catalogs, { deps: ['org.springframework.boot:spring-boot-starter-data-jpa'] }));
  assert.equal(types.get('org.springframework.data.repository.CrudRepository')?.entry.means, 'repository');
}
