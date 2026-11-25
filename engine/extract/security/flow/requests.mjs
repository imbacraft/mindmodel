import { targetIds } from '../../../model/targets.mjs';
import {
  argValues,
  callById,
  constantArg,
  constantNameAt,
  annotationName,
  memberAt,
  siteOf,
  simpleType,
  baseType,
} from './dump.mjs';

/**
 * A request read: a call to a library method of `HttpServletRequest`/`Cookie` (or `@CookieValue`/`@RequestHeader`,
 * whose name sits on the parameter) whose name argument the dump resolved. A helper that compares its own parameter
 * to a constant is followed with `comparedTo`: the name is the constant the caller passes.
 */
export function requestReads(entryId, q, db, model, depth = 2, methods = null) {
  const reads = [];
  const unresolved = [];
  const reach = methods ?? q.reach(entryId, depth).methods;
  const libraryCall = (c) => c.recv?.type && !db.types.has(c.recv.type);
  const requestRecv = (c) =>
    libraryCall(c) && ['HttpServletRequest', 'ServletRequest'].includes(simpleType(c.recv.type));
  const cookieRecv = (c) => libraryCall(c) && simpleType(c.recv.type) === 'Cookie';
  // A cookie is only read where one is in reach: `getName()` names it, `getValue()` reads it. Without that, a helper
  // comparing its parameter to a constant is a host check, not a cookie name.
  // A cookie is only read where one is in reach: `getName()`/`getValue()` on a `Cookie`, or the request's cookie stream
  // (`getCookies()`, which a helper then filters). Without that, a helper comparing its parameter to a constant is a
  // host check, not a cookie name.
  const cookieInReach = reach.some(({ id }) =>
    db.callsOf(id).some(
      (c) => (['getName', 'getValue'].includes(c.name) && cookieRecv(c)) || (c.name === 'getCookies' && requestRecv(c)),
    ),
  );
  /**
   * The parameter that carries cookie names in a helper: the `String[]` (or `String...`) parameter of a method that
   * reads the request's cookie stream (`getCookies()`) and turns it into values (`Cookie::getValue`). Both structural
   * facts are call rows; the type is the declaration's own. No text is read, and a helper without such a parameter
   * names nothing, so a method that merely calls `getCookies()` grants no cookie.
   */
  const cookieNamesParam = (methodId) => {
    const member = memberAt(db, methodId);
    // The dump writes the type as the declaration does (`String[]`, qualified only when the source writes it so), and a
    // varargs parameter says so on its own flag: `baseType` strips the brackets, so the flag tells them apart.
    const isStringArray = (p) => {
      const written = String(p.type ?? '').trim();
      const bare = /^(?:java\.lang\.)?String$/.test(baseType(written));
      return bare && (p.varargs === true || /\[\]$/.test(written) || /\.\.\.$/.test(written));
    };
    const index = (member?.params ?? []).findIndex(isStringArray);
    if (index < 0) return -1;
    const calls = db.callsOf(methodId);
    const readsCookies = calls.some((c) => c.name === 'getCookies' && requestRecv(c));
    const mapsValue = calls.some((c) =>
      (c.args ?? []).some((a) => a.kind === 'methodRef' && String(a.text ?? '').includes('::getValue')),
    );
    return readsCookies && mapsValue ? index : -1;
  };
  for (const { id } of reach) {
    const member = memberAt(db, id);
    const file = member?.pos?.file ?? member?.file ?? null;
    if (!member) continue;
    const calls = db.callsOf(id);
    const cite = (c) => `${c.file}:${c.line}`;
    // The cookie value read in this method, if any: the comparison names the cookie, `getValue()` reads it.
    const valueRead = calls.find((c) => c.name === 'getValue' && cookieRecv(c)) ?? null;
    for (const c of calls) {
      // A header: `request.getHeader(NAME)`, the name a constant or a literal the dump folded.
      if (c.name === 'getHeader' && requestRecv(c)) {
        const name = constantArg(q, c, 0);
        if (name) reads.push({ kind: 'header', name, value: c.id, cite: cite(c), call: c.id, method: id });
        else {
          const why = argValues(q, c, 0).unresolved[0]?.reason ?? 'no-constant';
          unresolved.push({ ...siteOf(c), what: 'header', reason: why });
        }
      }
      // `WebUtils.getCookie(request, NAME)`: a library call whose last argument is the cookie's name.
      if (c.name === 'getCookie' && libraryCall(c) && (c.args ?? []).length) {
        const name = constantArg(q, c, (c.args ?? []).length - 1);
        if (name)
          reads.push({ kind: 'cookie', name, value: valueRead?.id ?? c.id, cite: cite(c), call: c.id, method: id });
        else unresolved.push({ ...siteOf(c), what: 'cookie', reason: 'no-constant' });
      }
      // A cookie named at a comparison: `"actAs".equals(c.getName())` or `c.getName().equals("actAs")`.
      if (['equals', 'equalsIgnoreCase', 'contentEquals'].includes(c.name)) {
        const named = (c.args ?? []).some((a, i) => {
          const inner = a?.kind === 'call' ? callById(db, a.call) : null;
          return Boolean(inner && inner.name === 'getName' && cookieRecv(inner));
        });
        const chained = c.recv?.how === 'chain' && /getName\s*\(\s*\)/.test(String(c.recv.text ?? ''));
        if (!named && !chained) continue;
        // The name is the other side of the comparison: an argument that resolves, or a constant receiver.
        const other = (c.args ?? []).map((_, i) => constantArg(q, c, i)).find(Boolean);
        const name = other ?? (chained ? null : constantNameAt(db, id, c));
        if (name)
          reads.push({ kind: 'cookie', name, value: valueRead?.id ?? null, cite: cite(c), call: c.id, method: id });
        else
          // `"actAs".equals(c.getName())`: the name is the receiver, and the dump records a receiver's written text,
          // not its value. Unresolved with that reason, never parsed out of the text.
          unresolved.push({ ...siteOf(c), what: 'cookie-name', reason: 'receiver-is-not-a-value' });
      }
    }
    // A helper that filters the cookie stream by its own parameter (`Arrays.asList(names).contains(cookie.getName())`)
    // names each cookie at its call site: the constant the caller passes is the name, and one call site is one read.
    // Without the classpath the helper's `Cookie` is untyped, so this never fires on a guess.
    if (cookieInReach) {
      const namesIndex = cookieNamesParam(id);
      for (const [index, param] of (member.params ?? []).entries()) {
        if (!param.name || index !== namesIndex) continue;
        for (const caller of reach) {
          if (caller.id === id) continue;
          for (const c of db.callsOf(caller.id)) {
            if (!targetIds(c).includes(id)) continue;
            const name = constantArg(q, c, index);
            if (!name) {
              unresolved.push({ ...siteOf(c), what: 'cookie-name', reason: 'helper-callsite-not-constant' });
              continue;
            }
            if (reads.some((r) => r.cite === cite(c) && r.name === name)) continue;
            reads.push({
              kind: 'cookie',
              name,
              value: null,
              cite: cite(c),
              call: c.id,
              method: caller.id,
              via: 'helper',
            });
          }
        }
      }
    }
    // A helper that compares its own parameter to a constant: the cookie name is what the caller passes.
    for (const [index, param] of (cookieInReach ? member.params ?? [] : []).entries()) {
      if (!param.name) continue;
      const found = q.comparedTo({ method: id, index }).comparisons;
      for (const cmp of found) {
        const row = callById(db, cmp.call);
        if (!row) continue;
        const name =
          (row.args ?? []).map((_, i) => constantArg(q, row, i)).find(Boolean) ??
          constantNameAt(db, member.owner, row);
        if (name)
          reads.push({
            kind: 'cookie',
            name,
            value: valueRead?.id ?? null,
            cite: `${row.file}:${row.line}`,
            call: row.id,
            method: id,
            via: 'helper',
          });
      }
      if (found.length && !reads.some((r) => r.method === id && r.kind === 'cookie'))
        unresolved.push({ method: id, what: 'cookie-name', reason: 'helper-name-not-resolved' });
    }
    // `@CookieValue("x")` / `@RequestHeader("X")`: the annotation names the value the parameter carries.
    for (const param of member.params ?? [])
      for (const a of param.ann ?? []) {
        const cookie = /(?:^|\.)CookieValue$/.test(a.name ?? '');
        const kind = cookie ? 'cookie' : /(?:^|\.)RequestHeader$/.test(a.name ?? '') ? 'header' : null;
        if (!kind) continue;
        const name = annotationName(a);
        if (name)
          reads.push({
            kind,
            name,
            value: param.name ?? null,
            cite: `${file}:${a.line ?? member.pos?.line}`,
            method: id,
          });
        else unresolved.push({ method: id, what: kind, reason: 'annotation-value-not-in-dump' });
      }
  }
  return { reads, unresolved };
}
