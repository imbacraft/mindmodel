// The dump, loaded and indexed: the only door Node has into the Java engine. No analysis lives here — a query either
// answers from the dump or says it cannot. Contract mismatches throw; nothing is filled in from a guess.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

export const CONTRACT = 1;

function rows(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const simple = (fqn) => String(fqn ?? '').split('.').pop();
const key = (file, line) => `${file}\u0000${line}`;

/**
 * Opens a dump directory. Indexes are built once: types and members by name, calls by owning method and by call site,
 * subtypes from the supertype lists. `root` is optional and only used to resolve positions to absolute paths.
 */
export function open(dir) {
  const metaFile = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaFile)) throw new Error(`no dump at ${dir}: meta.json missing`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (meta.contract !== CONTRACT) throw new Error(`dump contract ${meta.contract}, this loader speaks ${CONTRACT}`);
  const types = rows(path.join(dir, 'types.ndjson'));
  const members = rows(path.join(dir, 'members.ndjson'));
  const calls = fs.existsSync(path.join(dir, 'calls.ndjson')) ? rows(path.join(dir, 'calls.ndjson')) : [];

  const byFqn = new Map(types.map((t) => [t.fqn, t]));
  const byId = new Map();
  const byOwner = new Map();
  for (const m of members) {
    if (m.id) byId.set(m.id, m);
    const list = byOwner.get(m.owner) ?? [];
    list.push(m);
    byOwner.set(m.owner, list);
  }
  const byMethod = new Map();
  const callers = new Map();
  const byLine = new Map();
  const bySite = new Map();
  for (const c of calls) {
    for (const [map, k] of [
      [byMethod, c.method],
      [byLine, key(c.file, c.line)],
      [bySite, key(c.file, `${c.line}:${c.col}`)],
    ]) {
      const list = map.get(k) ?? [];
      list.push(c);
      map.set(k, list);
    }
    for (const t of c.targets ?? []) callers.set(t, [...(callers.get(t) ?? []), c]);
  }
  const subtypes = new Map();
  for (const t of types)
    for (const s of t.supertypes ?? []) subtypes.set(s.fqn, [...(subtypes.get(s.fqn) ?? []), t.fqn]);

  /** Annotations on a type or member, by full name or simple name; the arguments are values, or null when unresolved. */
  const annotation = (element, name) => {
    const hit = (element?.ann ?? []).find((a) => a.name === name || simple(a.name) === name);
    if (!hit) return null;
    const args = {};
    for (const [k, v] of Object.entries(hit.args ?? {})) args[k] = v.kind === 'unresolved' ? null : v.value;
    return args;
  };

  const grep = (text, { limit = 40, kind } = {}) => {
    const needle = String(text).toLowerCase();
    const out = [];
    for (const t of types) {
      if ((!kind || t.kind === kind) && t.fqn.toLowerCase().includes(needle))
        out.push({ what: 'type', name: t.fqn, pos: t.pos });
      // A member kind filter must not hide the members of a type whose kind does not match.
      for (const m of byOwner.get(t.fqn) ?? []) {
        if (kind && m.kind !== kind) continue;
        if (m.name?.toLowerCase().includes(needle) || m.id?.toLowerCase().includes(needle))
          out.push({ what: m.kind, name: m.id ?? `${m.owner}#${m.name}`, pos: m.pos });
      }
      if (out.length >= limit) return out.slice(0, limit);
    }
    return out;
  };

  return {
    dir,
    meta,
    types: byFqn,
    members: byId,
    calls,
    type: (fqn) => byFqn.get(fqn) ?? null,
    membersOf: (fqn) => byOwner.get(fqn) ?? [],
    callsOf: (methodId) => byMethod.get(methodId) ?? [],
    callersOf: (methodId) => callers.get(methodId) ?? [],
    implsOf: (fqn) => subtypes.get(fqn) ?? [],
    subtypesOf: (fqn) => subtypes.get(fqn) ?? [],
    atLine: (file, line) => byLine.get(key(file, line)) ?? [],
    atSite: (file, line, col) => bySite.get(key(file, `${line}:${col}`)) ?? [],
    annotation,
    grep,
    /** The literal value of a final field, `{kind, value}` or null. */
    constant: (fqn, name) => byOwner.get(fqn)?.find((m) => m.kind === 'field' && m.name === name)?.value ?? null,
    simple,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check on a dump written here and then read back, so the loader is exercised without a jar or a project.
{
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dump-load-'));
  const w = (name, list) => fs.writeFileSync(path.join(dir, name), list.map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ contract: CONTRACT, engine: 'test', counts: { types: 2 } }));
  w('types.ndjson', [
    { fqn: 'a.Port', kind: 'interface', supertypes: [], ann: [], pos: { file: 'a/Port.java', line: 1, col: 1, endLine: 2, endCol: 1 } },
    { fqn: 'a.Impl', kind: 'class', supertypes: [{ kind: 'interface', text: 'Port', fqn: 'a.Port' }], ann: [],
      pos: { file: 'a/Impl.java', line: 1, col: 1, endLine: 3, endCol: 1 } },
  ]);
  w('members.ndjson', [
    { kind: 'method', owner: 'a.Port', name: 'find', id: 'a.Port#find(Long)', params: [{ type: 'Long' }], returns: 'Order', ann: [],
      pos: { file: 'a/Port.java', line: 2, col: 5, endLine: 2, endCol: 20 } },
    { kind: 'method', owner: 'a.Impl', name: 'find', id: 'a.Impl#find(Long)', params: [{ type: 'Long' }], returns: 'Order',
      ann: [{ name: 'org.springframework.transaction.annotation.Transactional', args: { value: { kind: 'string', value: 'x' } } }],
      pos: { file: 'a/Impl.java', line: 2, col: 5, endLine: 2, endCol: 20 } },
    { kind: 'field', owner: 'a.Impl', name: 'PATH', type: 'String', modifiers: ['static', 'final'], value: { kind: 'string', value: '/x' },
      ann: [], pos: { file: 'a/Impl.java', line: 1, col: 30, endLine: 1, endCol: 60 } },
  ]);
  w('calls.ndjson', [
    { method: 'a.Impl#find(Long)', file: 'a/Impl.java', line: 2, col: 9, name: 'find', argc: 1, recv: { type: 'a.Port', kind: 'field' },
      targets: ['a.Port#find(Long)', 'a.Impl#find(Long)'], origin: 'java' },
    { method: 'a.Impl#find(Long)', file: 'a/Impl.java', line: 2, col: 25, name: 'save', argc: 0, recv: { type: null, kind: 'implicit' },
      targets: [], origin: 'unresolved', reason: 'no-callee' },
  ]);
  const d = open(dir);
  assert.deepEqual(d.implsOf('a.Port'), ['a.Impl']);
  assert.deepEqual(d.callersOf('a.Impl#find(Long)').map((c) => c.name), ['find']);
  assert.deepEqual(d.atSite('a/Impl.java', 2, 9).map((c) => c.origin), ['java']);
  assert.deepEqual(d.annotation(d.members.get('a.Impl#find(Long)'), 'Transactional'), { value: 'x' });
  assert.equal(d.constant('a.Impl', 'PATH').value, '/x');
  assert.equal(d.grep('impl').length, 2);
  assert.equal(d.membersOf('a.Port').length, 1);
  assert.throws(() => {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ contract: 99 }));
    open(dir);
  }, /contract 99/);
}
