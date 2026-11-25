// Activity from git-log text, as pure data: the commits that touched a path set, the per-file counts and the window the
// counts use (rules 3.4). The git calls that produce these texts are io/activity.mjs.

// git reads a bare date in --since as that date at the current time of day, so the commit count would drift as the
// day passes. Pin the cutoff to midnight UTC instead.
export const sinceCutoff = (date) => `${date}T00:00:00Z`;

/** The first day of the six-month window that ends at the HEAD commit's date. */
export const sinceOf = (headDate) => new Date(new Date(headDate).getTime() - 182.5 * 864e5).toISOString().slice(0, 10);

// 6 months before HEAD when it holds 20+ commits; otherwise the last 50 when the repo has 10+ in total; otherwise none.
export function windowOf({ since, inWindow, total }) {
  if (inWindow >= 20) return { kind: '6 months', since, commits: inWindow };
  if (total >= 10) {
    const n = Math.min(50, total);
    return { kind: 'last 50 commits', since: `last ${n} commits`, commits: n };
  }
  return null;
}

// log: newest first, blocks "@@<sha>" followed by name-status lines; renames map old paths to their current name
export function count(log, prefixes) {
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

// Commits per file in one pass over a shared log: the flow rank asks about many entry files at once.
export function commitsPerFile(log) {
  const counts = new Map();
  let touched = new Set();
  const flush = () => {
    for (const p of touched) counts.set(p, (counts.get(p) ?? 0) + 1);
    touched = new Set();
  };
  for (const line of log.split('\n')) {
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
