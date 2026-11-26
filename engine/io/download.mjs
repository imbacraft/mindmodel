// Verified downloads into the user's cache, shared by the engine jar (io/engine-jar.mjs) and the Lombok jar
// (io/lombok-jar.mjs). The bytes go to a temporary name first and are renamed into place only once the caller's check
// passes, so a cache path never holds a partial or unverified file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** `~/.cache/mindmodel`, honouring XDG_CACHE_HOME. */
export function cacheRoot() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'mindmodel');
}

/** The hex digest of a file; `sha256` unless another algorithm is named. */
export function hashFile(file, algo = 'sha256') {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
}

/**
 * Fetches `url` into `dest`. `verify(tempFile)` throws when the bytes are not the expected ones. A failed fetch, an
 * HTTP error or a failed check leaves nothing behind; the caller turns the thrown error into its own reason.
 */
export async function fetchVerified({ url, dest, verify, fetch = globalThis.fetch }) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
    verify(temp);
    fs.renameSync(temp, dest);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
