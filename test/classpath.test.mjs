// The classpath (Part A), end to end and without the network: a tiny Maven project whose holder lives in a jar, a local
// repository built at test time from javac output, and the real engine reading the dump the scan would read. Maven is
// offline throughout; anything that needs the network is not tested here, because the product never does it.
//
// Skips when Maven or the engine jar is absent, rather than pretending: the run needs both.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTRACT, open } from '../engine/dump.mjs';
import { buildModelFromDump } from '../engine/model/from-dump-model.mjs';
import { authSources, tenantSources } from '../engine/extract/security.mjs';
import { mavenTool, resolve } from '../engine/classpath.mjs';
import { dumpFor } from '../engine/run.mjs';
import { scan, summarize } from '../engine/scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const jar = process.env.MINDMODEL_ENGINE_JAR ?? path.join(repo, 'engine-java/target/mindmodel-engine.jar');
const skip = !fs.existsSync(jar)
  ? 'engine jar not built (mvn -f engine-java/pom.xml package)'
  : !mavenTool()
    ? 'mvn not on PATH'
    : false;

const real = (p) => fs.realpathSync(p);
const L = (...x) => x.join('\n');

// The holder, in a jar: exactly the shape that is invisible without a classpath — a static ThreadLocal, a setter and a
// clearer, all in a library the checkout does not contain.
const HOLDER = L(
  'package com.acme.holder;',
  'public final class ContextHolder {',
  '  private static final ThreadLocal<String> CONTEXT = new ThreadLocal<>();',
  '  public static void setContext(String value) { CONTEXT.set(value); }',
  '  public static String getContext() { return CONTEXT.get(); }',
  '  public static void clearContext() { CONTEXT.remove(); }',
  '}',
);
// A class whose static initialiser throws: reading it must never run that initialiser.
const BOOM = L('package com.acme.holder;', 'public final class Boom {', '  static { if (true) throw new RuntimeException("ran"); }', '}');

