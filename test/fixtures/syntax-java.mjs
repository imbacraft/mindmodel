// Java method index: names, exact line ranges and annotations of every type and method in a file.
// Shared by the scanner (to state facts down to the method) and the validator (to resolve path#method citations).
// The syntax tree comes from the vendored tree-sitter grammar (engine/vendor/tree-sitter/README.md).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from '../../engine/vendor/tree-sitter/web-tree-sitter.mjs';

// The vendored tree-sitter files load once, at import, so every caller stays synchronous afterwards. A missing file
// names the path instead of failing inside the WASM loader.
const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../engine/vendor/tree-sitter');
for (const f of ['web-tree-sitter.mjs', 'web-tree-sitter.wasm', 'tree-sitter-java.wasm'])
  if (!fs.existsSync(path.join(VENDOR, f)))
    throw new Error(
      `tree-sitter is not vendored: missing ${path.join(VENDOR, f)} (see engine/vendor/tree-sitter/README.md)`,
    );

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(path.join(VENDOR, 'tree-sitter-java.wasm')));

// Java's declaration kinds, in the words the facts use.
const TYPE_KINDS = new Map([
  ['class_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['enum_declaration', 'enum'],
  ['record_declaration', 'record'],
  ['annotation_type_declaration', 'annotation'],
]);
const METHOD_KINDS = ['method_declaration', 'constructor_declaration'];

// `modifiers` is the declaration's first child, not a named field; it holds the annotations and the keywords.
const modifiersOf = (node) => (node.namedChildren[0]?.type === 'modifiers' ? node.namedChildren[0] : null);

// Annotations of one declaration, with the line each sits on and its arguments as written (whitespace collapsed).
// `annotations` in the index is the older "Name" / "Name(args)" string form that deep.mjs matches against.
const annotationsOf = (node) => {
  const mods = modifiersOf(node);
  if (!mods) return [];
  return mods.namedChildren
    .filter((c) => c.type === 'annotation' || c.type === 'marker_annotation')
    .map((a) => {
      const args = a.namedChildren.find((c) => c.type === 'annotation_argument_list');
      return {
        name: a.childForFieldName('name')?.text ?? '',
        args: args ? args.text.slice(1, -1).replace(/\s+/g, ' ').trim() : '',
        line: a.startPosition.row + 1,
      };
    });
};
const annotationStrings = (ann) => ann.map((a) => a.name + (a.args ? `(${a.args})` : ''));

// "extends Base<X>" -> "Base<X>"; declared over several lines, it stays one readable string.
const withoutKeyword = (text, keyword) =>
  text ? text.replace(new RegExp(`^\\s*${keyword}\\s+`), '').replace(/\s+/g, ' ').trim() : undefined;
// A type's superclass (classes) or extended interfaces (interfaces), as the old regex captured them.
const extendsOf = (node) => {
  if (node.type === 'class_declaration') return withoutKeyword(node.childForFieldName('superclass')?.text, 'extends');
  if (node.type === 'interface_declaration') {
    const ext = node.namedChildren.find((c) => c.type === 'extends_interfaces');
    return ext ? withoutKeyword(ext.text, 'extends') : undefined;
  }
  return undefined;
};
const implementsOf = (node) =>
  ['class_declaration', 'record_declaration', 'enum_declaration'].includes(node.type)
    ? withoutKeyword(node.childForFieldName('interfaces')?.text, 'implements')
    : undefined;

// A method's parameters, with the type each one has: receiver typing needs them, and a CDI observer names its event
// on one of them. Annotations stay on the parameter for extractors that care (@RequestBody, @PathParam).
const TYPE_NODES = new Set(['type_identifier', 'generic_type', 'scoped_type_identifier', 'array_type', 'integral_type', 'floating_point_type', 'boolean_type', 'void_type']);

const paramsOf = (node) => {
  const out = [];
  for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
    if (!['formal_parameter', 'spread_parameter', 'receiver_parameter'].includes(p.type)) continue;
    const ann = modifiersOf(p) ? annotationsOf(p) : [];
    const name =
      p.childForFieldName('name')?.text ??
      p.namedChildren.find((c) => c.type === 'variable_declarator')?.childForFieldName('name')?.text ??
      '';
    // A spread parameter (`String... args`) carries its type in a child node, and its id spelling is an array:
    // `String[]`, which is what the dump and every other layer use.
    const written = p.childForFieldName('type')?.text ?? p.namedChildren.find((c) => TYPE_NODES.has(c.type))?.text ?? '';
    const type = p.type === 'spread_parameter' && written ? `${written}[]` : written;
    out.push({
      name,
      type,
      varargs: p.type === 'spread_parameter',
      ann,
      annotations: annotationStrings(ann),
    });
  }
  return out;
};

