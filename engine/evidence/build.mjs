// L1 evidence: what the project says about itself. This module reads Maven POMs and Gradle builds (Groovy and Kotlin
// DSL, version catalogs) into coordinates a catalog can match, plus the code-generator plugins whose output is not
// hand-written code. No build is run and nothing is installed: a build file is text, read like any other source.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { childOf, childrenOf, parseXml, textOf } from './xml.mjs';
import { resolvePlaceholders } from '../core/placeholders.mjs';

const SCOPES = /^(compile|provided|runtime|test|system|import)$/;
const GRADLE_CONFIGS =
  'implementation|api|compileOnly|compileOnlyApi|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|annotationProcessor|kapt|ksp|providedCompile|providedRuntime|developmentOnly|testFixturesImplementation';

const uniq = (xs) => [...new Set(xs)];

// Build scripts are code: comments mention coordinates, strings contain slashes, blocks nest. Remove comments and read
// only `dependencies { ... }` bodies (at any nesting depth) with balanced braces — a regex over the whole file reads
// prose and the insides of `exclude` clauses as dependencies.
function stripComments(text) {
  let out = '',
    quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function blocksOf(text, keyword) {
  const out = [];
  const re = new RegExp(`\\b${keyword}\\s*\\{`, 'g');
  for (const m of text.matchAll(re)) {
    let depth = 0,
      quote = null,
      start = m.index + m[0].length;
    for (let i = start - 1; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i));
          break;
        }
      }
    }
  }
  return out;
}


// ${property} and ${project.version} inside a POM; a property the POM does not set is left as written.
const interpolate = (value, props) =>
  resolvePlaceholders(value, (key) => (Object.hasOwn(props, key) ? props[key] : null));

function dependencyOf(node, resolve) {
  const group = resolve(textOf(childOf(node, 'groupId'))),
    artifact = resolve(textOf(childOf(node, 'artifactId')));
  if (!group || !artifact) return null;
  return {
    group,
    artifact,
    version: resolve(textOf(childOf(node, 'version'))) || undefined,
    scope: textOf(childOf(node, 'scope')) || undefined,
    optional: textOf(childOf(node, 'optional')) === 'true' || undefined,
    type: textOf(childOf(node, 'type')) || undefined,
  };
}

function pluginOf(node, resolve) {
  const id = resolve(textOf(childOf(node, 'artifactId')));
  if (!id) return null;
  const configNode = childOf(node, 'configuration');
  const config = {};
  for (const key of ['generatorName', 'packageName', 'modelPackage', 'apiPackage', 'invokerPackage', 'output', 'inputSpec'])
    for (const c of childrenOf(configNode))
      if (c.tag === key) config[key] = resolve(textOf(c));
  return {
    id,
    group: resolve(textOf(childOf(node, 'groupId'))) || undefined,
    version: resolve(textOf(childOf(node, 'version'))) || undefined,
    ...(Object.keys(config).length ? { config } : {}),
  };
}

function readPom(text, rel = 'pom.xml') {
  const project = childOf(parseXml(text), 'project');
  if (!project) return null;
  const value = (tag) => textOf(childOf(project, tag));
  const parentNode = childOf(project, 'parent');
  const parent = parentNode
    ? {
        group: textOf(childOf(parentNode, 'groupId')),
        artifact: textOf(childOf(parentNode, 'artifactId')),
        version: textOf(childOf(parentNode, 'version')),
      }
    : null;
  const props = Object.fromEntries(
    childrenOf(childOf(project, 'properties')).map((c) => [c.tag, textOf(c)]),
  );
  const group = value('groupId') || parent?.group || '';
  const artifact = value('artifactId');
  const version = value('version') || parent?.version || '';
  Object.assign(props, { 'project.groupId': group, 'project.artifactId': artifact, 'project.version': version });
  const resolve = (v) => interpolate(v, props);
  const deps = childrenOf(childOf(project, 'dependencies'), 'dependency')
    .map((d) => dependencyOf(d, resolve))
    .filter(Boolean);
  const managed = childrenOf(childOf(childOf(project, 'dependencyManagement'), 'dependencies'), 'dependency')
    .map((d) => dependencyOf(d, resolve))
    .filter(Boolean);
  const plugins = childrenOf(childOf(childOf(project, 'build'), 'plugins'), 'plugin')
    .map((p) => pluginOf(p, resolve))
    .filter(Boolean);
  return {
    file: rel,
    kind: 'maven',
    group,
    artifact,
    version,
    packaging: value('packaging') || 'jar',
    parent: parent ?? undefined,
    modules: childrenOf(childOf(project, 'modules'), 'module').map(textOf),
    properties: Object.fromEntries(Object.entries(props).slice(0, 40)),
    deps,
    managedDeps: managed.length ? managed : undefined,
    plugins: plugins.length ? plugins : undefined,
  };
}

