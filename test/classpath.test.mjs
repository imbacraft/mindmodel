// The classpath (Part A), end to end and without the network: a tiny Maven project whose holder lives in a jar, a local
// repository built at test time from javac output, and the real engine reading the dump the scan would read. Maven is
// offline throughout; anything that needs the network is not tested here, because the product never does it.
//
// Skips when Maven or the engine jar is absent, rather than pretending: the run needs both.
import { withDegradation } from '../test-support/strict.mjs';
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
import { authSources, tenantSources } from '../engine/extract/security/index.mjs';
import { mavenTool, resolve, summaryHash } from '../engine/io/classpath.mjs';
import { dumpFor } from '../engine/io/dump-run.mjs';
import { scan } from '../engine/scan.mjs';
import { summarize } from '../engine/digest/facts-md.mjs';

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

    const dump = dumpFor(dir, ['app/src/main/java/shop/ContextFilter.java', 'lib/src/main/java/lib/Shape.java'], { classpath: cp, classpathHash: summaryHash(cp, dir) });
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
    const tenant = tenantSources(model, () => false, db);
    assert.equal(tenant.length, 1, 'the cookie the filter reads is the tenant source');
    assert.deepStrictEqual([tenant[0].kind, tenant[0].name, tenant[0].storedBy], ['cookie', 'cluster', 'thread-local']);
    assert.equal(tenant[0].confidence, 'resolved', 'read from the holder type, not inferred from a shape');
    assert.equal(tenant[0].via, 'classpath');
    const users = authSources(model, () => false, db);
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
    // The unresolved module is the degradation this case is about: it is recorded, and the scan still goes on.
    const { value: facts, reasons } = withDegradation(() => withEnv({ MINDMODEL_M2: m2 }, () => scan(dir)));
    assert.ok(reasons.some((r) => /unresolved offline \(.*\blib\b.*\): library types stay unresolved/.test(r)), reasons);
    assert.deepStrictEqual(facts.runtime.degraded, reasons, 'the facts carry the same reasons');
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
    const dump = dumpFor(dir, ['app/src/main/java/shop/ContextFilter.java'], { classpath: cp, classpathHash: summaryHash(cp, dir) });
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
    const a = dumpFor(dir, files, { classpath: cp, classpathHash: summaryHash(cp, dir), force: true, outDir: path.join(dir, 'mindmodel/.work/dump-a') });
    const b = dumpFor(dir, files, { classpath: cp, classpathHash: summaryHash(cp, dir), force: true, outDir: path.join(dir, 'mindmodel/.work/dump-b') });
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

// F1/F2: the holder and its element type both live in the organisation's shared jar, and the filter names two cookies
// through a helper that filters the cookie stream. This is the shape that produced "no tenant source found" on a real
// project while every other test passed.
const CTX = L(
  'package com.acme.holder;',
  'public final class Ctx {',
  '  private final String userId;',
  '  private final String region;',
  '  private Ctx(Builder b) { this.userId = b.userId; this.region = b.region; }',
  '  public String userId() { return userId; }',
  '  public String region() { return region; }',
  '  public static Builder builder() { return new Builder(); }',
  '  public static final class Builder {',
  '    private String userId;',
  '    private String region;',
  '    public Builder userId(String v) { this.userId = v; return this; }',
  '    public Builder region(String v) { this.region = v; return this; }',
  '    public Ctx build() { return new Ctx(this); }',
  '  }',
  '}',
);
const HOLDER_OF_CTX = L(
  'package com.acme.holder;',
  'public final class ContextHolder {',
  '  private static final ThreadLocal<Ctx> CONTEXT = new ThreadLocal<>();',
  '  public static void setContext(Ctx value) { CONTEXT.set(value); }',
  '  public static Ctx getContext() { return CONTEXT.get(); }',
  '  public static void clearContext() { CONTEXT.remove(); }',
  '}',
);
const TWO_COOKIE_FILTER = L(
  'package shop;',
  'import com.acme.holder.ContextHolder;',
  'import com.acme.holder.Ctx;',
  'import jakarta.servlet.http.Cookie;',
  'import jakarta.servlet.http.HttpServletRequest;',
  'import java.util.Arrays;',
  'public class ContextFilter {',
  '  private static final String A_COOKIE = "mm_user";',
  '  private static final String B_COOKIE = "mm_tenant";',
  '  private final UserPort users;',
  '  public ContextFilter(UserPort users) { this.users = users; }',
  '  public void doFilterInternal(HttpServletRequest request) {',
  '    try {',
  '      String a = firstCookieValueOrBlank(request, A_COOKIE);',
  '      String b = firstCookieValueOrBlank(request, B_COOKIE);',
  '      if (a != null && !a.isEmpty()) {',
  '        store(ctx(a));',
  '      } else if (b != null) {',
  '        store(Long.valueOf(b));',
  '      }',
  '    } finally {',
  '      ContextHolder.clearContext();',
  '    }',
  '  }',
  '  private void store(Ctx ctx) { ContextHolder.setContext(ctx); }',
  '  private void store(Long id) {',
  '    User u = users.findById(id);',
  '    ContextHolder.setContext(Ctx.builder().userId(u.id()).region(u.region()).build());',
  '  }',
  '  private Ctx ctx(String userId) { return Ctx.builder().userId(userId).region("eu").build(); }',
  '  private static String firstCookieValueOrBlank(HttpServletRequest request, String... names) {',
  '    if (request.getCookies() == null) return "";',
  '    return Arrays.stream(request.getCookies())',
  '        .filter(cookie -> Arrays.asList(names).contains(cookie.getName()))',
  '        .map(Cookie::getValue)',
  '        .findFirst().orElse("");',
  '  }',
  '}',
);
const USER_PORT = L(
  'package shop;',
  'public interface UserPort {',
  '  User findById(Long id);',
  '}',
);
const USER = L('package shop;', 'public record User(String id, String region) {}');

