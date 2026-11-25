import fs from 'node:fs';
import path from 'node:path';
import { tildify } from '../io/classpath.mjs';

// --- facts assembly ----------------------------------------------------------------------

/** The one line the CLI prints after a scan: what was found, and where the time went. */
export function summaryLine(f, out) {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const since = f.git?.window?.since ?? 'none';
  const gitText = f.git ? `${f.git.head}${f.git.dirty ? '+dirty' : ''} window=${since}` : 'none';
  const timings = Object.entries(f.timings)
    .map(([k, v]) => `${k} ${seconds(v)}`)
    .join(' ');
  const listeners = f.background.scheduledAsyncListeners.length;
  return (
    `wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB): ${f.entities.count} entities, ` +
    `${f.endpoints.length} endpoints, ${f.frontend.apiCalls} frontend API calls ` +
    `(${f.frontend.unmatchedApiCalls.length} unmatched), ${f.views.count} views, ` +
    `${listeners} scheduled/async/listeners, ${f.schedules.length} scheduled job(s), ` +
    `${f.securityRules.length} security rule(s), ${f.securityWarnings.length} security warning(s), ` +
    `${f.docs.length} docs, git ${gitText} · ${timings}`
  );
}

/**
 * The facts document. Its sections keep their order: the digest and the writer read the file by these names. `F` holds
 * the family results scan() built; `ctx` holds the inventory and the model.
 */
export function assembleFacts(ctx, started, F) {
  const { root, R, files, byExt, java, buildFiles, classpath, dump, dumpRun, callStats, dumpMs, classpathMs } = ctx;
  const { types, persist, sec, ten, entFacts, web, boot, deep, runtime, background, externals } = F;
  const { joined, fe, views, viewOut, routes } = web;
  return {
    version: 2,
    root,
    scannedAt: new Date().toISOString().slice(0, 10),
    // Where the run went (B.7): millisecond stages, so a slow scan says which stage to look at. `digest` is filled by
    // the CLI, which is the only caller that renders it.
    timings: { dump: dumpMs, classpath: classpathMs, extract: Date.now() - started - dumpMs - classpathMs },
    inventory: { byExt, topDirs: [...new Set(files.map((f) => R(f).split('/').slice(0, 2).join('/')))].slice(0, 60) },
    build: buildFiles,
    // What the run could read of the project's dependencies, and what it could not: the digest says it in one line.
    classpath: {
      mode: classpath.mode,
      jars: classpath.jars.length,
      generatedSources: classpath.generatedSources.length,
      failedModules: classpath.failedModules.map((f) => ({ module: f.module, reason: tildify(f.reason) })),
      // `tool` and `reason` are omitted rather than null: the schema has no null-able fields.
      ...(classpath.tool ? { tool: classpath.tool } : {}),
      ms: classpath.ms,
      ...(classpath.reason ? { reason: tildify(classpath.reason) } : {}),
    },
    git: F.gitInfo,
    docs: F.docs,
    packages: Object.entries(
      java.reduce((a, j) => {
        const d = path.dirname(j.p);
        a[d] = (a[d] ?? 0) + 1;
        return a;
      }, {}),
    )
      .map(([dir, n]) => ({ dir, javaFiles: n }))
      .sort((a, b) => a.dir.localeCompare(b.dir)),
    entities: {
      count: entFacts.entities.length,
      enums: types.enums,
      repositories: types.repos.map((r) => ({ file: r.p, extends: r.extends })),
      model: entFacts.entities.map((e) => ({
        name: e.name,
        file: e.file,
        line: e.line,
        table: e.table,
        relations: e.relations,
        keys: e.keyFields.slice(0, 12),
        unique: e.uniqueFields,
        // Own fields only, for the invariant that a field's line sits inside its type (inherited lines live elsewhere).
        ownKeys: e.fields.filter((f) => f.owner === e.name && !f.relation).map((f) => `${f.name}:${f.type}:${f.line}`),
        ownRelations: e.fields
          .filter((f) => f.owner === e.name && f.relation)
          .map((f) => `${f.relation.kind} ${f.relation.target?.split('.').pop() ?? f.type} ${f.name}:${f.line}`),
      })),
    },
    tenancy: {
      key: ten.tenancy.key,
      confidence: ten.tenancy.confidence,
      counts: ten.tenancy.counts,
      candidates: ten.tenancy.candidates.slice(0, 6),
      coverage: ten.tenancy.coverage,
      unscoped: ten.tenancy.unscoped,
      unscopedWrites: ten.tenancy.unscopedWrites,
      globalLookups: ten.tenancy.globalLookups,
      crossTenant: ten.tenancy.crossTenant,
      unscopedByRepo: ten.tenancy.unscopedByRepo,
      bridged: ten.tenancy.bridged,
      bases: ten.tenancy.bases,
      thresholds: ten.tenancyThresholds,
      sources: ten.tenancy.sources,
    },
    noRequestPaths: ten.withoutRequest,
    endpoints: F.endpoints,
    coverage: F.cov,
    frontend: {
      files: fe.length,
      routes,
      apiCalls: joined.length,
      unmatchedApiCalls: joined.filter((j) => !j.handler).map((j) => `${j.verb ?? ''} ${j.path} ${j.file}:${j.line}`),
      apiJoin: joined
        .filter((j) => j.handler)
        .map((j) => `${j.verb ?? ''} ${j.path} ${j.file}:${j.line} -> ${j.handler}`),
    },
    views: { count: views.length, returnedBy: viewOut.viewUse, deadViews: viewOut.deadViews },
    runtime: {
      // Whether Spoon answered this run, and how much of it: a scan without a dump is a scan without types.
      engine: dump
        ? {
            spoon: true,
            answered: callStats.answered,
            targets: callStats.targets,
            droppedTargets: callStats.droppedTargets,
            unanswered: callStats.unanswered,
            droppedSamples: callStats.droppedSamples?.slice(0, 8),
            // What the engine could not answer and why; dotted keys only, the rest of counts are sizes.
            failures: Object.fromEntries(Object.entries(dump.meta?.counts ?? {}).filter(([k]) => k.includes('.'))),
            dump: dumpRun.dir,
          }
        : { spoon: false, reason: dumpRun.reason },
      ...runtime,
      // What this scan gave up on, and why (core/degrade.mjs): the digest and validate print it.
      degraded: F.degraded,
    },
    methodSecurity: sec.methodSec.facts,
    securityModel: F.securityModelFact,
    channels: F.channels,
    background,
    state: { modifying: F.modifying },
    boot: {
      computed: boot.computed,
      mains: boot.mains,
      switches: boot.switches,
      profiles: boot.profiles,
      frontend: boot.frontend,
      compose: boot.compose,
      scripts: boot.scripts,
    },
    transactions: persist.transactions,
    transactionCounts: persist.transactionCounts,
    outsideCalls: persist.outsideCalls,
    stateWrites: persist.stateWrites,
    stateCaches: persist.stateFacts.filter((f) => f.family === 'state-cache'),
    lifecycle: deep.lifecycle,
    schedules: deep.schedules,
    recurring: F.recurring,
    securityRules: sec.securityRules,
    securityWarnings: sec.securityWarnings,
    tenantSources: F.tenantFacts,
    ...(F.tenantFacts.length
      ? {}
      : {
          tenantSourcesNote:
            'no tenant source found within depth 2 ' +
            '(no ThreadLocal/request-attribute store reached from doFilter/preHandle)',
        }),
    flows: F.flows,
    externals,
  };
}
