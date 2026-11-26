import fs from 'node:fs';
import path from 'node:path';
import { NON_SERVICE_DIRS, relPosix } from '../core/paths.mjs';
import { simple } from '../core/names.mjs';
import { patternOf, listOf } from '../catalogs/catalog.mjs';
import { dumpFor } from '../io/dump-run.mjs';
import { open as openDump } from '../dump.mjs';
import { buildModelFromDump } from '../model/from-dump-model.mjs';

export function findServices(folder) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > 2) return;
    const has = (f) => fs.existsSync(path.join(dir, f));
    if (
      (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) &&
      fs.existsSync(path.join(dir, 'src/main'))
    ) {
      out.push(dir);
      return;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory() && !e.name.startsWith('.') && !NON_SERVICE_DIRS.has(e.name))
        visit(path.join(dir, e.name), depth + 1);
  };
  visit(folder, 0);
  return out;
}

const javaFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!/^(test|target|build)$/.test(e.name)) walk(p);
      } else if (e.name.endsWith('.java')) out.push(p);
    }
  };
  walk(path.join(dir, 'src/main'));
  return out;
};

// The build markers of a Jakarta EE or MicroProfile deployable: a war or ear packaging, or a server plugin.
const EE_BUILD = new RegExp(
  '<packaging>\\s*(war|ear)\\s*<|quarkus-maven-plugin|liberty-maven-plugin|wildfly(-jar)?-maven-plugin|' +
    'payara-micro-maven-plugin|tomee-maven-plugin',
);
// An app is a Spring Boot configuration class, a Spring Boot servlet initializer (a WAR), or a Jakarta EE /
// MicroProfile deployable (a WAR or EAR, or a server plugin in its build).
const eeApp = (dir) => {
  const p = path.join(dir, 'pom.xml');
  if (!fs.existsSync(p)) return false;
  const t = fs.readFileSync(p, 'utf8');
  return (
    !/<packaging>\s*pom\s*</.test(t) &&
    EE_BUILD.test(
      t,
    )
  );
};

const BOOT_START = listOf('boot-start-annotations');
// A Spring Boot app declares one of the boot annotations, extends the servlet initializer (a WAR), or runs
// `SpringApplication.run` from a main method — the dump's `isMain` and the call's receiver type say so.
const bootsFromMain = (t) =>
  (t.methods ?? []).some(
    (m) => m.isMain && (m.calls ?? []).some((c) => patternOf('spring-application-receivers').test(c.recvFqn ?? '')),
  );
export const isApp = (dir, types) =>
  eeApp(dir) ||
  (types ?? []).some(
    (t) =>
      (t.ann ?? []).some((a) => BOOT_START.has(a.name)) ||
      (t.supers ?? []).some((s) => listOf('app-base-types').has(simple(s.fqn ?? s.text))) ||
      bootsFromMain(t),
  );

/** The package and imports each file wrote, from the dump's own header reader. */
export const sourcesOf = (db) =>
  new Map(
    [...db.files].map(([p, f]) => [
      p,
      {
        pkg: f.package ?? '',
        imports: (f.imports ?? []).map((i) => ({ name: i.name, wildcard: !!i.wildcard, isStatic: !!i.static })),
      },
    ]),
  );

/** A module's size, from the dump: the last line each of its types ends on. */
const linesOf = (types) => {
  const files = new Map();
  for (const t of types) files.set(t.file, Math.max(files.get(t.file) ?? 0, t.end ?? 0));
  return [...files.values()].reduce((a, b) => a + b, 0);
};

/** One dump of the whole folder, and the model built from it: the only reader of the modules' Java. */
export function folderModel(folder, modules) {
  const rels = modules.flatMap((d) => javaFiles(d).map((p) => relPosix(folder, p)));
  if (!rels.length) return null;
  const run = dumpFor(folder, rels, { outDir: path.join(folder, 'mindmodel-system', '.work', 'dump') });
  if (!run.ok) throw new Error(`mindmodel: no engine dump for ${rels.length} Java file(s) (${run.reason})`);
  const db = openDump(run.dir);
  return { db, model: buildModelFromDump(db, sourcesOf(db)) };
}

/**
 * One module's types, out of the folder's dump. A module owning a file the folder dump could not parse has a sibling
 * declaring the same type (a lambda or API variant); that module is dumped again on its own, because its build is what
 * its calls belong to and a copied class name must not empty its messaging.
 */
export function moduleOf(folder, dir, db, model, collided) {
  const rel = relPosix(folder, dir);
  // A module at the folder itself has no prefix: its files are already relative to the folder.
  const prefix = rel ? `${rel}/` : '';
  // Two dumps on purpose: the folder's resolves calls across modules; a collided module is dumped alone (no classpath).
  if (collided.has(dir)) {
    const own = dumpFor(dir, javaFiles(dir).map((p) => relPosix(dir, p)));
    if (own.ok) {
      const ownDb = openDump(own.dir);
      const ownModel = buildModelFromDump(ownDb, sourcesOf(ownDb));
      const types = [...ownModel.types.values()];
      return { dir, prefix, db: ownDb, model: ownModel, types, lines: linesOf(types) };
    }
  }
  const types = [...model.types.values()].filter((t) => t.file.startsWith(prefix));
  return { dir, prefix, db, model, types, lines: linesOf(types) };
}

/**
 * The modules that collide with a sibling: the folder dump keeps one declaration per type name, so a module that
 * copies a sibling's class (a lambda or API variant) has a file the dump could not parse, or a type file that kept no
 * type of its own. `package-info.java` and `module-info.java` declare no type and never count.
 */
export function collidedModules(folder, modules, db, model) {
  const typed = new Set([...(model?.types?.values() ?? [])].map((t) => t.file));
  const ownerOf = (rel) => modules.find((d) => rel.startsWith(`${relPosix(folder, d)}/`));
  const broken = [...(db?.files?.values() ?? [])].filter((f) => (f.errors ?? []).length).map((f) => f.path);
  const untyped = model
    ? modules.flatMap((d) => javaFiles(d).map((p) => relPosix(folder, p)))
        .filter((rel) => !/(^|\/)(package|module)-info\.java$/.test(rel) && !typed.has(rel))
    : [];
  return new Set([...broken, ...untyped].map(ownerOf).filter(Boolean));
}
