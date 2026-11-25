#!/usr/bin/env node
// The writer's question tool over a dump: no analysis, just the typed model, answered with a file:line on every line so
// a citation is written from the same answer that justified the claim. Output is capped so no query floods a reader.
// Usage: node ask.mjs <root|dump-dir> <command> [args]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './dump.mjs';
import { body } from './excerpts.mjs';
import { targetIds } from './model/targets.mjs';

const LIMIT = 40; // one answer's rows
const LINES = 60; // `lines`: a range, capped
const SRC = 40; // `src`: one method, capped
const FIND = 20; // `find`: hits, capped
const pos = (p) => (p ? `${p.file}:${p.line}` : '?');

/** The dump for a project root, or for a dump directory; `<root>/mindmodel/.work/dump` is where a scan puts it. */
function dumpDir(arg) {
  if (fs.existsSync(path.join(arg, 'meta.json'))) return arg;
  const under = path.join(arg, 'mindmodel', '.work', 'dump');
  if (fs.existsSync(path.join(under, 'meta.json'))) return under;
  return arg;
}
/** The project a dump belongs to: three levels up from `<root>/mindmodel/.work/dump`, else the working directory. */
const rootOf = (dir) => (/[/\\]\.work[/\\]dump[/\\]?$/.test(dir) ? path.resolve(dir, '..', '..', '..') : process.cwd());

const CONFIG = /(?:^|\/)application[\w.-]*\.(?:ya?ml|properties)$/;
/** The config files a scan reads: the same set, so a `find` answer and a digest fact never disagree. */
function configFiles(root) {
  const out = [];
  const skip = new Set(['.git', 'node_modules', 'target', 'build', '.work', 'mindmodel']);
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.mvn') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full, depth + 1);
      } else if (CONFIG.test(e.name)) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/** A config line with its value hidden when the key looks like a secret — the key stays, the value never leaves. */
