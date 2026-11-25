// Boot and deployables: which module is the app, how it runs, and its config keys. The Java questions — a `main`, the
// Spring Boot annotation or base class that makes it an app, the component-scan filters on its type — are answered by
// the dump's rows; build files, YAML and properties stay text, because they are not Java.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { configKeys } from './config.mjs';
import { simple } from '../core/names.mjs';
import { degraded } from '../core/degrade.mjs';
import { push } from '../core/collections.mjs';
import { annotationOn } from '../core/annotations.mjs';
import { listOf, patternOf, tableOf } from '../catalogs/catalog.mjs';
import { isTestCode } from '../core/paths.mjs';
import { placeholderOf } from '../core/placeholders.mjs';
import { linesMatching } from '../core/strings.mjs';

// What makes a `main` an app's entry point: a Spring Boot annotation on its type, or a Spring Boot initialiser it
// extends (a plain `main` that boots Spring through `SpringApplication` without an annotation). The dump names an
// annotation as the author wrote it, so the simple name is what is compared.
const SPRING_APP = [...listOf('boot-main-annotations')];
const SPRING_BASE = listOf('app-base-types');

const baseOf = (s) => simple(s.fqn ?? s.text);
const bindsSpring = (t) =>
  annotationOn(t, ...SPRING_APP) !== null || (t.supertypes ?? []).some((s) => SPRING_BASE.has(baseOf(s)));
// The dump's own files: the caller only reads a dump that ran, and a missing one is a broken dump, so it throws.
const linesOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

/**
 * The app entry points a dump names: every method the engine marked `isMain` in a file whose types bind Spring — one
 * answer per file, the first declaration in source order. Only the two sections this needs are read (types, and the
 * `isMain` member lines), because the scan opens the whole dump a moment later and its calls section is far larger than
 * everything here.
 */
export function mainIndex(dir) {
  const types = new Map();
  for (const line of linesOf(path.join(dir, 'types.ndjson'))) {
    const t = JSON.parse(line);
    const file = t.pos?.file;
    if (file) push(types, file, t);
  }
  const mains = new Map();
  for (const line of linesOf(path.join(dir, 'members.ndjson')).filter((l) => l.includes('"isMain":true'))) {
    const m = JSON.parse(line);
    const file = m.pos?.file;
    if (!file || !(types.get(file) ?? []).some(bindsSpring)) continue;
    push(mains, file, { type: simple(m.owner), line: m.pos.line ?? null, id: m.id });
  }
  for (const list of mains.values()) list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { typesOf: (file) => types.get(file) ?? [], mainsIn: (file) => mains.get(file) ?? [] };
}

/**
 * Every string written as `pattern` in an annotation's argument tree, at any depth: `excludeFilters` is an array of
 * nested `@ComponentScan.Filter` annotations in the dump, so a filter is found by its argument name, not by its text.
 */
function patternsIn(node, out = [], key = null) {
  if (Array.isArray(node)) {
    for (const item of node) patternsIn(item, out, key);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.kind === 'string') {
    if (key === 'pattern' && node.kind === 'string') out.push(String(node.value));
    else if (node.kind === 'array') patternsIn(node.value, out, key);
    else if (node.kind === 'annotation') patternsIn(node.value?.args, out, null);
    return out;
  }
  for (const [name, value] of Object.entries(node)) patternsIn(value, out, name);
  return out;
}

/**
 * The app entry points among `java`. `dump` is `mainIndex` of the checkout's dump, which the caller has already run;
 * null when the engine could not run (the scan fails loudly on that, a few lines later).
 */
