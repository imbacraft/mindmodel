// The project's own dependency jars, found the way the project already found them: the build tool's own answer, read
// offline from the local repository. Nothing is built, nothing is downloaded, nothing is written into the checkout.
//
// Why: without a classpath every type in a dependency is a name without members. A request-context holder that lives
// in the organisation's shared jar is then invisible, so the digest cannot name the filter that sets it. With the
// jars on the classpath Spoon resolves library types the way the compiler does (SourceModel, library stubs).
//
// The answer is optional and never blocks: every failure is a `mode: none` with a sentence, and the scan continues
// exactly as it did before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readBuild } from './build.mjs';

const TIMEOUT = 120_000;

/** `mvn 3.9.9 (PATH)`, or null when Maven is not installed. */
export function mavenTool() {
  const r = spawnSync('mvn', ['-v'], { encoding: 'utf8', timeout: 20_000 });
  if (r.error || r.status !== 0) return null;
  const version = /Apache Maven (\S+)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`)?.[1];
  return version ? `mvn ${version} (PATH)` : 'mvn (PATH)';
}

/**
 * What runs project code if the build tool is invoked: `.mvn/extensions.xml` and `<extensions>` in a POM (extra
 * plugins), `.mvn/jvm.config` and `.mvn/maven.config` (JVM arguments and goals on every run). A Gradle build is code by
 * definition. Preflight turns any of these into a `confirm`, never a silent run.
 */
export function risk(root, files = []) {
  const reasons = [];
  for (const rel of ['.mvn/extensions.xml', '.mvn/jvm.config', '.mvn/maven.config'])
    if (fs.existsSync(path.join(root, rel))) reasons.push(rel);
  for (const rel of files.filter((f) => /(^|\/)pom\.xml$/.test(f)))
    if (/<extensions>\s*<extension>/.test(fs.readFileSync(path.join(root, rel), 'utf8')))
      reasons.push(`${rel} declares build extensions`);
  if (files.some((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f))) reasons.push('gradle build script');
  return { level: reasons.length ? 'confirm' : 'safe', reasons };
}

/** The Maven modules this checkout declares: one per POM, plus the reactor coordinates a jar must never shadow. */
function mavenModules(root, files) {
  // Only files that are really there: a caller's list may name a build file it read from a configuration.
  const builds = readBuild(root, files.filter((f) => fs.existsSync(path.join(root, f)))).filter((b) => b.kind === 'maven');
  return {
    poms: builds.map((b) => b.file).sort(),
    coordinates: new Set(builds.filter((b) => b.artifact).map((b) => `${b.group}:${b.artifact}`)),
    artifacts: new Set(builds.filter((b) => b.artifact).map((b) => b.artifact)),
  };
}

/**
 * One Maven run's answer: every module's classpath, the modules that failed and why. The plugin prints one block per
 * module (`--- dependency:...:build-classpath ... @ module ---`) followed by `Dependencies classpath:` and one line of
 * `path.delimiter`-separated absolute jar paths; with `-q` it prints nothing at all, which is why the log is read.
 */
function parseClasspathLog(log, { artifacts = new Set() } = {}) {
  const jars = [];
  const seen = new Set();
  const failed = [];
  let blocks = 0;
  let module = null;
  const lines = String(log).split('\n');
  const drop = (entry) => {
    // A reactor jar is a stale copy of sources already in the model: the sources win.
    const base = path.basename(entry);
    for (const artifact of artifacts) if (base.startsWith(`${artifact}-`) && /(^|[\\/])[^\\/]*\.jar$/.test(base)) return true;
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = /^\[INFO\] --- dependency:[\d.]+:build-classpath[^@]*@ (.+?) ---\s*$/.exec(line);
    if (head) {
      module = head[1];
      blocks++;
      continue;
    }
    if (/^\[INFO\] Dependencies classpath:\s*$/.test(line)) {
      const entries = (lines[i + 1] ?? '')
        .split(path.delimiter)
        .map((x) => x.trim())
        .filter((x) => x.endsWith('.jar'));
      for (const entry of entries) {
        if (drop(entry) || seen.has(entry)) continue;
        seen.add(entry);
        jars.push(entry);
      }
      i++; // the classpath itself is not a directive line
      continue;
    }
    const failure = /^\[ERROR\] Failed to execute goal on project (\S+?):/.exec(line);
    if (failure) {
      const reason = lines
        .slice(i + 1, i + 6)
        .map((l) => /^\[ERROR\]\s+dependency:\s*(.+)$/.exec(l)?.[1] ?? /^\[ERROR\]\s+(Cannot access .+)$/.exec(l)?.[1])
        .find(Boolean);
      failed.push({ module: failure[1], reason: (reason ?? 'dependency resolution failed').slice(0, 200) });
    }
  }
  // One module can fail for several artifacts; one row per module keeps the digest's sentence short.
  const byModule = new Map();
  for (const f of failed) if (!byModule.has(f.module)) byModule.set(f.module, f);
  return { jars, failedModules: [...byModule.values()], blocks };
}

/**
 * Why Maven produced no classpath at all: the first line that names a cause, without the help articles and the
 * re-run advice. A reactor that cannot even be read (a BOM missing from the local repository) lands here.
 */
function failureReason(log) {
  const lines = String(log)
    .split('\n')
    .map((l) => l.replace(/^\[(?:ERROR|FATAL)\]\s*/, '').trim())
    .filter((l) => l && !/^(For more information|Re-run|To see the full stack|\[Help)/i.test(l));
  // The artifact that is missing is the whole answer: "Failed to execute goal on project X" says nothing a reader can
  // act on, and the parent-POM chain is already shortened by `shortenCause`.
  const artifact = lines.map((l) => /^dependency:\s*(.+)$/.exec(l)?.[1]).find(Boolean);
  if (artifact) return shortenCause(`missing from the local repository: ${artifact}`);
  const pick = lines.find((l) =>
    /could not read|Failed to execute goal|Non-resolvable|has not been downloaded|Cannot access|Could not resolve/.test(l),
  );
  return shortenCause(pick ?? lines[0] ?? 'maven printed no classpath');
}

/**
 * Maven's cause, cut to what a reader needs: the artifact that is missing and the kind of miss. One line of a digest
 * cannot carry a nested reactor sentence, the `(absent)` markers or the repository URL that "Cannot access" repeats.
 */
function shortenCause(text) {
  let t = String(text).replace(/\s+/g, ' ').trim();
  t = t.replace(/^(\[FATAL\]|\[ERROR\])\s*/, '');
  t = t.replace(
    /Non-resolvable (parent|import) POM for (?:[^:\s]+:)*?([^:\s]+): The following artifacts could not be resolved: ([^\s,]+).*/,
    'Non-resolvable $1 POM: $3',
  );
  t = t.replace(/The following artifacts could not be resolved: /, '');
  t = t.replace(/,?\s*Cannot access .*$/, '');
  t = t.replace(/\s*\(absent\)/g, '');
  t = t.replace(/[\s,:]+$/, '');
  if (t.length > 100) t = `${t.slice(0, 100).replace(/[\s,:(]+\S*$/, '')}…`;
  return t;
}

/** The `target/generated-sources/*` directories that already exist: read for their types, never generated here. */
export function generatedDirs(root, poms) {
  const out = [];
  const roots = poms.map((p) => path.dirname(p)).map((d) => (d === '.' ? '' : d));
  for (const rel of roots) {
    for (const name of ['target/generated-sources', 'target/generated-test-sources', 'build/generated/sources']) {
      const dir = path.join(root, rel, name);
      if (!fs.existsSync(dir)) continue;
      // One level down is where the processors put their packages; a deeper walk finds no more source roots.
      const children = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const childRel = path.join(rel, name, child.name).split(path.sep).join('/');
        if (!out.includes(childRel)) out.push(childRel);
      }
      const own = path.join(root, rel, name);
      if (children.every((c) => !c.isDirectory()) && fs.existsSync(own)) {
        const ownRel = path.join(rel, name).split(path.sep).join('/');
        if (!out.includes(ownRel)) out.push(ownRel);
      }
    }
  }
  return out.sort();
}

/** A hash of every build file's content plus the tool and the repository: a changed dependency re-resolves. */
function buildKey(root, files, { tool = '', m2 = '' } = {}) {
  const h = crypto.createHash('sha256');
  h.update(`${tool}\u0000${m2}\u0000`);
  for (const rel of files.filter((f) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/.test(f)).sort()) {
    h.update(rel);
    try {
      h.update(fs.readFileSync(path.join(root, rel)));
    } catch {
      h.update('missing');
    }
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * A stable digest over the ordered jar paths and their sizes, plus the generated sources' own files (a regenerated
 * mapper must rebuild the dump even when no POM moved). Part of the dump fingerprint.
 */
export function summaryHash(summary, root = null) {
  const h = crypto.createHash('sha256');
  h.update(summary?.mode ?? 'none');
  for (const jar of summary?.jars ?? []) {
    let size = 0;
    try {
      size = fs.statSync(jar).size;
    } catch {
      size = 0;
    }
    h.update(`${jar}:${size}\n`);
  }
  for (const dir of summary?.generatedSources ?? []) {
    h.update(`gen:${dir}\n`);
    if (!root) continue;
    // Bounded: a processor that wrote ten thousand files still fingerprints, without reading them all.
    for (const rel of generatedFiles(path.join(root, dir)).slice(0, 2000)) {
      let st = null;
      try {
        st = fs.statSync(path.join(root, dir, rel));
      } catch {
        continue;
      }
      h.update(`${dir}/${rel}:${st.size}:${st.mtimeMs}\n`);
    }
  }
  return h.digest('hex').slice(0, 16);
}

/** The `.java` files under one generated directory, relative to it, sorted. */
function generatedFiles(dir, depth = 0) {
  if (depth > 8) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) out.push(...generatedFiles(path.join(dir, e.name), depth + 1).map((r) => `${e.name}/${r}`));
    else if (e.name.endsWith('.java')) out.push(e.name);
  }
  return out.sort();
}

