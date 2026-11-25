import { git } from '../io/git.mjs';
import { activityByFile, forgetActivity, gitWindow } from '../io/activity.mjs';

/** The checkout's git state: HEAD, whether it has uncommitted changes, and the history window activity counts use. */
export function gitInfoOf(root) {
  const head = git(root, ['rev-parse', '--short', 'HEAD']).out;
  if (!head) return null;
  const dirty = !!git(root, ['status', '--porcelain', '--untracked-files=no']).out;
  const headDate = git(root, ['log', '-1', '--format=%cI']).out;
  const total = Number(git(root, ['rev-list', '--count', 'HEAD']).out);
  return { head, dirty, headDate, totalCommits: total, window: gitWindow(root, headDate, total) };
}

/**
 * Commits in the window that touched each flow entry's file, counted per file on demand. The entries are read in
 * chunks of 25 so the largest name-status page stays small; the shared log is dropped between chunks. An inherited
 * entry runs the declaring class's code, so that is the file whose churn matters.
 */
export function activityCounts(root, gitInfo, flowEntryList) {
  const win = gitInfo?.window;
  if (!win) return () => 0;
  const paths = [...new Set(flowEntryList.map((e) => (e.owner ?? e.t).file))];
  const counts = new Map();
  for (let i = 0; i < paths.length; i += 25) {
    for (const [p, n] of activityByFile(root, win.since, paths.slice(i, i + 25)))
      counts.set(p, (counts.get(p) ?? 0) + n);
    forgetActivity();
  }
  return (file) => counts.get(file) ?? 0;
}