// `libs.springframework.boot` -> "org.springframework.boot:spring-boot-starter-web:3.4.0" (version catalogs, TOML).
function readVersionCatalog(text) {
  const libs = new Map(),
    versions = new Map();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1];
      continue;
    }
    const kv = /^([\w.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (section === 'versions') {
      versions.set(key, /^"([^"]+)"/.exec(value)?.[1] ?? String(value).trim());
      continue;
    }
    if (section === 'libraries' || section === 'plugins') {
      const module = /module\s*=\s*"([^"]+)"/.exec(value)?.[1];
      const group = /group\s*=\s*"([^"]+)"/.exec(value)?.[1];
      const name = /name\s*=\s*"([^"]+)"/.exec(value)?.[1];
      const version =
        /version\s*=\s*"([^"]+)"/.exec(value)?.[1] ??
        (/version\.ref\s*=\s*"([^"]+)"/.exec(value)?.[1] !== undefined
          ? versions.get(/version\.ref\s*=\s*"([^"]+)"/.exec(value)[1])
          : undefined);
      const inline = /^"([^"$]+)"/.exec(value)?.[1];
      const coordinate = module ?? (group && name ? `${group}:${name}` : inline);
      if (!coordinate) continue;
      libs.set(key.replace(/-/g, '.'), version ? `${coordinate}:${version}` : coordinate);
      libs.set(key, version ? `${coordinate}:${version}` : coordinate);
    }
  }
  return libs;
}

