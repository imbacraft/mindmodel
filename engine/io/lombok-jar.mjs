// Where the Lombok jar comes from, for a project that uses Lombok. The members Lombok generates (getters, builders)
// are not in the source, so the engine needs the jar to see them. The version is the one the project's own build
// names, or the one the Spring Boot BOM it inherits manages. The jar is taken from the user's Maven repository or
// Gradle cache when present; otherwise it is fetched from Maven Central once per version and kept in the mindmodel cache,
// after its digest is checked against the one Central publishes.
//
// Preflight asks for it and never blocks: without a jar the hand-written Lombok rules are used, and the map says so.
// MINDMODEL_LOMBOK=off turns the fetch off; MINDMODEL_LOMBOK=local keeps the local lookup and forbids the download.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuild } from './build.mjs';
import { buildFileOf, pomPropertyOf, readVersionCatalog } from '../evidence/build.mjs';
import { cacheRoot, fetchVerified, hashFile } from './download.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = path.join(HERE, '..', 'catalogs', 'versions', 'lombok-by-boot.json');
const CENTRAL = 'https://repo1.maven.org/maven2/org/projectlombok/lombok';
const DIGEST_HEX_CHARS = { sha512: 128, sha1: 40 };
// The build files that name a version. A root-level `libs.versions.toml` is not Gradle's convention, so not read.
const BUILD_NAME = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|gradle\/libs\.versions\.toml)$/;
// The same bounds as the classpath's walk: directories a build does not keep its own build files in, and a depth cap.
const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'mindmodel']);
const MAX_DEPTH = 6;

const mode = () => process.env.MINDMODEL_LOMBOK || 'auto';
const isFile = (file) => fs.existsSync(file) && fs.statSync(file).isFile();
const gradleHome = () => process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * A version Maven Central could hold: dotted digits, then optional dash parts (`1.18.34`, `1.18.36-edge-SNAPSHOT`).
 * It becomes a path segment, so anything with a slash, a `..` or a Maven range or property is refused here.
 */
export function validVersion(version) {
  return typeof version === 'string' && /^\d+(\.\d+)+(-[A-Za-z0-9]+)*$/.test(version);
}

/** Numeric parts in order; a release sorts after its own pre-release (`1.18.36` after `1.18.36-edge`). */
export function compareVersions(a, b) {
  const parts = (v) => v.split('-')[0].split('.').map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return (a.includes('-') ? 0 : 1) - (b.includes('-') ? 0 : 1);
}

/** `~/.cache/mindmodel/lombok/<version>/lombok.jar`. The version is checked again here: it is a path. */
export function cacheFile(version) {
  if (!validVersion(version)) throw new Error(`not a Lombok version: ${version}`);
  return path.join(cacheRoot(), 'lombok', version, 'lombok.jar');
}

/** The Lombok a set of parsed builds declares: `used` when a dependency names it, `version` the first valid one. */
export function declaredLombok(builds) {
  const isLombok = (d) => d.group === 'org.projectlombok' && d.artifact === 'lombok';
  const used = builds.some((b) => (b.deps ?? []).some(isLombok));
  const versions = builds.flatMap((b) => [...(b.deps ?? []), ...(b.managedDeps ?? [])]).filter(isLombok);
  return { used, version: versions.map((d) => d.version).find(validVersion) ?? null };
}

// The Spring Boot version a build names: a Maven parent, an imported BOM, a Gradle plugin or a platform() dependency.
const isBootBom = (d) => d.group === 'org.springframework.boot' && d.artifact === 'spring-boot-dependencies';
export function bootVersionOf(builds) {
  const found = builds.flatMap((b) => [
    b.parent?.group === 'org.springframework.boot' && b.parent.artifact === 'spring-boot-starter-parent'
      ? b.parent.version
      : null,
    ...(b.deps ?? []).filter(isBootBom).map((d) => d.version),
    ...(b.managedDeps ?? []).filter(isBootBom).map((d) => d.version),
    ...(b.plugins ?? []).filter((p) => p.id === 'org.springframework.boot').map((p) => p.version),
  ]);
  return found.find(validVersion) ?? null;
}

// The build files under `root`, shallowest first, so the root's declaration wins over a module's.
function buildFilesOf(root) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable: no build file here can be read
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) visit(full, depth + 1);
      else if (BUILD_NAME.test(rel)) found.push(rel);
    }
  };
  visit(root, 0);
  return found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

// Gradle's files sit under a hash directory per download: `<version>/<hash>/<file>`.
function gradleFileOf(versionDir, file) {
  return listDir(versionDir)
    .map((h) => path.join(versionDir, h, file))
    .find(isFile) ?? null;
}

/**
 * An artifact file the user already has: the Maven repository, then the Gradle cache. `group` is dotted. Returns
 * `{ path, source }` or null. Nothing is downloaded or written.
 */
