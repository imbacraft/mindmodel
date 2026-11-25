import { simple } from '../core/names.mjs';

// An annotation as the facts state it: its name and the argument list the dump wrote, never the source line.
const describeAnn = (a) => `@${a.name}${a.args ? `(${a.args})` : ''}`.slice(0, 160);

/**
 * The places one shape appears in a set of types, as `{file, line, text}`: an annotation on the type or its methods, a
 * supertype, a field's type, a method's return type, or a call. Each `text` says what the shape is — the supertype
 * implemented, the annotation written, the argument passed — and a place is listed once.
 */
export function modelEntries(types, { types: tSpec = {}, methods: mSpec = {}, fields: fSpec = {} } = {}) {
  const out = [];
  for (const t of types ?? []) {
    for (const a of t.ann ?? [])
      if ((tSpec.ann ?? []).some((re) => re.test(a.name)))
        out.push({ file: t.file, line: a.line ?? t.nameLine, text: describeAnn(a) });
    for (const sp of t.supers ?? []) {
      const name = simple(sp.fqn ?? sp.text ?? '');
      if (!tSpec.supers || !tSpec.supers.test(name)) continue;
      const verb = sp.kind === 'interface' ? 'implements' : 'extends';
      out.push({ file: t.file, line: t.nameLine, text: `${verb} ${name}` });
    }
    for (const f of t.fields ?? [])
      if (fSpec.type && (fSpec.type.test(f.type ?? '') || fSpec.type.test(f.typeFqn ?? '')))
        out.push({ file: t.file, line: f.line, text: `${f.type || f.typeFqn} ${f.name}` });
    for (const m of t.methods ?? []) {
      for (const a of m.ann ?? [])
        if ((mSpec.ann ?? []).some((re) => re.test(a.name)))
          out.push({ file: t.file, line: a.line ?? m.nameLine, text: describeAnn(a) });
      if (mSpec.returns && mSpec.returns.test(m.returns ?? ''))
        out.push({ file: t.file, line: m.nameLine, text: `${m.returns} ${m.name}()` });
      for (const c of m.calls ?? []) {
        if (!mSpec.calls || !mSpec.calls.test(c.name ?? '')) continue;
        if (mSpec.recv && !mSpec.recv.test(c.recvFqn ?? '')) continue;
        out.push({ file: t.file, line: c.line, text: `${c.name}(${(c.args ?? [])[0] ?? ''})` });
      }
    }
  }
  const seen = new Set();
  return out
    .filter((e) => {
      const k = `${e.file}:${e.line}:${e.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
