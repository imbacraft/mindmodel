// L5: endpoints. One fact per REST handler, built from the model and the catalogs — never from raw text.
// Spring inline mappings and JAX-RS's @Path-on-the-method are the same shape once the catalog names the means.
// Paths built from constants are evaluated through the model; a part that cannot be resolved becomes `{?}` and the
// fact says so, because a half-printed path is worse than an honest hole.
import assert from 'node:assert';
import { annotationIndex, loadCatalogs, meanHit, selectCatalogs, simpleMeans } from '../catalogs/catalog.mjs';
import { evalString, splitTop } from '../model/strings.mjs';

// The expression an annotation gives for its path: the first named argument the catalog declares, else the first
// positional one. Segments are split at top-level commas so `value = A + "/x", method = GET` keeps its expression.
export function pathExpr(entry, args = '') {
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
export function verbOf(entry, args = '') {
  if (entry.verb) return entry.verb;
  const m = /RequestMethod\.(\w+)/.exec(args);
  return m ? m[1] : (entry.verbFromArg?.default ?? 'ANY');
}

// Same shape as the scanner's path normalization, so old and new facts are comparable letter for letter. `{?}` is the
// engine's own marker for an unresolved part and survives; every other brace group is a path variable.
export const normPath = (p) => {
  // `{?}` is ours, not a path variable or a query string: park it outside the replacements and put it back.
  const MARK = '\u0000';
  const out = ('/' + String(p).replace(/\{\?\}/g, MARK))
    .replace(/\/+/g, '/')
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/:\w+/g, '{}')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '');
  return (out || '/').replace(new RegExp(MARK, 'g'), '{?}');
};

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

