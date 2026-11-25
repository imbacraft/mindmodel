// Config keys from yml/properties (moved unchanged from deep.mjs).
import assert from 'node:assert';
import { isE2e, isTestCode, relPosix } from '../core/paths.mjs';

// Config values by property key, from every application*.yml and .properties outside src/test. Channel and queue names
// come from here; nested YAML keys are joined with dots.
export function channelConfigOf(files, read) {
  const out = new Map();
  for (const f of files.filter((x) => /application[\w.-]*\.(ya?ml|properties)$/.test(x) && !isTestCode(x))) {
    const text = read(f);
    if (/\.properties$/.test(f)) {
      for (const m of text.matchAll(/^([\w.-]+)\s*[=:]\s*(.+)$/gm)) out.set(m[1].trim(), m[2].trim());
      continue;
    }
    const stack = [];
    for (const line of text.split('\n')) {
      const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(line);
      if (!m || /^\s*#/.test(line)) continue;
      const indent = m[1].length;
      while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
      const key = [...stack.map((x) => x[1]), m[2]].join('.');
      if (m[3].trim() && !/^[|>]/.test(m[3].trim())) out.set(key, m[3].trim().replace(/^["']|["']$/g, ''));
      else stack.push([indent, m[2]]);
    }
  }
  return out;
}

// The application and bootstrap config files under resources, outside test and e2e code. Tests are judged on the
// repo-relative path, so a checkout that sits under a folder named `tests` keeps its config.
export function configFilesOf(files, root) {
  return files.filter((f) => {
    const rel = relPosix(root, f);
    return (
      /(application|bootstrap)[\w-]*\.(properties|ya?ml)$/.test(rel) &&
      /resources/.test(rel) &&
      !isTestCode(rel) &&
      !isE2e(rel)
    );
  });
}

// Config keys by file, with the database a JDBC URL names. Keys only: a value never leaves the file.
export function configKeyFacts(configFiles, rel, read) {
  return configFiles.map((f) => {
    const t = read(f);
    const keys = f.endsWith('.properties')
      ? t
          .split('\n')
          .map((l, i) => [l.replace(/^#\s*/, ''), i + 1, /^\s*#/.test(l)])
          .filter(([l]) => /^[\w.\-\[\]]+\s*[=:]/.test(l))
          .map(([l, n, c]) => `${l.split(/[=:]/)[0].trim()}:${n}${c ? ' (commented)' : ''}`)
      : t
          .split('\n')
          .map((l, i) => [l, i + 1])
          .filter(([l]) => /^\s*[\w-]+:/.test(l))
          .map(([l, n]) => `${l.trim().split(':')[0]}:${n}`);
    const db = /jdbc:(\w+)/.exec(t);
    return { file: rel(f), db: db?.[1], keys };
  });
}

export function configKeys(text, props = false) {
  const out = new Map(),
    stack = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*(#|$)/.test(l)) return;
    if (props) {
      const m = /^\s*([\w.\-[\]]+)\s*[=:]\s*(.*)$/.exec(l);
      if (m) out.set(m[1], { value: m[2].trim(), line: i + 1 });
      return;
    }
    const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(l);
    if (!m) return;
    while (stack.length && stack[stack.length - 1].indent >= m[1].length) stack.pop();
    stack.push({ indent: m[1].length, key: m[2] });
    if (m[3] && !m[3].startsWith('#'))
      out.set(stack.map((s) => s.key).join('.'), {
        value: m[3].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, ''),
        line: i + 1,
      });
  });
  return out;
}
{
  const k = configKeys('server:\n  port: ${PORT:8080}\nspring:\n  datasource:\n    url: ${DB_URL}\n');
  assert.deepStrictEqual(k.get('server.port'), { value: '${PORT:8080}', line: 2 });
  assert.equal(k.get('spring.datasource.url').value, '${DB_URL}');
}

// Jakarta EE and MicroProfile apps have no main(): a server plugin in the build runs them. Profiles that are not
// active by default hold alternative servers, not the default run.