const empty = (reason, extra = {}) => ({
  mode: 'none',
  jars: [],
  generatedSources: [],
  failedModules: [],
  tool: null,
  ms: 0,
  reason,
  ...extra,
});

/**
 * Whether the Maven classpath is read for this checkout, decided once for `resolve` and `preflightLines`: `{ skip }`
 * with the reason, or the build's `{ all, poms, artifacts }`. Gradle is named, never read.
 */
function classpathPlan(root, { env, files }) {
  const mode = env.MINDMODEL_CLASSPATH ?? 'auto';
  if (mode === 'off') return { skip: 'MINDMODEL_CLASSPATH=off' };
  const all = files?.length ? files : walk(root);
  const { poms, artifacts } = mavenModules(root, all);
  if (!poms.length) {
    const gradle = all.some((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f));
    return { skip: gradle ? 'Gradle build, classpath not implemented' : 'no pom.xml or build.gradle at the root' };
  }
  if (mode === 'gradle') return { skip: 'MINDMODEL_CLASSPATH=gradle, classpath not implemented' };
  return { all, poms, artifacts };
}

/**
 * Resolves the classpath for one checkout. Never throws and never blocks: the answer is either jars (mode
 * `maven-offline`), or `none` with a sentence the digest repeats. Every answer is cached — a scan of the same checkout
 * asks Maven once — a jar list while its jars exist, a `none` for `MINDMODEL_CLASSPATH_TTL_MS` (default ten minutes),
 * because the user may fetch the dependencies between two scans.
 *
 * Options: `files` (the walk's relative paths), `env`, `timeout`, `cache`, `log` (a sink for the tool's own output),
 * `which` (the tool lookup, `mavenTool` by default: a test passes its own).
 */