const RANK = { resolved: 0, inferred: 1, unresolved: 2 };
const weakest = (...hows) => hows.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'resolved');
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
export function superChain(model, fqn) {
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
          const path = normPath(parts.map((p) => p.text).join('/'));
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

{
  const catalogs = loadCatalogs();
  const files = [
    {
      p: 'src/demo/C.java',
      ix: {
        pkg: 'demo',
        imports: [
          { name: 'org.springframework.web.bind.annotation.GetMapping', wildcard: false, isStatic: false },
          { name: 'org.springframework.web.bind.annotation.RequestMapping', wildcard: false, isStatic: false },
          { name: 'org.springframework.web.bind.annotation.RestController', wildcard: false, isStatic: false },
        ],
        types: [
          {
            kind: 'class',
            name: 'C',
            owner: undefined,
            start: 1,
            end: 30,
            nameLine: 1,
            ann: [
              { name: 'RestController', args: '', line: 1 },
              { name: 'RequestMapping', args: '"/api"', line: 2 },
            ],
          },
        ],
        methods: [
          { name: 'list', nameLine: 6, start: 6, end: 8, arity: 0, ann: [{ name: 'GetMapping', args: '"/x"', line: 5 }] },
          { name: 'list', nameLine: 9, start: 9, end: 9, arity: 1, ann: [{ name: 'GetMapping', args: '"/x"', line: 8 }] },
          {
            name: 'create',
            nameLine: 12,
            start: 12,
            end: 14,
            ann: [{ name: 'RequestMapping', args: 'value = "/y", method = RequestMethod.POST', line: 11 }],
          },
          {
            name: 'built',
            nameLine: 20,
            start: 20,
            end: 22,
            ann: [{ name: 'GetMapping', args: 'Ids.BASE + "/" + Ids.ID', line: 19 }],
          },
          {
            name: 'unknown',
            nameLine: 26,
            start: 26,
            end: 28,
            ann: [{ name: 'GetMapping', args: 'Elsewhere.PATH', line: 25 }],
          },
        ],
        fields: [],
        constants: [],
      },
    },
    {
      p: 'src/demo/Ids.java',
      ix: {
        pkg: 'demo',
        imports: [],
        types: [{ kind: 'class', name: 'Ids', start: 1, end: 8, nameLine: 1, ann: [] }],
        methods: [],
        fields: [],
        constants: [
          { name: 'BASE', value: '"/x1"', line: 3 },
          { name: 'ID', value: '"{id}"', line: 4 },
        ],
      },
    },
    {
      p: 'src/ee/App.java',
      ix: {
        pkg: 'ee',
        imports: [
          { name: 'jakarta.ws.rs.ApplicationPath', wildcard: false, isStatic: false },
          { name: 'jakarta.ws.rs.core.Application', wildcard: false, isStatic: false },
        ],
        types: [
          {
            kind: 'class',
            name: 'App',
            owner: undefined,
            start: 1,
            end: 5,
            nameLine: 1,
            extends: 'Application',
            ann: [{ name: 'ApplicationPath', args: '"/root"', line: 1 }],
          },
        ],
        methods: [],
        fields: [],
        constants: [],
      },
    },
    {
      p: 'src/ee/R.java',
      ix: {
        pkg: 'ee',
        imports: [{ name: 'jakarta.ws.rs', wildcard: true, isStatic: false }],
        types: [
          {
            kind: 'class',
            name: 'R',
            owner: undefined,
            start: 1,
            end: 20,
            nameLine: 1,
            ann: [{ name: 'Path', args: '"/rest"', line: 1 }],
          },
        ],
        methods: [
          {
            name: 'get',
            nameLine: 6,
            start: 6,
            end: 8,
            ann: [
              { name: 'GET', args: '', line: 5 },
              { name: 'Path', args: '"/a"', line: 5 },
            ],
          },
          { name: 'post', nameLine: 12, start: 12, end: 14, ann: [{ name: 'POST', args: '', line: 11 }] },
        ],
        fields: [],
        constants: [],
      },
    },
    {
      // Another deployable: the same project, not this app's scope. Its handlers must not become facts.
      p: 'src/gw/Gw.java',
      ix: {
        pkg: 'gw',
        imports: [{ name: 'org.springframework.web.bind.annotation.GetMapping', wildcard: false, isStatic: false }],
        types: [{ kind: 'class', name: 'Gw', start: 1, end: 10, nameLine: 1, ann: [] }],
        methods: [{ name: 'ping', nameLine: 4, start: 4, end: 6, ann: [{ name: 'GetMapping', args: '"/ping"', line: 3 }] }],
        fields: [],
        constants: [],
      },
    },
    {
      // Inherited endpoints: an abstract base controller's mapping is served by each concrete subclass.
      p: 'src/demo/Base.java',
      ix: {
        pkg: 'demo',
        imports: [
          { name: 'org.springframework.web.bind.annotation.GetMapping', wildcard: false, isStatic: false },
          { name: 'org.springframework.web.bind.annotation.RequestMapping', wildcard: false, isStatic: false },
        ],
        types: [
          {
            kind: 'class',
            name: 'Base',
            start: 1,
            end: 16,
            nameLine: 1,
            abstract: true,
            ann: [{ name: 'RequestMapping', args: '"/inherited"', line: 1 }],
          },
        ],
        methods: [
          { name: 'list', nameLine: 5, start: 5, end: 7, params: [], ann: [{ name: 'GetMapping', args: '"/list"', line: 4 }] },
          { name: 'save', nameLine: 9, start: 9, end: 11, params: [], ann: [{ name: 'GetMapping', args: '"/save"', line: 8 }] },
          { name: 'remove', nameLine: 13, start: 13, end: 15, params: [], ann: [{ name: 'GetMapping', args: '"/remove"', line: 12 }] },
        ],
        fields: [],
        constants: [],
      },
    },
    {
      p: 'src/demo/Sub.java',
      ix: {
        pkg: 'demo',
        imports: [{ name: 'org.springframework.web.bind.annotation.GetMapping', wildcard: false, isStatic: false }],
        types: [{ kind: 'class', name: 'Sub', start: 1, end: 8, nameLine: 1, extends: 'Base', ann: [] }],
        methods: [
          // An override without an annotation keeps the inherited mapping.
          { name: 'list', nameLine: 4, start: 4, end: 6, params: [], ann: [] },
          // A re-annotated inherited method is listed once, at its own path.
          { name: 'save', nameLine: 7, start: 7, end: 7, params: [], ann: [{ name: 'GetMapping', args: '"/save2"', line: 6 }] },
        ],
        fields: [],
        constants: [],
      },
    },
  ];

  const { buildModel } = await import('../../test/fixtures/model-from-source.mjs');
  const { selectCatalogs } = await import('../catalogs/catalog.mjs');
  const model = buildModel(files);
  const selected = selectCatalogs(catalogs, {
    imports: [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name)),
  });
  const facts = extractEndpoints(model, selected, { include: (p) => !p.includes('src/gw/') });
  assert.deepStrictEqual(
    facts.map((f) => [f.verb, f.path, f.handler, f.confidence]),
    [
      // Facts sort by the file and line of the mapping that declares them; the base class comes first.
      ['GET', '/inherited/list', 'Sub.list', 'resolved'], // an override without an annotation keeps the mapping
      ['GET', '/inherited/remove', 'Sub.remove', 'resolved'], // an inherited method, served by the concrete class
      ['GET', '/api/x', 'C.list', 'resolved'],
      ['GET', '/api/x', 'C.list', 'resolved'], // an overload: same path and name, a different fact
      ['POST', '/api/y', 'C.create', 'resolved'],
      ['GET', '/api/x1/{}', 'C.built', 'resolved'], // constants resolved through the model
      ['GET', '/api/{?}', 'C.unknown', 'unresolved'], // never a half-printed path, never an unbalanced brace
      ['GET', '/inherited/save2', 'Sub.save', 'resolved'], // a re-annotated override, listed once
      ['GET', '/root/rest/a', 'R.get', 'inferred'], // JAX-RS app path applies to the JAX-RS resource
      ['POST', '/root/rest', 'R.post', 'inferred'],
    ],
  );
  // The base class holds the running method for `remove`, so the fact names it; an override runs in the controller.
  const inherited = facts.find((f) => f.handler === 'Sub.remove');
  assert.equal(inherited.declaredIn, 'demo.Base');
  assert.deepStrictEqual(inherited.evidence, ['src/demo/Base.java:12', 'src/demo/Base.java:13-15#remove']);
  assert.equal(facts.find((f) => f.handler === 'Sub.list').declaredIn, undefined);
  assert.equal(facts.filter((f) => f.handler === 'Sub.save').length, 1);
  assert.ok(!facts.some((f) => f.handlerFqn === 'demo.Base'), 'an abstract class contributes no endpoint of its own');
  assert.ok(!facts.some((f) => f.file.includes('src/gw/')), 'excluded deployables contribute no facts');
  assert.ok(!facts.some((f) => f.file.startsWith('src/demo/') && f.path.startsWith('/root')), 'Spring never takes the JAX-RS prefix');
  assert.match(facts.find((f) => f.handler === 'C.unknown').why.join(';'), /unresolved constant Elsewhere.PATH/);
  assert.equal(new Set(facts.map((f) => f.id)).size, facts.length);
  const own = facts.find((f) => f.handler === 'C.list' && f.path === '/api/x');
  assert.match(own.id, /^endpoint:GET \/api\/x@demo\.C#list\/0$/);
  assert.deepStrictEqual(own.evidence, ['src/demo/C.java:5', 'src/demo/C.java:6-8#list']);
}