// The project: two Maven modules, and a filter that stores the caller from a cookie through the library holder.
const FILTER = L(
  'package shop;',
  'import com.acme.holder.ContextHolder;',
  'import jakarta.servlet.http.Cookie;',
  'import jakarta.servlet.http.HttpServletRequest;',
  'public class ContextFilter {',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    try {',
  '      for (Cookie c : request.getCookies()) {',
  '        if (c.getName().equals("cluster")) {',
  '          remember(c.getValue());',
  '        }',
  '      }',
  '    } finally {',
  '      ContextHolder.clearContext();',
  '    }',
  '  }',
  '',
  '  private void remember(String value) {',
  '    ContextHolder.setContext(value);',
  '  }',
  '}',
);

/** javac + jar: a class directory and a jar, from source text. */
function compile(dir, files) {
  const out = path.join(dir, 'classes');
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, 'src', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  const sources = Object.keys(files).map((rel) => path.join(dir, 'src', rel));
  execFileSync('javac', ['-d', out, ...sources], { stdio: ['ignore', 'ignore', 'pipe'] });
  const jarFile = path.join(dir, 'lib.jar');
  execFileSync('jar', ['cf', jarFile, '-C', out, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return jarFile;
}

/** A local repository: every group the real `~/.m2` holds, symlinked, plus the fixture's own artifact. */
function localRepository(home2, jarFile, { withJar = true } = {}) {
  const root = fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-repo-'));
  const source = path.join(home2, 'repository');
  for (const name of fs.existsSync(source) ? fs.readdirSync(source) : [])
    fs.symlinkSync(path.join(source, name), path.join(root, name));
  // A group id that cannot collide with a real one, so nothing is ever written through a symlink into ~/.m2.
  const artifactDir = path.join(root, 'mindmodelfixture', 'holder', '1.0');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, 'holder-1.0.pom'),
    L(
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      '  <modelVersion>4.0.0</modelVersion>',
      '  <groupId>mindmodelfixture</groupId>',
      '  <artifactId>holder</artifactId>',
      '  <version>1.0</version>',
      '</project>',
    ),
  );
  if (withJar) fs.copyFileSync(jarFile, path.join(artifactDir, 'holder-1.0.jar'));
  return root;
}

const POM = (artifact, deps = [], packaging = 'jar') =>
  L(
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    '  <modelVersion>4.0.0</modelVersion>',
    '  <parent><groupId>shop</groupId><artifactId>fixture</artifactId><version>1.0</version></parent>',
    `  <artifactId>${artifact}</artifactId>`,
    `  <packaging>${packaging}</packaging>`,
    deps.length ? '  <dependencies>' : '',
    ...deps.map(
      ([g, a, v]) => `    <dependency><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version></dependency>`,
    ),
    deps.length ? '  </dependencies>' : '',
    '</project>',
  );

/** The two-module project: `lib` carries the dependency, `app` carries the filter and depends on `lib`. */
function project() {
  const dir = fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-cpfixture-'));
  fs.writeFileSync(
    path.join(dir, 'pom.xml'),
    L(
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      '  <modelVersion>4.0.0</modelVersion>',
      '  <groupId>shop</groupId><artifactId>fixture</artifactId><version>1.0</version>',
      '  <packaging>pom</packaging>',
      '  <modules><module>lib</module><module>app</module></modules>',
      '</project>',
    ),
  );
  fs.mkdirSync(path.join(dir, 'lib/src/main/java/lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib/pom.xml'), POM('lib', [['mindmodelfixture', 'holder', '1.0']]));
  fs.writeFileSync(
    path.join(dir, 'lib/src/main/java/lib/Shape.java'),
    L('package lib;', 'public class Shape {', '  public com.acme.holder.Boom boom;', '}'),
  );
  fs.mkdirSync(path.join(dir, 'app/src/main/java/shop'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app/pom.xml'), POM('app', [['shop', 'lib', '1.0']]));
  fs.writeFileSync(path.join(dir, 'app/src/main/java/shop/ContextFilter.java'), FILTER);
  return dir;
}

/** The scan's own environment, restored afterwards: a test never leaks MINDMODEL_* into another test. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const home2 = path.join(os.homedir(), '.m2');
const filesOf = (dir, base = dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === 'mindmodel') continue;
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(base, p));
    }
  };
  walk(dir);
  return out.sort();
};

test('classpath: a jar in the local repository makes the holder a typed store', { skip }, () => {
  const dir = project();
  const libJar = compile(fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-lib-')), {
    'com/acme/holder/ContextHolder.java': HOLDER,
    'com/acme/holder/Boom.java': BOOM,
  });
  const m2 = localRepository(home2, libJar);
  try {
    const cp = resolve(dir, { env: { ...process.env, MINDMODEL_M2: m2 } });
    assert.equal(cp.mode, 'maven-offline', `resolved offline: ${cp.reason ?? ''}`);
    assert.ok(cp.jars.some((j) => j.includes('holder-1.0.jar')), 'the fixture jar is on the classpath');

    const dump = dumpFor(dir, ['app/src/main/java/shop/ContextFilter.java', 'lib/src/main/java/lib/Shape.java'], { classpath: cp });
    assert.ok(dump.ok, dump.reason);
    const db = open(dump.dir);
    // The holder's own type is in the dump as a library row, with its static field: that is what the classpath bought.
    const holder = db.library.get('com.acme.holder.ContextHolder');
    assert.ok(holder, 'the library type is in the dump');
    assert.ok(holder.fields.some((f) => f.name === 'CONTEXT' && /ThreadLocal/.test(f.type)), 'with its static ThreadLocal');
    assert.ok(db.library.has('com.acme.holder.Boom'), 'and a class whose static initialiser throws was read, not run');
    assert.equal(fs.existsSync(path.join(dump.dir, 'library.ndjson')), true);

    const sources = new Map(
      [...db.files].map(([p, f]) => [p, { pkg: f.package ?? '', imports: (f.imports ?? []).map((i) => ({ name: i.name, wildcard: !!i.wildcard, isStatic: !!i.static })) }]),
    );
    const model = buildModelFromDump(db, sources, new Set());
    const tenant = tenantSources(model, () => '', () => false, db);
    assert.equal(tenant.length, 1, 'the cookie the filter reads is the tenant source');
    assert.deepStrictEqual([tenant[0].kind, tenant[0].name, tenant[0].storedBy], ['cookie', 'cluster', 'thread-local']);
    assert.equal(tenant[0].confidence, 'resolved', 'read from the holder type, not inferred from a shape');
    assert.equal(tenant[0].via, 'classpath');
    const users = authSources(model, () => '', () => false, db);
    assert.deepStrictEqual(users.map((u) => u.kind), ['cookie cluster (unverified)']);
    assert.match(users[0].why[0], /ContextHolder\.setContext\(/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(m2, { recursive: true, force: true });
  }
});

test('classpath: with MINDMODEL_CLASSPATH=off the same store is inferred from the try/finally shape', { skip }, () => {
  const dir = project();
  const libJar = compile(fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-lib-')), {
    'com/acme/holder/ContextHolder.java': HOLDER,
  });
  const m2 = localRepository(home2, libJar);
  try {
    const facts = withEnv({ MINDMODEL_CLASSPATH: 'off', MINDMODEL_M2: m2 }, () => scan(dir));
    assert.equal(facts.classpath.mode, 'none');
    assert.equal(facts.classpath.reason, 'MINDMODEL_CLASSPATH=off');
    assert.equal(facts.tenantSources.length, 1);
    assert.equal(facts.tenantSources[0].confidence, 'inferred');
    assert.equal(facts.tenantSources[0].via, 'try-finally-pattern');
    // And with the classpath the same scan answers from the jar instead.
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(m2, { recursive: true, force: true });
  }
});

test('classpath: an artifact missing from the repository is a named module, and the scan still runs', { skip }, () => {
  const dir = project();
  const libJar = compile(fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-lib-')), {
    'com/acme/holder/ContextHolder.java': HOLDER,
  });
  // The jar's own bytes are absent: the module that needs it cannot resolve offline.
  const m2 = localRepository(home2, libJar, { withJar: false });
  try {
    const facts = withEnv({ MINDMODEL_M2: m2 }, () => scan(dir));
    assert.ok(facts.classpath.failedModules.length >= 1, 'the module is named');
    assert.ok(facts.classpath.failedModules.some((f) => f.module === 'lib'), JSON.stringify(facts.classpath));
    // The digest says it in one line, and the run still produced a map's worth of facts.
    const digest = summarize(facts);
    assert.match(digest, /classpath: (none|maven offline)/);
    assert.ok(facts.endpoints || facts.entities);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(m2, { recursive: true, force: true });
  }
});

test('classpath: a class the engine cannot read is unresolved, and the dump completes', { skip }, () => {
  const dir = project();
  const base = compile(fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-lib-')), {
    'com/acme/holder/ContextHolder.java': HOLDER,
  });
  // Patch the class file's major version to one no JVM knows: the reader must report it, never fail the dump.
  const patched = path.join(path.dirname(base), 'patched');
  fs.mkdirSync(patched, { recursive: true });
  const unpack = path.join(patched, 'classes');
  fs.mkdirSync(unpack, { recursive: true });
  execFileSync('jar', ['xf', base], { cwd: unpack, stdio: ['ignore', 'ignore', 'pipe'] });
  const classFile = path.join(unpack, 'com/acme/holder/ContextHolder.class');
  const bytes = fs.readFileSync(classFile);
  bytes[6] = 0xff;
  bytes[7] = 0x00;
  fs.writeFileSync(classFile, bytes);
  const broken = path.join(patched, 'holder.jar');
  execFileSync('jar', ['cf', broken, '-C', unpack, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const m2 = localRepository(home2, broken);
  try {
    const cp = resolve(dir, { env: { ...process.env, MINDMODEL_M2: m2 } });
    assert.equal(cp.mode, 'maven-offline');
    const dump = dumpFor(dir, ['app/src/main/java/shop/ContextFilter.java'], { classpath: cp });
    assert.ok(dump.ok, `the dump survives one unreadable class: ${dump.reason ?? ''}`);
    const rows = fs
      .readFileSync(path.join(dump.dir, 'library.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const meta = JSON.parse(fs.readFileSync(path.join(dump.dir, 'meta.json'), 'utf8'));
    assert.ok(
      rows.some((r) => r.unresolved === 'library-class-unreadable') || meta.classpath.dropped,
      `the unreadable jar is reported, not silently ignored: ${JSON.stringify({ rows: rows.slice(0, 3), meta: meta.classpath })}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(m2, { recursive: true, force: true });
  }
});

test('classpath: two dumps of the same inputs are byte-identical, and nothing is written into the tree', { skip }, () => {
  const dir = project();
  const libJar = compile(fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-lib-')), {
    'com/acme/holder/ContextHolder.java': HOLDER,
  });
  const m2 = localRepository(home2, libJar);
  const before = filesOf(dir);
  try {
    const cp = resolve(dir, { env: { ...process.env, MINDMODEL_M2: m2 } });
    const files = ['app/src/main/java/shop/ContextFilter.java'];
    const a = dumpFor(dir, files, { classpath: cp, force: true, outDir: path.join(dir, 'mindmodel/.work/dump-a') });
    const b = dumpFor(dir, files, { classpath: cp, force: true, outDir: path.join(dir, 'mindmodel/.work/dump-b') });
    assert.ok(a.ok && b.ok);
    // Every section, and the whole directory: no timestamp, no per-run ordering.
    for (const name of fs.readdirSync(a.dir).filter((f) => f !== 'fingerprint')) {
      const ha = crypto.createHash('sha256').update(fs.readFileSync(path.join(a.dir, name))).digest('hex');
      const hb = crypto.createHash('sha256').update(fs.readFileSync(path.join(b.dir, name))).digest('hex');
      assert.equal(ha, hb, `${name} is byte-identical across dumps`);
    }
    // The scan's own writes stay under mindmodel/: the project's files are exactly what they were.
    const after = filesOf(dir, dir).filter((f) => !f.startsWith('mindmodel/') && !f.startsWith('mindmodel\\'));
    assert.deepStrictEqual(after, before, 'no file was written into the project tree');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(m2, { recursive: true, force: true });
  }
});

test('classpath: a warm scan asks Maven nothing, and the answer is the one it cached', { skip }, () => {
  const dir = project();
  const libJar = compile(fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-lib-')), {
    'com/acme/holder/ContextHolder.java': HOLDER,
  });
  const m2 = localRepository(home2, libJar);
  try {
    const cold = resolve(dir, { env: { ...process.env, MINDMODEL_M2: m2 } });
    assert.equal(cold.mode, 'maven-offline');
    // The second call must not spawn Maven: `log` is the sink its output would reach, and it stays untouched.
    let spawned = false;
    const warm = resolve(dir, { env: { ...process.env, MINDMODEL_M2: m2 }, log: () => (spawned = true) });
    assert.equal(spawned, false, 'no Maven run on a warm scan');
    assert.deepStrictEqual(warm.jars, cold.jars);
    assert.equal(warm.reason, cold.reason ?? null);
    // The cache is the scan's own scratch file, under mindmodel/.work, never beside the POMs.
    assert.equal(fs.existsSync(path.join(dir, 'mindmodel/.work/classpath.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'classpath.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(m2, { recursive: true, force: true });
  }
});
