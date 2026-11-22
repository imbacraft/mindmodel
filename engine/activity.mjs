#!/usr/bin/env node
// Rename-aware activity for one region (rules 3.4): commits in the window that touched any of the given path prefixes.
// Usage: node activity.mjs <root> <window> <pathPrefix>...   window = "YYYY-MM-DD" (since) or "last N commits"
// Prints: {"commits":n,"of":total,"since":"..."}
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

export function count(log, prefixes) {
  // log: newest first, blocks "@@<sha>" followed by name-status lines; renames map old paths to their current name
  const alias = new Map(),
    current = (p) => {
      let seen = 0;
      while (alias.has(p) && seen++ < 50) p = alias.get(p);
      return p;
    };
  let total = 0,
    hits = 0,
    touched = false;
  for (const line of log.split('\n')) {
    if (line.startsWith('@@')) {
      if (touched) hits++;
      total++;
      touched = false;
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    if (/^R\d*/.test(parts[0])) alias.set(parts[1], current(parts[2]));
    const p = current(parts[parts.length - 1]);
    if (prefixes.some((x) => p === x || p.startsWith(x.endsWith('/') ? x : x + '/'))) touched = true;
  }
  if (touched) hits++;
  return { commits: hits, of: total };
}
assert.deepStrictEqual(
  count(
    '@@a\nM\tsrc/new/A.java\n@@b\nR100\tsrc/old/A.java\tsrc/new/A.java\n@@c\nM\tsrc/old/A.java\n@@d\nM\tREADME.md',
    ['src/new'],
  ),
  { commits: 3, of: 4 },
);

export const git = (root, args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

// git reads a bare date in --since as that date at the current time of day, so the commit count would drift as the
// day passes. Pin the cutoff to midnight UTC instead.
export const sinceCutoff = (date) => `${date}T00:00:00Z`;
assert.equal(sinceCutoff('2026-05-23'), '2026-05-23T00:00:00Z');

// The activity window (rules 3.4): 6 months before HEAD; under 20 commits there, the last 50; under 10 in total, none.
// headDate and total may be passed in by a caller that already asked git for them.
export function gitWindow(
  root,
  headDate = git(root, ['log', '-1', '--format=%cI']),
  total = Number(git(root, ['rev-list', '--count', 'HEAD'])),
) {
  if (!headDate) return null;
  const since = new Date(new Date(headDate).getTime() - 182.5 * 864e5).toISOString().slice(0, 10);
  const inWindow = Number(git(root, ['rev-list', '--count', `--since=${sinceCutoff(since)}`, 'HEAD']));
  return inWindow >= 20
    ? { kind: '6 months', since, commits: inWindow }
    : total >= 10
      ? { kind: 'last 50 commits', since: `last ${Math.min(50, total)} commits`, commits: Math.min(50, total) }
      : null;
}

// One git log per root and window, shared by every region that asks.
const logs = new Map();
const logFor = (root, window, paths = []) => {
  const n = /^last (\d+) commits$/.exec(window),
    key = `${root}\0${window}\0${paths.join('\0')}`;
  if (!logs.has(key))
    logs.set(
      key,
      git(root, [
        'log',
        '-M',
        '--name-status',
        '--format=@@%H',
        ...(n ? ['-n', n[1]] : [`--since=${sinceCutoff(window)}`]),
        'HEAD',
        // Limited to the paths asked about: a 5,000-file history is otherwise tens of megabytes of name-status lines.
        ...(paths.length ? ['--', ...paths] : []),
      ]) ?? '',
    );
  return logs.get(key);
};

// Commits per file in one pass over the shared log: the flow rank asks about many entry files, and counting them one
// prefix at a time re-read the whole history for each.
export function activityByFile(root, window, paths = []) {
  const counts = new Map();
  let touched = new Set();
  const flush = () => {
    for (const p of touched) counts.set(p, (counts.get(p) ?? 0) + 1);
    touched = new Set();
  };
  for (const line of logFor(root, window, paths).split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      continue;
    }
    const parts = line.split('\t');
    if (parts.length >= 2) touched.add(parts[parts.length - 1]);
  }
  flush();
  return counts;
}
// A 5,000-file history is a large string to keep after the scan has counted what it needed.
export function forgetActivity() {
  logs.clear();
}
export function activityFor(root, window, prefixes) {
  return {
    ...count(
      logFor(root, window),
      prefixes.map((p) => p.replace(/\/$/, '')),
    ),
    since: window,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, window, ...prefixes] = process.argv.slice(2);
  if (!root || !window || !prefixes.length) {
    console.error('usage: activity.mjs <root> <window> <pathPrefix>...');
    process.exit(2);
  }
  console.log(JSON.stringify(activityFor(root, window, prefixes)));
}