export function resolve(
  root,
  { files = [], env = process.env, timeout = TIMEOUT, cache = true, log = null, which = mavenTool } = {},
) {
  const started = Date.now();
  const ttl = Number(env.MINDMODEL_CLASSPATH_TTL_MS ?? 600_000);
  const cachePath = path.join(root, 'mindmodel', '.work', 'classpath.json');
  const CACHE_VERSION = 5;
  const finish = (summary) => {
    const settled = { ...summary, ms: Date.now() - started };
    if (cache) {
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, key, at: Date.now(), summary: settled }, null, 1));
      } catch {
        // A project that cannot take a scratch file still gets its answer; only the cache is lost.
      }
    }
    return settled;
  };
  let key = '';
  const plan = classpathPlan(root, { env, files });
  if (plan.skip) return empty(plan.skip);
  const { all, poms, artifacts } = plan;
  const m2 = env.MINDMODEL_M2 ?? '';
  // The key is the build files and the repository, not the tool's version: asking Maven which version it is costs a
  // process spawn, and the goal is to ask the machine nothing at all on a warm scan. A Maven upgrade re-reads the same
  // POMs for the same dependency set, so the jars do not change. The version is recorded in the answer.
  key = buildKey(root, all, { m2 });
  if (cache && fs.existsSync(cachePath)) {
    try {
      const held = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const jars = held.summary?.jars ?? [];
      // A classpath is reused while every jar it names still exists: a cleaned repository resolves again.
      const stillThere = held.summary?.mode !== 'none' && jars.every((j) => fs.existsSync(j));
      // A `none` answer is reused for a bounded while, not forever: a cache that never expired would hide a repository
      // the user filled in since.
      const fresh = held.summary?.mode === 'none' && Date.now() - (held.at ?? 0) < ttl;
      if (held.version === CACHE_VERSION && held.key === key && (stillThere || fresh)) {
        return { ...held.summary, ms: Date.now() - started, reason: held.summary.reason ?? null };
      }
    } catch {
      // A broken cache is no cache.
    }
  }
  const tool = which();
  if (!tool) return empty('no mvn on PATH');
  // Nothing is written into the tree: Maven's own output goes to its log, and the answer to `.work/`.
  const args = ['-o', '-B', '-fae', 'dependency:build-classpath', '-Dmdep.includeScope=compile'];
  if (m2) args.splice(0, 0, `-Dmaven.repo.local=${m2}`);
  const run = spawnSync('mvn', args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (log) log(output);
  if (run.error?.code === 'ETIMEDOUT' || (run.error && /timed? ?out/i.test(run.error.message ?? '')))
    return finish({ ...empty(`maven timed out after ${Math.round(timeout / 1000)}s`), tool });
  const parsed = parseClasspathLog(output, { artifacts });
  const generated = generatedDirs(root, poms);
  // No module block means Maven never reached the goal: the reactor itself could not be read (offline, a BOM that was
  // never downloaded). That is a `none`, not a classpath of zero jars.
  if (!parsed.blocks)
    return finish({ ...empty(`maven could not read the build offline: ${failureReason(output)}`), tool });
  if (!parsed.jars.length && parsed.failedModules.length)
    return finish({
      ...empty(`no jar offline, module(s) unresolved: ${parsed.failedModules.map((f) => f.module).join(', ')}`),
      tool,
      failedModules: parsed.failedModules,
      generatedSources: generated,
    });
  return finish({
    mode: 'maven-offline',
    jars: parsed.jars,
    generatedSources: generated,
    failedModules: parsed.failedModules,
    tool,
    ms: 0,
    reason: null,
  });
}

