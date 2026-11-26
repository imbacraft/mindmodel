import fs from 'node:fs';
import path from 'node:path';
import { scan } from '../scan.mjs';
import { configKeys } from '../extract/config.mjs';
import { annotationOn, hasAnnotation } from '../core/annotations.mjs';
import { flatStrings, typeRow } from './rows.mjs';
import { channelName, jakartaJms, messaging, withoutJndiTwins } from './messaging.mjs';
import { gatewayRoutes, restCalls } from './rest.mjs';

/**
 * One service, from its folder and its module: the single-app scan, the messaging rows, the REST calls, the config keys
 * and what the config leaves unresolved.
 */
export function serviceOf(folder, dir, module, patterns, ix) {
  const facts = scan(dir);
  const res = path.join(dir, 'src/main/resources');
  const cfgFiles = !fs.existsSync(res)
    ? []
    : fs
        .readdirSync(res, { withFileTypes: true })
        .filter((e) => e.isFile() && /^(application|bootstrap)\.(ya?ml|properties)$/.test(e.name))
        .map((e) => path.join(dir, 'src/main/resources', e.name));
  const keys = new Map(),
    ymls = [];
  for (const f of cfgFiles) {
    const t = fs.readFileSync(f, 'utf8');
    ymls.push({ f, t });
    for (const [k, v] of configKeys(t, f.endsWith('.properties')))
      keys.set(k, { ...v, file: path.relative(folder, f) });
  }
  const name = keys.get('spring.application.name')?.value ?? path.basename(dir);
  const port = /^\d+$/.test(keys.get('server.port')?.value ?? '') ? keys.get('server.port').value : null;
  const cite = (file, line) => `${file}:${line}`;
  const msgs = [];
  const jndi = jakartaJms(module);
  for (const x of withoutJndiTwins(messaging(module, patterns), jndi)) {
    const r = channelName(x, module, keys, ix);
    msgs.push({ kind: x.kind, dir: x.dir, line: x.line, ...r, raw: x.raw, cite: cite(x.file, x.line) });
  }
  for (const x of jndi) msgs.push({ ...x, via: 'JNDI name', raw: x.name, cite: cite(x.file, x.line) });
  const calls = restCalls(module).map(({ file, ...c }) => ({ ...c, cite: cite(file, c.line) }));
  for (const [k, v] of keys) {
    const u = /^(?:https?|lb):\/\/([a-z][a-z0-9-]*)(?::(\d+))?(?=[:/]|$)/.exec(v.value);
    if (u && u[1] !== 'www' && k !== 'server.port')
      calls.push({
        host: u[1] === 'localhost' ? `localhost:${u[2]}` : u[1],
        path: '',
        via: 'config',
        cite: `${v.file}:${v.line}`,
      });
  }
  // Destinations bound from config that is not in the repo (env vars, deployment): named, marked unresolved.
  const unresolvedDest = [];
  for (const t of module.types) {
    const pre = flatStrings(annotationOn(typeRow(module, t), 'ConfigurationProperties')?.args?.prefix)[0];
    if (!pre) continue;
    for (const f of t.fields ?? []) {
      if (!/(Url|Uri|Host)$/.test(f.name)) continue;
      const key = `${pre}.${f.name}`;
      const known = [...keys.keys()].some((k) => k.toLowerCase().replace(/-/g, '') === key.toLowerCase());
      if (!known) unresolvedDest.push(key);
    }
  }
  for (const { f, t } of ymls)
    for (const g of gatewayRoutes(t))
      calls.push({
        host: g.host,
        path: g.paths.join(','),
        via: 'gateway',
        cite: `${path.relative(folder, f)}:${g.line}`,
      });
  // Plumbing the system relies on to run (config, discovery, admin): named, not a business service.
  const moduleCarriesAnn = (name) => module.types.some((t) => hasAnnotation(typeRow(module, t), name));
  const role = moduleCarriesAnn('EnableConfigServer')
    ? 'config server'
    : moduleCarriesAnn('EnableEurekaServer')
      ? 'discovery server'
      : moduleCarriesAnn('EnableAdminServer')
        ? 'admin server'
        : null;
  return {
    name,
    dir: path.relative(folder, dir) || '.',
    role,
    facts,
    msgs,
    calls,
    unresolvedDest,
    port,
    // The module's size, from the dump: the last line each of its types ends on.
    lines: module.lines,
  };
}
