// Spring's placeholders, `${key}` and `${key:default}`. The caller's lookup supplies the values; this only reads the
// syntax, so every config reader and channel name shares one parse.
import assert from 'node:assert';

// The placeholder a whole value is: its key and default (null when it has none, or when empty), or null when the
// value is not a placeholder at all.
export function placeholderOf(value) {
  const m = /^\$\{([^}:]+)(?::([^}]*))?\}$/.exec(String(value ?? '').trim());
  return m ? { key: m[1], def: m[2] || null } : null;
}

// Each placeholder in `text` replaced by the lookup's value for its key, else its default, else left as written.
export function resolvePlaceholders(text, lookup) {
  return String(text ?? '').replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (whole, key, def) => {
    const v = lookup(key);
    return v != null ? String(v) : def || whole;
  });
}

{
  assert.deepStrictEqual(placeholderOf('${PORT:8080}'), { key: 'PORT', def: '8080' });
  assert.deepStrictEqual(placeholderOf('${DB_URL}'), { key: 'DB_URL', def: null });
  assert.deepStrictEqual(placeholderOf('${X:}'), { key: 'X', def: null });
  assert.equal(placeholderOf('jdbc:${DB}'), null);
  assert.equal(resolvePlaceholders('${a}-${b:x}-${c}', (k) => (k === 'a' ? 1 : null)), '1-x-${c}');
  assert.equal(resolvePlaceholders('plain', () => 'z'), 'plain');
}
