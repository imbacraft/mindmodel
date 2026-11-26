// Where the Lombok jar comes from, for a project that uses Lombok. The members Lombok generates (getters, builders)
// are not in the source, so the engine needs the jar to see them. The version is the one the project's own build
// names. The jar is taken from the user's Maven repository or Gradle cache when present; otherwise it is fetched
// from Maven Central once per version and kept in the mindmodel cache, after its digest is checked against the one
// Central publishes.
//
// Preflight asks for it and never blocks: without a jar the hand-written Lombok rules are used, and the map says so.
// MINDMODEL_LOMBOK=off turns all of this off; MINDMODEL_LOMBOK=local keeps the local lookup and forbids the download.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBuild } from './build.mjs';
import { buildFileOf, readVersionCatalog } from '../evidence/build.mjs';
import { cacheRoot, fetchVerified, hashFile } from './download.mjs';

const CENTRAL = 'https://repo1.maven.org/maven2/org/projectlombok/lombok';
const DIGEST_HEX_CHARS = { sha512: 128, sha1: 40 };
// The build files that name a version. A root-level `libs.versions.toml` is not Gradle's convention, so not read.
const BUILD_NAME = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|gradle\/libs\.versions\.toml)$/;
// The same bounds as the classpath's walk: directories a build does not keep its own build files in, and a depth cap.
const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'mindmodel']);
const MAX_DEPTH = 6;

const mode = () => process.env.MINDMODEL_LOMBOK || 'auto';
const isFile = (file) => fs.existsSync(file) && fs.statSync(file).isFile();

/**
 * A version Maven Central could hold: dotted digits, then optional dash parts (`1.18.34`, `1.18.36-edge-SNAPSHOT`).
 * It becomes a path segment, so anything with a slash, a `..` or a Maven range or property is refused here.
 */
export function validVersion(version) {
  return typeof version === 'string' && /^\d+(\.\d+)+(-[A-Za-z0-9]+)*$/.test(version);
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

/** The Lombok declaration of the checkout at `root`. Reads the build files only; nothing is run. */
export function lombokOf(root) {
  return declaredLombok(readBuild(root, buildFilesOf(root)));
}

// Gradle's jars sit under a hash directory per download: `<version>/<hash>/lombok-<version>.jar`.
function gradleJarOf(versionDir, jar) {
  let hashes;
  try {
    hashes = fs.readdirSync(versionDir);
  } catch {
    return null;
  }
  return hashes.map((h) => path.join(versionDir, h, jar)).find(isFile) ?? null;
}

/**
 * The jar for `version` the user already has: the Maven repository, then the Gradle cache, then the mindmodel cache.
 * Returns `{ path, source }` or null.
 */
export function locateLombok(version) {
  if (mode() === 'off' || !validVersion(version)) return null;
  const jar = `lombok-${version}.jar`;
  const home = os.homedir();
  const maven = path.join(home, '.m2', 'repository', 'org', 'projectlombok', 'lombok', version, jar);
  if (isFile(maven)) return { path: maven, source: 'maven-repo' };
  const gradleHome = process.env.GRADLE_USER_HOME || path.join(home, '.gradle');
  const gradleDir = path.join(gradleHome, 'caches', 'modules-2', 'files-2.1', 'org.projectlombok', 'lombok', version);
  const gradle = gradleJarOf(gradleDir, jar);
  if (gradle) return { path: gradle, source: 'gradle-cache' };
  const cached = cacheFile(version);
  if (isFile(cached)) return { path: cached, source: 'cache' };
  return null;
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
  if (!version)
    return { ok: false, reason: 'the build files declare no Lombok version; a parent or BOM may manage it' };
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
