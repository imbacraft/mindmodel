import path from 'node:path';
import { isE2e, normalizePath } from '../core/paths.mjs';

// --- frontend routes ----------------------------------------------------------
// Angular route arrays use paths without a leading slash, so they're only trusted in files that declare routes.
const isAngularRoutes = (text) =>
  /\bRoutes\b|RouterModule\.for(Root|Child)|provideRouter\(/.test(text) && /@angular\/router/.test(text);
export function routePath(line, angular = false) {
  const m = /<Route[^>]*\bpath=["'{`]+([^"'}`]+)/.exec(line) ?? /\bpath:\s*["'](\/[^"']*)["']/.exec(line);
  if (m) return m[1];
  const a = angular && /\bpath:\s*["']([^"'/][^"']*|)["']/.exec(line);
  return a ? '/' + a[1] : null;
}

// --- frontend: sources, API calls and routes ------------------------------------------

/** The frontend's source files with their text, and the server-rendered view files. */
function frontendFiles({ files, R, read }) {
  // A bundle, a minified file or a one-line source is built output, not what the team wrote.
  const built = (f) =>
    /\/static\/assets\/|-[\w]{8,}\.(js|css)$|\.min\.js$/.test(f) || read(f).split('\n').some((l) => l.length > 3000);
  const fe = files
    .filter(
      (f) =>
        /\.(tsx?|jsx?|vue|svelte)$/.test(f) &&
        !/\.(test|spec|d)\.[tj]sx?$/.test(f) &&
        !/vendor|slick|jquery|bootstrap/i.test(f) &&
        !built(f) &&
        // End-to-end test code: Cypress/Playwright helpers call *another* application's API, so a spec is not this
        // app's frontend — the same rule that keeps `src/test/` out of the Java model.
        !isE2e(R(f)),
    )
    .map((p) => ({ p: R(p), source: read(p) }));
  const views = files
    .filter(
      (f) =>
        ((/\.(jsp|jspf|html|ftl|mustache)$/.test(f) && /(WEB-INF|templates|views)\//.test(f)) ||
          (/\.xhtml$/.test(f) && /src\/main\/webapp\//.test(f))) &&
        !/templates\/(emails?|library)\//.test(f),
    )
    .map((p) => ({ p: R(p), text: read(p) }));
  return { fe, views };
}

/** The `/api` calls the frontend makes, each with the verb of the request options written next to it, if any. */
function frontendApiCalls(fe) {
  return fe.flatMap((f) =>
    f.source.split('\n').flatMap((l, i) => {
      const m = /["'`](\/api\/[^"'`\s]*)["'`]/.exec(l);
      if (!m) return [];
      const around = f.source
        .split('\n')
        .slice(Math.max(0, i - 3), i + 4)
        .join(' ');
      const vm = /method:\s*["'](GET|POST|PUT|DELETE|PATCH)["']/i.exec(around);
      return [{ path: normalizePath(m[1]), verb: vm?.[1]?.toUpperCase(), file: f.p, line: i + 1 }];
    }),
  );
}

/**
 * Each frontend call joined to the endpoint it reaches: the same path (placeholders match any segment), then the verb.
 */
function joinApiCalls(calls, endpoints) {
  const epByPath = new Map();
  for (const e of endpoints) {
    if (!epByPath.has(e.path)) epByPath.set(e.path, []);
    epByPath.get(e.path).push(e);
  }
  const segMatch = (ep, call) => {
    const a = ep.split('/'),
      b = call.split('/');
    return a.length === b.length && a.every((s, i) => s === '{}' || b[i] === '{}' || s === b[i]);
  };
  return calls.map((c) => {
    const cands = epByPath.get(c.path) ?? endpoints.filter((e) => segMatch(e.path, c.path));
    const hit = cands.find((e) => !c.verb || e.verb === c.verb || e.verb === 'ANY') ?? cands[0];
    return { ...c, handler: hit ? `${hit.file}:${hit.line}` : null };
  });
}

/**
 * Frontend routes: each `<Route path>` line, or each Angular route-array `path:` line, in the files that declare them.
 */
function frontendRoutes(fe) {
  return fe.flatMap((f) => {
    const ng = isAngularRoutes(f.source);
    return f.source.split('\n').flatMap((l, i) => {
      const p = routePath(l, ng);
      return p == null ? [] : [{ path: p, file: f.p, line: i + 1 }];
    });
  });
}

/** Which views the controllers return, and which view files nothing returns or includes. */
function viewFacts(controllers, views) {
  const viewUse = {};
  for (const c of controllers)
    for (const v of c.views)
      if (!/^(redirect|forward):/.test(v.view)) (viewUse[v.view] ??= []).push(`${c.p}:${v.line}`);
  const viewNames = views.map((v) => ({ file: v.p, name: path.basename(v.p).replace(/\.\w+$/, '') }));
  const included = new Set(
    views.flatMap((v) =>
      [...v.text.matchAll(/(?:include\s+file|page)\s*=\s*"([^"]+)"/g)].map((m) =>
        path.basename(m[1]).replace(/\.\w+$/, ''),
      ),
    ),
  );
  const deadViews = viewNames
    .filter(
      (v) =>
        !Object.keys(viewUse).some((k) => k === v.name || k.endsWith('/' + v.name)) && !included.has(v.name),
    )
    .map((v) => v.file);
  return { viewUse, deadViews };
}

/** The frontend: sources, the API calls joined to the endpoints they reach, routes, and the view facts. */
export function webFacts(ctx, types, endpoints) {
  const { fe, views } = frontendFiles(ctx);
  const joined = joinApiCalls(frontendApiCalls(fe), endpoints);
  const viewOut = viewFacts(types.controllers, views);
  return { fe, views, joined, viewOut, routes: frontendRoutes(fe) };
}
