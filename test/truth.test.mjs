// Hand-checked samples: call resolution (test/truth/<app>.json), flow shape (-flows), fact shape (-facts) and security
// facts (-security). A person read the source and wrote down the answer; the engine disagreeing is a regression the
// rates alone would hide.
//
// The files are discovered, not listed: everything in test/truth/ and in test/truth/local/ (gitignored, for a private
// app) is run. An app that is not cloned is skipped, so a fresh clone runs the public sample only and a checkout with a
// private corpus adds it without editing this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../engine/scan.mjs';
import { dirOf, loadApps } from './apps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadApps(here);

function truthFiles() {
  const dirs = [path.join(here, 'truth'), path.join(here, 'truth', 'local')];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const m = /^([\w.-]+?)(-(?:flows|facts|security|tenancy))?\.json$/.exec(f);
      if (!m) continue;
      out.push({ app: m[1], kind: m[2]?.slice(1) ?? 'calls', file: path.join(dir, f) });
    }
  }
  return out;
}

const appDir = (name) => {
  const a = cfg.apps.find((x) => x.name === name);
  return a ? dirOf(cfg, a) : null;
};

// Every call site the model holds, addressed the way a reader would: file, line, method name, receiver text.
function callIndex(model) {
  const by = new Map();
  for (const t of model.types.values())
    for (const m of t.methods)
      for (const c of m.calls ?? []) {
        const recv = c.recv ? (c.recv.kind === 'name' ? c.recv.text : c.recv.kind) : null;
        by.set(`${t.file}|${c.line}|${c.name}|${recv}`, c);
      }
  return by;
}

