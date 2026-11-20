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

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, window, ...prefixes] = process.argv.slice(2);
  if (!root || !window || !prefixes.length) { console.error('usage: activity.mjs <root> <window> <pathPrefix>...'); process.exit(2); }
  const n = /^last (\d+) commits$/.exec(window);
  const range = n ? ['-n', n[1]] : [`--since=${window}`];
  const log = execFileSync('git', ['-C', root, 'log', '-M', '--name-status', '--format=@@%H', ...range, 'HEAD'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  console.log(JSON.stringify({ ...count(log, prefixes.map((p) => p.replace(/\/$/, ''))), since: window }));
}
