#!/usr/bin/env node
// The writer's question tool over a dump: no analysis, just the typed model, answered with a file:line on every line so
// a citation is written from the same answer that justified the claim. Output is capped so no query floods a reader.
// Usage: node ask.mjs <dump-dir> <command> [args]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './dump.mjs';

const LIMIT = 40;
const pos = (p) => (p ? `${p.file}:${p.line}` : '?');
const [dir, command, ...rest] = process.argv.slice(2);
const usage = () => {
  console.error(`usage: node ask.mjs <dump-dir> <command> [args]
  type <fqn>                 kind, position, supertypes
  method <id|fqn#name>       signature, position, annotations
  calls <id>                 call sites inside that method
  callers <id>               call sites that reach that method
  impls <fqn>                project subtypes of a type
  ann <fqn|id> <name>        annotation arguments as values
  constant <fqn> <name>      the literal value of a final field
  grep <text> [--kind K]     names containing text (types and members)`);
  process.exit(2);
};
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) {
  // Imported by a test that only loads the module (self-checks live in test/, never on import): nothing to answer.
} else if (!dir || !command) {
  usage();
} else {


  const d = open(dir);
  const arg = (i) => rest[i] ?? '';
  const out = [];
  const push = (...lines) => out.push(...lines);

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
        push(`  ${c.file}:${c.line}:${c.col} ${c.name}/${c.argc} recv=${c.recv.type ?? '?'} -> ${c.targets.join(', ') || `- ${c.origin}${c.reason ? ` (${c.reason})` : ''}`}`);
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
    default:
      usage();
  }
  console.log(out.join('\n'));
}
