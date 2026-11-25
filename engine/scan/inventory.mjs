import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS, isTestCode, relPosix } from '../core/paths.mjs';
import { readBuild } from '../io/build.mjs';

// The checkout's files: the walk, the buckets the families read, the run's scratch folder and the docs.

// Compiled and binary files are never read, so don't even list them (wherever a build tool put them).
const SKIP_EXT = new RegExp(
  [
    '\\.(class|jar|war|ear|so|dll|dylib|exe|o|pyc|png|jpe?g|gif|webp|ico|bmp|tiff?|woff2?|ttf|otf|eot|',
    'mp[34]|mov|avi|zip|gz|tgz|rar|7z|pdf|psd|map)$',
  ].join(''),
  'i',
);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && !['.github'].includes(e.name) && e.isDirectory()) continue;
    if (IGNORED_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (!SKIP_EXT.test(e.name)) out.push(p);
  }
  return out;
}

// The run's scratch folder. `.work/` holds facts, the Java dump and report files (megabytes nobody should commit);
// `mindmodel.json` and `index.html` beside it are the deliverables and stay visible.
export function ensureWork(root) {
  const work = path.join(root, 'mindmodel', '.work');
  fs.mkdirSync(work, { recursive: true });
  // A `.gitignore` inside `.work/` keeps the scan data out of `git status` without editing the project's own file.
  const ignore = path.join(work, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return work;
}

/**
 * A run writes a new map from the current facts, so the previous `mindmodel.json` must not sit at the path the writer
 * writes: left there, the writer patches the old map and a plugin upgrade never shows. Renaming keeps the old file
 * byte-identical inside `.work/`, where it is out of the writer's way but still there for a diff.
 */
export function retirePreviousMap(root) {
  const map = path.join(root, 'mindmodel', 'mindmodel.json');
  let isFile = false;
  try {
    isFile = fs.statSync(map).isFile();
  } catch {
    // no map yet: nothing to retire
  }
  if (!isFile) return null;
  const kept = path.join(ensureWork(root), 'previous-mindmodel.json');
  fs.renameSync(map, kept); // an older copy is replaced: the latest previous map is the only useful one
  return kept;
}

/** A reader that loads each file once per scan: several families read the same config and frontend files. */
function memoizedReader() {
  const texts = new Map();
  return (file) => {
    if (!texts.has(file)) texts.set(file, fs.readFileSync(file, 'utf8'));
    return texts.get(file);
  };
}

/** The checkout's files, the Java files the dump reads, and the build files. */
export function inventory(root) {
  const files = walk(root);
  const R = (p) => relPosix(root, p);
  const read = memoizedReader();
  const byExt = {};
  for (const f of files) {
    const e = path.extname(f).slice(1) || '(none)';
    byExt[e] = (byExt[e] ?? 0) + 1;
  }
  // The Java files, by path: the dump is the only reader of them; the scan itself never opens one.
  const javaAll = files.filter((f) => f.endsWith('.java') && !isTestCode(f)).map((p) => ({ p: R(p) }));
  // The build, read as data: modules, coordinates, properties, plugins (evidence/build.mjs).
  const buildFiles = readBuild(root, files.map(R));
  return { root, files, R, read, byExt, javaAll, buildFiles };
}

// --- docs, git and activity ---------------------------------------------------------

/** The docs in the repo: their size in KB and their first heading. */
export function docsOf(files, R, read) {
  return files
    .filter((f) => /\.(md|adoc|rst)$/i.test(f))
    .map((f) => {
      const t = read(f);
      return {
        file: R(f),
        kb: Math.round(t.length / 102.4) / 10,
        title: (/^#\s+(.+)$/m.exec(t)?.[1] ?? '').slice(0, 90),
      };
    });
}
