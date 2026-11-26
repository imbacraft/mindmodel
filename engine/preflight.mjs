#!/usr/bin/env node
// Pre-flight for /mindmodel: is the code about to be mapped a clean, current state, and can the engine run here? It
// never touches the network for the project's code; its fetches are the engine jar, once per version
// (io/engine-jar.mjs), and the Lombok jar when the project uses Lombok (io/lombok-jar.mjs).
// Usage: node preflight.mjs <projectRoot>   Prints JSON: { ok, node, git, warnings[] }. ok=false means: ask the user before continuing.
import fs from 'node:fs';
import path from 'node:path';
import { ensure } from './io/engine-jar.mjs';
import { ensureLombok, lombokOf } from './io/lombok-jar.mjs';
import { git } from './io/git.mjs';
import { javaVersionText } from './io/java.mjs';
import { preflightLines as classpathLines, tildify } from './io/classpath.mjs';

// "## main...origin/main [ahead 1, behind 3]" → { branch, upstream, ahead, behind }
export function parseBranchLine(line) {
  const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(line ?? '');
  if (!m) return {};
  const nums = m[3] ?? '';
  return {
    branch: m[1],
    upstream: m[2] ?? null,
    ahead: +(/ahead (\d+)/.exec(nums)?.[1] ?? 0),
    behind: +(/behind (\d+)/.exec(nums)?.[1] ?? 0),
  };
}

// The Java runtime the Spoon engine runs on, from `java -version` (which prints to stderr). macOS's /usr/bin/java is a
// stub that follows JAVA_HOME, so the answer can differ per environment and both are tried.
export function javaMajor(env = process.env) {
  const m = /version "(?:1\.)?(\d+)/.exec(javaVersionText(env));
  return m ? +m[1] : null;
}