// Groovy and Kotlin DSL: the same information, written three ways (`'g:a:v'`, a map, or a version-catalog accessor).
function readGradleBuild(source, rel = 'build.gradle', libs = new Map()) {
  const text = stripComments(source);
  const depsText = blocksOf(text, 'dependencies').join('\n');
  const group = /\bgroup\s*[=:]\s*['"]([^'"]+)/.exec(text)?.[1];
  const version = /^\s*version\s*[=:]\s*['"]([^'"]+)/m.exec(text)?.[1];
  const resolveAccessor = (accessor) => libs.get(accessor.replace(/^libs\./, ''));
  const deps = [];
  const push = (coord) => {
    if (!coord || coord.startsWith('$')) return;
    const [g, a, v] = coord.split(':');
    if (g && a) deps.push({ group: g, artifact: a, version: v || undefined });
  };
  for (const m of depsText.matchAll(new RegExp(`(?<![\\w-])(${GRADLE_CONFIGS})\\s*\\(?\\s*(?:platform\\s*\\(\\s*)?['"]([^'"]+)['"]`, 'g')))
    push(m[2]);
  for (const m of depsText.matchAll(new RegExp(`(?<![\\w-])(${GRADLE_CONFIGS})\\s+group:\\s*['"]([^'"]+)['"]\\s*,\\s*name:\\s*['"]([^'"]+)['"](?:\\s*,\\s*version:\\s*['"]([^'"]+)['"])?`, 'g')))
    push(`${m[2]}:${m[3]}${m[4] ? `:${m[4]}` : ''}`);
  for (const m of depsText.matchAll(new RegExp(`(?<![\\w-])(${GRADLE_CONFIGS})\\s*\\(?\\s*(libs\\.[\\w.]+)`, 'g')))
    push(resolveAccessor(m[2]));
  const plugins = [];
  for (const m of text.matchAll(/\bid\s*\(?\s*['"]([\w.-]+)['"]\s*\)?(?:\s*version\s*['"]([^'"]+)['"])?/g))
    plugins.push({ id: m[1], version: m[2] || undefined });
  for (const m of text.matchAll(/\bapply plugin:\s*['"]([\w.-]+)['"]/g)) plugins.push({ id: m[1] });
  const config = {};
  for (const key of ['packageName', 'modelPackage', 'apiPackage', 'outputDir', 'output'])
    for (const m of text.matchAll(new RegExp(`\\b${key}\\s*[=:]\\s*['"]([^'"]+)['"]`, 'g')))
      config[key] = m[1];
  const generator = plugins.find((p) => /generator|openapi|protobuf|grpc|jooq|querydsl/.test(p.id));
  if (generator && Object.keys(config).length) generator.config = config;
  return {
    file: rel,
    kind: 'gradle',
    group: group || undefined,
    artifact: /\brootProject\.name\s*=\s*['"]([^'"]+)/.exec(text)?.[1] || undefined,
    version: version || undefined,
    deps,
    plugins: plugins.length ? plugins : undefined,
  };
}

// settings.gradle(.kts): the module tree, which is what makes a folder a deployable in Gradle builds.
function readGradleSettings(text, rel = 'settings.gradle') {
  const modules = [];
  for (const m of text.matchAll(/\binclude\s*\(?\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g))
    for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) modules.push(q[1].replace(/^:/, '').replace(/:/g, '/'));
  return { file: rel, kind: 'gradle-settings', modules: uniq(modules) };
}

// package.json: the frontend half of a full-stack app. Coordinates are `npm:<name>`; no catalog matches them, and the
// frontend family reads the same file for routes and calls. Kept here so the build evidence is complete.
function readPackageJson(text, rel = 'package.json') {
  let pkg = {};
  try {
    pkg = JSON.parse(text);
  } catch {
    return { file: rel, kind: 'npm', deps: [] };
  }
  const deps = Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).map(
    ([name, version]) => ({ group: 'npm', artifact: name, version: String(version) }),
  );
  return {
    file: rel,
    kind: 'npm',
    group: 'npm',
    artifact: pkg.name,
    version: pkg.version,
    deps,
    ...(pkg.scripts ? { scripts: Object.keys(pkg.scripts) } : {}),
  };
}

const BUILD_FILE = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json)$/;

function isBuildFile(rel) {
  return BUILD_FILE.test(rel) && !/(^|\/)(node_modules|build|target|dist)\//.test(rel);
}

export function readBuild(root, rels) {
  const versionCatalog = rels.find((r) => /(^|\/)gradle\/libs\.versions\.toml$/.test(r));
  const libs = versionCatalog
    ? readVersionCatalog(fs.readFileSync(path.join(root, versionCatalog), 'utf8'))
    : new Map();
  const out = [];
  for (const rel of rels.filter(isBuildFile)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const parsed = /pom\.xml$/.test(rel)
      ? readPom(text, rel)
      : /package\.json$/.test(rel)
        ? readPackageJson(text, rel)
        : /settings\.gradle/.test(rel)
          ? readGradleSettings(text, rel)
          : readGradleBuild(text, rel, libs);
    if (parsed) out.push(parsed);
  }
  return out;
}

// Every declared coordinate, for catalog selection: `group:artifact`, never a version.
export function coordinatesOf(build) {
  return uniq(
    build.flatMap((b) => [...(b.deps ?? []), ...(b.managedDeps ?? [])].map((d) => `${d.group}:${d.artifact}`)),
  );
}

{
  const pom = readPom(
    `<project>
      <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.4.0</version></parent>
      <artifactId>demo</artifactId>
      <properties><rev>1.2</rev></properties>
      <modules><module>core</module><module>web</module></modules>
      <dependencies>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
        <dependency><groupId>org.foo</groupId><artifactId>bar</artifactId><version>\${rev}</version><scope>test</scope></dependency>
      </dependencies>
      <dependencyManagement><dependencies>
        <dependency><groupId>org.junit</groupId><artifactId>junit-bom</artifactId><version>5.11.0</version><scope>import</scope><type>pom</type></dependency>
      </dependencies></dependencyManagement>
      <build><plugins><plugin>
        <groupId>org.openapitools</groupId><artifactId>openapi-generator-maven-plugin</artifactId><version>7.0.0</version>
        <configuration><packageName>demo.api</packageName><output>\${project.build.directory}/gen</output></configuration>
      </plugin></plugins></build>
    </project>`,
  );
  assert.deepStrictEqual(
    [pom.group, pom.artifact, pom.version, pom.packaging],
    ['org.springframework.boot', 'demo', '3.4.0', 'jar'],
  );
  assert.deepStrictEqual(pom.modules, ['core', 'web']);
  assert.deepStrictEqual(pom.deps.map((d) => `${d.group}:${d.artifact}:${d.version ?? ''}`), [
    'org.springframework.boot:spring-boot-starter-web:',
    'org.foo:bar:1.2',
  ]);
  assert.equal(pom.deps[1].scope, 'test');
  assert.deepStrictEqual(pom.plugins[0].config, { packageName: 'demo.api', output: '${project.build.directory}/gen' });
  assert.equal(pom.managedDeps[0].scope, 'import');
}

{
  const libs = readVersionCatalog(`
    [versions]
    boot = "3.4.0"
    [libraries]
    spring-boot-starter-web = { module = "org.springframework.boot:spring-boot-starter-web", version.ref = "boot" }
    foo-bar = "org.foo:bar:1.0"
    [plugins]
    spring-boot = { id = "org.springframework.boot", version = "3.4.0" }
  `);
  assert.equal(libs.get('spring.boot.starter.web'), 'org.springframework.boot:spring-boot-starter-web:3.4.0');
  assert.equal(libs.get('foo.bar'), 'org.foo:bar:1.0');
}

{
  const g = readGradleBuild(
    `plugins { id 'org.springframework.boot' version '3.4.0'; id 'java' }
     group = 'com.example'
     version = '2.0'
     dependencies {
       implementation 'org.foo:bar:1.0'
       implementation platform('org.springframework.boot:spring-boot-dependencies:3.4.0')
       api group: 'com.baz', name: 'qux', version: '2.0'
       implementation libs.spring.boot.starter.web
       testImplementation('org.junit.jupiter:junit-jupiter:5.11.0')
     }
     openapi { packageName = 'demo.api' }`,
    'build.gradle',
    new Map([['spring.boot.starter.web', 'org.springframework.boot:spring-boot-starter-web:3.4.0']]),
  );
  assert.equal(g.group, 'com.example');
  assert.deepStrictEqual(
    g.deps.map((d) => `${d.group}:${d.artifact}:${d.version ?? ''}`).sort(),
    [
      'com.baz:qux:2.0',
      'org.foo:bar:1.0',
      'org.junit.jupiter:junit-jupiter:5.11.0',
      'org.springframework.boot:spring-boot-dependencies:3.4.0',
      'org.springframework.boot:spring-boot-starter-web:3.4.0',
    ],
  );
  assert.deepStrictEqual(g.plugins.map((p) => p.id), ['org.springframework.boot', 'java']);
}

{
  const settings = readGradleSettings(`include 'a', 'b'\ninclude(':c:d')\n`, 'settings.gradle');
  assert.deepStrictEqual(settings.modules, ['a', 'b', 'c/d']);
}

{
  const pkg = readPackageJson(
    JSON.stringify({
      name: 'web-app',
      version: '1.0.0',
      scripts: { build: 'vite build' },
      dependencies: { react: '^18.0.0' },
      devDependencies: { vite: '^5.0.0' },
    }),
    'web-app/package.json',
  );
  assert.deepStrictEqual(
    pkg.deps.map((d) => `${d.group}:${d.artifact}`),
    ['npm:react', 'npm:vite'],
  );
  assert.deepStrictEqual([pkg.kind, pkg.artifact, pkg.scripts], ['npm', 'web-app', ['build']]);
  // A generated or vendored manifest is not the project's build.
  assert.equal(isBuildFile('node_modules/x/package.json'), false);
  assert.equal(isBuildFile('target/classes/pom.xml'), false);
  assert.equal(isBuildFile('web-app/package.json'), true);
}

// Real snippets from the corpus, not inventable ones: hertzbeat's manager POM (a comment between dependencies, a
// dependency on a starter with no version) and fineract's build.gradle (a string containing `group:`, an `exclude`
// clause, a compileOnly dependency and an annotationProcessor for the same artifact).
{
  const pom = readPom(`<project>
    <artifactId>hertzbeat-manager</artifactId>
    <dependencies>
      <dependency>
        <groupId>com.usthe.sureness</groupId>
        <artifactId>spring-boot3-starter-sureness</artifactId>
      </dependency>
      <!-- okhttp -->
      <dependency>
        <groupId>com.squareup.okhttp3</groupId>
        <artifactId>okhttp</artifactId>
      </dependency>
    </dependencies>
  </project>`);
  assert.deepStrictEqual(
    pom.deps.map((d) => `${d.group}:${d.artifact}`),
    ['com.usthe.sureness:spring-boot3-starter-sureness', 'com.squareup.okhttp3:okhttp'],
  );
}
{
  const g = readGradleBuild(`
    configurations.configureEach {
        if (name == 'implementation') {
            exclude group: 'commons-logging', module: 'commons-logging'
        }
    }
    dependencies {
        implementation ("ch.qos.logback:logback-classic") {
            exclude(module: "slf4j-api")
        }
        compileOnly 'org.projectlombok:lombok'
        annotationProcessor 'org.projectlombok:lombok'
    }`);
  const coords = [...new Set(g.deps.map((d) => `${d.group}:${d.artifact}`))];
  assert.deepStrictEqual(coords, ['ch.qos.logback:logback-classic', 'org.projectlombok:lombok']);
}