export function localFile(group, artifact, version, file) {
  if (!validVersion(version)) return null;
  const maven = path.join(os.homedir(), '.m2', 'repository', ...group.split('.'), artifact, version, file);
  if (isFile(maven)) return { path: maven, source: 'maven-repo' };
  const versionDir = path.join(gradleHome(), 'caches', 'modules-2', 'files-2.1', group, artifact, version);
  const gradle = gradleFileOf(versionDir, file);
  return gradle ? { path: gradle, source: 'gradle-cache' } : null;
}

/**
 * The jar for `version` the user already has: the Maven repository, then the Gradle cache, then the mindmodel cache.
 * Returns `{ path, source }` or null.
 */
export function locateLombok(version) {
  if (mode() === 'off' || !validVersion(version)) return null;
  const local = localFile('org.projectlombok', 'lombok', version, `lombok-${version}.jar`);
  if (local) return local;
  const cached = cacheFile(version);
  return isFile(cached) ? { path: cached, source: 'cache' } : null;
}

// The Lombok version a Spring Boot BOM manages, when that BOM's pom is local. Null when there is no such file.
function lombokFromBootBom(boot) {
  const pom = `spring-boot-dependencies-${boot}.pom`;
  const found = localFile('org.springframework.boot', 'spring-boot-dependencies', boot, pom);
  if (!found) return null;
  let version = null;
  try {
    version = pomPropertyOf(fs.readFileSync(found.path, 'utf8'), 'lombok.version');
  } catch {
    return null; // an unreadable BOM is no BOM to read from
  }
  if (!validVersion(version)) return null;
  return { version, detail: `the lombok.version of the spring-boot-dependencies ${boot} BOM (${found.source})` };
}

// The Lombok version for a Spring Boot minor line, from the table beside the catalogs. Null when the line has no row.
function lombokFromTable(boot) {
  const minor = boot.split('.').slice(0, 2).join('.');
  const version = JSON.parse(fs.readFileSync(TABLE, 'utf8')).lombok?.[minor];
  if (!validVersion(version)) return null;
  return { version, detail: `the Spring Boot ${minor} row of engine/catalogs/versions/lombok-by-boot.json` };
}

/** The newest Lombok version with a jar in any local store, or null. A guess: the project's own version is unknown. */
export function newestLocalLombok() {
  const names = [
    ...listDir(path.join(os.homedir(), '.m2', 'repository', 'org', 'projectlombok', 'lombok')),
    ...listDir(path.join(gradleHome(), 'caches', 'modules-2', 'files-2.1', 'org.projectlombok', 'lombok')),
    ...listDir(path.join(cacheRoot(), 'lombok')),
  ];
  const present = [...new Set(names)].filter((v) => locateLombok(v) !== null).sort(compareVersions);
  return present[present.length - 1] ?? null;
}

const choice = (version, rule, detail, approximate = false) => ({ used: true, version, rule, detail, approximate });

/**
 * The Lombok declaration of the checkout at `root`, and the rule that chose its version: `declared` (the build names
 * it), `boot-bom` (the Spring Boot BOM's pom is local), `boot-table` (the table row for the Boot line), or
 * `newest-local` (an approximation). `version` is null when no rule applies. Reads files only; nothing is run.
 */
export function lombokOf(root) {
  const builds = readBuild(root, buildFilesOf(root));
  const declared = declaredLombok(builds);
  if (!declared.used) return { used: false, version: null, rule: null, detail: null, approximate: false };
  if (declared.version) return choice(declared.version, 'declared', 'declared in the build files');
  const boot = bootVersionOf(builds);
  const bom = boot && lombokFromBootBom(boot);
  if (bom) return choice(bom.version, 'boot-bom', bom.detail);
  const row = boot && lombokFromTable(boot);
  if (row) return choice(row.version, 'boot-table', row.detail);
  const newest = newestLocalLombok();
  if (newest) return choice(newest, 'newest-local', 'the newest Lombok already local', true);
  return choice(null, null, 'no version declared, and no Spring Boot BOM, table row or local Lombok jar gives one');
}

// The digest Central publishes beside the jar: sha512 where it exists, else sha1. Never none: an unverified jar is
// not cached.
async function publishedDigest(jarUrl, fetch) {
  for (const algo of ['sha512', 'sha1']) {
    const response = await fetch(`${jarUrl}.${algo}`, { redirect: 'follow' });
    if (!response.ok) continue;
    const hex = /^[0-9a-fA-F]+/.exec((await response.text()).trim())?.[0].toLowerCase() ?? '';
    if (hex.length !== DIGEST_HEX_CHARS[algo]) throw new Error(`the ${algo} file from Maven Central is not a digest`);
    return { algo, hex };
  }
  throw new Error('Maven Central publishes no checksum for this jar');
}

/** Fetches the jar from Maven Central into the cache, verified against its published digest. Returns the path. */
export async function downloadLombok(version, fetch = globalThis.fetch) {
  const url = `${CENTRAL}/${version}/lombok-${version}.jar`;
  const { algo, hex } = await publishedDigest(url, fetch);
  const dest = cacheFile(version);
  await fetchVerified({
    url,
    dest,
    fetch,
    verify: (temp) => {
      if (hashFile(temp, algo) !== hex) throw new Error('checksum mismatch: the jar is not the one Central publishes');
    },
  });
  return dest;
}

