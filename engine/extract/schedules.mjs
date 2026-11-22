import assert from 'node:assert/strict';

// Recurring work that is not `@Scheduled`: a fixed-rate/fixed-delay submission to an executor, a hashed-wheel timer,
// or a project's own scheduler. These run forever after a lifecycle hook, and a reader who only greps for annotations
// believes the app has one job when it has a dozen. The catalog says what a submission looks like (`means: 'recurring'`);
// for a project's own scheduler the method name and a scheduler-ish receiver type are the fallback.

const RECURRING = /^(?:scheduleAtFixedRate|scheduleWithFixedDelay|scheduleAtFixedRateAsync|newTimeout|schedulePage|schedulePeriodic)$/;
const SCHEDULER = /(?:Scheduler|Timer|WheelTimer|Executor)$/;

const simple = (s) => String(s ?? '').split('.').pop();
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
        const byShape = RECURRING.test(c.name) && SCHEDULER.test(simple(c.recvFqn ?? ''));
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
