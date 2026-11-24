// Entities as the model sees them (§5.1, slice 3): the annotations say which type is an entity, the model says which
// fields it has (inherited ones included) and what each field's type resolves to. No line windows, no per-file search.
import { meanOf } from '../catalogs/catalog.mjs';

const RELATIONS = new Set(['relation']);
const IGNORED_FIELDS = new Set(['serialVersionUID']);

// The element type of a declared field, generics peeled: `List<Booking>` → Booking, `Map<Long, Slot>` → Slot.
export const elementType = (text) =>
  String(text ?? '')
    .replace(/^.*</, '')
    .replace(/>$/, '')
    .split(',')
    .map((s) => s.trim().replace(/<.*/, ''))
    .pop();

export const snake = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

const annArg = (ann, key) => new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(ann?.args ?? '')?.[1] ?? null;
const meansOfAnn = (index, a, on) => meanOf(index, a.fqn, on)?.means ?? null;

// A field's meaning: relation kind, key, or plain column.
function fieldInfo(index, f, file, model) {
  const kindAnn = (f.ann ?? []).find((a) => meansOfAnn(index, a, 'field') === 'relation');
  const rel = kindAnn ? meansOfAnn(index, kindAnn, 'field') && kindAnn.name : null;
  const mappedBy = kindAnn ? annArg(kindAnn, 'mappedBy') : null;
  const column = (f.ann ?? []).map((a) => annArg(a, 'name')).find(Boolean) ?? null;
  const target = rel ? model.resolveIn(file, elementType(f.type)) : null;
  return {
    name: f.name,
    type: elementType(f.type),
    typeFqn: f.typeFqn ?? null,
    column,
    id: (f.ann ?? []).some((a) => meansOfAnn(index, a, 'field') === 'id'),
    unique: (f.ann ?? []).some((a) => /unique\s*=\s*true/.test(a.args ?? '')),
    enumerated: (f.ann ?? []).some((a) => meansOfAnn(index, a, 'field') === 'enumerated') || undefined,
    relation: rel ? { kind: rel, target, owning: !mappedBy, mappedBy: mappedBy ?? null } : undefined,
    line: f.line,
  };
}

// Fields of a type including those it inherits from @MappedSuperclass (and from an @Entity supertype) through the model.
function fieldsOf(t, index, model, seen = new Set()) {
  if (seen.has(t.fqn)) return [];
  seen.add(t.fqn);
  const inherited = (t.supers ?? [])
    .map((s) => (s.fqn ? model.types.get(s.fqn) : null))
    .filter((s) => s && !seen.has(s.fqn))
    .flatMap((s) => fieldsOf(s, index, model, seen));
  const own = (t.fields ?? [])
    .filter((f) => !/\bstatic\b|\btransient\b/.test(f.mods ?? '') && !IGNORED_FIELDS.has(f.name))
    .map((f) => ({ ...fieldInfo(index, f, t.file, model), owner: t.name }));
  return [...inherited, ...own];
}

export const isTestPath = (p) => /\/src\/(test|it|integrationTest)\//.test(p ?? '');

