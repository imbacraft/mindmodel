// The Lombok jar's lookup and fetch, with a fake HOME: the user's Maven repository, Gradle cache and mindmodel
// cache are temporary folders, and the network is an injected fetch. Nothing here reaches Maven Central.
import '../test-support/strict.mjs';
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheFile, declaredLombok, ensureLombok, locateLombok, lombokOf } from '../engine/io/lombok-jar.mjs';

const VERSION = '1.18.34';
const JAR = Buffer.from('not really a jar, but bytes Central would serve');
const CENTRAL = `https://repo1.maven.org/maven2/org/projectlombok/lombok/${VERSION}/lombok-${VERSION}.jar`;

// A fake HOME with the variables the lookup reads; the real environment is put back by `restore`.
function sandbox(env = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mm-lombok-'));
  const set = {
    HOME: dir,
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    GRADLE_USER_HOME: path.join(dir, 'gradle-home'),
    MINDMODEL_LOMBOK: undefined,
    ...env,
  };
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return {
    dir,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function putFile(file, body = JAR) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// A fetch that serves `files` (url -> body) and answers 404 for anything else; `calls` records every URL asked for.
function fakeFetch(files) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const body = files.get(url);
    if (body === undefined)
      return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => Buffer.alloc(0) };
    return { ok: true, status: 200, text: async () => body.toString(), arrayBuffer: async () => body };
  };
  return { fetch, calls };
}

const sha = (algo, bytes) => crypto.createHash(algo).update(bytes).digest('hex');

test('locate: the Maven repository first, then the Gradle cache, then the mindmodel cache', () => {
  const s = sandbox();
  try {
    assert.equal(locateLombok(VERSION), null, 'an empty home has no Lombok');

    const cached = putFile(cacheFile(VERSION));
    assert.deepStrictEqual(locateLombok(VERSION), { path: cached, source: 'cache' });

    const gradle = putFile(
      path.join(s.dir, 'gradle-home', 'caches', 'modules-2', 'files-2.1', 'org.projectlombok', 'lombok', VERSION,
        'abc123', `lombok-${VERSION}.jar`),
    );
    assert.deepStrictEqual(locateLombok(VERSION), { path: gradle, source: 'gradle-cache' });

    const maven = putFile(path.join(s.dir, '.m2', 'repository', 'org', 'projectlombok', 'lombok', VERSION,
      `lombok-${VERSION}.jar`));
    assert.deepStrictEqual(locateLombok(VERSION), { path: maven, source: 'maven-repo' });
  } finally {
    s.restore();
  }
});

test('locate: a sources jar or another version is not the jar', () => {
  const s = sandbox();
  try {
    putFile(path.join(s.dir, '.m2', 'repository', 'org', 'projectlombok', 'lombok', VERSION,
      `lombok-${VERSION}-sources.jar`));
    putFile(path.join(s.dir, '.m2', 'repository', 'org', 'projectlombok', 'lombok', '1.18.30',
      'lombok-1.18.30.jar'));
    assert.equal(locateLombok(VERSION), null);
  } finally {
    s.restore();
  }
});

test('MINDMODEL_LOMBOK=off disables the lookup even when a copy exists', () => {
  const s = sandbox({ MINDMODEL_LOMBOK: 'off' });
  try {
    putFile(cacheFile(VERSION));
    assert.equal(locateLombok(VERSION), null);
  } finally {
    s.restore();
  }
});

test('ensure: a located jar is used with no request', async () => {
  const s = sandbox();
  try {
    const cached = putFile(cacheFile(VERSION));
    const { fetch, calls } = fakeFetch(new Map());
    assert.deepStrictEqual(await ensureLombok(VERSION, { fetch }), { ok: true, path: cached, source: 'cache' });
    assert.deepStrictEqual(calls, []);
  } finally {
    s.restore();
  }
});

test('ensure: a missing jar is fetched from Central once, checked against its sha1 and cached', async () => {
  const s = sandbox();
  try {
    const digest = Buffer.from(`${sha('sha1', JAR)}  lombok-${VERSION}.jar\n`);
    const files = new Map([[`${CENTRAL}.sha1`, digest], [CENTRAL, JAR]]);
    const { fetch, calls } = fakeFetch(files);
    const r = await ensureLombok(VERSION, { fetch });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'download');
    assert.equal(r.path, cacheFile(VERSION));
    assert.deepStrictEqual(fs.readFileSync(r.path), JAR);
    // sha512 is asked for first and missing here, so sha1 is the digest used.
    assert.deepStrictEqual(calls, [`${CENTRAL}.sha512`, `${CENTRAL}.sha1`, CENTRAL]);
    assert.ok(calls.every((u) => u.startsWith('https://repo1.maven.org/maven2/org/projectlombok/lombok/')));
    // Second use: located in the cache, no second request.
    assert.equal((await ensureLombok(VERSION, { fetch })).source, 'cache');
    assert.equal(calls.length, 3);
  } finally {
    s.restore();
  }
});

