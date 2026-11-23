// What the scan reads from Java source: the file's package, its imports, and whether it parsed. Types, members and
// calls are the engine's (engine-java/); this walks the top-level declarations only, and is the last tree-sitter use
// on the Java path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from '../vendor/tree-sitter/web-tree-sitter.mjs';

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../vendor/tree-sitter');
for (const f of ['web-tree-sitter.mjs', 'web-tree-sitter.wasm', 'tree-sitter-java.wasm'])
  if (!fs.existsSync(path.join(VENDOR, f)))
    throw new Error(
      `tree-sitter is not vendored: missing ${path.join(VENDOR, f)} (see engine/vendor/tree-sitter/README.md)`,
    );

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(path.join(VENDOR, 'tree-sitter-java.wasm')));

/** `{pkg, imports, degraded}` for one Java file. `imports` is `{name, wildcard, isStatic}`, as javac spells it. */
export function sourceFacts(text) {
  const tree = parser.parse(text);
  const root = tree.rootNode;
  let pkg = '';
  const imports = [];
  for (const node of root.namedChildren) {
    if (node.type === 'package_declaration') pkg = node.namedChildren[0]?.text ?? '';
    else if (node.type === 'import_declaration') {
      const raw = node.text.replace(/^import\s+/, '').replace(/;$/, '').trim();
      const isStatic = raw.startsWith('static ');
      const name = (isStatic ? raw.slice(7) : raw).trim();
      imports.push({ name: name.replace(/\.\*$/, ''), wildcard: name.endsWith('.*'), isStatic });
    }
  }
  const facts = { pkg, imports };
  // Read before the tree is freed: a freed node answers nothing reliable.
  if (root.hasError) facts.degraded = true;
  tree.delete();
  return facts;
}

{
  const fs2 = await import('node:assert');
  const facts = sourceFacts('package a.b;\nimport java.util.List;\nimport static a.b.C.ID;\nimport jakarta.ws.rs.*;\nclass X {}');
  fs2.equal(facts.pkg, 'a.b');
  fs2.deepStrictEqual(facts.imports, [
    { name: 'java.util.List', wildcard: false, isStatic: false },
    { name: 'a.b.C.ID', wildcard: false, isStatic: true },
    { name: 'jakarta.ws.rs', wildcard: true, isStatic: false },
  ]);
  fs2.equal(facts.degraded, undefined);
  fs2.equal(sourceFacts('class {').degraded, true);
}
