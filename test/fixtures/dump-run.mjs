// Fixtures run through the real engine: inline Java is written to a scratch dir, the jar dumps it, and the model is
// built from that dump — the same path a scan takes. Nothing here parses Java; a test that needs a dump skips when the
// jar has not been built.
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

/**
 * One dump of one set of sources: `files` is `{ 'src/main/java/shop/F.java': text }`. Returns the open dump, the model
 * built from it (which carries the dump, so the extractors can query it) and the file→package/imports map.
 */
export function dumpOf(files, known = new Set()) {
  // A real path, not the /var symlink: the dump relativises its file paths against the root it was given.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mindmodel-fixture-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  const list = path.join(dir, 'files.txt');
  fs.writeFileSync(list, Object.keys(files).sort().join('\n') + '\n');
  const out = path.join(dir, 'dump');
  execFileSync('java', ['-jar', JAR, 'dump', '--contract', String(CONTRACT), dir, list, out], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  const model = buildModelFromDump(db, sources, known);
  return { db, model, sources, dir };
}
