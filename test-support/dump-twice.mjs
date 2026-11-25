// Two dumps of one checkout, timed: the dump must be identical byte for byte, and the second run says how long one
// costs. Usage: node test-support/dump-twice.mjs <checkout> [outdir-a] [outdir-b]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { jarPath } from '../engine/io/engine-jar.mjs';
import { IGNORED_DIRS, isTestCode } from '../engine/core/paths.mjs';
const SKIP_EXT =
  /\.(class|jar|war|ear|so|dll|dylib|exe|o|pyc|png|jpe?g|gif|webp|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|mov|avi|zip|gz|tgz|rar|7z|pdf|psd|map)$/i;

function javaFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github' && e.isDirectory()) continue;
    if (IGNORED_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) javaFiles(p, out);
    else if (!SKIP_EXT.test(e.name) && e.name.endsWith('.java') && !isTestCode(p)) out.push(p);
  }
  return out;
}

const [root, a, b] = process.argv.slice(2);
if (!root) throw new Error('usage: node dump-twice.mjs <checkout> [outdir-a] [outdir-b]');
const dirA = a ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mm-dump-a-'));
const dirB = b ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mm-dump-b-'));
const files = javaFiles(root).map((p) => path.relative(root, p).split(path.sep).join('/')).sort();
const list = path.join(os.tmpdir(), `mm-files-${process.pid}.txt`);
fs.writeFileSync(list, files.join('\n') + '\n');
const jar = jarPath();
console.log(`${files.length} java files, jar ${jar}`);
for (const out of [dirA, dirB]) {
  fs.rmSync(out, { recursive: true, force: true });
  const started = process.hrtime.bigint();
  execFileSync('java', [`-Xmx${process.env.MINDMODEL_ENGINE_XMX ?? '4g'}`, '-jar', jar, 'dump', '--compliance', '17', root, list, out], {
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  console.log(`${out}: ${(Number(process.hrtime.bigint() - started) / 1e9).toFixed(2)}s`);
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let same = true;
for (const name of ['types.ndjson', 'members.ndjson', 'calls.ndjson', 'fields.ndjson', 'files.ndjson']) {
  const x = sha(path.join(dirA, name));
  const y = sha(path.join(dirB, name));
  if (x !== y) same = false;
  console.log(`${x === y ? 'identical' : 'DIFFERS  '} ${name} ${x.slice(0, 12)} ${y.slice(0, 12)}`);
}
console.log(same ? 'byte-identical across two runs' : 'DUMPS DIFFER');
process.exitCode = same ? 0 : 1;