export function entityFacts(model, index, types = new Map()) {
  const isRepoType = (fqn) => fqn && (types.get(fqn)?.entry?.means ?? null) === 'repository';
  // A test fixture annotated @Entity is not part of the app's schema.
  const typesInApp = [...model.types.values()].filter((t) => !isTestPath(t.file));
  const entities = [];
  for (const t of typesInApp) {
    const means = (t.ann ?? []).map((a) => meansOfAnn(index, a, 'type')).filter(Boolean);
    if (!means.includes('entity')) continue;
    const fields = fieldsOf(t, index, model);
    // A unique constraint declared on the table names its columns: those are unique too.
    const tableAnn = (t.ann ?? []).find((a) => meansOfAnn(index, a, 'type') === 'table');
    const uniqueCols = new Set([...(tableAnn?.args ?? '').matchAll(/unique\s*=\s*true[^,]*|columnNames\s*=\s*\{([^}]*)\}/g)].flatMap(() => []));
    for (const m of (tableAnn?.args ?? '').matchAll(/@UniqueConstraint\(([^)]*)\)/g))
      for (const c of m[1].matchAll(/"([^"]+)"/g)) uniqueCols.add(c[1]);
    const uc = (tableAnn?.args ?? '').match(/uniqueConstraints\s*=\s*\{([\s\S]*?)\}\s*\)/);
    if (uc) for (const c of uc[1].matchAll(/columnNames\s*=\s*\{([^}]*)\}/g)) for (const x of c[1].matchAll(/"([^"]+)"/g)) uniqueCols.add(x[1]);
    for (const f of fields) if (uniqueCols.has(f.column ?? '') || uniqueCols.has(f.name)) f.unique = true;
    const table = annArg(
      (t.ann ?? []).find((a) => meansOfAnn(index, a, 'type') === 'table'),
      'name',
    );
    entities.push({
      name: t.name,
      fqn: t.fqn,
      file: t.file,
      line: t.nameLine,
      table: table ?? snake(t.name),
      mappedSuperclass: means.includes('mapped-superclass'),
      fields,
      relations: fields
        .filter((f) => f.relation)
        .map((f) => `${f.relation.kind} ${f.relation.target?.split('.').pop() ?? f.type} ${f.name}:${f.line}`),
      keyFields: fields.filter((f) => !f.relation).map((f) => `${f.name}:${f.type}:${f.line}`),
      uniqueFields: fields.filter((f) => f.unique || f.id).map((f) => f.name),
      status: fields.some((f) => /^(status|state)$/i.test(f.name) || (f.enumerated && /status|state/i.test(f.type))),
    });
  }

  // Repositories and their entity. Spring Data: the first type argument of the repository supertype. MyBatis: the
  // entity most of its query methods return. Jakarta EE: the entity its EntityManager names most.
  const repoMethods = new Map();
  const repos = new Map();
  const queryOf = (m) => {
    const q = (m.ann ?? []).find((a) => ['Query', 'Select', 'Insert', 'Update', 'Delete'].includes(a.name));
    return q?.args?.trim() ? q.args.trim().slice(0, 200) : m.name;
  };
  for (const t of typesInApp) {
    const means = (t.ann ?? []).map((a) => meansOfAnn(index, a, 'type')).filter(Boolean);
    const isRepo = means.includes('repository') || (t.supers ?? []).some((s) => isRepoType(s.fqn));
    if (!isRepo) continue;
    let entity = null;
    for (const s of t.supers ?? []) {
      if (!isRepoType(s.fqn)) continue;
      const arg = /<([^,>]+)/.exec(s.text ?? '')?.[1]?.trim();
      if (arg) entity = model.resolveIn(t.file, elementType(arg)) ?? arg.split('.').pop();
      if (entity) break;
    }
    if (!entity) {
      const counts = {};
      for (const m of t.methods ?? []) {
        const rt = model.resolveIn(t.file, elementType(m.returnText ?? ''));
        if (rt && model.types.get(rt)?.ann?.some((a) => meansOfAnn(index, a, 'type') === 'entity')) counts[rt] = (counts[rt] ?? 0) + 1;
      }
      entity = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    if (!entity) continue;
    entity = entity.split('.').pop();
    repos.set(t.fqn, entity);
    repoMethods.set(
      t.fqn,
      (t.methods ?? []).map((m) => ({
        name: m.name,
        query: queryOf(m),
        line: m.nameLine,
        params: (m.params ?? []).map((p) => p.name),
        evidence: [`${t.file}:${m.nameLine}#${m.name}`],
        dynamic: (m.ann ?? []).some((a) => ['Query', 'Select', 'Insert', 'Update', 'Delete'].includes(a.name)),
        modifying: (m.ann ?? []).some((a) => a.name === 'Modifying') || /^\s*(update|delete)\b/i.test(m.ann?.find((a) => a.name === 'Query')?.args ?? ''),
      })),
    );
  }
  // Jakarta EE: a class holding an EntityManager is a repository; its entity is the one it names most in X.class.
  for (const t of typesInApp) {
    if (repos.has(t.fqn)) continue;
    if (!(t.fields ?? []).some((f) => /EntityManager$/.test(f.type ?? ''))) continue;
    const counts = {};
    for (const m of t.methods ?? []) {
      const text = [m.returnText, ...(m.params ?? []).map((p) => p.type)].join(' ');
      for (const e of entities) if (new RegExp(`\\b${e.name}\\b`).test(text)) counts[e.name] = (counts[e.name] ?? 0) + 1;
    }
    const entity = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (entity) repos.set(t.fqn, entity.split('.').pop());
  }
  return { entities, repos, repoMethods };
}

