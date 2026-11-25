#!/usr/bin/env node
// System scan: the services in a folder and the proven connections between them (REST, Kafka, JMS).
// The folder is read through one engine dump (the only reader of its Java), and every service's own facts come from
// the single-app scanner. This adds what crosses service boundaries and joins it.
// Usage: node system.mjs <folder> [outDir]   (default out: <folder>/mindmodel-system/.work/)
// The parts live in system/: messaging and REST edges, the folder model, one service, the joins and the summary.
import fs from 'node:fs';
import path from 'node:path';
import { retuneHeap } from './io/heap.mjs';
import { summarize } from './digest/facts-md.mjs';
import { BUILTIN, codeIndex } from './system/messaging.mjs';
import { collidedModules, findServices, folderModel, isApp, moduleOf } from './system/folder.mjs';
import { serviceOf } from './system/service.mjs';
import { joinEdges } from './system/edges.mjs';
import { systemSummary } from './system/summary.mjs';

/** The system scan of one folder: its services, its shared libraries, and the channels and REST calls between them. */
export function systemScan(folder) {
  const modules = findServices(folder);
  // Company wrappers around Kafka/JMS: extra patterns from <folder>/mindmodel-system.json
  // ({"messaging":[{"kind","dir","re"}]}).
  const custom = fs.existsSync(path.join(folder, 'mindmodel-system.json'))
    ? (JSON.parse(fs.readFileSync(path.join(folder, 'mindmodel-system.json'), 'utf8')).messaging ?? [])
    : [];
  const patterns = [...BUILTIN, ...custom];
  const folderFacts = folderModel(folder, modules);
  const db = folderFacts?.db ?? null;
  const model = folderFacts?.model ?? null;
  const ix = codeIndex(model);
  // Modules with a file the folder dump could not parse: the dump keeps one type per name, so a module that copies a
  // sibling's class needs its own dump.
  const collided = collidedModules(folder, modules, db);
  const byModule = new Map(modules.map((d) => [d, moduleOf(folder, d, db, model, collided)]));
  // Modules without a Spring entry point are shared libraries (DTOs, events), not services. Decided once per module:
  // the check reads the module's build file.
  const appOf = new Map(modules.map((d) => [d, isApp(d, byModule.get(d).types)]));
  const libraries = modules.filter((d) => !appOf.get(d)).map((d) => path.relative(folder, d));
  const services = modules
    .filter((dir) => appOf.get(dir))
    .map((dir) => serviceOf(folder, dir, byModule.get(dir), patterns, ix));
  // Two services with the same spring.application.name (a copy-paste slip) would merge in discovery: tell them apart
  // by folder.
  const dupes = services.filter((s) => services.filter((o) => o.name === s.name).length > 1);
  for (const s of dupes) {
    s.nameConflict = s.name;
    s.name = path.basename(s.dir);
  }
  const { channels, rest } = joinEdges(services);
  return {
    folder,
    services,
    libraries,
    channels,
    rest,
    duplicates: dupes.map((s) => ({ name: s.nameConflict, dir: s.dir })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  retuneHeap();
  const folder = path.resolve(process.argv[2] ?? '.');
  const out = path.resolve(process.argv[3] ?? path.join(folder, 'mindmodel-system', '.work'));
  const sys = systemScan(folder);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, 'system.json'),
    JSON.stringify(
      {
        ...sys,
        services: sys.services.map(({ facts, ...s }) => ({
          ...s,
          endpoints: facts.endpoints.length,
          entities: facts.entities.model.slice(0, 10).map((e) => e.name),
        })),
      },
      null,
      1,
    ),
  );
  fs.writeFileSync(path.join(out, 'system.md'), systemSummary(sys));
  // Each service's own facts digest, so the writer can look inside a service without rescanning it.
  fs.mkdirSync(path.join(out, 'services'), { recursive: true });
  for (const s of sys.services) fs.writeFileSync(path.join(out, 'services', `${s.name}.md`), summarize(s.facts));
  console.log(
    `wrote ${out}/system.md: ${sys.services.length} services, ${sys.channels.length} channels, ` +
      `${sys.rest.length} REST calls`,
  );
}
