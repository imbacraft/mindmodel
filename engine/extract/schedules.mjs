import assert from 'node:assert/strict';
import { simple } from '../core/names.mjs';
import { listOf, patternOf } from '../catalogs/catalog.mjs';

// Recurring work that is not `@Scheduled`: a fixed-rate/fixed-delay submission to an executor, a hashed-wheel timer,
// or a project's own scheduler. These run forever after a lifecycle hook, and a reader who only greps for annotations
// believes the app has one job when it has a dozen. The catalog says what a submission looks like (`means: 'recurring'`);
// for a project's own scheduler the method name and a scheduler-ish receiver type are the fallback.

const RECURRING = listOf('recurring-calls');
const SCHEDULER = patternOf('scheduler-type');

const cite = (type, m) => `${type.file}:${m.nameLine}#${m.name}`;

export function extractSchedules(model, selected = []) {
  const recurringMeans = [];
  for (const { catalog } of selected)
    for (const c of catalog.calls ?? [])
      if (c.means === 'recurring') recurringMeans.push({ types: new Set(c.types ?? [c.type]), methods: new Set(c.methods ?? []) });

  const facts = [];
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const c of m.calls ?? []) {
        const inCatalog = recurringMeans.some((x) => x.types.has(c.recvFqn) && (x.methods.size ? x.methods.has(c.name) : true));
        const byShape = RECURRING.has(c.name) && SCHEDULER.test(simple(c.recvFqn ?? ''));
        if (!inCatalog && !byShape) continue;
        facts.push({
          id: `schedule:recurring@${t.fqn}#${m.name}(${c.name}@${c.line})`,
          family: 'schedule',
          confidence: inCatalog ? 'resolved' : 'inferred',
          kind: 'recurring',
          mechanism: c.name,
          recv: c.recvFqn ?? null,
          method: m.id ?? `${t.fqn}#${m.name}`,
          line: c.line,
          evidence: [cite(t, m)],
          why: [
            inCatalog
              ? `receiver ${c.recvFqn} named a recurring submission by the catalog (${c.name})`
              : `receiver ${simple(c.recvFqn ?? '?')} is a scheduler and ${c.name} is a fixed rate/delay submission`,
          ],
        });
      }
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------
{
  const model = {
    types: new Map([
      [
        'a.Jobs',
        {
          fqn: 'a.Jobs',
          file: 'src/a/Jobs.java',
          methods: [
            {
              name: 'start',
              nameLine: 10,
              id: 'a.Jobs#start()',
              calls: [
                { name: 'scheduleAtFixedRate', line: 12, recvFqn: 'java.util.concurrent.ScheduledExecutorService' },
                { name: 'newTimeout', line: 14, recvFqn: 'io.netty.util.HashedWheelTimer' },
                { name: 'execute', line: 16, recvFqn: 'java.util.concurrent.ExecutorService' },
              ],
            },
          ],
        },
      ],
    ]),
  };
  const selected = [
    {
      catalog: {
        calls: [
          {
            types: ['java.util.concurrent.ScheduledExecutorService'],
            methods: ['scheduleAtFixedRate', 'scheduleWithFixedDelay'],
            means: 'recurring',
          },
        ],
      },
    },
  ];
  const facts = extractSchedules(model, selected);
  // The fixed-rate call is a fact from the catalog; the hashed wheel is a fact by shape; a plain execute is not recurring.
  assert.deepStrictEqual(facts.map((f) => [f.mechanism, f.line, f.confidence]), [
    ['scheduleAtFixedRate', 12, 'resolved'],
    ['newTimeout', 14, 'inferred'],
  ]);
}



// Schedules and retries in plain words. Both come off the model: the method's
// annotations (the dump's rows, with the argument list as the dump wrote it) and its own calls (for the time windows).
import { humanMs, humanSchedule, windowsIn } from './text/time.mjs';

const JOB = listOf('timed-job-annotations');

export function scheduleFacts({ files, cite }) {
  const schedules = [];
  for (const f of files)
    for (const m of f.methods ?? []) {
      const job = (m.ann ?? []).find((a) => JOB.has(a.name));
      if (job) {
        const w = windowsIn(m);
        schedules.push(
          `${f.name}.${m.name} ${cite(f, m)}: ${humanSchedule(job.args ?? '')}${w.length ? ` · windows ${w.join(', ')}` : ''}`,
        );
      }
      const retry = (m.ann ?? []).find((a) => a.name === 'Retryable');
      if (retry) {
        const args = retry.args ?? '',
          a = /maxAttempts\s*=\s*(\d+)/.exec(args)?.[1],
          d = /delay\s*=\s*(\d+)/.exec(args)?.[1],
          x = /multiplier\s*=\s*([\d.]+)/.exec(args)?.[1];
        schedules.push(
          `RETRY ${f.name}.${m.name} ${cite(f, m)}: ${a ?? 3} attempts${d ? `, first wait ${humanMs(Number(d))}` : ''}${x ? ` ×${x}` : ''}`,
        );
      }
    }
  return schedules;
}
{
  // A job and a retry, from the model's annotation rows and the method's own calls — no source lines in play.
  const files = [
    {
      name: 'Jobs',
      p: 'src/a/Jobs.java',
      methods: [
        {
          name: 'sweep',
          nameLine: 10,
          id: 'a.Jobs#sweep()',
          ann: [
            {
              name: 'Scheduled',
              fqn: 'org.springframework.scheduling.annotation.Scheduled',
              args: 'cron = "0 */10 * * * *"',
            },
          ],
          calls: [
            { name: 'minusHours', line: 11, args: ['24'], recvFqn: 'java.time.LocalDateTime' },
            { name: 'minusDays', line: 12, args: ['24'], recvFqn: 'java.time.LocalDateTime' },
          ],
        },
        {
          name: 'lookup',
          nameLine: 20,
          id: 'a.Jobs#lookup()',
          ann: [
            {
              name: 'Retryable',
              fqn: 'org.springframework.retry.annotation.Retryable',
              args:
                'retryFor = { java.io.IOException.class }, maxAttempts = 4, ' +
                'backoff = @Backoff(delay = 5000, multiplier = 3)',
            },
          ],
          calls: [],
        },
        { name: 'plain', nameLine: 30, id: 'a.Jobs#plain()', ann: [], calls: [] },
      ],
    },
  ];
  const cite = (f, m) => `${f.p}#${m.name}`;
  assert.deepStrictEqual(scheduleFacts({ files, cite }), [
    'Jobs.sweep src/a/Jobs.java#sweep: every 10 min · windows 24 h, 24 d',
    'RETRY Jobs.lookup src/a/Jobs.java#lookup: 4 attempts, first wait 5 s ×3',
  ]);
}
