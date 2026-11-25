// The one place git is run. Synchronous, read-only, and never throws: a caller gets `{ out, reason }`, where `out` is
// stdout (trimmed unless `trim: false`) or null, and `reason` says why there is none.
import { spawnSync } from 'node:child_process';

export function git(root, args, { trim = true, timeout } = {}) {
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { out: null, reason: r.error.message };
  if (r.status !== 0) return { out: null, reason: (r.stderr || '').trim().split('\n')[0] || `git exit ${r.status}` };
  const out = r.stdout ?? '';
  return { out: trim ? out.trim() : out, reason: null };
}
