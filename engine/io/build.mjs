// Reads a checkout's build files from disk and hands their text to evidence/build.mjs, which parses it. The only reader
// of build files; nothing here runs a build.
import fs from 'node:fs';
import path from 'node:path';
import { buildFileOf, isBuildFile, readVersionCatalog } from '../evidence/build.mjs';

export function readBuild(root, rels) {
  const versionCatalog = rels.find((r) => /(^|\/)gradle\/libs\.versions\.toml$/.test(r));
  const libs = versionCatalog
    ? readVersionCatalog(fs.readFileSync(path.join(root, versionCatalog), 'utf8'))
    : new Map();
  const out = [];
  for (const rel of rels.filter(isBuildFile)) {
    const parsed = buildFileOf(rel, fs.readFileSync(path.join(root, rel), 'utf8'), libs);
    if (parsed) out.push(parsed);
  }
  return out;
}