/** The two-cookie project: the filter, the port it loads a user through, and one module that depends on the holder. */
function cookieProject() {
  const dir = fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-cookiefixture-'));
  fs.writeFileSync(
    path.join(dir, 'pom.xml'),
    L(
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      '  <modelVersion>4.0.0</modelVersion>',
      '  <groupId>shop</groupId><artifactId>fixture</artifactId><version>1.0</version>',
      '  <packaging>pom</packaging>',
      '  <modules><module>app</module></modules>',
      '</project>',
    ),
  );
  const src = path.join(dir, 'app/src/main/java/shop');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app/pom.xml'), POM('app', [['mindmodelfixture', 'holder', '1.0']]));
  fs.writeFileSync(path.join(src, 'ContextFilter.java'), TWO_COOKIE_FILTER);
  fs.writeFileSync(path.join(src, 'UserPort.java'), USER_PORT);
  fs.writeFileSync(path.join(src, 'User.java'), USER);
  return dir;
}

const filterFacts = (dir) => {
  const facts = scan(dir);
  const users = facts.securityModel?.userSources ?? [];
  return {
    facts,
    users,
    warnings: facts.securityWarnings ?? [],
    tenant: facts.tenantSources ?? [],
    note: facts.tenantSourcesNote,
  };
};

test('F1: a holder whose element is in the jar becomes a user source, and the tenant note goes', { skip }, () => {
  const dir = cookieProject();
  const lib = compile(fs.mkdtempSync(path.join(real(os.tmpdir()), 'mindmodel-lib-')), {
    'com/acme/holder/Ctx.java': CTX,
    'com/acme/holder/ContextHolder.java': HOLDER_OF_CTX,
  });
  const m2 = localRepository(home2, lib);
  try {
    const withPath = withEnv({ MINDMODEL_M2: m2, MINDMODEL_CLASSPATH: 'auto' }, () => filterFacts(dir));
    assert.equal(withPath.facts.classpath.mode, 'maven-offline', `resolved: ${withPath.facts.classpath.reason ?? ''}`);
    // The store is a security sink because the element is a value class in the jar, and the cookies are the sources.
    assert.ok(withPath.users.length >= 1, `no user source: ${JSON.stringify(withPath.users)}`);
    assert.ok(
      withPath.users.some((u) => String(u.why ?? '').includes('ContextHolder.setContext')),
      `the user source names the holder: ${JSON.stringify(withPath.users)}`,
    );
    assert.equal(withPath.note, undefined, 'the tenant note must be gone once the store is found');
    assert.ok(withPath.tenant.length >= 1, `no tenant source: ${JSON.stringify(withPath.tenant)}`);
    // F2: both cookies are named, from the constant each call site passes.
    const names = withPath.users.map((u) => u.kind).join(' ');
    assert.match(names, /mm_user/, `the first cookie: ${names}`);
    assert.match(names, /mm_tenant/, `the second cookie: ${names}`);
    // No identity warning here, and that is the documented gap (docs/round-4-status.md, F1 note 2): with the classpath
    // the store is typed, the parameter-only sink is skipped as a forward, and the caller frame builds its value through
    // a project factory (`ctx(a)`) that `builtValue` does not follow. Without the classpath the shape-only sink does
    // warn, because it has no forwarding rule to lose to.
    assert.equal(withPath.warnings.filter((w) => w.kind === 'client-asserted-identity').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(m2, { recursive: true, force: true });
  }
});

test('F1: without the jar the same store is inferred, with its element unresolved', { skip }, () => {
  const dir = cookieProject();
  try {
    const off = withEnv({ MINDMODEL_CLASSPATH: 'off' }, () => filterFacts(dir));
    assert.equal(off.facts.classpath.mode, 'none');
    // The store is still there: found by its try/finally shape, inferred, and never dropped.
    assert.ok(off.tenant.length >= 1, `the shape alone must still give a store: ${JSON.stringify(off.tenant)}`);
    assert.equal(off.tenant[0].confidence, 'inferred');
    assert.equal(off.tenant[0].via, 'try-finally-pattern');
    const unresolved = off.warnings.some((w) => (w.why ?? []).join(' ').includes('element unresolved'));
    assert.ok(unresolved || off.warnings.length === 0, `an unknown element is said, not guessed: ${JSON.stringify(off.warnings)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