test('ensure: a sha512 published beside the jar is the digest used', async () => {
  const s = sandbox();
  try {
    const files = new Map([[`${CENTRAL}.sha512`, Buffer.from(sha('sha512', JAR))], [CENTRAL, JAR]]);
    const r = await ensureLombok(VERSION, { fetch: fakeFetch(files).fetch });
    assert.equal(r.source, 'download');
  } finally {
    s.restore();
  }
});

test('ensure: a jar that does not match its published digest is refused and nothing is cached', async () => {
  const s = sandbox();
  try {
    const files = new Map([[`${CENTRAL}.sha1`, Buffer.from(sha('sha1', 'another jar'))], [CENTRAL, JAR]]);
    const r = await ensureLombok(VERSION, { fetch: fakeFetch(files).fetch });
    assert.equal(r.ok, false);
    assert.match(r.reason, /checksum mismatch/);
    assert.equal(fs.existsSync(cacheFile(VERSION)), false);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(cacheFile(VERSION))), []);
  } finally {
    s.restore();
  }
});

test('ensure: no published digest means no download', async () => {
  const s = sandbox();
  try {
    const { fetch, calls } = fakeFetch(new Map([[CENTRAL, JAR]]));
    const r = await ensureLombok(VERSION, { fetch });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no checksum/);
    assert.equal(calls.includes(CENTRAL), false, 'the jar is not fetched without a digest to check it by');
  } finally {
    s.restore();
  }
});

test('ensure: downloads off, local-only mode, no version, and a bad version all answer without a request', async () => {
  const s = sandbox();
  try {
    const { fetch, calls } = fakeFetch(new Map([[CENTRAL, JAR]]));
    assert.equal((await ensureLombok(VERSION, { download: false, fetch })).ok, false);
    assert.match((await ensureLombok(VERSION, { download: false, fetch })).reason, /downloads are off/);
    assert.match((await ensureLombok(null, { fetch })).reason, /declare no Lombok version/);
    assert.match((await ensureLombok('../1.0', { fetch })).reason, /not a Lombok version/);
    process.env.MINDMODEL_LOMBOK = 'local';
    assert.match((await ensureLombok(VERSION, { fetch })).reason, /downloads are off/);
    process.env.MINDMODEL_LOMBOK = 'off';
    assert.equal((await ensureLombok(VERSION, { fetch })).reason, 'MINDMODEL_LOMBOK=off');
    assert.deepStrictEqual(calls, []);
  } finally {
    s.restore();
  }
});

test('lombokOf reads the project: a POM version, a managed version, and a Gradle catalog', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mm-lombok-project-'));
  try {
    fs.writeFileSync(path.join(dir, 'pom.xml'), `<project><artifactId>app</artifactId><dependencyManagement><dependencies>
      <dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId>
      <version>1.18.30</version></dependency>
      </dependencies></dependencyManagement><dependencies><dependency><groupId>org.projectlombok</groupId>
      <artifactId>lombok</artifactId></dependency></dependencies></project>`);
    // The module declares the use; the root pins the version, so the root's version is the one reported.
    fs.mkdirSync(path.join(dir, 'core'));
    fs.writeFileSync(path.join(dir, 'core', 'pom.xml'), '<project><artifactId>core</artifactId></project>');
    assert.deepStrictEqual(lombokOf(dir), { used: true, version: '1.18.30' });

    fs.rmSync(path.join(dir, 'pom.xml'));
    fs.mkdirSync(path.join(dir, 'gradle'));
    fs.writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'),
      '[versions]\nlombok = "1.18.36"\n[libraries]\n' +
      'lombok = { module = "org.projectlombok:lombok", version.ref = "lombok" }\n');
    fs.writeFileSync(path.join(dir, 'build.gradle.kts'), 'dependencies { annotationProcessor(libs.lombok) }');
    assert.deepStrictEqual(lombokOf(dir), { used: true, version: '1.18.36' });

    // A project without Lombok: nothing to say, nothing to fetch.
    fs.rmSync(path.join(dir, 'build.gradle.kts'));
    assert.deepStrictEqual(lombokOf(dir), { used: false, version: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('declaredLombok: a dependency without a version is used, with no version to fetch', () => {
  assert.deepStrictEqual(declaredLombok([{ deps: [{ group: 'org.projectlombok', artifact: 'lombok' }] }]), {
    used: true,
    version: null,
  });
});
