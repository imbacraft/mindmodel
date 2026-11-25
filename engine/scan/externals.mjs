import { mapOf } from '../catalogs/catalog.mjs';
import { configKeyFacts } from '../extract/config.mjs';

/** The SDKs the app imports, each with the first six files that import it. The config keys are read elsewhere. */
function externalsOf(java, sources) {
  const importsOf = (relPath) => (sources.get(relPath)?.imports ?? []).map((i) => i.name);
  const externals = {};
  for (const j of java)
    for (const [k, v] of Object.entries(mapOf('sdk-vendors')))
      if (importsOf(j.p).some((name) => name.includes(k))) (externals[v] ??= []).push(j.p);
  return Object.fromEntries(Object.entries(externals).map(([k, v]) => [k, [...new Set(v)].slice(0, 6)]));
}

/** The SDK imports and the config keys (keys only, never values). */
export function externalsFacts(ctx, configFiles) {
  return {
    sdkImports: externalsOf(ctx.java, ctx.sources),
    config: configKeyFacts(configFiles, ctx.R, ctx.read),
  };
}
