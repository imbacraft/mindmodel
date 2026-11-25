#!/usr/bin/env node
// Collects the mechanical facts so the writer reads code only to judge, not to search.
// Usage: node scan.mjs <projectRoot> [outFile]   (default out: <root>/mindmodel/.work/facts.json)
// Never copies config values (only keys) so secrets cannot leak into facts or the map.
import fs from 'node:fs';
import path from 'node:path';
import { retuneHeap } from './io/heap.mjs';
import { isTestCode } from './core/paths.mjs';
import { extractEndpoints } from './extract/endpoints.mjs';
import { flowEntries } from './extract/flows.mjs';
import { channelFacts } from './extract/channels.mjs';
import { extractSchedules } from './extract/schedules.mjs';
import { channelConfigOf, configFilesOf } from './extract/config.mjs';
import { tenantSources } from './extract/security/index.mjs';
import { coverage } from './checks/coverage.mjs';
import { summarize } from './digest/facts-md.mjs';
import { loadModel } from './scan/model.mjs';
import { ensureWork, inventory, retirePreviousMap, docsOf } from './scan/inventory.mjs';
import { typeFacts, entityFactsOf } from './scan/types.mjs';
import { webFacts } from './scan/web.mjs';
import { persistenceFacts } from './scan/persistence.mjs';
import { securityOf } from './scan/security.mjs';
import { tenancyAndSecurity } from './scan/tenancy.mjs';
import { runtimeAndBackground } from './scan/runtime.mjs';
import { externalsFacts } from './scan/externals.mjs';
import { javaFactsOf } from './scan/java.mjs';
import { bootOf } from './scan/boot.mjs';
import { gitInfoOf, activityCounts } from './scan/git.mjs';
import { flowsOf } from './scan/flows.mjs';
import { assembleFacts, summaryLine } from './scan/assemble.mjs';

// Scans one app root and returns its facts; the CLI below writes them. Skills call this file, so the CLI stays here.
export function scan(root, { withModel = false, extraConstants = new Map() } = {}) {
  const started = Date.now();
  const inv = inventory(root);
  const ctx = { ...inv, ...loadModel(inv) };
  const { model, selected, app, files, R, read } = ctx;
  const types = typeFacts(ctx);
  const endpoints = extractEndpoints(model, selected, { include: (p) => !app.isExcluded(p) });
  const web = webFacts(ctx, types, endpoints);
  const persist = persistenceFacts(ctx);
  const recurring = extractSchedules(model, selected);
  const configFiles = configFilesOf(files, root);
  const sec = securityOf(ctx, endpoints);
  const tenantFacts = tenantSources(model, isTestCode);
  // Flow entries serve tenancy (worker callers) and the flows: computed once, before the wildcard-annotation pass.
  const flowEntryList = flowEntries(model, endpoints, selected);
  const entFacts = entityFactsOf(ctx);
  const { ten, securityModelFact } = tenancyAndSecurity(model, selected, {
    endpoints,
    sec,
    flowEntryList,
    tenantFacts,
    entFacts,
  });
  const { runtime, background } = runtimeAndBackground(ctx, types, endpoints, web.views);
  const externals = externalsFacts(ctx, configFiles);
  const { deep, modifying } = javaFactsOf(ctx, types, entFacts, endpoints);
  const boot = bootOf(ctx, types, configFiles);
  const gitInfo = gitInfoOf(root);
  const activityOf = activityCounts(root, gitInfo, flowEntryList);
  const flows = flowsOf(ctx, { flowEntryList, persist, deep, entFacts, activityOf, sec, joined: web.joined });
  const channels = channelFacts(model, { config: channelConfigOf(files, read), extraConstants });
  const cov = coverage(model, endpoints, selected, { build: ctx.buildFiles, rels: files.map(R) });
  const facts = assembleFacts(ctx, started, {
    types,
    endpoints,
    persist,
    recurring,
    sec,
    web,
    ten,
    securityModelFact,
    runtime,
    background,
    externals,
    deep,
    modifying,
    boot,
    gitInfo,
    docs: docsOf(files, R, read),
    flows,
    channels,
    cov,
    entFacts,
    tenantFacts,
  });
  // Tests that check resolution against hand-verified calls need the model; facts alone cannot show a receiver type.
  if (withModel) Object.defineProperty(facts, 'model', { value: model, enumerable: false });
  // The lifecycle set sites: the same rows the flows rank reads, kept for the excerpt file (the writer's flow steps and
  // setter context). Not part of facts.json — the digest already carries the sentence form of every one.
  Object.defineProperty(facts, 'statusSets', { value: deep.statusSets, enumerable: false });
  return facts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  retuneHeap();
  const root = path.resolve(process.argv[2] ?? '.');
  const out = path.resolve(process.argv[3] ?? path.join(root, 'mindmodel', '.work', 'facts.json'));
  // The model is kept for the excerpt file only: it is not part of facts.json (non-enumerable), and it is the one place
  // that knows where each method's body begins and ends.
  const facts = scan(root, { withModel: true });
  // Right before the writer: create the scratch folder (self-ignoring) and move any previous map out of its path.
  ensureWork(root);
  const retired = retirePreviousMap(root);
  const digestStart = Date.now();
  const digest = summarize(facts);
  facts.timings.digest = Date.now() - digestStart;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(facts, null, 1));
  fs.writeFileSync(out.replace(/\.json$/, '.md'), digest);
  console.log(summaryLine(facts, out));
  if (retired) console.log(`previous map kept at ${retired}`);
}
