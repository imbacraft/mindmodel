#!/usr/bin/env node
// Prints the mindmodel.json shape compactly (field names, types, required marks) from the schema,
// so the writer reads ~1/4 of the schema's size. The validator still enforces the full schema.
// Usage: node shape.mjs [system]   (no argument: the single-app schema)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function shape(node, defs, depth = 0) {
  if (node.$ref) return shape(defs[node.$ref.split('/').pop()], defs, depth);
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join('|');
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.type === 'array') return `[${node.items ? shape(node.items, defs, depth) : ''}]`;
  if (node.type === 'object' && node.properties) {
    const pad = '  '.repeat(depth + 1),
      req = new Set(node.required ?? []);
    const note = (v) => (v.description ? `  // ${v.description}` : '');
    const lines = Object.entries(node.properties).map(
      ([k, v]) => `${pad}${k}${req.has(k) ? '' : '?'}: ${shape(v, defs, depth + 1)}${note(v)}`,
    );
    return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
  }
  return node.type ?? 'any';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(here, `../schema/${process.argv[2] === 'system' ? 'system' : 'mindmodel'}.schema.json`),
      'utf8',
    ),
  );
  console.log(
    '// "?" = optional. cite = "path", "path:line" or "path:start-end", optionally "#symbol"; where a file declares ' +
      'several methods of that name, cite one by its own range, or add its arity ("#save/2"). ' +
      '[[id|text]] links a concept/region in sentences.',
  );
  console.log(shape(schema, schema.$defs ?? {}));
}