/**
 * A Lombok jar for `version`, fetched if need be. Returns `{ ok, path, source }` or `{ ok: false, reason }`, where the
 * reason is a phrase preflight prints. Never throws.
 */
export async function ensureLombok(version, { download = true, fetch = globalThis.fetch } = {}) {
  if (mode() === 'off') return { ok: false, reason: 'MINDMODEL_LOMBOK=off' };
  if (!version) return { ok: false, reason: 'no Lombok version could be chosen' };
  if (!validVersion(version)) return { ok: false, reason: `"${version}" is not a Lombok version` };
  const found = locateLombok(version);
  if (found) return { ok: true, ...found };
  if (!download || mode() === 'local')
    return { ok: false, reason: `no local copy of Lombok ${version} and downloads are off` };
  try {
    return { ok: true, path: await downloadLombok(version, fetch), source: 'download' };
  } catch (error) {
    return { ok: false, reason: `the Lombok ${version} download failed (${error.message})` };
  }
}

{
  for (const v of ['1.18.34', '1.18.36-edge-SNAPSHOT']) assert.ok(validVersion(v), v);
  for (const v of ['../1.0', '1.0/../2', '1..2', '[1.18,)', '${lombok.version}', '', undefined, '1.18.34\n'])
    assert.equal(validVersion(v), false, String(v));
  assert.throws(() => cacheFile('1.0/../../x'), /not a Lombok version/);
}

{
  assert.ok(compareVersions('1.18.34', '1.18.9') > 0);
  assert.ok(compareVersions('1.18.36', '1.18.36-edge-SNAPSHOT') > 0);
  assert.equal(compareVersions('1.18.36', '1.18.36'), 0);
}

{
  const pom = buildFileOf(
    'pom.xml',
    `<project><artifactId>app</artifactId><properties><lombok.version>1.18.30</lombok.version></properties>
     <dependencies><dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId>
     <version>\${lombok.version}</version></dependency></dependencies></project>`,
  );
  assert.deepStrictEqual(declaredLombok([pom]), { used: true, version: '1.18.30' });

  // Managed but not used: a root POM that only pins the version declares no use of Lombok.
  const managed = buildFileOf(
    'pom.xml',
    `<project><dependencyManagement><dependencies><dependency><groupId>org.projectlombok</groupId>
     <artifactId>lombok</artifactId><version>1.18.34</version></dependency></dependencies>
     </dependencyManagement></project>`,
  );
  assert.deepStrictEqual(declaredLombok([managed]), { used: false, version: '1.18.34' });

  // A parent-managed version is not in the file: used, with no version to fetch.
  const parentManaged = buildFileOf(
    'pom.xml',
    `<project><artifactId>app</artifactId><dependencies><dependency><groupId>org.projectlombok</groupId>
     <artifactId>lombok</artifactId></dependency></dependencies></project>`,
  );
  assert.deepStrictEqual(declaredLombok([parentManaged]), { used: true, version: null });
  assert.deepStrictEqual(declaredLombok([buildFileOf('pom.xml', '<project><artifactId>x</artifactId></project>')]), {
    used: false,
    version: null,
  });
}

{
  const gradle = buildFileOf(
    'build.gradle',
    "dependencies {\n  compileOnly 'org.projectlombok:lombok:1.18.32'\n" +
      "  annotationProcessor 'org.projectlombok:lombok:1.18.32'\n}",
  );
  assert.deepStrictEqual(declaredLombok([gradle]), { used: true, version: '1.18.32' });

  const libs = readVersionCatalog(
    '[versions]\nlombok = "1.18.36"\n[libraries]\n' +
      'lombok = { module = "org.projectlombok:lombok", version.ref = "lombok" }',
  );
  const kts = buildFileOf('build.gradle.kts', 'dependencies { compileOnly(libs.lombok) }', libs);
  assert.deepStrictEqual(declaredLombok([kts]), { used: true, version: '1.18.36' });
}

{
  const parent = buildFileOf(
    'pom.xml',
    `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId>
     <version>3.4.1</version></parent><artifactId>app</artifactId></project>`,
  );
  assert.equal(bootVersionOf([parent]), '3.4.1');
  const plugin = buildFileOf('build.gradle', "plugins { id 'org.springframework.boot' version '3.3.5' }");
  assert.equal(bootVersionOf([plugin]), '3.3.5');
  const platform = buildFileOf(
    'build.gradle',
    "dependencies { implementation platform('org.springframework.boot:spring-boot-dependencies:3.2.0') }",
  );
  assert.equal(bootVersionOf([platform]), '3.2.0');
  assert.equal(bootVersionOf([buildFileOf('pom.xml', '<project><artifactId>x</artifactId></project>')]), null);
}
