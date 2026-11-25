// L5: endpoints. One fact per REST handler, built from the model and the catalogs — never from raw text.
// Spring inline mappings and JAX-RS's @Path-on-the-method are the same shape once the catalog names the means.
// Paths built from constants are evaluated through the model; a part that cannot be resolved becomes `{?}` and the
// fact says so, because a half-printed path is worse than an honest hole.
import assert from 'node:assert';
import { annotationIndex, meanHit, simpleMeans } from '../catalogs/catalog.mjs';
import { evalString, splitTop } from '../core/strings.mjs';
import { normalizePath } from '../core/paths.mjs';
import { weakest } from '../core/rank.mjs';

// The expression an annotation gives for its path: the first named argument the catalog declares, else the first
// positional one. Segments are split at top-level commas so `value = A + "/x", method = GET` keeps its expression.
function pathExpr(entry, args = '') {
  const segs = splitTop(args, ',');
  for (const key of entry.path?.args ?? ['value', 'path']) {
    const seg = segs.find((s) => new RegExp(`^\\s*${key}\\s*=`).test(s));
    if (seg) return seg.replace(new RegExp(`^\\s*${key}\\s*=\\s*`), '');
  }
  // `@PutMapping(params = "!id")` names no path at all: an empty path, never the value of a different argument.
  if (segs.some((s) => /^\s*[\w$]+\s*=/.test(s))) return '';
  return segs[0] ?? '';
}

// The verb an annotation declares, or the one named in `method = RequestMethod.X`.
function verbOf(entry, args = '') {
  if (entry.verb) return entry.verb;
  const m = /RequestMethod\.(\w+)/.exec(args);
  return m ? m[1] : (entry.verbFromArg?.default ?? 'ANY');
}

// A file's imports can name a catalog annotation through a wildcard even when the model could not resolve it.
function fqnFromCatalogs(model, file, name, index) {
  for (const i of model.importsOf.get(file)?.imports ?? [])
    if (i.wildcard && !i.isStatic && index.byFqn.has(`${i.name}.${name}`)) return `${i.name}.${name}`;
  return null;
}

// Match one annotation of one declaration to a catalog entry. `how` is what the fact's confidence rests on, and the
// catalog is kept: a path prefix is a property of the framework that declared it, not of the project.
function match(model, type, ann, on, index) {
  // A FQN the model resolved (single-type import, same package, project type) is `resolved`. A wildcard import
  // completed by a catalog is a simple-name match: `inferred`, exactly as the confidence rules say.
  const fqn = ann.fqn ?? fqnFromCatalogs(model, type.file, ann.name, index);
  const hit = meanHit(index, fqn, on);
  if (hit) return { ...hit, how: ann.fqn ? 'resolved' : 'inferred', fqn };
  const hits = simpleMeans(index, ann.name.split('.').pop(), on);
  if (hits.length === 1) return { ...hits[0], how: 'inferred', fqn };
  return null;
}

// An overload is told apart by arity: the syntax index's own count first, then the parameter list.
const arityOf = (m) => m.arity ?? m.params?.length ?? 0;

// A path part: the evaluated text, or `{?}` when any of it is beyond the model.
function pathPart(model, type, hit, args) {
  const expr = pathExpr(hit.entry, args);
  if (!expr.trim()) return { text: '', unresolved: [] };
  const { text, unresolved } = evalString(expr, (n) => model.resolveConst(type.file, type.fqn, n));
  return { text: unresolved.length ? '{?}' : text, unresolved };
}

// Project supertypes of one type, nearest first: breadth first from the class itself, superclass and interfaces
// alike. Only types this scan declares are walked; a library base class adds nothing the model can read.
function superChain(model, fqn) {
  const out = [],
    seen = new Set([fqn]),
    queue = [fqn];
  while (queue.length) {
    for (const s of model.types.get(queue.shift())?.supers ?? []) {
      if (!s.fqn || seen.has(s.fqn) || !model.types.has(s.fqn)) continue;
      seen.add(s.fqn);
      out.push(s.fqn);
      queue.push(s.fqn);
    }
  }
  return out;
}

