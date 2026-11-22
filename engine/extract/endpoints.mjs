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

// A path part: the evaluated text, or `{?}` when any of it is beyond the model.
function pathPart(model, type, hit, args) {
  const expr = pathExpr(hit.entry, args);
  if (!expr.trim()) return { text: '', unresolved: [] };
  const { text, unresolved } = evalString(expr, (n) => model.resolveConst(type.file, type.fqn, n));
  return { text: unresolved.length ? '{?}' : text, unresolved };
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
  for (const t of model.types.values()) {
    if (!include(t.file)) continue;
    const bases = [];
    for (const a of t.ann) {
      const hit = match(model, t, a, 'type', index);
      if (hit?.entry.means === 'endpoint-base')
        bases.push({ hit, a, ...pathPart(model, t, hit, a.args) });
    }
    const base = bases[0];
    for (const m of t.methods) {
      const matched = [];
      for (const a of m.ann ?? []) {
        const hit = match(model, t, a, 'method', index);
        if (hit?.entry.means === 'endpoint') matched.push({ hit, a });
      }
      if (!matched.length) continue;
      const own = m.ann
        .map((a) => ({ a, hit: match(model, t, a, 'method', index) }))
        .find((x) => x.hit?.entry.means === 'endpoint-path');
      const ownPart = own ? { hit: own.hit, ...pathPart(model, t, own.hit, own.a.args) } : null;
      for (const { hit, a } of matched) {
        const verb = verbOf(hit.entry, a.args);
        const app = appPathBy.get(base?.hit.catalog.id ?? hit.catalog.id) ?? { text: '', unresolved: [] };
        const methodPart = ownPart ?? { hit, ...pathPart(model, t, hit, a.args) };
        const parts = [app, base, methodPart].filter((p) => p && p.text !== '');
        const unresolved = parts.flatMap((p) => p.unresolved);
        const path = normPath(parts.map((p) => p.text).join('/'));
        const why = [`@${a.name} (${hit.entry.means}, ${hit.how})`];
        if (base) why.push(`class @${base.a.name}("${base.text}")`);
        if (app.text) why.push(`application path "${app.text}" (${base?.hit.catalog.id ?? hit.catalog.id})`);
        if (unresolved.length) why.push(`unresolved constant ${unresolved.join(', ')}`);
        facts.push({
          id: `endpoint:${verb} ${path}@${t.fqn}#${m.name}/${m.arity ?? 0}`,
          family: 'endpoint',
          confidence: weakest(
            hit.how,
            base?.hit.how ?? 'resolved',
            own?.hit.how ?? 'resolved',
            unresolved.length ? 'unresolved' : 'resolved',
          ),
          evidence: [`${t.file}:${a.line}`, `${t.file}:${m.nameLine}-${m.end}#${m.name}`],
          why,
          verb,
          path,
          handler: `${t.name}.${m.name}`,
          handlerFqn: t.fqn,
          file: t.file,
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
  ];

  const { buildModel } = await import('../model/model.mjs');
  const { selectCatalogs } = await import('../catalogs/catalog.mjs');
  const model = buildModel(files);
  const selected = selectCatalogs(catalogs, {
    imports: [...model.importsOf.values()].flatMap((i) => i.imports.map((x) => x.name)),
  });
  const facts = extractEndpoints(model, selected, { include: (p) => !p.includes('src/gw/') });
  assert.deepStrictEqual(
    facts.map((f) => [f.verb, f.path, f.handler, f.confidence]),
    [
      ['GET', '/api/x', 'C.list', 'resolved'],
      ['GET', '/api/x', 'C.list', 'resolved'], // an overload: same path and name, a different fact
      ['POST', '/api/y', 'C.create', 'resolved'],
      ['GET', '/api/x1/{}', 'C.built', 'resolved'], // constants resolved through the model
      ['GET', '/api/{?}', 'C.unknown', 'unresolved'], // never a half-printed path, never an unbalanced brace
      ['GET', '/root/rest/a', 'R.get', 'inferred'], // JAX-RS app path applies to the JAX-RS resource
      ['POST', '/root/rest', 'R.post', 'inferred'],
    ],
  );
  assert.ok(!facts.some((f) => f.file.includes('src/gw/')), 'excluded deployables contribute no facts');
  assert.ok(!facts.some((f) => f.file.startsWith('src/demo/') && f.path.startsWith('/root')), 'Spring never takes the JAX-RS prefix');
  assert.match(facts.find((f) => f.handler === 'C.unknown').why.join(';'), /unresolved constant Elsewhere.PATH/);
  assert.equal(new Set(facts.map((f) => f.id)).size, facts.length);
  assert.match(facts[0].id, /^endpoint:GET \/api\/x@demo\.C#list\/0$/);
  assert.deepStrictEqual(facts[0].evidence, ['src/demo/C.java:5', 'src/demo/C.java:6-8#list']);
}
