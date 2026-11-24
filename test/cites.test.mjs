// Task 5: a citation never pins an overload by guesswork. A file that declares several methods of one name resolves
// only through a range that overlaps exactly one declaration, or through the arity form `#name/2`; a bare `#name` there
// is an error that lists the candidates, so the writer chooses instead of the validator.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, declaredFromModel, citeCandidates, citeProblem, parseCite } from '../engine/validate.mjs';

// The long overload does the work; the short one only throws, which is the failure the fixer used to pin silently.
const FIXTURE = `package demo;

/** Two overloads of save(), plus a call site in another method. */
public class X {
  public void save() {
    throw new IllegalStateException("Not supported");
  }

  public void save(String a, int b) {
    String out = a.trim();
    if (b < 0) {
      throw new IllegalArgumentException("b");
    }
    for (int i = 0; i < b; i++) {
      out = out + "-" + i;
    }
    store(out);
  }

  public void caller() {
    save("a", 1);
  }

  private void store(String s) {
    this.last = s;
  }

  private String last;
}
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmodel-cites-'));
fs.writeFileSync(path.join(root, 'X.java'), FIXTURE);
const lines = () => FIXTURE.split('\n');

// Where the fixture's declarations sit, as the engine's model reports them (params included, so their arity is known).
const DECLARED = declaredFromModel({
  types: new Map([
    [
      'demo.X',
      {
        name: 'X',
        file: 'X.java',
        start: 4,
        end: 29,
        nameLine: 4,
        methods: [
          { name: 'X', start: 4, end: 29, nameLine: 4, params: [] }, // the constructor, named like its type
          { name: 'save', start: 5, end: 7, nameLine: 5, params: [] },
          { name: 'save', start: 9, end: 18, nameLine: 9, params: [{ name: 'a' }, { name: 'b' }] },
          { name: 'caller', start: 20, end: 22, nameLine: 21, params: [] },
          { name: 'store', start: 24, end: 26, nameLine: 25, params: [{ name: 's' }] },
        ],
      },
    ],
  ]),
});

// The fixture is only useful if its line numbers are the ones above: check them here rather than in the fixtures.
test('the fixture declares the two overloads where the model says', () => {
  const l = lines();
  assert.match(l[4], /public void save\(\) \{/);
  assert.match(l[6], /^  \}$/);
  assert.match(l[8], /public void save\(String a, int b\) \{/);
  assert.match(l[17], /^  \}$/);
  assert.match(l[20], /save\("a", 1\);/);
  assert.deepEqual(
    DECLARED.get('X.java').methods.filter((m) => m.name === 'save').map((m) => m.arity),
    [0, 2],
    'both overloads carry their parameter count',
  );
  assert.equal(
    DECLARED.get('X.java').methods.some((m) => m.name === 'X'),
    false,
    'a constructor is not a second declaration of its type name',
  );
});

// The production path has no model in hand: the validator reads mindmodel/.work/dump beside the map instead.
const DUMP = path.join(root, 'mindmodel', '.work', 'dump');
fs.mkdirSync(DUMP, { recursive: true });
const ndjson = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
fs.writeFileSync(
  path.join(DUMP, 'meta.json'),
  JSON.stringify({ contract: 2, engine: 'fixture', counts: { types: 1 } }),
);
fs.writeFileSync(
  path.join(DUMP, 'types.ndjson'),
  ndjson([
    { fqn: 'demo.X', kind: 'class', supertypes: [], ann: [], pos: { file: 'X.java', line: 4, col: 1, endLine: 29 } },
  ]),
);
fs.writeFileSync(
  path.join(DUMP, 'members.ndjson'),
  ndjson(
    [
      { name: 'save', start: 5, end: 7, params: 0 },
      { name: 'save', start: 9, end: 18, params: 2 },
      { name: 'caller', start: 20, end: 22, params: 0 },
      { name: 'store', start: 24, end: 26, params: 1 },
    ].map((m) => ({
      kind: 'method',
      owner: 'demo.X',
      name: m.name,
      id: `demo.X#${m.name}/${m.params}`,
      params: Array.from({ length: m.params }, () => ({ type: 'String' })),
      returns: 'void',
      ann: [],
      pos: { file: 'X.java', line: m.start, col: 3, endLine: m.end, endCol: 4 },
    })),
  ),
);

