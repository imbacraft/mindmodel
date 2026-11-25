// Fixtures run through the real engine: the Java sources live on disk under test-support/fixtures/<name>/, and a case
// names the layers it needs (base, then a variant that overrides or adds files). The layers are copied into a scratch
// dir once per set and the jar dumps them; the model is built from that dump — the same path a scan takes. Nothing
// here parses Java; a test that needs a dump skips when the jar has not been built.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTRACT, open } from '../../engine/dump.mjs';
import { buildModelFromDump } from '../../engine/model/from-dump-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const JAR = process.env.MINDMODEL_ENGINE_JAR ?? path.join(here, '../../engine-java/target/mindmodel-engine.jar');
export const NO_ENGINE = !fs.existsSync(JAR) ? 'engine jar not built (mvn -f engine-java/pom.xml package)' : false;

const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name),
      dst = path.join(to, e.name);
    if (e.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
};

/** Every `.java` under `dir`, relative and forward-slashed: the list the dump reads. */
const javaFiles = (dir, base = dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...javaFiles(p, base));
    else if (e.name.endsWith('.java')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
};

// One dump per layer set: the cases in a test file share the base layers, so each set is copied and dumped once.
const dumps = new Map();

/**
 * `layers` are fixture dir names under test-support/fixtures, applied in order (a later layer overwrites a file of the
 * same path). `generated` names directories inside the fixture that an annotation processor would have written: their
 * files are not in the file list, and the dump reads them as signatures only. Returns the open dump, the model built
 * from it (which carries the dump, so the extractors can query it) and the file → package/imports map.
 */
export function dumpOfLayers(layers, { generated = [] } = {}) {
  const key = `${layers.join('|')}#${generated.join('|')}`;
  if (dumps.has(key)) return dumps.get(key);
  // A real path, not the /var symlink: the dump relativises its file paths against the root it was given.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mindmodel-fixture-'));
  for (const layer of layers) copyTree(path.join(here, layer), dir);
  const list = path.join(dir, 'files.txt');
  // Build output is never an input: a scan's file list comes from the sources, and a generated root is named apart.
  const files = javaFiles(dir)
    .filter((f) => !/(^|\/)(target|build)\//.test(f))
    .filter((f) => !generated.some((g) => f.startsWith(`${g}/`)));
  fs.writeFileSync(list, files.join('\n') + (files.length ? '\n' : ''));
  const out = path.join(dir, 'dump');
  const args = ['-jar', JAR, 'dump', '--contract', String(CONTRACT)];
  if (generated.length) {
    const roots = path.join(dir, 'generated.txt');
    fs.writeFileSync(roots, generated.join('\n') + '\n');
    args.push('--generated', roots);
  }
  args.push(dir, list, out);
  execFileSync('java', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const db = open(out);
  const sources = new Map(
    [...db.files].map(([p, f]) => [
      p,
      {
        pkg: f.package ?? '',
        imports: (f.imports ?? []).map((i) => ({ name: i.name, wildcard: !!i.wildcard, isStatic: !!i.static })),
      },
    ]),
  );
  const model = buildModelFromDump(db, sources);
  const result = { db, model, sources, dir };
  dumps.set(key, result);
  return result;
}