const checks = {
  calls(app, truth, res, misses) {
    const { model } = res;
    const calls = callIndex(model);
    for (const want of truth) {
      const got = calls.get(`${want.file}|${want.line}|${want.call}|${want.recv}`);
      if (!got) {
        misses.push(`${want.file}:${want.line} ${want.call}: the call site is gone`);
        continue;
      }
      const actual = {
        recvFqn: got.recvFqn ?? null,
        recvHow: got.recvHow ?? null,
        how: got.how ?? null,
        targets: [...(got.targets ?? [])].sort(),
      };
      const expected = { recvFqn: want.recvFqn, recvHow: want.recvHow, how: want.how, targets: want.targets };
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        misses.push(`${want.file}:${want.line} ${want.call}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    assert.ok(truth.length >= 29, `${app}: the hand-checked sample is still there`);
  },

  flows(app, truth, res, misses) {
    const { flows } = res;
    for (const want of truth) {
      const rank = flows.findIndex((f) => f.entry.cite.endsWith(want.entry)) + 1;
      const got = flows[rank - 1];
      if (!got) {
        misses.push(`${want.entry}: no such flow`);
        continue;
      }
      if (want.kind && got.entry.kind !== want.kind) misses.push(`${want.entry}: kind ${got.entry.kind}, expected ${want.kind}`);
      if (want.maxRank && rank > want.maxRank) misses.push(`${want.entry}: rank ${rank}, expected top ${want.maxRank}`);
      for (const hop of want.reaches ?? [])
        if (!got.steps.some((s) => s.startsWith(hop)))
          misses.push(`${want.entry}: does not reach ${hop} (steps: ${got.steps.join('; ')})`);
    }
  },

  facts(app, truth, res, misses) {
    const facts = res;
    for (const want of truth) {
      if (want.family === 'enum') {
        const e = (facts.entities.enums ?? []).find((x) => x.name === want.name);
        if (!e) misses.push(`enum ${want.name}: missing`);
        else if (JSON.stringify(e.values) !== JSON.stringify(want.values))
          misses.push(`enum ${want.name}: ${JSON.stringify(e.values)}, expected ${JSON.stringify(want.values)}`);
        continue;
      }
      if (want.family === 'schedule') {
        const s = (facts.schedules ?? []).find((x) => x.includes(want.methodContains));
        if (!s) misses.push(`schedule ${want.methodContains}: missing`);
        else if (want.when && !s.endsWith(want.when))
          misses.push(`schedule ${want.methodContains}: "${s.split(': ').pop()}", expected "${want.when}"`);
        continue;
      }
      if (want.family === 'lifecycle') {
        const line = (facts.lifecycle ?? []).find((x) => new RegExp(`^  ${want.value}: `).test(x));
        if (!line) {
          misses.push(`lifecycle ${want.value}: not listed`);
          continue;
        }
        for (const bad of want.notSetIn ?? [])
          if (line.includes(bad)) misses.push(`lifecycle ${want.value}: wrongly set in ${bad}`);
        for (const good of want.setIn ?? [])
          if (!line.includes(good)) misses.push(`lifecycle ${want.value}: does not name ${good} (${line.slice(0, 160)})`);
        continue;
      }
      const list = facts[want.family === 'transaction' ? 'transactions' : `${want.family}s`] ?? [];
      const got = list.find((f) => (f.method ?? '').includes(want.methodContains) && (!want.kind || f.kind === want.kind));
      if (!got) {
        misses.push(`${want.methodContains}: no such fact`);
        continue;
      }
      const outside = (got.outside ?? []).join('; ');
      if (want.outsideStartsWith && !outside.startsWith(want.outsideStartsWith))
        misses.push(`${want.methodContains}: outside is "${outside}", expected "${want.outsideStartsWith}…"`);
      if (want.evidenceContains && !(got.evidence ?? []).some((e) => e.includes(want.evidenceContains)))
        misses.push(`${want.methodContains}: evidence does not cite ${want.evidenceContains}`);
    }
  },

  tenancy(app, truth, res, misses) {
    const t = res.tenancy;
    for (const want of truth) {
      if ('key' in want && t.key !== want.key) misses.push(`key: ${t.key}, expected ${want.key}`);
      if (want.entities !== undefined && t.counts.entities !== want.entities)
        misses.push(`entities with the key: ${t.counts.entities}, expected ${want.entities}`);
      if (want.of !== undefined && t.counts.of !== want.of) misses.push(`entities: ${t.counts.of}, expected ${want.of}`);
      for (const e of want.withKey ?? []) if (!t.coverage.withKey.includes(e)) misses.push(`coverage: ${e} should carry the key`);
      for (const e of want.withoutKey ?? []) if (!t.coverage.withoutKey.includes(e)) misses.push(`coverage: ${e} should not carry the key`);
      if (want.tenantSources)
        for (const ts of want.tenantSources) {
          const got = (res.tenantSources ?? []).find((x) => x.kind === ts.kind && x.name === ts.name);
          if (!got) misses.push(`tenant source ${ts.kind} ${ts.name}: missing`);
          else if (ts.methodContains && !(got.method ?? '').includes(ts.methodContains))
            misses.push(`tenant source ${ts.name}: set by ${got.method}, expected ${ts.methodContains}`);
        }
      for (const bad of want.notTenantSources ?? [])
        if ((res.tenantSources ?? []).some((x) => (x.method ?? '').includes(bad))) misses.push(`tenant source: ${bad} must not be a source`);
      if (want.model) {
        const m = res.securityModel;
        const w = want.model;
        if (w.prefixes) for (const [prefix, access] of Object.entries(w.prefixes)) {
          const p = (m.prefixes ?? []).find((x) => x.prefix === prefix);
          if (!p) misses.push(`security model: prefix ${prefix} missing`);
          else if (!p.access.startsWith(access)) misses.push(`security model: ${prefix} is ${p.access}, expected ${access}`);
        }
        for (const u of w.userSources ?? []) if (!(m.userSources ?? []).some((x) => x.kind.includes(u))) misses.push(`security model: user source ${u} missing`);
        if (w.tenantKey !== undefined && (m.tenant?.key ?? null) !== w.tenantKey) misses.push(`security model: tenant ${m.tenant?.key}, expected ${w.tenantKey}`);
      }
      if (want.methodSecurity !== undefined && (res.methodSecurity ?? []).length !== want.methodSecurity)
        misses.push(`method-security facts: ${(res.methodSecurity ?? []).length}, expected ${want.methodSecurity}`);
      if (want.rules !== undefined && (res.securityRules ?? []).length !== want.rules)
        misses.push(`security rules: ${(res.securityRules ?? []).length}, expected ${want.rules}`);
      for (const src of want.ruleSources ?? [])
        if (!(res.securityRules ?? []).some((r) => r.source === src)) misses.push(`security rule source ${src}: none`);
      for (const q of want.scopedIncludes ?? []) {
        const inU = (t.unscoped ?? []).some((u) => `${u.repo}#${u.method}` === q || u.method === q.split('#').pop());
        if (inU) misses.push(`scoped: ${q} is still listed as unscoped`);
      }
      for (const q of want.crossIncludes ?? [])
        if (!(t.crossTenant ?? []).some((g) => `${g.repo}#${g.method}` === q)) misses.push(`cross-tenant read: ${q} missing`);
      for (const q of want.globalIncludes ?? [])
        if (!(t.globalLookups ?? []).some((g) => `${g.repo}#${g.method}` === q))
          misses.push(`global lookup: ${q} missing`);
      for (const q of want.unscopedIncludes ?? [])
        if (!t.unscoped.some((u) => `${u.repo}#${u.method}` === q || u.query.includes(q)))
          misses.push(`unscoped: ${q} missing`);
      if (want.bridged !== undefined && (t.bridged ?? 0) !== want.bridged)
        misses.push(`bridged (reads scoped by a base service): ${t.bridged}, expected ${want.bridged}`);
      for (const b of want.bases ?? []) if (!(t.bases ?? []).includes(b)) misses.push(`base service ${b}: not detected`);
      if (want.noRequest !== undefined && (res.noRequestPaths ?? []).length < want.noRequest)
        misses.push(`no-request paths: fewer than ${want.noRequest}`);
    }
  },

  security(app, truth, res, misses) {
    const facts = res;
    const WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'];
    // Only API prefixes: a docs or actuator permit is not an API write, and the truth is about the API surface.
    const anonWrites = (facts.securityRules ?? [])
      .filter((r) => /^\/api\b/.test(r.pattern) && r.access === 'anonymous' && (r.verbs ?? ['*']).some((v) => v === '*' || WRITE.includes(v)))
      .map((r) => `${r.verbs.join('|')} ${r.pattern}`)
      .sort();
    for (const want of truth) {
      if (want.warningCount !== undefined && (facts.securityWarnings ?? []).length !== want.warningCount)
        misses.push(`warnings: ${facts.securityWarnings.length}, expected ${want.warningCount}`);
      if (want.anonymousWriteRules) {
        const got = JSON.stringify(anonWrites),
          exp = JSON.stringify([...want.anonymousWriteRules].sort());
        if (got !== exp) misses.push(`anonymous write rules: ${got}, expected ${exp}`);
      }
      if (want.warning) {
        const w = (facts.securityWarnings ?? []).find(
          (x) => x.verb === want.warning.verb && x.path === want.warning.path && (x.handler ?? '').includes(want.warning.handlerContains),
        );
        if (!w) misses.push(`${want.warning.handlerContains}: no anonymous-write warning`);
        else if (!(w.evidence ?? []).some((e) => e.includes(want.warning.evidenceContains)))
          misses.push(`${want.warning.handlerContains}: evidence does not cite ${want.warning.evidenceContains}`);
      }
      if (want.tenant) {
        const t = (facts.tenantSources ?? []).find(
          (x) => x.kind === want.tenant.kind && x.name === want.tenant.name && (x.method ?? '').includes(want.tenant.methodContains),
        );
        if (!t) misses.push(`tenant ${want.tenant.kind}:${want.tenant.name} from ${want.tenant.methodContains}: missing`);
      }
    }
  },
};

// One scan per app for every truth kind: the model is needed for call resolution, so these scans stay in-memory.
const scanned = new Map();
const factsFor = (app, dir) => {
  if (!scanned.has(app)) scanned.set(app, scan(dir, { withModel: true }));
  return scanned.get(app);
};

for (const { app, kind, file } of truthFiles()) {
  const dir = appDir(app);
  test(`truth ${kind} ${app}`, { skip: !dir || !fs.existsSync(dir) ? `${app} is not cloned` : false }, () => {
    const truth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const misses = [];
    checks[kind](app, truth, factsFor(app, dir), misses);
    assert.deepEqual(misses, [], `${app}: ${misses.length} hand-checked ${kind} fact(s) disagree`);
  });
}
