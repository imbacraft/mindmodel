// Import-time self-checks moved out of engine/extract/text/time.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert';
import { humanCron, humanSchedule, windowsIn } from '../engine/extract/text/time.mjs';

test('humanCron: six-field cron expressions', () => {
  assert.equal(humanCron('0 0 3 * * *'), 'daily 03:00');
  assert.equal(humanCron('0 */15 * * * *'), 'every 15 min');
});

test('windowsIn: the windows a method\'s own calls write, once each, in source order', () => {
  const m = {
    calls: [
      { name: 'minusHours', args: ['24'], recvFqn: 'java.time.ZonedDateTime' },
      { name: 'ofDays', args: ['7'], recvFqn: 'java.time.Duration' },
      { name: 'ofDays', args: ['7'], recvFqn: null },
      { name: 'minusHours', args: ['24'], recvFqn: 'java.time.ZonedDateTime' },
      { name: 'minusSeconds', args: ['WINDOW'], recvFqn: 'java.time.Instant' },
      { name: 'ofDays', args: ['7'], recvFqn: 'org.joda.time.Hours' },
      { name: 'minusDays', recvFqn: 'java.time.LocalDate' },
    ],
  };
  assert.deepStrictEqual(
    windowsIn(m),
    ['24 h', '7 d'],
    'a named amount, another type and a missing argument are not windows',
  );
  assert.deepStrictEqual(windowsIn({}), [], 'a method with no calls has no windows');
});

test('humanSchedule: fixed rate, delay and written fields', () => {
  assert.equal(humanSchedule('(fixedRate = 600_000)'), 'every 10 min');
  assert.equal(humanSchedule('(fixedDelay = 30000)'), '30 s after each run ends');
  assert.equal(humanSchedule('(minute = "*/2", hour = "*")'), 'every 2 min');
  assert.equal(humanSchedule('(hour = "3")'), 'daily 03:00');
});