// A map that passes every other check, so the only error left is the one the citation deserves.
const map = (cites) => ({
  version: '0.6',
  project: { name: 'cite-fixture', commit: 'abc1234', generatedAt: '2026-01-01T00:00:00.000Z' },
  purpose: { text: 'A fixture that stores one string.', cites: ['X.java:1-2'] },
  context: { actors: [], externals: [] },
  coreSentence: { text: 'The [[saving|saving]] concept is the whole fixture.', cites: ['X.java:4'] },
  concepts: [
    {
      id: 'saving',
      name: 'Saving',
      codeNames: ['X'],
      what: 'A string is kept in a field.',
      lifecycle: [{ state: 'stored', text: 'The string is kept in a field.' }],
      relations: [],
      keyFields: [{ name: 'last', text: 'the stored string' }],
      lives: { entity: 'X' },
      cites: ['X.java:28'],
    },
  ],
  state: {
    owners: [
      { concept: 'saving', truth: 'The last string written.', writer: 'core', gate: 'none', cites: ['X.java:28'] },
    ],
  },
  regionSentence: { text: 'The call arrives in [[core|the core]] and the string lands in [[edge|the edge]].' },
  regions: [
    { id: 'core', name: 'Core', role: 'backend', owns: ['saving'], paths: ['X.java'] },
    { id: 'edge', name: 'Edge', role: 'backend', owns: [], paths: ['X.java'] },
  ],
  runtime: {
    title: 'One call',
    lanes: [
      { id: 'caller', name: 'Caller', text: 'the code that calls save' },
      { id: 'field', name: 'Field', text: 'the field that keeps the string' },
    ],
    steps: [
      {
        region: 'core',
        from: 'caller',
        to: 'field',
        label: 'save',
        text: 'The string is passed down.',
        cites: ['X.java:21'],
      },
      {
        region: 'edge',
        from: 'field',
        to: 'field',
        label: 'store',
        text: 'The string is written.',
        cites: ['X.java:25'],
      },
    ],
  },
  background: { intro: 'Nothing runs on its own.', items: [] },
  rules: [
    {
      title: 'The string is stored as sent',
      text: 'The writer stores the string it is given.',
      importance: 'It is the only rule.',
      cites,
    },
  ],
  stories: [
    {
      id: 'store',
      kind: 'usage',
      title: 'Storing a string',
      setup: 'A caller has a string.',
      steps: [
        { region: 'core', text: 'The caller calls save.', cites: ['X.java:21'] },
        { region: 'edge', text: 'The string reaches the field.', cites: ['X.java:25'] },
      ],
      takeaways: ['The fixture stores strings.'],
      importance: 'The only flow.',
    },
  ],
});

const ruleCite = (m) => m.rules[0].cites[0];

test('a bare #name over two overloads is refused, listing both candidates', () => {
  const m = map(['X.java#save']);
  const { errors } = validate(m, root, DECLARED);
  assert.deepEqual(errors, [
    '$.rules[0].cites: "X.java#save" is ambiguous: ' +
      'X.java:5-7#save (0 params), X.java:9-18#save (2 params)',
  ]);
  assert.equal(ruleCite(m), 'X.java#save', 'the fixer picks no overload');
});

test('the arity form resolves to the overload it names', () => {
  const m = map(['X.java#save/2']);
  const { errors } = validate(m, root, DECLARED);
  assert.deepEqual(errors, []);
  assert.equal(ruleCite(m), 'X.java:9-18#save/2');
});

test('a range over one overload is accepted unchanged', () => {
  const m = map(['X.java:9-18#save']);
  const { errors } = validate(m, root, DECLARED);
  assert.deepEqual(errors, []);
  assert.equal(ruleCite(m), 'X.java:9-18#save');
});

test('a range over only a call site is rejected', () => {
  const m = map(['X.java:21#save']);
  const { errors } = validate(m, root, DECLARED);
  assert.deepEqual(errors, [
    '$.rules[0].cites: "X.java:21#save" is ambiguous: ' +
      'X.java:5-7#save (0 params), X.java:9-18#save (2 params)',
  ]);
  assert.equal(ruleCite(m), 'X.java:21#save', 'the fixer does not move it somewhere plausible');
});

test('one declaration of the name still resolves by name, as before', () => {
  const m = map(['X.java#caller']);
  const { errors } = validate(m, root, DECLARED);
  assert.deepEqual(errors, []);
  assert.equal(ruleCite(m), 'X.java:20-22#caller');
});

test('an arity no declaration has is an error, not a fallback to the nearest name', () => {
  const pc = parseCite('X.java#save/3');
  const why = citeProblem(pc, citeCandidates(DECLARED, pc), lines());
  assert.equal(why, 'names no "save" with 3 params in that file');
});

test('the dump beside the map names the same overloads', () => {
  const m = map(['X.java#save']);
  const { errors } = validate(m, root); // no declared argument: read mindmodel/.work/dump
  assert.deepEqual(errors, [
    '$.rules[0].cites: "X.java#save" is ambiguous: ' +
      'X.java:5-7#save (0 params), X.java:9-18#save (2 params)',
  ]);
});

test('a #Type citation is not made ambiguous by the constructor of the same name', () => {
  const m = map(['X.java#X']);
  const { errors } = validate(m, root, DECLARED);
  assert.deepEqual(errors, []);
  assert.equal(ruleCite(m), 'X.java:4-29#X');
});
