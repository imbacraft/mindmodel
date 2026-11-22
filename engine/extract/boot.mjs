// Boot and deployables (moved unchanged from deep.mjs): which module is the app, how it runs, and its config keys.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { configKeys } from './config.mjs';

export function deployables({ java, files, rel, read }) {
  const isMain = (j) =>
    /static\s+void\s+main\s*\(/.test(j.text) &&
    /SpringApplication(Builder)?\b|@SpringBootApplication|@SpringBootConfiguration|@EnableAutoConfiguration/.test(
      j.text,
    );
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
  const mains = java
    .filter(isMain)
    .map((j) => ({
      file: j.p,
      line: j.text.split('\n').findIndex((l) => /static\s+void\s+main/.test(l)) + 1 || null,
      module: moduleOf(j.p),
      name: j.name,
    }))
    .map((m) => ({ ...m, deps: deps(m.module) }))
    .sort((a, b) => b.deps - a.deps);
  if (!mains.length) return { primary: null, others: [], isExcluded: () => false };
  const primary = mains[0],
    others = mains
      .slice(1)
      .filter((o) => o.module !== primary.module && !primary.module.startsWith(o.module + '/') && o.module !== '.');
  const mainText = java.find((j) => j.p === primary.file).text;
  const scanBlock =
    /@ComponentScan\s*\(([\s\S]*?)\)\s*\n\s*@|@ComponentScan\s*\(([\s\S]*?)\)\s*\n\s*(public\s+)?class/.exec(mainText);
  const patterns = scanBlock
    ? [...(scanBlock[1] ?? scanBlock[2]).matchAll(/pattern\s*=\s*"([^"]+)"/g)].map(
        (m) => new RegExp(m[1].replace(/\\\\/g, '\\')),
      )
    : [];
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
  const java = [
    {
      p: 'app/src/main/java/x/App.java',
      name: 'App',
      text: '@SpringBootConfiguration\n@ComponentScan(basePackages = {"x"}, excludeFilters = @ComponentScan.Filter(type = FilterType.REGEX, pattern = "x\\\\.gw\\\\..*"))\npublic class App { public static void main(String[] a) {} }',
    },
    {
      p: 'worker/src/main/java/x/W.java',
      name: 'W',
      text: '@SpringBootApplication\nclass W { public static void main(String[] a) {} }',
    },
  ];
  const files = ['app/pom.xml', 'worker/pom.xml'],
    text = { 'app/pom.xml': '<artifactId>worker</artifactId>', 'worker/pom.xml': '' };
  const d = deployables({ java, files, rel: (f) => f, read: (f) => text[f] });
  assert.equal(d.primary.module, 'app');
  assert.ok(d.isExcluded('worker/src/main/java/x/W.java'));
  assert.ok(d.isExcluded('app/src/main/java/x/gw/Api.java'));
  assert.ok(!d.isExcluded('app/src/main/java/x/core/Svc.java'));
}

// --- Boot: the one way to run the whole app locally ---------------------------------
// Flat key paths of a YAML or .properties file: "server.port" -> { value, line }.

const RUNTIMES = [
  [/quarkus-maven-plugin/, 'quarkus:dev', 'Quarkus', 8080],
  [/liberty-maven-plugin/, 'liberty:run', 'Open Liberty', 9080],
  [/wildfly(-jar)?-maven-plugin/, 'wildfly:run', 'WildFly', 8080],
  [/payara-micro-maven-plugin/, 'payara-micro:start', 'Payara Micro', 8080],
  [/tomee-maven-plugin/, 'tomee:run', 'TomEE', 8080],
  [/cargo-maven\d?-plugin/, 'cargo:run', null, 8080],
];
export function eeBoot(pom, B, mvn, prefix = '') {
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
  const rt = RUNTIMES.map((r) => ({ r, m: first(r[0]) }))
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
  const [, goal, label, port] = rt.r,
    line = pom.slice(0, rt.m.index).split('\n').length;
  const c = /<containerId>\s*([a-z]+)/.exec(pom.slice(rt.m.index, rt.m.index + 2000))?.[1],
    server = label ?? (c ? c[0].toUpperCase() + c.slice(1) : 'the configured server');
  const out = [
    `run: ${prefix}${mvn} ${/:dev$/.test(goal) ? '' : 'clean package '}${goal} (${B}:${line}): runs the app in ${server}`,
    `url: http://localhost:${port}/${label === 'Quarkus' ? '' : `${name}/`} (${server}'s default port${label === 'Quarkus' ? '' : '; context root = the WAR name'})`,
  ];
  const alt = off
    .filter((p) => p.id)
    .map((p) => ({ p, r: RUNTIMES.find((r) => r[0].test(p.text)) }))
    .filter((x) => x.r);
  if (alt.length) out.push(`other servers (Maven profiles): ${alt.map(({ p, r }) => `-P${p.id} ${r[1]}`).join(', ')}`);
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

export function bootFacts({ root, files, rel, git, app }) {
  const read = (p) => fs.readFileSync(p, 'utf8');
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
    const d = /^\$\{(\w+):(\d+)\}$/.exec(p.value);
    out.push(`port: ${d ? `${d[2]} unless ${d[1]} is set` : p.value} (${p.file}:${p.line})`);
  } else out.push('port: 8080 (Spring default; no server.port)');

  // Does the backend build also build and serve the frontend?
  const fe = /NpmTask|node-gradle|com\.github\.node|frontend-maven-plugin|npm\s+run|yarnBuild/.exec(b),
    hook = /(processResources|bootJar|generate-resources|prepare-package)[^\n]*/.exec(b);
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