/**
 * What preflight says about the classpath, before anything runs: where the dependencies would come from, and the one
 * case that asks first (a Maven build that would execute project code). Gradle is never a `confirm` here because
 * nothing would run — its classpath is not implemented, so the answer is `none` either way.
 */
export function preflightLines(root, { env = process.env, files = null, which = mavenTool } = {}) {
  const plan = classpathPlan(root, { env, files });
  if (plan.skip) return [{ level: 'info', text: `No classpath: ${plan.skip}. Library types stay unresolved.` }];
  if (!which())
    return [{ level: 'info', text: 'No classpath: no mvn on PATH. Library types stay unresolved.' }];
  const lines = [
    {
      level: 'info',
      text: 'Dependencies will be read from the local Maven repository (offline, nothing is built, nothing is downloaded).',
    },
  ];
  const r = risk(root, plan.all);
  if (r.level === 'confirm')
    lines.push({
      level: 'confirm',
      text:
        `Running Maven in this checkout executes project code (${r.reasons.join(', ')}): ` +
        'its extensions or JVM arguments run on every invocation. The classpath is optional — continue to read the ' +
        'local repository, or skip it and leave library types unresolved.',
    });
  return lines;
}

/** The build files and POMs, for a caller that has no file list: bounded, so a huge checkout is not walked twice. */
function walk(root, depth = 0) {
  const out = [];
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || ['node_modules', 'target', 'build', 'mindmodel'].includes(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walk(full, depth + 1).map((r) => `${e.name}/${r}`));
    else if (/(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(e.name)) out.push(e.name);
  }
  return out;
}