function preflightInner(root) {
  const warnings = [];
  const major = +process.versions.node.split('.')[0];
  if (major < 18)
    warnings.push({ level: 'block', text: `Node ${process.versions.node} is too old; mindmodel needs Node 18+.` });

  // The Java engine needs a JDK 17+; without one every call stays a guess, so the run is blocked rather than degraded.
  const withHome = javaMajor();
  const bare = javaMajor(Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'JAVA_HOME')));
  const java = Math.max(withHome ?? 0, bare ?? 0) || null;
  if (!java || java < 17)
    warnings.push({
      level: 'block',
      text: `Java 17+ not found on PATH (${java ? `found ${java}` : 'no java'}); the Spoon engine cannot run. Install a JDK 17+.`,
    });

  // The classpath is optional and never blocks: one line says where the dependencies would come from, and the only
  // `confirm` is a Maven build that would execute project code (extensions, .mvn/jvm.config, .mvn/maven.config).
  warnings.push(...classpathLines(root));

  const isRepo = git(root, ['rev-parse', '--is-inside-work-tree']).out === 'true';
  if (!isRepo) {
    warnings.push({
      level: 'info',
      text: 'Not a git repository: the map will have no activity badges and no commit reference.',
    });
    return { ok: !warnings.some((w) => w.level !== 'info'), node: process.versions.node, git: null, warnings };
  }

  const status = git(root, ['status', '--porcelain=v1', '-b']).out ?? '';
  const [branchLine, ...changes] = status.split('\n');
  const b = parseBranchLine(branchLine);
  const head = git(root, ['rev-parse', '--short', 'HEAD']).out;
  const detached = b.branch?.startsWith('HEAD') || git(root, ['symbolic-ref', '-q', 'HEAD']).out === null;
  const defaultBranch =
    (git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out ?? '').replace(/^origin\//, '') || null;
  const fetchHead = path.join(git(root, ['rev-parse', '--git-dir']).out ?? '.git', 'FETCH_HEAD');
  const fetchFile = path.isAbsolute(fetchHead) ? fetchHead : path.join(root, fetchHead);
  const lastFetchDays = fs.existsSync(fetchFile)
    ? Math.floor((Date.now() - fs.statSync(fetchFile).mtimeMs) / 864e5)
    : null;
  const uncommitted = changes.filter((l) => l.trim() && !l.startsWith('??')).length;
  const untracked = changes.filter((l) => l.startsWith('??') && !/ mindmodel\//.test(l)).length;

  if (uncommitted)
    warnings.push({
      level: 'confirm',
      text: `${uncommitted} file(s) have uncommitted changes: the map will describe code that is in no commit.`,
    });
  if (b.behind)
    warnings.push({
      level: 'confirm',
      text: `Branch is ${b.behind} commit(s) behind ${b.upstream} (as of the last fetch${lastFetchDays != null ? `, ${lastFetchDays} day(s) ago` : ''}): the map will describe outdated code. Consider pulling first.`,
    });
  if (detached)
    warnings.push({
      level: 'confirm',
      text: `Detached HEAD at ${head}: the map will describe a commit that is not on any branch.`,
    });
  else if (defaultBranch && b.branch && b.branch !== defaultBranch)
    warnings.push({
      level: 'confirm',
      text: `On branch "${b.branch}", not the default "${defaultBranch}": the map will describe this branch.`,
    });
  if (!b.upstream && !detached)
    warnings.push({ level: 'info', text: 'Branch has no upstream: cannot tell whether it is behind the remote.' });
  else if (lastFetchDays != null && lastFetchDays > 7)
    warnings.push({
      level: 'info',
      text: `Last fetch was ${lastFetchDays} days ago: "behind" may be out of date. Run git fetch to be sure.`,
    });
  if (untracked) warnings.push({ level: 'info', text: `${untracked} untracked file(s) will be included in the scan.` });

  const existing = path.join(root, 'mindmodel', 'mindmodel.json');
  if (fs.existsSync(existing)) {
    try {
      const prev = JSON.parse(fs.readFileSync(existing, 'utf8')).project?.commit ?? '';
      const prevSha = prev.split(/\s/)[0];
      const behindBy =
        prevSha && /^[0-9a-f]{6,}$/.test(prevSha)
          ? git(root, ['rev-list', '--count', `${prevSha}..HEAD`]).out
          : null;
      const since = `${prev || 'an unknown commit'}${behindBy != null ? `, ${behindBy} commit(s) ago` : ''}`;
      warnings.push({
        level: 'info',
        text:
          `An existing map (built from ${since}) will be replaced: the scan moves it to ` +
          'mindmodel/.work/previous-mindmodel.json and the writer starts from the facts.',
      });
    } catch {
      warnings.push({
        level: 'info',
        text: 'An existing mindmodel/mindmodel.json will be moved to mindmodel/.work/previous-mindmodel.json and replaced.',
      });
    }
  }
  return {
    ok: !warnings.some((w) => w.level !== 'info'),
    node: process.versions.node,
    java,
    git: {
      head,
      branch: b.branch,
      upstream: b.upstream,
      ahead: b.ahead,
      behind: b.behind,
      defaultBranch,
      uncommitted,
      lastFetchDays,
    },
    warnings,
  };
}

// The Lombok jar, when the project uses Lombok. Its outcome is an info line, never a block: without the jar the
// hand-written Lombok rules are used and the map is degraded. Returns null when the project does not use Lombok.
async function lombokStatus(root, warnings) {
  const { used, version } = lombokOf(root);
  if (!used) return null;
  const found = await ensureLombok(version);
  if (!found.ok) {
    warnings.push({
      level: 'info',
      text: `Lombok not available (${found.reason}): hand-written Lombok rules are used, degraded.`,
    });
    return { ok: false, version, reason: found.reason };
  }
  const mb = (fs.statSync(found.path).size / 1048576).toFixed(1);
  warnings.push({
    level: 'info',
    text:
      found.source === 'download'
        ? `Lombok ${version} downloaded once (${mb} MB) into the mindmodel cache.`
        : `Lombok ${version} located (${found.source}, ${mb} MB): ${tildify(found.path)}`,
  });
  return { ok: true, path: found.path, source: found.source, version };
}

/**
 * The gate a run passes through: the project's own state, the JDK, and an engine jar that is present and verified.
 * `ok: false` means a block-level warning, and the caller must ask before going on.
 */
export async function preflight(root) {
  const r = preflightInner(root);
  const engine = await ensure({ log: (text) => r.warnings.push({ level: 'info', text }) });
  if (!engine.ok) r.warnings.push({ level: 'block', text: engine.reason });
  r.engine = { ok: engine.ok, source: engine.source ?? null, path: engine.path ?? null };
  r.lombok = await lombokStatus(root, r.warnings);
  r.ok = !r.warnings.some((w) => w.level !== 'info');
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(process.argv[2] ?? '.');
  if (!fs.existsSync(root)) {
    console.log(JSON.stringify({ ok: false, warnings: [{ level: 'block', text: `No such directory: ${root}` }] }));
    process.exit(1);
  }
  const r = await preflight(root);
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.warnings.some((w) => w.level === 'block') ? 1 : 0);
}