export function deployables({ java, files, rel, read, dump = null }) {
  const d = dump;
  const moduleOf = (p) => (p.includes('/src/main/java/') ? p.split('/src/main/java/')[0] : '.');
  const mods = new Set(java.map((j) => moduleOf(j.p)).filter((m) => m !== '.'));
  const deps = (m) => {
    const b = files.find(
      (f) =>
        rel(f) === `${m === '.' ? '' : m + '/'}pom.xml` ||
        rel(f) === `${m === '.' ? '' : m + '/'}build.gradle` ||
        rel(f) === `${m === '.' ? '' : m + '/'}build.gradle.kts`,
    );
    if (!b) return 0;
    const t = read(b);
    return [...mods].filter((o) => o !== m && new RegExp(`[>:'"]${path.basename(o)}[<'"]`).test(t)).length;
  };
  const mains = (d ? java : [])
    .flatMap((j) => d.mainsIn(j.p).map((m) => ({ file: j.p, line: m.line, module: moduleOf(j.p), name: m.type })))
    .map((m) => ({ ...m, deps: deps(m.module) }))
    .sort((a, b) => b.deps - a.deps);
  if (!mains.length) return { primary: null, others: [], isExcluded: () => false };
  const primary = mains[0],
    others = mains
      .slice(1)
      .filter((o) => o.module !== primary.module && !primary.module.startsWith(o.module + '/') && o.module !== '.');
  const patterns = d
    .typesOf(primary.file)
    .flatMap((t) => (t.ann ?? []).filter((a) => simple(a.name) === 'ComponentScan'))
    .flatMap((a) => patternsIn(a.args))
    .map((p) => new RegExp(p));
  const fqn = (p) =>
    p
      .split('/src/main/java/')[1]
      ?.replace(/\.java$/, '')
      .split('/')
      .join('.') ?? '';
  const isExcluded = (p) => others.some((o) => p.startsWith(o.module + '/')) || patterns.some((re) => re.test(fqn(p)));
  return { primary, others, excludedPatterns: patterns.map(String), isExcluded };
}
{
  // Two mains, two modules; the app's type carries the scan filter as the dump writes it (a nested annotation in an
  // array), and the worker's module still answers "pom.xml names it".
  const java = [{ p: 'app/src/main/java/x/App.java' }, { p: 'worker/src/main/java/x/W.java' }];
  const types = {
    'app/src/main/java/x/App.java': [
      {
        fqn: 'x.App',
        pos: { file: 'app/src/main/java/x/App.java', line: 3 },
        ann: [
          { name: 'SpringBootConfiguration', args: {} },
          {
            name: 'ComponentScan',
            args: {
              basePackages: { kind: 'array', value: [{ kind: 'string', value: 'x' }] },
              excludeFilters: {
                kind: 'array',
                value: [
                  {
                    kind: 'annotation',
                    value: {
                      name: 'ComponentScan.Filter',
                      args: {
                        type: { kind: 'enum', value: 'org.springframework.context.annotation.FilterType.REGEX' },
                        pattern: { kind: 'string', value: 'x\\.gw\\..*' },
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    ],
    'worker/src/main/java/x/W.java': [
      { fqn: 'x.W', pos: { file: 'worker/src/main/java/x/W.java', line: 2 }, ann: [{ name: 'SpringBootApplication' }] },
    ],
  };
  const mains = {
    'app/src/main/java/x/App.java': [{ type: 'App', line: 4, id: 'x.App#main(String[])' }],
    'worker/src/main/java/x/W.java': [{ type: 'W', line: 3, id: 'x.W#main(String[])' }],
  };
  const dump = { typesOf: (f) => types[f] ?? [], mainsIn: (f) => mains[f] ?? [] };
  const files = ['app/pom.xml', 'worker/pom.xml'],
    text = { 'app/pom.xml': '<artifactId>worker</artifactId>', 'worker/pom.xml': '' };
  const d = deployables({ java, files, rel: (f) => f, read: (f) => text[f], dump });
  assert.equal(d.primary.module, 'app');
  assert.equal(d.primary.name, 'App', "the entry point's type names the deployable");
  assert.equal(d.primary.line, 4);
  assert.deepStrictEqual(d.others.map((o) => [o.name, o.module, o.deps]), [['W', 'worker', 0]]);
  assert.deepStrictEqual(
    d.excludedPatterns,
    ['/x\\.gw\\..*/'],
    'the filter pattern is the annotation value, unescaped once',
  );
  assert.ok(d.isExcluded('worker/src/main/java/x/W.java'));
  assert.ok(d.isExcluded('app/src/main/java/x/gw/Api.java'));
  assert.ok(!d.isExcluded('app/src/main/java/x/core/Svc.java'));
  // A dump with no entry point has no app: the answer comes from the rows, not from the word "main" in a file.
  const none = { typesOf: (f) => types[f] ?? [], mainsIn: () => [] };
  assert.equal(deployables({ java, files, rel: (f) => f, read: (f) => text[f], dump: none }).primary, null);
}
{
  // The dump-section reader on a written-out dump: `isMain` picks the entry point, the Spring Boot annotation on its
  // type decides whether it is an app, and a main without one is left out.
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-index-'));
  const w = (name, list) =>
    fs.writeFileSync(path.join(dir, name), list.map((x) => JSON.stringify(x)).join('\n') + '\n');
  w('types.ndjson', [
    { fqn: 'a.App', kind: 'class', pos: { file: 'a/App.java' }, ann: [{ name: 'SpringBootApplication', args: {} }] },
    { fqn: 'a.Util', kind: 'class', pos: { file: 'a/Util.java' }, ann: [] },
    {
      fqn: 'a.Boot',
      kind: 'class',
      pos: { file: 'a/Boot.java' },
      ann: [],
      supertypes: [
        {
          kind: 'class',
          text: 'SpringBootServletInitializer',
          fqn: 'org.springframework.boot.web.servlet.support.SpringBootServletInitializer',
        },
      ],
    },
  ]);
  const main = (owner, line) => ({
    kind: 'method',
    owner,
    name: 'main',
    isMain: true,
    id: `${owner}#main(String[])`,
    pos: { file: `a/${owner.slice(2)}.java`, line },
  });
  w('members.ndjson', [
    main('a.App', 7),
    main('a.Util', 3),
    main('a.Boot', 5),
    { kind: 'method', owner: 'a.App', id: 'a.App#run()', name: 'run', isMain: false,
      pos: { file: 'a/App.java', line: 9 } },
  ]);
  const index = mainIndex(dir);
  assert.deepStrictEqual(index.mainsIn('a/App.java'), [{ type: 'App', line: 7, id: 'a.App#main(String[])' }]);
  assert.deepStrictEqual(index.mainsIn('a/Boot.java'), [{ type: 'Boot', line: 5, id: 'a.Boot#main(String[])' }],
    'a servlet initialiser boots Spring without an annotation');
  assert.deepStrictEqual(index.mainsIn('a/Util.java'), [],
    'a main in a type that is not a Spring app is not an entry point');
  assert.deepStrictEqual(index.mainsIn('a/Missing.java'), [], 'a file the dump does not list has no entry point');
}

// --- Boot: the one way to run the whole app locally ---------------------------------
// Flat key paths of a YAML or .properties file: "server.port" -> { value, line }.

// The Maven plugins that run an app server locally: the vocabulary's `local-servers`, with the pattern as a RegExp.
const RUNTIMES = tableOf('local-servers').map((r) => ({ ...r, re: new RegExp(r.pattern) }));
function eeBoot(pom, B, mvn, prefix = '') {
  const profiles = [...pom.matchAll(/<profile>[\s\S]*?<\/profile>/g)].map((m) => ({
    text: m[0],
    from: m.index,
    to: m.index + m[0].length,
    id: /<id>([^<]+)/.exec(m[0])?.[1],
    on: /<activeByDefault>\s*true/.test(m[0]),
  }));
  const off = profiles.filter((p) => !p.on),
    inOff = (i) => off.some((p) => i >= p.from && i < p.to);
  const first = (re) => [...pom.matchAll(new RegExp(re.source, 'g'))].find((m) => !inOff(m.index));
  const rt = RUNTIMES.map((r) => ({ r, m: first(r.re) }))
    .filter((x) => x.m)
    .sort((a, b) => a.m.index - b.m.index)[0];
  const packaging = /<packaging>\s*(war|ear)\s*</.exec(pom)?.[1];
  if (!rt && !packaging) return null;
  const own = pom.replace(/<parent>[\s\S]*?<\/parent>/, ''),
    fin = /<finalName>([^<$]+)<\/finalName>/.exec(own)?.[1],
    name = fin ?? /<artifactId>([^<]+)<\/artifactId>/.exec(own)?.[1] ?? 'the app';
  if (!rt)
    return [
      `run: no server plugin in ${B}: build with ${prefix}${mvn} clean package and deploy target/${name}.${packaging} to a Jakarta EE server`,
    ];
  const { goal, label, port } = rt.r,
    line = pom.slice(0, rt.m.index).split('\n').length;
  const c = /<containerId>\s*([a-z]+)/.exec(pom.slice(rt.m.index, rt.m.index + 2000))?.[1],
    server = label ?? (c ? c[0].toUpperCase() + c.slice(1) : 'the configured server');
  const out = [
    `run: ${prefix}${mvn} ${/:dev$/.test(goal) ? '' : 'clean package '}${goal} (${B}:${line}): runs the app in ${server}`,
    `url: http://localhost:${port}/${label === 'Quarkus' ? '' : `${name}/`} (${server}'s default port${label === 'Quarkus' ? '' : '; context root = the WAR name'})`,
  ];
  const alt = off
    .filter((p) => p.id)
    .map((p) => ({ p, r: RUNTIMES.find((r) => r.re.test(p.text)) }))
    .filter((x) => x.r);
  if (alt.length)
    out.push(`other servers (Maven profiles): ${alt.map(({ p, r }) => `-P${p.id} ${r.goal}`).join(', ')}`);
  return out;
}
{
  const pom =
    '<project><artifactId>shop</artifactId><packaging>war</packaging><build><finalName>shop</finalName></build><profiles>\n<profile><id>payara</id><activation><activeByDefault>true</activeByDefault></activation>\n<plugin><artifactId>cargo-maven3-plugin</artifactId><containerId>payara</containerId></plugin></profile>\n<profile><id>openliberty</id><plugin><artifactId>liberty-maven-plugin</artifactId></plugin></profile></profiles></project>';
  assert.deepStrictEqual(eeBoot(pom, 'pom.xml', './mvnw'), [
    'run: ./mvnw clean package cargo:run (pom.xml:3): runs the app in Payara',
    "url: http://localhost:8080/shop/ (Payara's default port; context root = the WAR name)",
    'other servers (Maven profiles): -Popenliberty liberty:run',
  ]);
  assert.equal(eeBoot('<project><packaging>jar</packaging></project>', 'pom.xml', 'mvn'), null);
}

// A runnable entry point: a `main` method (the dump's `isMain`) whose class is a Spring Boot app or whose body runs
// `SpringApplication`.
function mainsOf(model) {
  return [...model.types.values()]
    .filter((t) => !isTestCode(t.file))
    .filter((t) =>
      t.methods.some(
        (m) =>
          m.isMain &&
          (annotationOn(t, ...listOf('boot-start-annotations')) !== null ||
            (m.calls ?? []).some((c) => patternOf('spring-application-receivers').test(c.recvFqn ?? ''))),
      ),
    )
    .flatMap((t) => t.methods.filter((m) => m.isMain).map((m) => ({ file: t.file, line: m.nameLine })));
}

// The frontend's entry files (bundler configs, index pages, proxies), with the lines that say how they run.
const FE_ENTRY_FILE = new RegExp(
  [
    '(^|\\/)(vite\\.config\\.\\w+|index\\.html|src\\/main\\.[jt]sx?|src\\/index\\.[jt]sx?|',
    'angular\\.json|proxy\\.conf\\.json)$',
  ].join(''),
);
const FE_ENTRY_LINE = new RegExp(
  [
    'port|proxy|target|createRoot|render\\(|type="module"|bootstrapApplication|bootstrapModule|createApp|new App\\(',
    'mount\\(|"main":|"browser":',
  ].join('|'),
);
function frontendEntries(files, rel, read) {
  return files
    .filter((f) => FE_ENTRY_FILE.test(rel(f)) && !/node_modules|resources\/(static|templates)/.test(rel(f)))
    .map((f) => ({ file: rel(f), lines: linesMatching(read(f), FE_ENTRY_LINE).slice(0, 8) }));
}

// Compose files and the services each one declares, as `name:line`.
function composeServices(files, rel, read) {
  return files
    .filter((f) => /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/.test(rel(f)))
    .map((f) => ({
      file: rel(f),
      services: linesMatching(read(f), /^  [\w-]+:\s*$/).map((m) => `${m.text.replace(':', '')}:${m.line}`),
    }));
}

// The scripts of package.json files at the root or one folder down; an unreadable file has none.
function packageScripts(files, rel, read) {
  return files
    .filter((f) => /(^|\/)package\.json$/.test(rel(f)) && rel(f).split('/').length <= 3)
    .map((f) => {
      try {
        return { file: rel(f), scripts: JSON.parse(read(f)).scripts ?? {} };
      } catch {
        return { file: rel(f), scripts: degraded(`${rel(f)} is not readable JSON: its scripts are not listed`, {}) };
      }
    });
}

/**
 * How the app runs and what it reads: the `main` entry points, the frontend entry files, compose services, package
 * scripts and the profile files. Every answer is read from the dump's rows or from the files as text.
 */
export function bootEntries({ model, files, rel, read, configFiles }) {
  return {
    mains: mainsOf(model),
    profiles: configFiles.map((f) => rel(f)).filter((f) => /application-[\w]+\./.test(f)),
    frontend: frontendEntries(files, rel, read),
    compose: composeServices(files, rel, read),
    scripts: packageScripts(files, rel, read),
  };
}

export function bootFacts({ root, files, rel, git, app, read = (p) => fs.readFileSync(p, 'utf8') }) {
  const lineOf = (text, re) => {
    const i = text.split('\n').findIndex((l) => re.test(l));
    return i < 0 ? null : i + 1;
  };
  const build = files
    .filter((f) => /(^|\/)(build\.gradle(\.kts)?|pom\.xml)$/.test(rel(f)))
    .sort((a, b) => rel(a).split('/').length - rel(b).split('/').length)[0];
  if (!build) return [];
  const b = read(build),
    B = rel(build),
    dir = path.dirname(build),
    gradle = !B.endsWith('pom.xml');
  const out = [];
  const wrapper = fs.existsSync(path.join(dir, gradle ? 'gradlew' : 'mvnw'));
  const prefix = path.dirname(B) === '.' ? '' : `cd ${path.dirname(B)} && `;
  if (!app?.primary && !gradle) {
    const ee = eeBoot(b, B, wrapper ? './mvnw' : 'mvn', prefix);
    if (ee) return ee;
  }
  // A separate module only if it has its own build file; otherwise it is just a source folder of the root build.
  const ownBuild = (m) =>
    files.some((f) =>
      new RegExp(`^${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(pom\\.xml|build\\.gradle(\\.kts)?)$`).test(rel(f)),
    );
  const mod =
    app?.primary && app.primary.module !== '.' && app.primary.module !== path.dirname(B) && ownBuild(app.primary.module)
      ? app.primary.module
      : null;
  if (mod)
    out.push(
      `app: ${mod} (main ${app.primary.file}${app.primary.line ? ':' + app.primary.line : ''}); multi-module build, so confirm the exact command in the README. Usually: ${gradle ? `./gradlew :${path.basename(mod)}:bootRun` : `${wrapper ? './mvnw' : 'mvn'} -pl ${mod} -am spring-boot:run`}`,
    );
  else
    out.push(
      `run: ${prefix}${gradle ? (wrapper ? './gradlew' : 'gradle') + ' bootRun' : (wrapper ? './mvnw' : 'mvn') + ' spring-boot:run'} (${B}${gradle && lineOf(b, /\bbootRun\b/) ? ':' + lineOf(b, /\bbootRun\b/) : ''})`,
    );
  if (app?.others.length)
    out.push(
      `other deployables in this repo (not mapped): ${app.others.map((o) => `${o.name} (${o.module})`).join(', ')}${app.excludedPatterns.length ? `; also excluded from the app's component scan: ${app.excludedPatterns.join(', ')}` : ''}`,
    );

  // Profile the run command activates.
  let profile = null,
    profileAt = null;
  const lit =
    /spring\.profiles\.active\s*=\s*([\w-]+)/.exec(b) ??
    /<profiles>\s*<profile>([\w-]+)</.exec(b) ??
    /systemProperty\s*\(?\s*['"]spring\.profiles\.active['"]\s*,\s*['"]([\w-]+)['"]/.exec(b);
  if (lit) {
    profile = lit[1];
    profileAt = lineOf(b, new RegExp(lit[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } else {
    const v = /spring\.profiles\.active=?["']?\s*\+\s*(\w+)/.exec(b);
    const def = v && new RegExp(`\\b${v[1]}\\s*=\\s*[^\\n]*?['"]([\\w-]+)['"]`).exec(b);
    if (def) {
      profile = def[1];
      profileAt = lineOf(b, new RegExp(`\\b${v[1]}\\s*=`));
    }
  }

  const cfg = files.filter(
    (f) =>
      /src\/main\/resources\/application(-[\w-]+)?\.(ya?ml|properties)$/.test(rel(f)) &&
      (!mod || rel(f).startsWith(mod + '/')),
  );
  const load = (name) => {
    const f = cfg.find((c) => new RegExp(`/application${name ? '-' + name : ''}\\.(ya?ml|properties)$`).test(rel(c)));
    return f ? { file: rel(f), keys: configKeys(read(f), f.endsWith('.properties')) } : null;
  };
  const base = load(null);
  if (!profile && base?.keys.get('spring.profiles.active')) {
    const k = base.keys.get('spring.profiles.active');
    profile = k.value.replace(/^\$\{[^:}]*:?([^}]*)\}$/, '$1') || null;
    profileAt = `${base.file}:${k.line}`;
  }
  const prof = profile ? load(profile) : null;
  if (profile) {
    let where = 'no profile config file found';
    if (prof) {
      const tracked = git(root, ['ls-files', '--error-unmatch', prof.file]) != null;
      const ign = !tracked && git(root, ['check-ignore', '-v', prof.file]);
      where = tracked
        ? `${prof.file} (in git)`
        : `${prof.file} is NOT in git${ign ? ` (ignored by ${ign.split('\t')[0].replace(/:[^:]*$/, '')})` : ''}: a new developer must create it`;
    }
    out.push(`profile: ${profile} (${typeof profileAt === 'number' ? `${B}:${profileAt}` : profileAt}); ${where}`);
  }
  const port = (k) => k?.keys.get('server.port') && { ...k.keys.get('server.port'), file: k.file };
  const p = port(prof) ?? port(base);
  if (p) {
    const d = placeholderOf(p.value);
    const fixed = d?.def && /^\d+$/.test(d.def);
    out.push(`port: ${fixed ? `${d.def} unless ${d.key} is set` : p.value} (${p.file}:${p.line})`);
  } else out.push('port: 8080 (Spring default; no server.port)');

  // Does the backend build also build and serve the frontend?
  const fe = patternOf('frontend-build').exec(b),
    hook = patternOf('frontend-served-hook').exec(b);
  if (fe && hook)
    out.push(
      `frontend: built and served by the backend, so the run command starts the whole app (${B}:${lineOf(b, new RegExp(fe[0]))}, ${B}:${lineOf(b, new RegExp(hook[1]))})`,
    );

  // Settings with no default in the base config, and whether the profile file supplies them.
  if (base) {
    const need = [...base.keys].filter(([, v]) => /\$\{\w+\}/.test(v.value));
    const missing = need.filter(([k]) => !prof?.keys.has(k)),
      covered = need.filter(([k]) => prof?.keys.has(k));
    if (missing.length)
      out.push(
        `required, no default anywhere: ${missing.map(([k, v]) => `${/\$\{(\w+)\}/.exec(v.value)[1]} (${k}, ${base.file}:${v.line})`).join(', ')}`,
      );
    if (covered.length)
      out.push(`set by the ${profile} profile file instead of env vars: ${covered.map(([k]) => k).join(', ')}`);
  }
  return out;
}

