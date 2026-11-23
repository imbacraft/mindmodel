// Corpus configuration for the tests. The public list lives in apps.json; a checkout that also has a private app adds
// test/apps.local.json (gitignored) with the same shape, and the two are merged. Nothing in a tracked file names a
// private app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadApps(dir = here) {
  const read = (name) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const pub = read('apps.json') ?? { root: '~/Projects/test-apps', apps: [], systems: [] };
  const local = read('apps.local.json') ?? {};
  const merge = (a = [], b = []) => {
    const byName = new Map(a.map((x) => [x.name, { ...x }]));
    for (const x of b) byName.set(x.name, { ...x, local: true });
    return [...byName.values()];
  };
  return {
    root: (local.root ?? pub.root).replace(/^~/, os.homedir()),
    apps: merge(pub.apps, local.apps),
    systems: merge(pub.systems, local.systems),
  };
}

// An app may live outside the corpus root (`dir`); the tests skip one that is not cloned.
export const dirOf = (cfg, app) => app.dir ?? path.join(cfg.root, app.name);