// Comments are named nodes in the tree; a comment between a receiver and its dot is not the receiver.
const NOT_CHILD = new Set(['line_comment', 'block_comment']);

// The shape of a call's receiver, kept as a small tree so the model can resolve a chain one level deep
// (`getRepo().flush()` -> the return type of `getRepo()`).
const recvExprOf = (node) => {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'field_access' || node.type === 'this' || node.type === 'super')
    return { kind: 'name', text: node.text };
  if (node.type === 'method_invocation') {
    const kids = node.namedChildren.filter((c) => !NOT_CHILD.has(c.type)),
      args = kids.findLast((c) => c.type === 'argument_list');
    const ai = args ? kids.indexOf(args) : kids.length;
    return {
      kind: 'call',
      name: kids[ai - 1]?.text ?? '',
      argc: args ? args.namedChildren.length : 0,
      args: (args?.namedChildren ?? []).map((a) => a.text.slice(0, 80)),
      recv: recvExprOf(ai - 2 >= 0 ? kids[ai - 2] : null),
    };
  }
  if (node.type === 'object_creation_expression')
    return { kind: 'new', type: (node.childForFieldName('type')?.text ?? '').replace(/<.*/, '') };
  return { kind: 'expr', text: node.text.slice(0, 80) };
};

// One call made inside a method: a method invocation, a constructor call or a method reference. `args` keeps the
// argument text (cut at 80 chars) because extractors read values out of it: the enum constant, the topic name.
const callOf = (node) => {
  const kids = node.namedChildren.filter((c) => !NOT_CHILD.has(c.type));
  if (node.type === 'method_reference')
    return { kind: 'ref', name: kids[kids.length - 1]?.text ?? '', argc: null, args: [], recv: recvExprOf(kids[0]), line: node.startPosition.row + 1 };
  const args = kids.findLast((c) => c.type === 'argument_list');
  const ai = args ? kids.indexOf(args) : kids.length;
  const name = node.type === 'object_creation_expression' ? (node.childForFieldName('type')?.text ?? '') : (kids[ai - 1]?.text ?? '');
  const recv = node.type === 'object_creation_expression' ? null : recvExprOf(ai - 2 >= 0 ? kids[ai - 2] : null);
  return {
    kind: node.type === 'object_creation_expression' ? 'new' : 'call',
    name: name.replace(/<.*/, '').split('.').pop(),
    argc: args ? args.namedChildren.length : 0,
    args: (args?.namedChildren ?? []).map((a) => a.text.slice(0, 80)),
    recv,
    line: node.startPosition.row + 1,
  };
};

// Lambda parameters of a call's arguments: their type comes from the receiver's element type (`list.forEach(x -> …)`).
const lambdaParamsOf = (args) => {
  const out = [];
  for (const a of args?.namedChildren ?? []) {
    if (a.type !== 'lambda_expression') continue;
    const p = a.namedChildren[0];
    if (!p) continue;
    const names =
      p.type === 'identifier'
        ? [p.text]
        : (p.namedChildren ?? []).filter((c) => c.type === 'identifier').map((c) => c.text);
    if (names.length) out.push({ params: names, line: a.startPosition.row + 1, endLine: a.endPosition.row + 1 });
  }
  return out;
};