const SECRET = /(?:^|[\w.-])(?:password|passwd|secret|token|credential|api[-_.]?key|private[-_.]?key)/i;
function redact(rel, line) {
  if (!CONFIG.test(rel)) return line.trim();
  const pair = /^\s*([\w.-]+)\s*[:=]\s*(.*)$/.exec(line);
  if (!pair || !SECRET.test(pair[1])) return line.trim();
  return `${pair[1]}: <redacted>`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) {
  // Imported by a test that only loads the module (self-checks live in test/, never on import): nothing to answer.
} else {
  const [dirArg, command, ...rest] = process.argv.slice(2);
  const usage = () => {
    console.error(`usage: node ask.mjs <root|dump-dir> <command> [args]
  type <fqn>                 kind, position, supertypes
  method <id|fqn#name>       signature, position, annotations
  calls <id>                 call sites inside that method
  callers <id>               call sites that reach that method
  impls <fqn>                project subtypes of a type
  ann <fqn|id> <name>        annotation arguments as values
  constant <fqn> <name>      the literal value of a final field
  grep <text> [--kind K]     names containing text (types and members)
  src <path#method>          that method's body, numbered, capped at ${SRC} lines
  lines <path>:<a>-<b>       that line range, numbered, capped at ${LINES} lines
  find <text>                fixed-string search of the Java sources and the config the scan reads, ${FIND} hits`);
    process.exit(2);
  };
  if (!dirArg || !command) usage();
  const dir = dumpDir(path.resolve(dirArg));
  const root = rootOf(dir);

  const d = open(dir);
  const arg = (i) => rest[i] ?? '';
  const out = [];
  const push = (...lines) => out.push(...lines);
  const readFile = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };

  switch (command) {
    case 'type': {
      const t = d.type(arg(0));
      if (!t) push(`no such type: ${arg(0)}`);
      else push(`${t.fqn} ${t.kind} ${pos(t.pos)} supertypes: ${(t.supertypes ?? []).map((s) => s.text).join(', ') || '-'}`);
      break;
    }
    case 'method': {
      const id = arg(0).includes('#') ? arg(0) : [...d.members.values()].find((m) => m.id?.startsWith(`${arg(0)}#`))?.id;
      const m = d.members.get(id);
      if (!m) push(`no such method: ${arg(0)}`);
      else push(`${m.id} ${pos(m.pos)} returns ${m.returns ?? m.type ?? '-'} params ${m.params.map((p) => p.type).join(',') || '-'}${m.generated ? ` generated:${m.generated}` : ''} ann: ${(m.ann ?? []).map((a) => a.name.split('.').pop()).join(',') || '-'}`);
      break;
    }
    case 'calls':
    case 'callers': {
      const list = (command === 'calls' ? d.callsOf(arg(0)) : d.callersOf(arg(0))).slice(0, LIMIT);
      push(`${list.length} ${command} of ${arg(0)}`);
      for (const c of list)
        push(`  ${c.file}:${c.line}:${c.col} ${c.name}/${c.argc} recv=${c.recv.type ?? '?'} -> ${targetIds(c).join(', ') || `- ${c.origin}${c.reason ? ` (${c.reason})` : ''}`}`);
      break;
    }
    case 'impls': {
      const list = d.implsOf(arg(0)).slice(0, LIMIT);
      push(`${list.length} subtype(s) of ${arg(0)}`);
      for (const fqn of list) push(`  ${fqn} ${pos(d.type(fqn)?.pos)}`);
      break;
    }
    case 'ann': {
      const el = d.members.get(arg(0)) ?? d.type(arg(0));
      if (!el) push(`no such type or method: ${arg(0)}`);
      else {
        const args = d.annotation(el, arg(1));
        push(args === null ? `no @${arg(1)} on ${arg(0)}` : `@${arg(1)} ${pos(el.pos)} ${JSON.stringify(args)}`);
      }
      break;
    }
    case 'constant': {
      const v = d.constant(arg(0), arg(1));
      push(v === null ? `no such constant: ${arg(0)}.${arg(1)}` : `${arg(0)}.${arg(1)} = ${JSON.stringify(v.value)} (${v.kind})`);
      break;
    }
    case 'grep': {
      const kindIndex = rest.indexOf('--kind');
      const hits = d.grep(arg(0), { kind: kindIndex < 0 ? undefined : rest[kindIndex + 1], limit: LIMIT });
      push(`${hits.length} hit(s) for ${arg(0)}`);
      for (const h of hits) push(`  ${h.what} ${h.name} ${pos(h.pos)}`);
      break;
    }
    case 'src': {
      // The method as written, from the dump's own range: a citation the writer can quote, never a guess at the brace.
      const [rel, name] = arg(0).split('#');
      const hits = [...d.members.values()].filter((m) => m.pos?.file === rel && m.name === name && m.pos.endLine);
      const text = rel ? readFile(rel) : null;
      if (!hits.length) push(`no such method in ${rel || 'the dump'}: ${name || '(none given)'}`);
      else if (hits.length > 1) push(`${hits.length} methods named ${name} in ${rel}: give the full id (${hits.map((m) => m.id).join(', ')})`);
      else if (text === null) push(`cannot read ${rel}`);
      else {
        const m = hits[0];
        push(`${rel}:${m.pos.line}-${m.pos.endLine}#${m.name}`, ...body(text, m.pos.line, m.pos.endLine, SRC));
      }
      break;
    }
    case 'lines': {
      const m = /^(.*):(\d+)-(\d+)$/.exec(arg(0));
      const text = m ? readFile(m[1]) : null;
      if (!m) push(`usage: lines <path>:<a>-<b>`);
      else if (text === null) push(`cannot read ${m[1]}`);
      else push(`${m[1]}:${m[2]}-${m[3]}`, ...body(text, Number(m[2]), Number(m[3]), LINES));
      break;
    }
    case 'find': {
      // A fixed string over the sources the dump read and the config the scan reads: not a shell grep, and never more
      // than a reader can use. A config value is redacted when its key looks like a secret; the key itself is kept.
      const needle = arg(0);
      if (!needle) usage();
      const javaFiles = [...d.files.keys()];
      const config = configFiles(root);
      const hits = [];
      for (const rel of [...javaFiles, ...config]) {
        const text = readFile(rel);
        if (text === null) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < FIND; i++) {
          const at = lines[i].indexOf(needle);
          if (at < 0) continue;
          hits.push(`${rel}:${i + 1}: ${redact(rel, lines[i])}`.slice(0, 240));
        }
        if (hits.length >= FIND) break;
      }
      push(`${hits.length}${hits.length >= FIND ? '+' : ''} hit(s) for ${needle}`);
      push(...hits);
      break;
    }
    default:
      usage();
  }
  console.log(out.join('\n'));
}
