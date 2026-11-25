// Reads a checkout's build files from disk and hands their text to evidence/build.mjs, which parses it. The only reader
// of build files; nothing here runs a build.
import fs from 'node:fs';
import path from 'node:path';
import { buildFileOf, isBuildFile, readVersionCatalog } from '../evidence/build.mjs';

// `read` takes an absolute path and returns its text: a scan passes its per-scan reader, so a POM is read once.
export function readBuild(root, rels, read = (p) => fs.readFileSync(p, 'utf8')) {
  const versionCatalog = rels.find((r) => /(^|\/)gradle\/libs\.versions\.toml$/.test(r));
  const libs = versionCatalog
    ? readVersionCatalog(read(path.join(root, versionCatalog)))
    : new Map();
  const out = [];
  for (const rel of rels.filter(isBuildFile)) {
    const parsed = buildFileOf(rel, read(path.join(root, rel)), libs);
    if (parsed) out.push(parsed);
  }
  return out;
}
