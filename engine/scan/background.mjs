import path from 'node:path';
import { annotationOn } from '../core/annotations.mjs';
import { anyNamed, listOf, patternOf } from '../catalogs/catalog.mjs';
import { modelEntries } from './model-entries.mjs';

/** Jakarta Batch: jobs are XML files under META-INF/batch-jobs; JobOperator.start("name") starts them. */
function batchJobsOf(appTypes, files, R, read) {
  return files
    .filter((f) => /META-INF\/batch-jobs\/[\w.-]+\.xml$/.test(f))
    .map((f) => {
      const xml = read(f);
      const id = /<job\b[^>]*\bid="([^"]+)"/.exec(xml)?.[1] ?? path.basename(f, '.xml');
      // `JobOperator.start("name")`: the dump's call row, with the job id as its folded argument.
      const starts = appTypes.flatMap((t) =>
        (t.methods ?? [])
          .flatMap((m) => (m.calls ?? []).filter((c) => c.name === 'start' && (c.args ?? []).includes(`"${id}"`)))
          .map((c) => `${t.file}:${c.line}`),
      );
      const steps = [...xml.matchAll(/<(batchlet|reader|processor|writer)\b[^>]*\bref="([^"]+)"/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      );
      return {
        kind: 'Batch job',
        args: `${id}: ${steps.join(', ')}${starts.length ? `; started at ${starts.join(', ')}` : ''}`,
        file: R(f),
        line: 1,
      };
    });
}

/** Work that runs without a request, the sockets the app opens and the runners it starts with. */
export function backgroundOf({ files, R, read }, { appTypes, appEntries }, endpoints) {
  const background = appEntries.flatMap((e) => e.scheduled.map((s) => ({ ...s, file: e.p, cls: e.name })));
  const sockets = endpoints
    .filter((e) => e.verb === 'STOMP')
    .map((e) => ({ file: e.file, line: e.line, path: e.path }))
    .concat(modelEntries(appTypes, { methods: { calls: anyNamed('stomp-config-calls') } }));
  const runners = appTypes
    .filter(
      (t) =>
        (t.supers ?? []).some((s) => patternOf('runner-supers').test(s.text ?? '')) ||
        annotationOn(t, ...listOf('startup-annotations')) !== null,
    )
    .map((t) => ({ file: t.file, line: t.start }));
  return {
    scheduledAsyncListeners: [...background, ...batchJobsOf(appTypes, files, R, read)],
    sockets,
    runners,
  };
}
