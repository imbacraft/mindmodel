import assert from 'node:assert/strict';
import { queries } from '../../model/query.mjs';
import { simple } from '../../core/names.mjs';
import { IDENTITY_ENTRY } from './identity/types.mjs';
import { memberFile, memberLine, simpleType } from './flow/dump.mjs';
import { requestReads } from './flow/requests.mjs';

// preHandle), so a `doFilterInternal` filter stays a user source without becoming a tenant source, as before.
const TENANT_ENTRY = /^(doFilter|preHandle)$/;

// Where the tenant comes from: a store an entry performs — `stores()`, one definition shared with security — and
// the request value that feeds it. A claim read outranks a header read: a filter that reads a header *and* a claim
// stores what the claim said, and the header is only checked against it. Then the path. Nothing is read from text.
export function tenantSources(model, isTest = () => false, db = null) {
  const d = db ?? model?.dump ?? null;
  const q = queries(d);
  const facts = [];
  for (const t of model.types?.values() ?? []) {
    if (isTest(t.file)) continue;
    for (const m of t.methods ?? []) {
      // The cheap test first: only a request entry can hold a tenant, and a `doFilterInternal` one is read only when
      // the request-scoped shape proves it stores something — so no method's reach is walked for nothing.
      const entry = TENANT_ENTRY.test(m.name ?? '');
      if (!entry && !IDENTITY_ENTRY.test(m.name ?? '')) continue;
      const id = m.id ?? `${t.fqn}#${m.name}`;
      const { methods } = q.reach(id, 2);
      // The tenant is *stored*: a holder write, a request attribute, the security context. A clear is not a store.
      // A tenant is kept in a holder or a request attribute. The security context is the *caller*, not the tenant:
      // `stores()` knows that store too, and counting it here would make every authenticated request a tenant source.
      const scoped = q.scopedStores ? methods.flatMap(({ id: mid }) => q.scopedStores(mid).stores) : [];
      if (!entry && !scoped.length) continue;
      const stores = [
        ...methods.flatMap(({ id: mid }) =>
          q.stores(mid, 0).stores.filter((s) => s.op !== 'clear' && s.kind !== 'security-context'),
        ),
        ...scoped,
      ];
      if (!stores.length) continue;
      const writer = stores[0];
      const storedBy =
        writer.kind === 'request-attribute'
          ? 'request-attribute'
          : writer.kind === 'holder'
            ? 'thread-local'
            : 'security-context';
      const fieldName = writer.field
        ? String(writer.field).split('#').pop()
        : writer.holder
          ? simpleType(writer.holder)
          : null;
      const valueName = fieldName ? camelName(fieldName) : null;
      const writerCite =
        writer.via === 'try-finally-pattern' && writer.file
          ? `${writer.file}:${writer.line}`
          : `${memberFile(d, writer.method) ?? t.file}:${memberLine(d, writer.method) ?? m.start}`;
      const reads = requestReads(id, q, d, model, 2, methods).reads;
      const headers = reads.filter((r) => r.kind === 'header');
      const cookies = reads.filter((r) => r.kind === 'cookie');
      const claim = claimReadIn(methods, d);
      const path = pathReadIn(methods, d);
      // A cookie is an origin for the stores the run had to work for: the request-scoped shape and a holder the
      // classpath named. Both are stores of a request value the dump may not type; a header is the
      // better-known spelling of the same thing and still outranks it.
      const inferredStore = writer.via === 'try-finally-pattern' || writer.via === 'classpath';
      // A token origin is the claim's name when the read carries one, else the store's own name; and it cites the read,
      // never the store — the store line is already the first evidence, and citing it twice says one thing twice.
      const origin = claim
        ? {
            kind: 'token',
            name: literalName(claim) ?? valueName ?? 'token claim',
            cite: claim.file ? `${claim.file}:${claim.line}` : writerCite,
          }
        : headers.length
          ? headers[0]
          : inferredStore && cookies.length
            ? cookies[0]
            : path
              ? { kind: 'path', name: 'request path', cite: `${path.file}:${path.line}` }
              : null;
      if (!origin) continue;
      const all = origin.kind === 'header' ? headers : origin.kind === 'cookie' ? cookies : [origin];
      for (const o of all)
        facts.push({
          id: `tenant-source:${o.kind}:${o.name}@${m.name}`,
          family: 'tenant-source',
          // A store found by shape is inferred, whatever the origin: the holder's own type is a library type the dump
          // could not read, and the try/finally is the evidence.
          confidence:
            writer.via === 'try-finally-pattern' || o.kind === 'token' || o.kind === 'path' ? 'inferred' : 'resolved',
          ...(writer.via ? { via: writer.via } : {}),
          kind: o.kind,
          name: o.name,
          method: `${t.name}#${m.name}`,
          storedBy,
          evidence: [`${writerCite}#${String(writer.method).split('#').pop()}`, o.cite],
          why: [
            `${simple(String(writer.method).split('#')[0])}#${String(writer.method).split('#').pop()} ` +
              `stores the tenant into a ${storedBy}`,
            writer.via === 'try-finally-pattern'
              ? `${simpleType(writer.holder)} is called in a try block and cleared in its finally: one request, ` +
                'one store (inferred from the shape)'
              : `the value read here comes from ${o.kind} ${o.name} (${o.cite})`,
            writer.via === 'try-finally-pattern'
              ? `the value read here comes from ${o.kind} ${o.name} (${o.cite})`
              : null,
          ].filter(Boolean),
        });
    }
  }
  const seen = new Set();
  return facts.filter((f) => !seen.has(`${f.kind}:${f.name}`) && seen.add(`${f.kind}:${f.name}`));
}

