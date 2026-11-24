// The dump, loaded and indexed: the only door Node has into the Java engine. No analysis lives here — a query either
// answers from the dump or says it cannot. Contract mismatches throw; nothing is filled in from a guess.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

export const CONTRACT = 2;

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
  // Contract 2 sections: absent in an older dump, empty rather than fatal, because the indexes below answer [] then.
  const fields = fs.existsSync(path.join(dir, 'fields.ndjson')) ? rows(path.join(dir, 'fields.ndjson')) : [];
  const files = fs.existsSync(path.join(dir, 'files.ndjson')) ? rows(path.join(dir, 'files.ndjson')) : [];

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
  const byMethodRef = new Map();
  const callers = new Map();
  const byLine = new Map();
  const bySite = new Map();
  const byCallId = new Map();
  for (const c of calls) {
    if (c.id) byCallId.set(c.id, c);
    const map = c.via === 'methodRef' ? byMethodRef : byMethod;
    for (const [target, k] of [
      [map, c.method],
      [byLine, key(c.file, c.line)],
      [bySite, key(c.file, `${c.line}:${c.col}`)],
    ]) {
      const list = target.get(k) ?? [];
      list.push(c);
      target.set(k, list);
    }
    for (const t of c.targets ?? []) callers.set(t, [...(callers.get(t) ?? []), c]);
  }
  // Field reads and writes by field, so "which methods write this holder" is a lookup, not a scan.
  const byField = new Map();
  for (const f of fields) {
    if (!f.field) continue;
    const list = byField.get(f.field) ?? [];
    list.push(f);
    byField.set(f.field, list);
  }
  const byFile = new Map(files.map((f) => [f.path, f]));
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
    fields,
    files: byFile,
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
    /** The arguments of one call row, typed: `[{text, kind, ...}]`, in source order. */
    argsOf: (callId) => byCallId.get(callId)?.args ?? [],
    /** Every read and write of one field (`owner#name`), in file and source order. */
    fieldAccessOf: (fieldId) => byField.get(fieldId) ?? [],
    /** The methods that write one field: the same rows, writes only. */
    writersOf: (fieldId) => (byField.get(fieldId) ?? []).filter((f) => f.op === 'write'),
    /** What one method returns, and the arms of any switch whose result it hands on. */
    returnsOf: (methodId) => byId.get(methodId)?.returned ?? [],
    /** The method references written inside one method. */
    methodRefsIn: (methodId) => byMethodRef.get(methodId) ?? [],
    /** A file's imports as written, or null when the dump could not read its header (never an empty-list guess). */
    imports: (file) => {
      const row = byFile.get(file);
      if (!row || row.importsOrigin === 'unresolved') return null;
      return row.imports ?? [];
    },
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
      isMain: false,
      ann: [{ name: 'org.springframework.transaction.annotation.Transactional', args: { value: { kind: 'string', value: 'x' } } }],
      // One switch whose result the method hands on, one plain return, one value the engine could not describe.
      returned: [
        { kind: 'return', line: 2, col: 5, value: { text: 'PATH', kind: 'constant', type: 'java.lang.String', value: '/x' } },
        { kind: 'switch', line: 3, col: 5, form: 'expression', target: 'code',
          on: { text: 'status', kind: 'param', type: 'java.lang.String', index: 0 },
          arms: [
            { labels: ['NEW'], default: false, value: { text: 'A', kind: 'literal', type: 'java.lang.String', value: 'A' } },
            { labels: [], default: true, value: { text: 'mystery.x', kind: 'unresolved', type: null, reason: 'no-declaration' } },
          ] },
      ],
      pos: { file: 'a/Impl.java', line: 2, col: 5, endLine: 2, endCol: 20 } },
    { kind: 'field', owner: 'a.Impl', name: 'PATH', type: 'String', modifiers: ['static', 'final'], value: { kind: 'string', value: '/x' },
      ann: [], pos: { file: 'a/Impl.java', line: 1, col: 30, endLine: 1, endCol: 60 } },
  ]);
  w('calls.ndjson', [
    { method: 'a.Impl#find(Long)', id: 'a.Impl#find(Long)@2:9', file: 'a/Impl.java', line: 2, col: 9, name: 'find', argc: 1,
      recv: { type: 'a.Port', kind: 'field' }, targets: ['a.Port#find(Long)', 'a.Impl#find(Long)'], origin: 'java',
      args: [{ text: 'PATH', kind: 'constant', value: '/x', valueKind: 'string', type: 'java.lang.String' }] },
    { method: 'a.Impl#find(Long)', id: 'a.Impl#find(Long)@2:25', file: 'a/Impl.java', line: 2, col: 25, name: 'save', argc: 0,
      recv: { type: null, kind: 'implicit' }, targets: [], origin: 'unresolved', reason: 'no-callee',
      args: [{ text: 'x', kind: 'unresolved', type: null, reason: 'no-declaration' }] },
    { method: 'a.Impl#find(Long)', id: 'a.Impl#find(Long)@2:30', file: 'a/Impl.java', line: 2, col: 30, name: 'getPath',
      via: 'methodRef', argc: 0, recv: { type: 'a.Impl', kind: 'instance' }, targets: ['a.Impl#path()'], origin: 'java', args: [] },
  ]);
  w('fields.ndjson', [
    { method: 'a.Impl#find(Long)', field: 'a.Impl#PATH', static: true, op: 'read', file: 'a/Impl.java', line: 2, col: 9,
      value: { text: 'PATH', kind: 'constant', type: 'java.lang.String', value: '/x', valueKind: 'string', field: 'a.Impl#PATH' } },
    { method: 'a.Impl#find(Long)', field: 'a.Impl#name', static: false, op: 'write', file: 'a/Impl.java', line: 2, col: 20,
      value: { text: 'name', kind: 'param', type: 'java.lang.String', index: 0 } },
    { method: 'a.Impl#find(Long)', field: null, static: false, op: 'read', file: 'a/Impl.java', line: 2, col: 31,
      origin: 'unresolved', reason: 'no-declaring-type',
      value: { text: 'mystery.x', kind: 'unresolved', type: null, reason: 'no-declaration' } },
  ]);
  w('files.ndjson', [
    { path: 'a/Impl.java', package: 'a', importsOrigin: 'header', imports: [{ name: 'java.util.List', wildcard: false, static: false }], errors: [] },
    { path: 'a/Unknown.java', package: 'a', importsOrigin: 'unresolved', importsReason: 'header-unreadable', imports: [], errors: [] },
  ]);
  const d = open(dir);
  assert.deepEqual(d.implsOf('a.Port'), ['a.Impl']);
  assert.deepEqual(d.callersOf('a.Impl#find(Long)').map((c) => c.name), ['find']);
  assert.deepEqual(d.atSite('a/Impl.java', 2, 9).map((c) => c.origin), ['java']);
  assert.deepEqual(d.annotation(d.members.get('a.Impl#find(Long)'), 'Transactional'), { value: 'x' });
  assert.equal(d.constant('a.Impl', 'PATH').value, '/x');
  // Contract 2: typed arguments, field reads and writes, returns, method references and imports, each a lookup.
  assert.deepEqual(d.argsOf('a.Impl#find(Long)@2:9').map((a) => a.kind), ['constant']);
  assert.deepEqual(d.argsOf('a.Impl#find(Long)@2:25')[0].reason, 'no-declaration', 'an unresolved argument says why');
  assert.deepEqual(d.argsOf('a.Impl#find(Long)@missing'), [], 'an unknown call has no arguments, not a guess');
  assert.deepEqual(d.fieldAccessOf('a.Impl#PATH').map((f) => f.op), ['read']);
  assert.deepEqual(d.fieldAccessOf('a.Impl#name').map((f) => f.method), ['a.Impl#find(Long)']);
  assert.deepEqual(d.writersOf('a.Impl#name').map((f) => f.value.kind), ['param']);
  assert.deepEqual(d.writersOf('a.Impl#PATH'), [], 'a read is not a write');
  assert.equal(d.fieldAccessOf('a.Impl#name')[0].static, false);
  assert.deepEqual(d.returnsOf('a.Impl#find(Long)').map((r) => r.kind), ['return', 'switch']);
  assert.equal(d.returnsOf('a.Impl#find(Long)')[1].arms[0].labels[0], 'NEW');
  assert.equal(d.returnsOf('a.Impl#find(Long)')[1].arms[1].default, true);
  assert.equal(d.returnsOf('a.Impl#find(Long)')[1].arms[1].value.kind, 'unresolved');
  assert.deepEqual(d.returnsOf('a.Port#find(Long)'), [], 'a method with no body returns nothing it wrote');
  assert.deepEqual(d.methodRefsIn('a.Impl#find(Long)').map((c) => c.name), ['getPath']);
  assert.deepEqual(d.callsOf('a.Impl#find(Long)').map((c) => c.name), ['find', 'save'], 'a method reference is not a call');
  assert.deepEqual(d.imports('a/Impl.java').map((i) => i.name), ['java.util.List']);
  assert.equal(d.imports('a/Unknown.java'), null, 'an unreadable header is an unknown, not an empty list');
  assert.equal(d.grep('impl').length, 2);
  assert.equal(d.membersOf('a.Port').length, 1);
  assert.throws(() => {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ contract: 99 }));
    open(dir);
  }, /contract 99/);
}
