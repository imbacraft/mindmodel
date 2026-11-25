import { isTestCode } from '../core/paths.mjs';
import { annotationOn, hasAnnotation } from '../core/annotations.mjs';
import { listOf, typeIndex } from '../catalogs/catalog.mjs';
import { entityFacts } from '../extract/entities.mjs';
import { resolveWildcardAnnotations } from './model.mjs';

// Work that runs without a request: a job annotation on the method, an observer on its parameter.
const JOB = listOf('job-annotations');
const OBSERVER = listOf('observer-annotations');
const MESSAGE_DRIVEN = [...listOf('message-driven-annotations')];

/** A job, an observer or a message listener: the annotation is on the method (or its parameter), the model has both. */
function scheduledOf(t) {
  const jobs = [];
  for (const m of t.methods ?? []) {
    for (const a of m.ann ?? [])
      if (JOB.has(a.name))
        jobs.push({
          kind: a.name,
          args: (a.args ? `(${a.args})` : '').trim().slice(0, 120),
          line: a.line ?? m.nameLine,
          method: m.name,
        });
    // A CDI observer names its event on the parameter, and an MDB names its destination on the class.
    for (const p of m.params ?? [])
      for (const a of p.ann ?? [])
        if (OBSERVER.has(a.name))
          jobs.push({ kind: a.name, args: String(p.type ?? '').slice(0, 120), line: a.line ?? m.nameLine });
  }
  const mdb = annotationOn(t, ...MESSAGE_DRIVEN);
  if (mdb) {
    const dest =
      /propertyName\s*=\s*"destination(?:Lookup)?"\s*,\s*propertyValue\s*=\s*"([^"]+)"/.exec(mdb.args ?? '') ??
      /mappedName\s*=\s*"([^"]+)"/.exec(mdb.args ?? '');
    const on = (t.methods ?? []).find((m) => m.name === 'onMessage');
    jobs.push({ kind: 'MessageDriven', args: dest?.[1] ?? '', line: on?.nameLine ?? t.start });
  }
  return jobs.sort((a, b) => a.line - b.line);
}

const tableOf = (t) =>
  /name\s*=\s*"([^"]+)"/.exec(annotationOn(t, 'Table')?.args ?? '')?.[1];

/**
 * A model type in the shape the families read: identity (name, kind, annotations, supertypes, enum values), and its
 * members.
 */
function typeEntry(t) {
  return {
    p: t.file,
    name: t.name,
    kind: t.kind,
    classLine: t.start,
    annotations: (t.ann ?? []).map((a) => a.name),
    extends: (t.supers ?? []).filter((s) => s.kind !== 'interface').map((s) => s.text).join(','),
    implements: (t.supers ?? []).filter((s) => s.kind === 'interface').map((s) => s.text).join(','),
    constants: t.enumValues ?? [],
    scheduled: scheduledOf(t),
    views: [],
    table: tableOf(t),
    fields: (t.fields ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      typeFqn: f.typeFqn,
      ann: f.ann,
      line: f.line,
    })),
    methods: t.methods ?? [],
    type: t,
  };
}

/** The view names a controller returns: the string values its methods hand back, as the dump wrote them. */
// shortcut: switch arms that return a view are not read yet, a view named only there counts as dead; upgrade when one
// shows up.
function viewsReturnedBy(dump, t) {
  return (t.methods ?? [])
    .filter((m) => !hasAnnotation(m, 'ResponseBody'))
    .flatMap((m) =>
      (dump?.returnsOf(m.id) ?? [])
        .filter((r) => r.kind === 'return' && typeof r.value?.value === 'string' && /^\S+$/.test(r.value.value))
        .map((r) => ({ view: r.value.value, line: r.line })),
    );
}

/**
 * The app's types, as the families read them. Entries are built once and picked for the entity, controller and
 * repository passes here, before the wildcard-annotation pass, as the facts always were.
 */
export function typeFacts({ model, dump, app }) {
  const appTypes = [...model.types.values()].filter((t) => !app.isExcluded(t.file) && !isTestCode(t.file));
  const appEntries = appTypes.map(typeEntry);
  const entities = appEntries.filter((e) => hasAnnotation(e.type, 'Entity'));
  // Controllers: Spring MVC, JAX-RS resources, and JSF backing beans (@Named with a UI scope).
  const isController = (t) =>
    annotationOn(t, ...listOf('controller-annotations')) !== null ||
    (annotationOn(t, ...listOf('named-annotations')) !== null && annotationOn(t, ...listOf('ui-scopes')) !== null);
  const controllers = appEntries
    .filter((e) => isController(e.type))
    // A REST or JAX-RS method's string is a response body, not a view name.
    .map((e) => ({
      ...e,
      views:
        hasAnnotation(e.type, 'RestController') || hasAnnotation(e.type, 'Path') ? [] : viewsReturnedBy(dump, e.type),
    }));
  const repos = appEntries.filter((e) =>
    (e.type.supers ?? []).some((s) => /\b(Jpa|Crud|PagingAndSorting)?Repository\s*</.test(s.text ?? '')),
  );
  // Status enums with values (lifecycles): the model's kinds and the enum constants the dump lists.
  const enums = appTypes
    .filter((t) => t.kind === 'enum' && /(Status|State|Type|Mode|Tier|Role|Source)$/.test(t.name ?? ''))
    .map((t) => ({ name: t.name, file: t.file, line: t.start, values: t.enumValues ?? [] }));
  return { appTypes, appEntries, entities, controllers, repos, enums };
}

/** Entities and repositories on the model, after the wildcard-annotation pass has named what a catalog resolves. */
export function entityFactsOf({ model, selected, annIndex }) {
  resolveWildcardAnnotations(model, annIndex);
  return entityFacts(model, annIndex, typeIndex(selected));
}
