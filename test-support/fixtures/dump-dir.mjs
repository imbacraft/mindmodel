// Fixtures run through the real engine: the Java sources live on disk under test-support/fixtures/<name>/, and a case
// names the layers it needs (base, then a variant that overrides or adds files). The layers are copied into a scratch
// dir once per distinct set of bytes and the jar dumps them; the model is built from that dump — the same path a scan
// takes. Inline Java (`dumpOf`) takes the same route through a scratch dir of its own. Each dump is memoized for the
// life of the test process, keyed by a hash of its sources, and the scratch dirs are removed when the process exits.
// The jar reads one root per run, so a dump is one JVM: batching several dumps into one run needs a CLI change.
// Nothing here parses Java; a test that needs a dump skips when the jar has not been built.
import crypto from 'node:crypto';
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

// A real path, not the /var symlink: the dump relativises its file paths against the root it was given.
const scratchDirs = [];
const scratchDir = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mindmodel-fixture-'));
  scratchDirs.push(dir);
  return dir;
};
process.on('exit', () => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir` as [relative path, bytes], in a fixed order. */
function readTree(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) readTree(p, base, out);
    else out.push([path.relative(base, p).split(path.sep).join('/'), fs.readFileSync(p)]);
  }
  return out;
}

/** The key a dump is memoized under: the names and bytes of its sources, and what marks them generated or known. */
function keyOf(entries, extra = []) {
  const h = crypto.createHash('sha256');
  for (const [rel, bytes] of entries) h.update(rel).update('\0').update(bytes).update('\0');
  for (const x of extra) h.update(x).update('\n');
  return h.digest('hex');
}

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

/** The jar reads `dir` and the listed files, and writes the dump under `dir/dump`; returns the open dump. */
function runDump(dir, files, { generated = [] } = {}) {
  const list = path.join(dir, 'files.txt');
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
  return open(out);
}

/** The imports and package of each file, as the model reads them. */
function sourcesOf(db) {
  return new Map(
    [...db.files].map(([p, f]) => [
      p,
      {
        pkg: f.package ?? '',
        imports: (f.imports ?? []).map((i) => ({ name: i.name, wildcard: !!i.wildcard, isStatic: !!i.static })),
      },
    ]),
  );
}

// One dump per distinct source set: the cases in a test file share the base layers, and two cases with the same bytes
// share one dump.
const dumps = new Map();

/**
 * `layers` are fixture dir names under test-support/fixtures, applied in order (a later layer overwrites a file of the
 * same path). `generated` names directories inside the fixture that an annotation processor would have written: their
 * files are not in the file list, and the dump reads them as signatures only. Returns the open dump, the model built
 * from it (which carries the dump, so the extractors can query it) and the file → package/imports map.
 */
export function dumpOfLayers(layers, { generated = [] } = {}) {
  const bytes = layers.flatMap((layer) => readTree(path.join(here, layer)));
  const key = keyOf(bytes, ['layers', ...generated.map((g) => `generated:${g}`)]);
  if (dumps.has(key)) return dumps.get(key);
  const dir = scratchDir();
  for (const layer of layers) copyTree(path.join(here, layer), dir);
  // Build output is never an input: a scan's file list comes from the sources, and a generated root is named apart.
  const files = javaFiles(dir)
    .filter((f) => !/(^|\/)(target|build)\//.test(f))
    .filter((f) => !generated.some((g) => f.startsWith(`${g}/`)));
  const db = runDump(dir, files, { generated });
  const sources = sourcesOf(db);
  const model = buildModelFromDump(db, sources);
  const result = { db, model, sources, dir };
  dumps.set(key, result);
  return result;
}

/**
 * One dump of one set of inline sources: `files` is `{ 'src/main/java/shop/F.java': text }`. Returns the open dump, the
 * model built from it (which carries the dump, so the extractors can query it) and the file → package/imports map.
 */
export function dumpOf(files, known = new Set()) {
  const entries = Object.keys(files)
    .sort()
    .map((rel) => [rel, Buffer.from(files[rel])]);
  const key = keyOf(entries, ['inline', ...[...known].sort()]);
  if (dumps.has(key)) return dumps.get(key);
  const dir = scratchDir();
  for (const [rel, bytes] of entries) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  }
  const db = runDump(dir, entries.map(([rel]) => rel));
  const sources = sourcesOf(db);
  const model = buildModelFromDump(db, sources, known);
  const result = { db, model, sources, dir };
  dumps.set(key, result);
  return result;
}