/** The home directory as `~`: a facts file is read and quoted, so no absolute home path goes into it. */
export function tildify(text, home = os.homedir()) {
  return String(text ?? '').split(home).join('~');
}

{
  // Self-checks: the log's shape, the reactor drop, the cache key and the summary hash — no Maven and no network.
  const log = [
    '[INFO] --- dependency:3.7.0:build-classpath (default-cli) @ parent ---',
    '[INFO] No dependencies found.',
    '[INFO] Dependencies classpath:',
    '',
    '[INFO] --- dependency:3.7.0:build-classpath (default-cli) @ lib ---',
    '[INFO] Dependencies classpath:',
    '/m2/org/slf4j/slf4j-api-1.7.36.jar:/m2/demo/lib-1.0.jar',
    '[INFO] --- dependency:3.7.0:build-classpath (default-cli) @ app ---',
    '[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project demo:app:jar:1.0',
    '[ERROR] dependency: com.acme:missing:jar:2.0 (compile)',
    '[ERROR] \tCannot access central (https://repo.maven.apache.org/maven2) in offline mode',
  ].join('\n');
  const parsed = parseClasspathLog(log, { artifacts: new Set(['lib']) });
  assert.deepStrictEqual(parsed.jars, ['/m2/org/slf4j/slf4j-api-1.7.36.jar'], 'a reactor jar is dropped, order kept');
  assert.deepStrictEqual(parsed.failedModules, [{ module: 'app', reason: 'com.acme:missing:jar:2.0 (compile)' }]);
  assert.deepStrictEqual(parseClasspathLog('').jars, [], 'nothing printed, nothing claimed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmodel-cp-'));
  try {
    fs.mkdirSync(path.join(dir, 'target', 'generated-sources', 'annotations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>');
    assert.deepStrictEqual(generatedDirs(dir, ['pom.xml']), ['target/generated-sources/annotations']);
    const k = buildKey(dir, ['pom.xml'], { tool: 'mvn 1', m2: '' });
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project><modules/></project>');
    assert.notEqual(buildKey(dir, ['pom.xml'], { tool: 'mvn 1', m2: '' }), k, 'a changed pom re-resolves');
    assert.equal(summaryHash({ mode: 'none', jars: [] }), summaryHash({ mode: 'none', jars: [] }));
    assert.equal(summaryHash({ mode: 'maven-offline', jars: ['/nope.jar'] }), summaryHash({ mode: 'maven-offline', jars: ['/nope.jar'] }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