// Endpoints of every REST controller in scope. Facts carry their own evidence and the catalog that named the
// meaning, so a reader (or the writer) can see why the engine believes it.
// `include` keeps facts to the app the scan is about: the model still spans every module, but a module the app does
// not component-scan is a different deployable, and its handlers are not this app's API.
export function extractEndpoints(model, selected, { include = () => true } = {}) {
  const index = annotationIndex(selected);

  // The JAX-RS application path, keyed by the catalog that declared it. A Spring controller in the same project
  // never takes it: `/api` from `@ApplicationPath` is not a Spring prefix.
  const appPathBy = new Map();
  for (const t of model.types.values())
    for (const a of t.ann) {
      const hit = match(model, t, a, 'type', index);
      if (hit?.entry.means === 'app-path' && !appPathBy.has(hit.catalog.id))
        appPathBy.set(hit.catalog.id, pathPart(model, t, hit, a.args));
    }

  const facts = [];
  // Type-level annotation meanings, computed once: a chain walk asks the same type several times.
  const hitsOf = (type) => (type.ann ?? []).map((a) => ({ a, hit: match(model, type, a, 'type', index) }));
  const isController = (type) =>
    hitsOf(type).some((x) => x.hit?.entry.means === 'endpoint-base' || x.hit?.entry.means === 'controller');

  for (const t of model.types.values()) {
    if (!include(t.file)) continue;
    // An interface or an abstract class serves nothing by itself: its mappings are inherited by the concrete types.
    if (t.kind === 'interface' || t.abstract) continue;
    const chain = [t, ...superChain(model, t.fqn).map((fqn) => model.types.get(fqn))];
    // Inherit only along a controller: a plain base class may annotate nothing but its own methods.
    const controllerChain = chain.some(isController);
    const baseAt = chain
      .map((type) => ({ type, hit: hitsOf(type).find((x) => x.hit?.entry.means === 'endpoint-base') ?? null }))
      .find((x) => x.hit) ?? null;
    const base = baseAt
      ? { hit: baseAt.hit.hit, ...pathPart(model, baseAt.type, baseAt.hit.hit, baseAt.hit.a.args) }
      : null;
    // The declaration that runs for a mapping: the nearest one with the same signature (name and parameter types),
    // else the nearest with the same name and arity — no-classpath resolution cannot always match a generic override.
    const sigOf = (m) =>
      `${m.name}/${(m.params ?? []).map((p) => String(p.type ?? '').replace(/\s+/g, '')).join(',') || arityOf(m)}`;
    const runningOf = (m) => {
      for (const ct of chain) {
        const hit = (ct.methods ?? []).find((x) => sigOf(x) === sigOf(m));
        if (hit) return { type: ct, m: hit };
      }
      for (const ct of chain) {
        const hit = (ct.methods ?? []).find((x) => x.name === m.name && arityOf(x) === arityOf(m));
        if (hit) return { type: ct, m: hit };
      }
      return null;
    };
    // Per mapping declaration, nearest first. An override without an annotation keeps the inherited mapping; a
    // re-annotated override shadows it, so the pair is listed once, at the override's own path.
    const emitted = new Set();
    for (const type of controllerChain ? chain : [t])
      for (const m of type.methods ?? []) {
        const hits = (m.ann ?? [])
          .map((a) => ({ a, hit: match(model, type, a, 'method', index) }))
          .filter((x) => x.hit?.entry.means === 'endpoint' || x.hit?.entry.means === 'endpoint-path');
        const verbs = hits.filter((x) => x.hit.entry.means === 'endpoint');
        if (!verbs.length) continue;
        const running = runningOf(m);
        if (!running) continue;
        const key = `${running.type.fqn}#${sigOf(running.m)}`;
        if (emitted.has(key)) continue; // a nearer override already serves this mapping
        emitted.add(key);
        const own = hits.find((x) => x.hit.entry.means === 'endpoint-path');
        const ownPart = own ? { hit: own.hit, ...pathPart(model, type, own.hit, own.a.args) } : null;
        const declaredIn = running.type.fqn !== t.fqn ? running.type.fqn : undefined;
        const arity = arityOf(running.m);
        for (const { hit, a } of verbs) {
          const verb = verbOf(hit.entry, a.args);
          const app = appPathBy.get(base?.hit.catalog.id ?? hit.catalog.id) ?? { text: '', unresolved: [] };
          const methodPart = ownPart ?? { hit, ...pathPart(model, type, hit, a.args) };
          const parts = [app, base, methodPart].filter((p) => p && p.text !== '');
          const unresolved = parts.flatMap((p) => p.unresolved);
          const path = normalizePath(parts.map((p) => p.text).join('/'));
          const why = [`@${a.name} (${hit.entry.means}, ${hit.how})`];
          if (base) why.push(`class @${baseAt.hit.a.name}("${base.text}")`);
          if (app.text) why.push(`application path "${app.text}" (${base?.hit.catalog.id ?? hit.catalog.id})`);
          if (declaredIn) why.push(`declared in ${declaredIn}, inherited by ${t.fqn}`);
          if (unresolved.length) why.push(`unresolved constant ${unresolved.join(', ')}`);
          facts.push({
            id: `endpoint:${verb} ${path}@${t.fqn}#${running.m.name}/${arity}`,
            family: 'endpoint',
            confidence: weakest(
              hit.how,
              base?.hit.how ?? 'resolved',
              own?.hit.how ?? 'resolved',
              unresolved.length ? 'unresolved' : 'resolved',
            ),
            evidence: [`${type.file}:${a.line}`, `${running.type.file}:${running.m.nameLine}-${running.m.end}#${running.m.name}`],
            why,
            verb,
            path,
            handler: `${t.name}.${running.m.name}`,
            handlerFqn: t.fqn,
            ...(declaredIn ? { declaredIn } : {}),
            file: type.file,
            line: a.line,
            rest: true,
          });
        }
      }
  }
  return facts.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}
