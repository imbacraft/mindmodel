// V8, not the data, sets the peak: on fineract the parse alone leaves 387 MB RSS and the heap keeps committed pages
// it will not return, so a 5,000-file scan peaks at 565–640 MB with Node's default 16 MB semi-space and at 473–494 MB
// with a 3 MB one, at the same wall time. V8 reads the flag at startup, so a command-line run restarts itself once
// with it. Only the CLI entry points call this: a test that imports `scan` runs in the caller's own process.
import { spawnSync } from 'node:child_process';

const SEMI_SPACE_MB = 3;
const HEAP_TUNED = 'MINDMODEL_HEAP_TUNED';

export function retuneHeap(script = process.argv[1]) {
  if (process.env[HEAP_TUNED]) return;
  if (process.execArgv.some((a) => a.startsWith('--max-semi-space-size'))) return;
  const r = spawnSync(
    process.execPath,
    [`--max-semi-space-size=${SEMI_SPACE_MB}`, ...process.execArgv, script, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, [HEAP_TUNED]: '1' } },
  );
  process.exit(r.status ?? 1);
}