// `AUTHENTICATED_WORKSPACE_ID` -> `authenticatedWorkspaceId`: the field a value is stored in, named the way the code
// names the value. A name the dump wrote, never a word list.
const camelName = (field) =>
  String(field)
    .toLowerCase()
    .replace(/_id$|_/g, (x) => (x === '_id' ? 'Id' : ' '))
    .replace(/ (.)/g, (_, c) => c.toUpperCase());

/**
 * The call that reads a claim value, if the reach has one. A read that carries the claim's own name in a literal
 * (`getClaim("iss")`) is the strongest evidence and wins; otherwise the first match in source order stands, and its
 * name is whatever the store is called.
 */
const claimReadIn = (methods, db) => {
  const hits = [];
  const claimName = /claim/i;
  const tokenRead = /^(get|resolve|read|load|parse).*(Subject|Token)/i;
  for (const { id } of methods)
    for (const c of db.callsOf(id))
      if (claimName.test(c.name ?? '') || tokenRead.test(c.name ?? '')) hits.push(c);
  return hits.find((c) => literalName(c)) ?? hits[0] ?? null;
};

/** The first string literal among a call's arguments: the claim or parameter name the code actually asks for. */
export const literalName = (c) =>
  (c.args ?? []).map((a) => (a?.kind === 'literal' && a.value?.kind === 'string' ? a.value.value : null)).find(Boolean) ?? null;
const pathReadIn = (methods, db) => {
  for (const { id } of methods)
    for (const c of db.callsOf(id)) if (['getRequestURI', 'getServletPath', 'getPathInfo'].includes(c.name)) return c;
  return null;
};

{
  // A claim's name is the literal the read asks for, never a variable or a type: `getClaim("iss")` names `iss`.
  assert.equal(literalName({ args: [{ kind: 'literal', value: { kind: 'string', value: 'iss' } }] }), 'iss');
  assert.equal(
    literalName({ args: [{ kind: 'local', text: 'claimName' }, { kind: 'literal', value: { kind: 'number', value: '1' } }] }),
    null,
    'a variable is not a claim name, and neither is a number',
  );
  assert.equal(literalName({}), null, 'a call with no arguments names nothing');
}
