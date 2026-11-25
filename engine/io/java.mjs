// The JDK on this machine, as `java -version` prints it (stderr, so both streams are kept). The parse is preflight's.
import { spawnSync } from 'node:child_process';

export function javaVersionText(env = process.env) {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8', env });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
