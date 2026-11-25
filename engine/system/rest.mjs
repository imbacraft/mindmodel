import { annotationOn } from '../core/annotations.mjs';
import { dumpArgs, flatStrings, stringArg, typeRow } from './rows.mjs';

// REST calls to other services: Feign clients, discovery lookups, and URLs (or `lb://` routes) whose host the dump
// folded. A URL built in a local variable is not a value the dump has: those calls stay out, never a guess.
const URL_HOST = /^(?:https?|lb):\/\/([a-z][a-z0-9-]*)(?::(\d+))?(\/[^?#]*)?$/;
export function restCalls(module) {
  const { db, types } = module ?? {};
  const out = [];
  if (!db) return out;
  for (const t of types ?? []) {
    const feign = annotationOn(typeRow(module, t), 'FeignClient');
    if (feign) {
      const host = flatStrings(feign.args?.name)[0] ?? flatStrings(feign.args?.value)[0];
      if (host) out.push({ host, path: '', line: feign.line ?? t.start, via: 'feign', file: module.prefix + t.file });
    }
    for (const m of t.methods ?? []) {
      for (const c of m.calls ?? []) {
        const rows = dumpArgs(db, c);
        if (/^(getInstances|choose|getInstance)$/.test(c.name)) {
          const d = stringArg(rows[0]);
          if (d && /^[a-z][a-z0-9-]*$/.test(d))
            out.push({ host: d, path: '', line: c.line, via: 'discovery', file: module.prefix + t.file });
        }
        // A URL the dump folded, wherever it is passed: a client's `uri(...)`, a route, a webhook.
        for (const a of rows) {
          const value = stringArg(a);
          const u = value == null ? null : URL_HOST.exec(value);
          if (!u || /^(localhost|www)$/.test(u[1])) continue;
          out.push({
            host: u[1],
            path: (u[3] ?? '').split('?')[0],
            line: c.line,
            via: 'url',
            file: module.prefix + t.file,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.via.localeCompare(b.via));
}

// Gateway routes in YAML: "uri: lb://vets-service" followed by "- Path=/api/vet/**".
export function gatewayRoutes(yml) {
  const out = [];
  let cur = null;
  yml.split('\n').forEach((l, i) => {
    const u = /uri:\s*(?:lb|https?):\/\/([a-z][a-z0-9-]*)(?=[:/\s"']|$)/.exec(l);
    if (u) {
      cur = { host: u[1], line: i + 1, paths: [] };
      out.push(cur);
    }
    const p = /-\s*Path=([^\s#]+)/.exec(l);
    if (p && cur) cur.paths.push(...p[1].split(','));
  });
  return out;
}
