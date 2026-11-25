import path from 'node:path';

/**
 * Joins the services: topics and queues to their producers and consumers, and REST calls to the service they reach.
 * A call matches a service by its name, its folder, the same name without dashes ("customercore"), or, for local URLs
 * like http://localhost:8110, by the port the service runs on.
 */
export function joinEdges(services) {
  const normService = (n) =>
    String(n)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const byName = new Map(
    services.flatMap((s) => [
      [s.name, s],
      [path.basename(s.dir), s],
      [normService(s.name), s],
      [normService(path.basename(s.dir)), s],
      ...(s.port ? [[`localhost:${s.port}`, s]] : []),
    ]),
  );
  const channels = {};
  for (const s of services)
    for (const m of s.msgs) {
      const key = `${m.kind}:${m.name ?? `?${m.unresolved}`}`;
      (channels[key] ??= { kind: m.kind, name: m.name, unresolved: m.unresolved, out: [], in: [] })[m.dir].push({
        service: s.name,
        cite: m.cite,
      });
    }
  const rest = [];
  for (const s of services)
    for (const c of s.calls) {
      const target = byName.get(c.host) ?? byName.get(normService(c.host));
      const ep =
        target && c.path && c.via !== 'gateway'
          ? target.facts.endpoints.find((e) => e.path === c.path.replace(/\{[^}]+}/g, '{}').replace(/\/$/, ''))
          : null;
      rest.push({
        from: s.name,
        to: target?.name ?? c.host,
        known: !!target,
        path: c.path,
        via: c.via,
        cite: c.cite,
        endpoint: ep ? `${ep.file}:${ep.line}` : null,
      });
    }
  return { channels: Object.values(channels), rest };
}
