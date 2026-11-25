// Annotation presence by name. A name is simple (`Entity`) or full (`jakarta.persistence.Entity`). The dump writes each
// annotation as the author wrote it and, when the model resolved it, also with its FQN.
import assert from 'node:assert';
import { simple } from './names.mjs';

// A simple name matches the name as written or the FQN's last segment; a full name matches the resolved FQN or the
// name as written.
const isNamed = (a, name) =>
  name.includes('.') ? a.fqn === name || a.name === name : simple(a.name) === name || simple(a.fqn) === name;

// The first annotation on a type, field or method row that is any of `names`, or null.
export const annotationOn = (element, ...names) =>
  (element?.ann ?? []).find((a) => names.some((n) => isNamed(a, n))) ?? null;

// Whether the element carries the annotation.
export const hasAnnotation = (element, name) => annotationOn(element, name) !== null;

{
  const t = { ann: [{ name: 'Entity', fqn: 'jakarta.persistence.Entity' }, { name: 'org.x.Table' }] };
  assert.equal(hasAnnotation(t, 'Entity'), true);
  assert.equal(hasAnnotation(t, 'Table'), true);
  assert.equal(hasAnnotation(t, 'jakarta.persistence.Entity'), true);
  assert.equal(hasAnnotation(t, 'javax.persistence.Entity'), false);
  assert.equal(annotationOn(t, 'Nope', 'Table').name, 'org.x.Table');
  assert.equal(annotationOn({}, 'Entity'), null);
}
