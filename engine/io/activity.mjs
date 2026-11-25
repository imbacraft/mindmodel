// The git calls behind the activity counts: the window's HEAD date and total, and the log of the window. The text is
// read by core/git-log.mjs.
import { git } from './git.mjs';
import { commitsPerFile, count, sinceCutoff, sinceOf, windowOf } from '../core/git-log.mjs';

// The activity window (rules 3.4), or null. headDate and total may come from a caller that already asked git.
export function gitWindow(
  root,
  headDate = git(root, ['log', '-1', '--format=%cI']).out,
  total = Number(git(root, ['rev-list', '--count', 'HEAD']).out),
) {
  if (!headDate) return null;
  const since = sinceOf(headDate);
  const inWindow = Number(git(root, ['rev-list', '--count', `--since=${sinceCutoff(since)}`, 'HEAD']).out);
  return windowOf({ since, inWindow, total });
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
      ]).out ?? '',
    );
  return logs.get(key);
};

export const activityByFile = (root, window, paths = []) => commitsPerFile(logFor(root, window, paths));

export function activityFor(root, window, prefixes) {
  return {
    ...count(
      logFor(root, window),
      prefixes.map((p) => p.replace(/\/$/, '')),
    ),
    since: window,
  };
}

// A 5,000-file history is a large string to keep after the scan has counted what it needed.
export function forgetActivity() {
  logs.clear();
}
