#!/usr/bin/env node
// Rename-aware activity for one region (rules 3.4): commits in the window that touched any of the given path prefixes.
// Usage: node activity.mjs <root> <window> <pathPrefix>...   window = "YYYY-MM-DD" (since) or "last N commits"
// Prints: {"commits":n,"of":total,"since":"..."}
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

export function count(log, prefixes) {
  // log: newest first, blocks "@@<sha>" followed by name-status lines; renames map old paths to their current name
  const alias = new Map(), current = (p) => { let seen = 0; while (alias.has(p) && seen++ < 50) p = alias.get(p); return p; };
  let total = 0, hits = 0, touched = false;
  for (const line of log.split('\n')) {
    if (line.startsWith('@@')) { if (touched) hits++; total++; touched = false; continue; }
    const parts = line.split('\t'); if (parts.length < 2) continue;
    if (/^R\d*/.test(parts[0])) alias.set(parts[1], current(parts[2]));
    const p = current(parts[parts.length - 1]);
    if (prefixes.some((x) => p === x || p.startsWith(x.endsWith('/') ? x : x + '/'))) touched = true;
  }
  if (touched) hits++;
  return { commits: hits, of: total };
}
assert.deepStrictEqual(count('@@a\nM\tsrc/new/A.java\n@@b\nR100\tsrc/old/A.java\tsrc/new/A.java\n@@c\nM\tsrc/old/A.java\n@@d\nM\tREADME.md', ['src/new']), { commits: 3, of: 4 });

export const git = (root, args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// The activity window (rules 3.4): 6 months before HEAD; under 20 commits there, the last 50; under 10 in total, none.
// headDate and total may be passed in by a caller that already asked git for them.
export function gitWindow(root, headDate = git(root, ['log', '-1', '--format=%cI']), total = Number(git(root, ['rev-list', '--count', 'HEAD']))) {
  if (!headDate) return null;
  const since = new Date(new Date(headDate).getTime() - 182.5 * 864e5).toISOString().slice(0, 10);
  const inWindow = Number(git(root, ['rev-list', '--count', `--since=${since}`, 'HEAD']));
  return inWindow >= 20 ? { kind: '6 months', since, commits: inWindow } : total >= 10 ? { kind: 'last 50 commits', since: `last ${Math.min(50, total)} commits`, commits: Math.min(50, total) } : null;
}

// One git log per root and window, shared by every region that asks.
const logs = new Map();
export function activityFor(root, window, prefixes) {
  const n = /^last (\d+) commits$/.exec(window), key = `${root}\0${window}`;
  if (!logs.has(key)) logs.set(key, git(root, ['log', '-M', '--name-status', '--format=@@%H', ...(n ? ['-n', n[1]] : [`--since=${window}`]), 'HEAD']) ?? '');
  return { ...count(logs.get(key), prefixes.map((p) => p.replace(/\/$/, ''))), since: window };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, window, ...prefixes] = process.argv.slice(2);
  if (!root || !window || !prefixes.length) { console.error('usage: activity.mjs <root> <window> <pathPrefix>...'); process.exit(2); }
  console.log(JSON.stringify(activityFor(root, window, prefixes)));
}
