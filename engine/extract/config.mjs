// Config keys from yml/properties (moved unchanged from deep.mjs).
import assert from 'node:assert';

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
