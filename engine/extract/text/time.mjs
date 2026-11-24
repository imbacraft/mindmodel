// Plain-language timing for schedules (moved unchanged from deep.mjs).
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

// Time windows and retry settings written inside a method (e.g. "older than 5 min"): the moment arithmetic and the
// `Duration.ofX(n)` construction, read from the call rows the method owns — not from its source lines.
const WINDOW = /^(?:minus|plus)(Seconds|Minutes|Hours|Days|Weeks)$/;
const DURATION = /^of(Seconds|Minutes|Hours|Days)$/;
const UNIT = { Seconds: 's', Minutes: 'min', Hours: 'h', Days: 'd', Weeks: 'wk' };

/** The unit one call writes a window in, or null: `minusHours(24)`, `Duration.ofDays(7)`. */
function windowUnit(c) {
  const minus = WINDOW.exec(c.name);
  if (minus) return minus[1];
  // `Duration.ofHours(48)` is a static call; an untyped receiver is still Duration's spelling, and dropping it would
  // lose the window, so only a receiver that names another type rules it out.
  const type = c.recvFqn ?? '';
  return !type || /(^|\.)Duration$/.test(type) ? DURATION.exec(c.name)?.[1] ?? null : null;
}

export const windowsIn = (m) => {
  const out = new Set();
  for (const c of m.calls ?? []) {
    const unit = windowUnit(c);
    const amount = String(c.args?.[0] ?? '');
    if (unit && /^\d+$/.test(amount)) out.add(`${amount} ${UNIT[unit]}`);
  }
  return [...out];
};

// --- Java: seams, lifecycles, schedules -----------------------------------------------