// Every type, method, field and call in a file, with exact line ranges and body offsets.
// `start` is the declaration's first line (annotations and modifiers included); `nameLine` is the line of the name.
export function index(text) {
  const tree = parser.parse(text);
  const root = tree.rootNode;

  const types = [],
    methods = [],
    fields = [],
    constants = [];
  let pkg = '';
  const imports = [];

  // One traversal for all of it, not one per node kind: a large file has a million nodes. The type name is carried
  // down (a field's owner) and so is the method (a call belongs to the method that makes it, not to its caller).
  const visit = (node, owner, method) => {
    const kind = TYPE_KINDS.get(node.type);
    if (kind) {
      const name = node.childForFieldName('name'),
        body = node.childForFieldName('body'),
        ann = annotationsOf(node);
      if (name) {
        types.push({
          kind,
          name: name.text,
          start: node.startPosition.row + 1,
          nameLine: name.startPosition.row + 1,
          end: node.endPosition.row + 1,
          open: body?.startIndex ?? node.startIndex,
          close: (body?.endIndex ?? node.endIndex) - 1,
          owner,
          extends: extendsOf(node),
          implements: implementsOf(node),
          // `<T, R>` on the declaration: a generic type's members return its type variables, and a call on a
          // `Repo<Order>` receiver has to substitute them.
          typeParams: (node.childForFieldName('type_parameters')?.namedChildren ?? [])
            .filter((c) => c.type === 'type_parameter')
            .map((c) => c.childForFieldName('name')?.text ?? c.text.split(/\s/)[0]),
          // A record's header names its components; the accessors and the canonical constructor are implicit.
          components: kind === 'record' ? paramsOf(node) : undefined,
          // An enum's constants, from its own body. Reading them by searching the file for `enum` attached a
          // neighbouring enum's constants to the wrong type.
          constants:
            kind === 'enum'
              ? (node.childForFieldName('body')?.namedChildren ?? [])
                  .filter((c) => c.type === 'enum_constant')
                  .map((c) => c.childForFieldName('name')?.text ?? c.text.split(/[\s(]/)[0])
              : undefined,
          abstract: /\babstract\b/.test(modifiersOf(node)?.text ?? ''),
          ann,
          annotations: annotationStrings(ann),
        });
        owner = name.text;
      }
    } else if (METHOD_KINDS.includes(node.type)) {
      const name = node.childForFieldName('name'),
        body = node.childForFieldName('body');
      // Abstract and interface methods have no body to digest, but their signature is the target every caller needs.
      if (name) {
        const ann = annotationsOf(node);
        method = {
          name: name.text,
          start: node.startPosition.row + 1,
          nameLine: name.startPosition.row + 1,
          end: node.endPosition.row + 1,
          open: body ? body.startIndex : null,
          close: body ? body.endIndex - 1 : null,
          hasBody: !!body,
          ann,
          annotations: annotationStrings(ann),
          params: paramsOf(node),
          returnText: node.childForFieldName('type')?.text ?? '',
          // Body digests (§5.1): calls, locals, assignments, catches. The model resolves them; extractors read them.
          calls: [],
          locals: [],
          assigns: [],
          catches: [],
          loops: [],
          lambdas: [],
          // Overloads share a name; arity is what tells them apart in a fact id without touching the source order.
          arity: (node.childForFieldName('parameters')?.namedChildren ?? []).filter((c) =>
            /parameter$/.test(c.type),
          ).length,
          isPublic: /\bpublic\b/.test(modifiersOf(node)?.text ?? ''),
        };
        methods.push(method);
      }
    } else if (node.type === 'method_invocation' || node.type === 'object_creation_expression' || node.type === 'method_reference') {
      // A call belongs to the method that makes it, wherever it sits (a lambda body included).
      if (method) {
        const call = callOf(node);
        const args = node.namedChildren.find((c) => c.type === 'argument_list');
        const lambdas = lambdaParamsOf(args);
        if (lambdas.length) call.lambdas = lambdas;
        method.calls.push(call);
      }
    } else if (method && node.type === 'local_variable_declaration') {
      // The declared type of a local is the receiver type of every call on it; `var` is decided by the initializer.
      // `final` is a modifier node, not the type, so read the type field (and never the modifiers).
      const type = node.childForFieldName('type')?.text ?? '';
      for (const d of node.namedChildren.filter((c) => c.type === 'variable_declarator')) {
        const n = d.childForFieldName('name'),
          v = d.childForFieldName('value');
        if (!n) continue;
        method.locals.push({
          name: n.text,
          type,
          line: n.startPosition.row + 1,
          init: !v
            ? null
            : v.type === 'object_creation_expression'
              ? { kind: 'new', type: (v.childForFieldName('type')?.text ?? '').replace(/<.*/, '') }
              : v.type === 'method_invocation'
                ? { kind: 'call', call: callOf(v) }
                : { kind: 'expr', text: v.text.slice(0, 80) },
        });
      }
    } else if (method && node.type === 'enhanced_for_statement') {
      const t = node.childForFieldName('type'),
        n = node.childForFieldName('name');
      if (t && n) method.locals.push({ name: n.text, type: t.text, line: n.startPosition.row + 1, init: null });
      method.loops.push({ start: node.startPosition.row + 1, end: node.endPosition.row + 1 });
    } else if (method && node.type === 'lambda_expression') {
      // The calls inside a lambda belong to the enclosing method, but they run elsewhere (a worker started by an
      // executor). Their range is what lets a walk step into the Runnable.
      method.lambdas.push({ start: node.startPosition.row + 1, end: node.endPosition.row + 1 });
    } else if (method && (node.type === 'while_statement' || node.type === 'do_statement' || node.type === 'for_statement')) {
      // Loop ranges are what tells a polling consumer from a one-shot call: a queue poll inside a loop is a worker.
      method.loops.push({ start: node.startPosition.row + 1, end: node.endPosition.row + 1 });
    } else if (method && node.type === 'assignment_expression') {
      const [left, right] = node.namedChildren;
      if (left && right)
        method.assigns.push({
          target: left.text.slice(0, 80),
          value: right.text.slice(0, 80),
          line: node.startPosition.row + 1,
        });
    } else if (method && node.type === 'catch_clause') {
      const param = node.namedChildren[0],
        body = node.namedChildren.find((c) => c.type === 'block');
      if (param && param.type === 'catch_formal_parameter') {
        const catchType = param.childForFieldName('type')?.text ?? param.text.replace(/\s+\w+\s*$/, '');
        const types = catchType
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
        const name = param.childForFieldName('name')?.text;
        // `e.getMessage()` is a call on the caught exception, so the catch parameter is a local like any other.
        if (name) method.locals.push({ name, type: types[0] ?? '', line: param.startPosition.row + 1, init: null });
        const text = body?.text ?? '';
        method.catches.push({
          line: node.startPosition.row + 1,
          types,
          rethrows: /\bthrow\b/.test(text),
          // Only a log call in the body: the failure is swallowed, which is what seams care about.
          onlyLogs: /^\{\s*[\w.]*\.(?:trace|debug|info|warn|error)\s*\([\s\S]*\)\s*;\s*\}$/.test(text),
        });
      }
    } else if (node.type === 'package_declaration') {
      pkg = node.namedChildren[0]?.text ?? '';
    } else if (node.type === 'import_declaration') {
      const raw = node.text.replace(/^import\s+/, '').replace(/;$/, '').trim();
      const isStatic = raw.startsWith('static ');
      const name = (isStatic ? raw.slice(7) : raw).trim();
      imports.push({ name: name.replace(/\.\*$/, ''), wildcard: name.endsWith('.*'), isStatic });
    } else if (node.type === 'field_declaration') {
      const fieldType = node.childForFieldName('type'),
        name = node.childForFieldName('declarator')?.childForFieldName('name'),
        mods = modifiersOf(node)?.text ?? '';
      // Package-private fields are declarations too (injected repositories and clients often are): keep them, and let
      // each caller apply the visibility rule it needs.
      // `static final String`s are how annotations build paths ("{" + ID + "}"); they are not injected fields, so
      // they live apart from `fields` and keep their initializer text for the model to resolve.
      if (fieldType && /\bstatic\b/.test(mods) && /\bfinal\b/.test(mods)) {
        for (const d of node.namedChildren)
          if (d.type === 'variable_declarator') {
            const n = d.childForFieldName('name'),
              v = d.childForFieldName('value');
            if (n && v) constants.push({ name: n.text, value: v.text, line: n.startPosition.row + 1, owner });
          }
        // A static final field of a class type is still a receiver (`log.warn(...)`, a shared formatter); a String is a
        // path constant and belongs only to `constants`.
        if (!/^(String|int|long|boolean|char|byte|short|float|double)$/.test(fieldType.text) && name) {
          const ann = annotationsOf(node);
          fields.push({
            name: name.text,
            type: fieldType.text,
            line: fieldType.startPosition.row + 1,
            owner,
            mods,
            static: true,
            ann,
            annotations: annotationStrings(ann),
          });
        }
      } else if (fieldType && name && !/\bstatic\b/.test(mods)) {
        const ann = annotationsOf(node);
        fields.push({
          name: name.text,
          type: fieldType.text,
          line: fieldType.startPosition.row + 1,
          owner,
          mods,
          ann,
          annotations: annotationStrings(ann),
        });
      }
    }
    for (const c of node.namedChildren) visit(c, owner, method);
  };
  visit(root, undefined, undefined);

  types.sort((a, b) => a.start - b.start);
  methods.sort((a, b) => a.start - b.start);

  const idx = { pkg, imports, types, methods, fields, constants };
  // A file that does not parse yields a recovered tree: keep what was found, but say so instead of implying a
  // complete parse.
  if (root.hasError) idx.degraded = true;
  tree.delete();
  return idx;
}

// The innermost method containing a line, or null.
export const methodAt = (idx, line) =>
  idx.methods.filter((m) => m.start <= line && line <= m.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0] ??
  null;

{
  const t =
    'public class A {\n  // a } comment {\n  @Transactional\n  public void pay(Long id) {\n    String s = "}{";\n    String p = """\n      { not a brace\n      """;\n    run(new Sync() {\n      public void afterCommit() { go(); }\n    });\n    list.forEach(x -> { x(); });\n  }\n  int size() { return 1; }\n}\n';
  const ix = index(t);
  assert.deepStrictEqual(
    ix.types.map((x) => [x.kind, x.name, x.start, x.nameLine, x.end]),
    [['class', 'A', 1, 1, 15]],
  );
  assert.deepStrictEqual(
    ix.methods.map((x) => [x.name, x.start, x.nameLine, x.end]),
    [
      ['pay', 3, 4, 13],
      ['afterCommit', 10, 10, 10],
      ['size', 14, 14, 14],
    ],
  );
  assert.deepStrictEqual(ix.methods[0].annotations, ['Transactional']);
  assert.equal(ix.methods[0].isPublic, true);
  assert.equal(methodAt(ix, 10).name, 'afterCommit');
  assert.equal(methodAt(ix, 12).name, 'pay');
  // Body offsets index the source string directly: callers slice [open, close) and never include the '}'.
  for (const m of ix.methods) {
    assert.equal(t[m.open], '{');
    assert.equal(t[m.close], '}');
    assert.ok(m.open < m.close);
  }
  assert.match(t.slice(ix.methods[2].open, ix.methods[2].close), /return 1/);
}

// A generic return type and annotations with arguments over several lines are ordinary now: the declaration is one
// node, whatever its signature looks like.
{
  const ix = index(
    '@RestController\npublic class G {\n  @GetMapping("/s")\n  public Flux<ServerSentEvent<Chat>> stream() {\n    return null;\n  }\n}',
  );
  assert.deepStrictEqual(
    ix.methods.map((m) => [m.name, m.start, m.nameLine]),
    [['stream', 3, 4]],
  );
  assert.deepStrictEqual(ix.methods[0].annotations, ['GetMapping("/s")']);
  assert.deepStrictEqual(
    ix.types[0].annotations,
    ['RestController'],
  );
}
{
  const ix = index(
    'class M {\n  @GetMapping(\n    value = "/one"\n  )\n  public Mono<Data> one() {\n    return null;\n  }\n}',
  );
  assert.deepStrictEqual(ix.methods[0].annotations, ['GetMapping(value = "/one")']);
}

// Braces and nested annotations inside annotation arguments no longer cut a header in half.
{
  const ix = index(
    'class B {\n  @Consumes({ "a", "b" })\n  @ApiResponse(content = @Content(schema = @Schema(type = "string")))\n  public void x() {}\n}',
  );
  assert.deepStrictEqual(ix.methods[0].annotations, [
    'Consumes({ "a", "b" })',
    'ApiResponse(content = @Content(schema = @Schema(type = "string")))',
  ]);
}

// Records, enums with methods, lambdas and text blocks are parsed as declarations, not as text patterns.
{
  const rec = index('record R(int a) {\n  int twice() {\n    return a * 2;\n  }\n}');
  assert.deepStrictEqual(
    rec.types.map((t) => [t.kind, t.name]),
    [['record', 'R']],
  );
  assert.deepStrictEqual(
    rec.methods.map((m) => m.name),
    ['twice'],
  );
  const en = index('enum E {\n  A;\n  int v() {\n    return 1;\n  }\n}');
  assert.deepStrictEqual(
    en.types.map((t) => [t.kind, t.name]),
    [['enum', 'E']],
  );
  assert.deepStrictEqual(
    en.methods.map((m) => m.name),
    ['v'],
  );
  const tb = index('class T {\n  private String s = """\n    { not a brace }\n    """;\n  void m() {}\n}');
  assert.deepStrictEqual(
    tb.fields.map((f) => f.name),
    ['s'],
  );
  assert.deepStrictEqual(
    tb.methods.map((m) => m.name),
    ['m'],
  );
  const an = index('@interface Ann {\n  String value();\n}');
  assert.deepStrictEqual(
    an.types.map((t) => [t.kind, t.name]),
    [['annotation', 'Ann']],
  );
  assert.deepStrictEqual(an.methods, []);
}

// Entity fields carry their own annotations and their declared type.
{
  const ix = index(
    'class E {\n  @ManyToOne\n  @JoinColumn(name = "client_id")\n  private Client client;\n  private String name;\n  static final int X = 1;\n}',
  );
  assert.deepStrictEqual(
    ix.fields.map((f) => [f.name, f.type, f.line, f.annotations]),
    [
      ['client', 'Client', 4, ['ManyToOne', 'JoinColumn(name = "client_id")']],
      ['name', 'String', 5, []],
    ],
  );
}

// A file that does not parse is flagged, not thrown on.
{
  const broken = index('class X {\n  void m( {\n');
  assert.equal(broken.degraded, true);
}

// Offsets are JS string indices even after non-ASCII text, so `text.slice(open, close)` stays correct.
{
  const text = 'class U { // é 😀\n  void m() {\n    return;\n  }\n}';
  const m = index(text).methods[0];
  assert.equal(m.nameLine, 2);
  assert.equal(text[m.open], '{');
  assert.equal(text[m.close], '}');
  assert.match(text.slice(m.open, m.close), /return;/);
}

// Package, imports and nesting: what the model needs to give a type its full name.
{
  const ix = index(
    'package a.b;\nimport java.util.List;\nimport static java.util.Objects.requireNonNull;\nimport jakarta.ws.rs.*;\nclass Outer {\n  class Inner {\n    void m() {\n      requireNonNull(List.of(1));\n    }\n  }\n}',
  );
  assert.equal(ix.pkg, 'a.b');
  assert.deepStrictEqual(ix.imports, [
    { name: 'java.util.List', wildcard: false, isStatic: false },
    { name: 'java.util.Objects.requireNonNull', wildcard: false, isStatic: true },
    { name: 'jakarta.ws.rs', wildcard: true, isStatic: false },
  ]);
  assert.deepStrictEqual(
    ix.types.map((t) => [t.name, t.owner]),
    [
      ['Outer', undefined],
      ['Inner', 'Outer'],
    ],
  );
}

// Calls belong to the method that makes them: nested lambdas included. A chained call keeps the receiver expression's
// shape (`getRepo().flush()` -> the call `getRepo`), which is what the model resolves one level deep.
{
  const ix = index(
    'class C {\n  void a(java.util.List<Order> list) {\n    repo.save(x, 1);\n    this.help();\n    helper();\n    new Inner();\n    list.forEach(y -> repo.delete(y));\n    getRepo().flush();\n    Runnable r = repo::save;\n  }\n  void help() {}\n  void helper() {}\n  class Inner {}\n}',
  );
  const a = ix.methods.find((m) => m.name === 'a');
  assert.deepStrictEqual(
    a.calls.map((c) => [c.kind, c.name, c.recv?.text ?? c.recv?.kind ?? null, c.argc]),
    [
      ['call', 'save', 'repo', 2],
      ['call', 'help', 'this', 0],
      ['call', 'helper', null, 0],
      ['new', 'Inner', null, 0],
      ['call', 'forEach', 'list', 1],
      ['call', 'delete', 'repo', 1],
      ['call', 'flush', 'call', 0],
      ['call', 'getRepo', null, 0],
      ['ref', 'save', 'repo', null],
    ],
  );
  assert.deepStrictEqual(a.calls[0].args, ['x', '1']);
  // The lambda parameter is recorded with the call that introduced it, so the model can type it from the element type.
  assert.deepStrictEqual(a.calls[4].lambdas, [{ params: ['y'], line: 7, endLine: 7 }]);
  assert.deepStrictEqual(ix.methods.find((m) => m.name === 'help').calls, []);
}

// Body digests: locals (with the initializer that decides `var`), field assignments, and what a catch does.
{
  const ix = index(
    'class C {\n  void a(Order o) {\n    var x = new Foo();\n    Order found = repo.find(o);\n    Order idle;\n    for (Order each : orders) { each.status = open; }\n    this.status = Status.PAID;\n    try { go(); } catch (IOException | RuntimeException e) { throw new X(e); }\n    try { go(); } catch (E e) { log.warn("x", e); }\n  }\n}',
  );
  const a = ix.methods[0];
  assert.deepStrictEqual(
    a.locals.map((l) => [l.name, l.type, l.init?.kind ?? null, l.init?.type ?? l.init?.call?.name ?? null]),
    [
      ['x', 'var', 'new', 'Foo'],
      ['found', 'Order', 'call', 'find'],
      ['idle', 'Order', null, null],
      ['each', 'Order', null, null],
      // A catch parameter is a local: `e.getMessage()` needs its type.
      ['e', 'IOException', null, null],
      ['e', 'E', null, null],
    ],
  );
  assert.deepStrictEqual(
    a.assigns.map((x) => [x.target, x.value]),
    [
      ['each.status', 'open'],
      ['this.status', 'Status.PAID'],
    ],
  );
  assert.deepStrictEqual(
    a.catches.map((c) => [c.types, c.rethrows, c.onlyLogs]),
    [
      [['IOException', 'RuntimeException'], true, false],
      [['E'], false, true],
    ],
  );
  assert.deepStrictEqual(
    a.params.map((p) => [p.name, p.type]),
    [['o', 'Order']],
  );
  assert.equal(a.returnText, 'void');
}

// `final` is a modifier node; a comment between a receiver and its dot is not the receiver.
{
  const ix = index(
    'class C {\n  void a() {\n    final StringBuilder b = new StringBuilder();\n    b.append("x");\n    result // still the receiver\n      .build();\n  }\n}',
  );
  const a = ix.methods[0];
  assert.deepStrictEqual(a.locals.map((l) => [l.name, l.type]), [['b', 'StringBuilder']]);
  const build = a.calls.find((c) => c.name === 'build');
  assert.deepStrictEqual([build.recv.kind, build.recv.text], ['name', 'result']);
}

// Path constants keep their initializer text, and stay out of the injected-field list.
{
  const ix = index(
    'package a;\nclass K {\n  public static final String ID = "jobId";\n  static final String P = "{" + ID + "}";\n  private String dep;\n}',
  );
  assert.deepStrictEqual(ix.constants.map((c) => [c.name, c.value, c.line]), [
    ['ID', '"jobId"', 3],
    ['P', '"{" + ID + "}"', 4],
  ]);
  assert.deepStrictEqual(ix.fields.map((f) => f.name), ['dep']);
}
