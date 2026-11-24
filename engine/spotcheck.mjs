// Spot-check: before the writer calls a map finished, ten of its claims are checked against the code they cite.
// The pick is random but seeded, so the same map and seed give the same checklist on any machine; the writer confirms
// each row or corrects the map. This is the cheapest guard against a plausible sentence that the cited lines do not say.
//
// Usage: node spotcheck.mjs <projectRoot> [--map path] [--seed N] [--count N]
// Writes <root>/mindmodel/.work/spotcheck.md and prints the path.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// mulberry32: small, deterministic, good enough for picking ten rows.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every claim the map makes with a citation: rules, story steps and state rows. A claim without a cite cannot be
// spot-checked and is not a claim under P3 anyway.
export function claimsOf(map) {
  const out = [];
  for (const r of map.rules ?? [])
    if (r.cites?.length) out.push({ where: `rule: ${r.title ?? r.kind}`, text: r.text ?? '', cites: r.cites });
  for (const s of map.stories ?? [])
    for (const st of s.steps ?? [])
      if (st.cites?.length) out.push({ where: `story ${s.title ?? s.id}: step ${st.n ?? ''}`.trim(), text: st.text ?? '', cites: st.cites });
  const state = map.state ?? {};
  for (const row of state.owners ?? [])
    if (row.cites?.length) out.push({ where: `state owner: ${row.concept}`, text: `${row.truth} (writer: ${row.writer})`, cites: row.cites });
  return out;
}

// `path:12-18#sym` -> {file, from, to}
export function parseCite(cite) {
  const m = /^([^:#]+?)(?::(\d+)(?:-(\d+))?)?(?:#\S+)?$/.exec(String(cite ?? ''));
  if (!m) return null;
  const from = m[2] ? Number(m[2]) : null;
  return { file: m[1], from, to: m[3] ? Number(m[3]) : from };
}

function excerpt(root, cite) {
  const c = parseCite(cite);
  if (!c) return null;
  const abs = path.join(root, c.file);
  if (!fs.existsSync(abs)) return { missing: c.file };
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const from = Math.max(1, c.from ?? 1);
  const to = Math.min(lines.length, c.to ?? from + 11, from + 19);
  return { from, to, lines: lines.slice(from - 1, to) };
}

export function pick(claims, seed = 1, count = 10) {
  const r = rng(seed);
  const pool = [...claims];
  const picked = [];
  while (pool.length && picked.length < count) picked.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return picked;
}

export function spotcheckMarkdown(picked, { root, seed, mapName = 'mindmodel.json' }) {
  const out = [
    `# Spot-check (${picked.length} claims, seed ${seed}, map ${mapName})`,
    '',
    'Confirm each row against the cited lines before the map is finished: the claim is what the code does, the cite is',
    'where it says so. A row that fails is corrected in the map, not waved through. Record the outcome beside the row.',
    '',
  ];
  picked.forEach((c, i) => {
    out.push(`## ${i + 1}. ${c.where}`, '', `**Claim.** ${c.text}`, '', `**Cites.** ${c.cites.join(', ')}`);
    const ex = excerpt(root, c.cites[0]);
    if (!ex) out.push('', '_The first citation could not be parsed._');
    else if (ex.missing) out.push('', `_${ex.missing} is not in the tree._`);
    else {
      out.push('', `**Code** (${parseCite(c.cites[0]).file}:${ex.from}-${ex.to}):`, '', '```java');
      out.push(...ex.lines.map((l, k) => `${String(ex.from + k).padStart(4)}  ${l}`));
      out.push('```');
    }
    out.push('', '- [ ] confirmed as written', '- [ ] corrected (say how):', '');
  });
  return `${out.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const root = path.resolve(argv.find((a) => !a.startsWith('--')) ?? '.');
  const flag = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const mapPath = path.resolve(flag('map', path.join(root, 'mindmodel', 'mindmodel.json')));
  const seed = Number(flag('seed', 1));
  const count = Number(flag('count', 10));
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const picked = pick(claimsOf(map), seed, count);
  const out = path.join(root, 'mindmodel', '.work', 'spotcheck.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, spotcheckMarkdown(picked, { root, seed, mapName: path.basename(mapPath) }));
  console.log(`wrote ${out} (${picked.length} claims, seed ${seed})`);
}

// ---------------------------------------------------------------------------------------------------------------
// The pick is stable for a seed and covers the map's claims; a citation is read as file:from-to.
{
  const claims = Array.from({ length: 25 }, (_, i) => ({ where: `rule ${i}`, text: `claim ${i}`, cites: [`a.java:${i + 1}`] }));
  assert.deepStrictEqual(pick(claims, 7, 10), pick(claims, 7, 10));
  assert.notDeepStrictEqual(pick(claims, 7, 10), pick(claims, 8, 10));
  assert.deepStrictEqual(parseCite('src/a/B.java:12-18#m'), { file: 'src/a/B.java', from: 12, to: 18 });
  assert.deepStrictEqual(parseCite('src/a/B.java'), { file: 'src/a/B.java', from: null, to: null });
}
