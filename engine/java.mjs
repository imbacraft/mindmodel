// Java method index: names, exact line ranges and annotations of every type and method in a file.
// Shared by the scanner (to state facts down to the method) and the validator (to resolve path#method citations).
// The syntax tree comes from the vendored tree-sitter grammar (engine/vendor/tree-sitter/README.md).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from './vendor/tree-sitter/web-tree-sitter.mjs';

// The vendored tree-sitter files load once, at import, so every caller stays synchronous afterwards. A missing file
// names the path instead of failing inside the WASM loader.
const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor/tree-sitter');
for (const f of ['web-tree-sitter.mjs', 'web-tree-sitter.wasm', 'tree-sitter-java.wasm'])
  if (!fs.existsSync(path.join(VENDOR, f)))
    throw new Error(
      `tree-sitter is not vendored: missing ${path.join(VENDOR, f)} (see engine/vendor/tree-sitter/README.md)`,
    );

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(path.join(VENDOR, 'tree-sitter-java.wasm')));

// Blank out comments, strings, char literals and text blocks (same length, newlines kept) so braces and
// keywords inside them can't fool the parser. Quotes stay, so `"..."` still reads as a string.
export function clean(text) {
  let out = '',
    i = 0;
  const n = text.length,
    blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i],
      d = text[i + 1];
    let end = -1;
    if (c === '/' && d === '/') (end = text.indexOf('\n', i)), (end = end < 0 ? n : end);
    else if (c === '/' && d === '*') (end = text.indexOf('*/', i + 2)), (end = end < 0 ? n : end + 2);
    else if (text.startsWith('"""', i)) {
      end = text.indexOf('"""', i + 3);
      end = end < 0 ? n : end + 3;
      out += '"""' + blank(text.slice(i + 3, end - 3)) + '"""';
      i = end;
      continue;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      end = Math.min(j + 1, n);
      out += c + blank(text.slice(i + 1, end - 1)) + (text[end - 1] === c ? c : '');
      i = end;
      continue;
    }
    if (end >= 0) {
      out += blank(text.slice(i, end));
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

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

// A method's annotated parameters: a CDI observer names its event this way. Plain parameters carry no fact, so they
// are not copied into the index.
const paramsOf = (node) => {
  const out = [];
  for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
    if (p.type !== 'formal_parameter' || !modifiersOf(p)) continue;
    const ann = annotationsOf(p);
    out.push({ type: p.childForFieldName('type')?.text ?? '', ann, annotations: annotationStrings(ann) });
  }
  return out;
};

// Every type, method and field in a file, with exact line ranges and the body offsets callers slice `src` with.
// `start` is the declaration's first line (annotations and modifiers included); `nameLine` is the line of the name.
export function index(text) {
  const src = clean(text),
    starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  // Position -> 1-based line. Offsets from the parser are JS string indices, so they index `src` directly.
  const lineOf = (pos) => {
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (starts[m] <= pos) lo = m;
      else hi = m - 1;
    }
    return lo + 1;
  };

  const tree = parser.parse(text);
  const root = tree.rootNode;

  const types = [],
    methods = [],
    fields = [];

  // One traversal for all three, not one per node kind: a large file has a million nodes. A type's name is carried
  // down so every field knows the type whose body holds it.
  const visit = (node, owner) => {
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
          extends: extendsOf(node),
          implements: implementsOf(node),
          ann,
          annotations: annotationStrings(ann),
        });
        owner = name.text;
      }
    } else if (METHOD_KINDS.includes(node.type)) {
      const name = node.childForFieldName('name'),
        body = node.childForFieldName('body');
      // Abstract and interface methods have no body, and every caller slices the body.
      if (name && body) {
        const ann = annotationsOf(node);
        methods.push({
          name: name.text,
          start: node.startPosition.row + 1,
          nameLine: name.startPosition.row + 1,
          end: node.endPosition.row + 1,
          open: body.startIndex,
          close: body.endIndex - 1,
          ann,
          annotations: annotationStrings(ann),
          params: paramsOf(node),
          isPublic: /\bpublic\b/.test(modifiersOf(node)?.text ?? ''),
        });
      }
    } else if (node.type === 'field_declaration') {
      const fieldType = node.childForFieldName('type'),
        name = node.childForFieldName('declarator')?.childForFieldName('name'),
        mods = modifiersOf(node)?.text ?? '';
      if (fieldType && name && !/\bstatic\b/.test(mods) && /\b(public|private|protected)\b/.test(mods)) {
        const ann = annotationsOf(node);
        fields.push({
          name: name.text,
          type: fieldType.text,
          line: fieldType.startPosition.row + 1,
          owner,
          ann,
          annotations: annotationStrings(ann),
        });
      }
    }
    for (const c of node.namedChildren) visit(c, owner);
  };
  visit(root, undefined);

  types.sort((a, b) => a.start - b.start);
  methods.sort((a, b) => a.start - b.start);

  const idx = { src, lineOf, types, methods, fields };
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
  // Body offsets index `src` directly: callers slice [open, close) and never include the closing brace.
  for (const m of ix.methods) {
    assert.equal(ix.src[m.open], '{');
    assert.equal(ix.src[m.close], '}');
    assert.ok(m.open < m.close);
  }
  assert.match(ix.src.slice(ix.methods[2].open, ix.methods[2].close), /return 1/);
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

// Offsets are JS string indices even after non-ASCII text, so `src.slice(open, close)` stays correct.
{
  const ix = index('class U { // é 😀\n  void m() {\n    return;\n  }\n}');
  const m = ix.methods[0];
  assert.equal(m.nameLine, 2);
  assert.equal(ix.src[m.open], '{');
  assert.equal(ix.src[m.close], '}');
  assert.match(ix.src.slice(m.open, m.close), /return;/);
}
