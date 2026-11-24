// Import-time self-checks moved out of engine/extract/text/time.mjs (Task 9); the assertions are unchanged.
import test from 'node:test';
import assert from 'node:assert';
import { humanCron, humanSchedule } from '../engine/extract/text/time.mjs';

test('humanCron: six-field cron expressions', () => {
  assert.equal(humanCron('0 0 3 * * *'), 'daily 03:00');
  assert.equal(humanCron('0 */15 * * * *'), 'every 15 min');
});

test('humanSchedule: fixed rate, delay and written fields', () => {
  assert.equal(humanSchedule('(fixedRate = 600_000)'), 'every 10 min');
  assert.equal(humanSchedule('(fixedDelay = 30000)'), '30 s after each run ends');
  assert.equal(humanSchedule('(minute = "*/2", hour = "*")'), 'every 2 min');
  assert.equal(humanSchedule('(hour = "3")'), 'daily 03:00');
});
