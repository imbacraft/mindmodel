// The library table is generated, never typed by hand: the catalogs hold the facts, this flattens them into the one
// resource the Java engine reads (`engine-java/src/main/resources/library-signatures.json`). A test compares the two,
// so an edited catalog that forgets to regenerate fails loudly instead of drifting.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const catalogs = join(here, '..', 'catalogs');
export const TABLE = join(here, '..', '..', 'engine-java', 'src', 'main', 'resources', 'library-signatures.json');

/** A return type a chain can continue through: raw class, or null for a primitive, void or a type variable. */
export function raw(text) {
  if (!text) return null;
  const stripped = String(text).replace(/<[\s\S]*/, '').replace(/\[\]/g, '').trim();
  if (!stripped) return null;
  const simple = stripped.slice(stripped.lastIndexOf('.') + 1);
  if (simple.length <= 2 && simple === simple.toUpperCase()) return null;
  if (['void', 'boolean', 'int', 'long', 'double', 'float', 'byte', 'short', 'char'].includes(stripped)) return null;
  return stripped.includes('.') ? stripped : `java.lang.${stripped}`;
}

/** Every signature in the shipped catalogs, flattened to `type -> (method[/argc] -> return)`. */
export function table() {
  const types = {};
  for (const file of readdirSync(catalogs).filter((f) => f.endsWith('.json')).sort()) {
    const catalog = JSON.parse(readFileSync(join(catalogs, file), 'utf8'));
    for (const signature of catalog.signatures ?? []) {
      const methods = (types[signature.type] ??= {});
      for (const [name, returns] of Object.entries(signature.methods ?? {})) {
        if (typeof returns === 'string') {
          const type = raw(returns);
          if (type) methods[name] = type;
          continue;
        }
        for (const [argc, spec] of Object.entries(returns.byArg ?? {})) {
          const type = raw(spec?.returns ?? spec);
          if (type) methods[`${name}/${argc}`] = type;
        }
      }
    }
  }
  const sorted = {};
  for (const type of Object.keys(types).sort()) {
    if (!Object.keys(types[type]).length) continue;
    sorted[type] = {};
    for (const name of Object.keys(types[type]).sort()) sorted[type][name] = types[type][name];
  }
  return { version: 1, types: sorted };
}

export const serialised = () => `${JSON.stringify(table(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(TABLE, serialised());
  const flat = table();
  const count = Object.values(flat.types).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`wrote ${TABLE}: ${Object.keys(flat.types).length} types, ${count} methods`);
}
