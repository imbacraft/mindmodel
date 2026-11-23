#!/usr/bin/env node
// Pre-flight for /mindmodel: is the code about to be mapped a clean, current state? Never fetches (no network).
// Usage: node preflight.mjs <projectRoot>   Prints JSON: { ok, node, git, warnings[] }. ok=false means: ask the user before continuing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert';

const git = (root, args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

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
assert.deepStrictEqual(parseBranchLine('## main...origin/main [ahead 1, behind 3]'), {
  branch: 'main',
  upstream: 'origin/main',
  ahead: 1,
  behind: 3,
});
assert.deepStrictEqual(parseBranchLine('## feature/x'), { branch: 'feature/x', upstream: null, ahead: 0, behind: 0 });

// The Java runtime the Spoon engine runs on, from `java -version` (which prints to stderr). macOS's /usr/bin/java is a
// stub that follows JAVA_HOME, so the answer can differ per environment and both are tried.
export function javaMajor(env = process.env) {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8', env });
  const m = /version "(?:1\.)?(\d+)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return m ? +m[1] : null;
}
assert.equal(javaMajor({ PATH: '' }), null);

export function preflight(root) {
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

  const isRepo = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!isRepo) {
    warnings.push({
      level: 'info',
      text: 'Not a git repository: the map will have no activity badges and no commit reference.',
    });
    return { ok: !warnings.some((w) => w.level !== 'info'), node: process.versions.node, git: null, warnings };
  }

  const status = git(root, ['status', '--porcelain=v1', '-b']) ?? '';
  const [branchLine, ...changes] = status.split('\n');
  const b = parseBranchLine(branchLine);
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  const detached = b.branch?.startsWith('HEAD') || git(root, ['symbolic-ref', '-q', 'HEAD']) === null;
  const defaultBranch =
    (git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) ?? '').replace(/^origin\//, '') || null;
  const fetchHead = path.join(git(root, ['rev-parse', '--git-dir']) ?? '.git', 'FETCH_HEAD');
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
        prevSha && /^[0-9a-f]{6,}$/.test(prevSha) ? git(root, ['rev-list', '--count', `${prevSha}..HEAD`]) : null;
      warnings.push({
        level: 'info',
        text: `An existing map (built from ${prev || 'an unknown commit'}${behindBy != null ? `, ${behindBy} commit(s) ago` : ''}) will be replaced.`,
      });
    } catch {
      warnings.push({ level: 'info', text: 'An existing mindmodel/mindmodel.json will be replaced.' });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(process.argv[2] ?? '.');
  if (!fs.existsSync(root)) {
    console.log(JSON.stringify({ ok: false, warnings: [{ level: 'block', text: `No such directory: ${root}` }] }));
    process.exit(1);
  }
  const r = preflight(root);
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.warnings.some((w) => w.level === 'block') ? 1 : 0);
}
