// Plain-language timing for schedules (moved unchanged from deep.mjs).
import assert from 'node:assert';
export function humanMs(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}
export function humanCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 6 || f[3] !== '*' || f[4] !== '*' || !['*', '?'].includes(f[5])) return `cron "${expr}"`;
  const [s, m, h] = f,
    every = (x) => /^(\*|0)\/(\d+)$/.exec(x)?.[2];
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) return `daily ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (every(m) && h === '*') return `every ${every(m)} min`;
  if (/^\d+$/.test(m) && h === '*') return 'hourly';
  if (/^\d+$/.test(m) && every(h)) return `every ${every(h)} h`;
  if (every(s) && m === '*') return `every ${every(s)} s`;
  return `cron "${expr}"`;
}
export function humanSchedule(args) {
  // EJB @Schedule: calendar attributes, each defaulting as the spec says (second 0, minute 0, hour 0, every day).
  if (/\b(second|minute|hour|dayOfMonth|month|dayOfWeek)\s*=\s*"/.test(args)) {
    const a = (k, d) => new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`).exec(args)?.[1] ?? d;
    return humanCron(
      `${a('second', '0')} ${a('minute', '0')} ${a('hour', '0')} ${a('dayOfMonth', '*')} ${a('month', '*')} ${a('dayOfWeek', '*')}`,
    );
  }
  // `fixedRate = 10 * 60 * 1000` is one value, not 10: read the arithmetic, don't take the first integer.
  const num = (k) => {
    const m = new RegExp(`\\b${k}\\s*=\\s*([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*)L?`).exec(args);
    return m ? m[1].split('*').reduce((a, b) => a * Number(b.replace(/_/g, '').trim()), 1) : null;
  };
  const parts = [];
  const cron = /cron\s*=\s*"([^"]+)"/.exec(args);
  if (cron) parts.push(/^\$\{/.test(cron[1]) ? `cron from config ${cron[1]}` : humanCron(cron[1]));
  if (num('fixedRate') != null) parts.push(`every ${humanMs(num('fixedRate'))}`);
  if (num('fixedDelay') != null) parts.push(`${humanMs(num('fixedDelay'))} after each run ends`);
  const str = /(fixedRate|fixedDelay|initialDelay)String\s*=\s*"([^"]+)"/.exec(args);
  if (str) parts.push(`${str[1]} from config ${str[2]}`);
  if (num('initialDelay') != null) parts.push(`first run after ${humanMs(num('initialDelay'))}`);
  return parts.join(', ') || args;
}
assert.equal(humanCron('0 0 3 * * *'), 'daily 03:00');
assert.equal(humanCron('0 */15 * * * *'), 'every 15 min');
assert.equal(humanSchedule('(fixedRate = 600_000)'), 'every 10 min');
assert.equal(humanSchedule('(fixedDelay = 30000)'), '30 s after each run ends');
assert.equal(humanSchedule('(minute = "*/2", hour = "*")'), 'every 2 min');
assert.equal(humanSchedule('(hour = "3")'), 'daily 03:00');

// Time windows and retry settings written inside a method (e.g. "older than 5 min").
const WINDOW =
  /(?:minus|plus)(Seconds|Minutes|Hours|Days|Weeks)\(\s*(\d+)|Duration\.of(Seconds|Minutes|Hours|Days)\(\s*(\d+)/g;
const UNIT = { Seconds: 's', Minutes: 'min', Hours: 'h', Days: 'd', Weeks: 'wk' };
export const windowsIn = (lines, m) => [
  ...new Set(
    [
      ...lines
        .slice(m.start - 1, m.end)
        .join('\n')
        .matchAll(WINDOW),
    ].map((x) => `${x[2] ?? x[4]} ${UNIT[x[1] ?? x[3]]}`),
  ),
];

// --- Java: seams, lifecycles, schedules -----------------------------------------------
