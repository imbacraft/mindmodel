# Java engine: architecture

The engine reads a Java checkout with Spoon, without its classpath, and writes the dump: one ndjson file per section
and a
`meta.json`. Node reads the dump and never sees Spoon. Where the engine cannot answer, it writes the unknown as `null`
or `origin: "unresolved"` with a reason, and never a guess. The format is `CONTRACT.md` (contract 8), with its JSON
Schemas in `contract/`.

## The pipeline

`mindmodel.engine.run.Dump.run` reads top to bottom, and each step takes its inputs explicitly:

1. Read the relative file list, sorted, and build the Spoon model (`SourceModel.load`). Each classpath entry that is
   missing or unreadable is dropped first (`Classpath.readable`) and counted; the model reads the rest. Each source
   that is not UTF-8 is counted (`files.notUtf8`).
2. Count duplicate declarations (`Duplicates.count`).
3. Collect the declared types, re-reading the files Spoon left as bare shells (`Declarations.of`).
4. Synthesise the members Lombok and the compiler write. With a Lombok jar, delombok runs over the Lombok-using sources
   and its output is the answer (`LombokOracle.run`); otherwise the hand-written rules are (`Lombok.synthesize`).
5. Write `types.ndjson`.
6. Walk each body once (`Walk.Bodies`), give every call site its id, and write `calls.ndjson`. Calls go first because
   their ids are what the other sections name, and they hand back each body's returns and field accesses.
7. Write `members.ndjson`, `fields.ndjson`, `library.ndjson` and `files.ndjson`.
8. Write `meta.json`: the contract, the classpath digest, the counts and every failure counter.

## Packages and dependency direction

The dependency direction is `cli` to `run` to `write` to `resolve` to `model`. A class may import from its own layer or
from a lower one, never from a higher one. The build section below says how to check it.

- `cli`: `Main`. Arguments, usage and exit codes.
- `run`: `Dump`, the pipeline. `DumpRun` is a test helper only.
- `write`: one writer per ndjson file. `TypesWriter`, `MembersWriter`, `CallsWriter`, `FieldsWriter`, `FilesWriter`,
  `LibraryWriter` and `MetaWriter`. `Ndjson` streams rows and escapes lone surrogates. `Json` holds the shapes the rows
  share: positions, modifiers, nullable keys, values, annotations, references and supertypes. `Contract` holds the
  contract number and the engine name.
- `resolve`: what things are, decided from Spoon's answers. `Refs` is an expression as data. `Chains` types receivers,
  and `Calls` says which declarations a call reaches. `FieldAccess` and `Returns` resolve body facts, and `BodyShape`
  gives loops, branches and try blocks as line ranges. `Lombok` synthesises generated members by the
  hand-written rules, and `LombokOracle` reads them from delombok's output. `Values` and `Anns` read constants and
  annotations. `LibraryTypes` holds the one declared extension table. `CallIds` names call sites. `Types`
  gives a type's kind.
- `model`: the Spoon model and the spelling of its names. `SourceModel` builds the model. `Generated` tracks generated
  sources. `Recovery`, `Duplicates` and `Declarations` handle the three ways Spoon merges or drops declarations.
  `Imports` and `FileProblems` read the file header and parse errors. `SourceText` is the one reader of a file's text
  (UTF-8, else ISO-8859-1). `Classpath` drops the unreadable classpath entries. `Delombok` runs Lombok's delombok in a
  child JVM over a staging copy, and removes it afterwards. `Walk` and `Anonymous` cover bodies and their
  anonymous classes. `RecordCtors` finds a record's canonical constructor. `Names`, `Positions` and `Failures` are the
  one owner each of name spelling, source positions and failure counting.

## Where each section is written

| File | Writer | One row is |
|---|---|---|
| `types.ndjson` | `TypesWriter` | a declared type, with its supertypes, annotations and position |
| `members.ndjson` | `MembersWriter` | a field, method, constructor, enum constant or record component; executables carry their body facts and `returned` |
| `calls.ndjson` | `CallsWriter` | a call site, method reference or `new`, with its receiver, targets and arguments |
| `fields.ndjson` | `FieldsWriter` | a read or write of a field inside a body |
| `files.ndjson` | `FilesWriter` | an input file, with its package, imports and problems |
| `library.ndjson` | `LibraryWriter` | a shallow row for a classpath type the project names |
| `meta.json` | `MetaWriter` | the contract, the classpath digest, the counts and the failure counters |

`returned` has no file of its own. `MembersWriter` writes it onto each executable's row from `Returns.plan`.

## Conventions

`CONTRACT.md` is the contract. It lists the keys of each row kind, the order of every section, the origins, and the
failure counters, and `contract/` holds the same shapes as JSON Schemas. The conventions are checked by
`DumpConventionsTest` on a fixture that writes every row kind, and every row of the fixtures by `ContractSchemaTest`. A
change to a key or an order is a change to the contract and its schema, and a contract bump when the shape changes.

Within the code, each concept has one owner: `Names` for every spelling of a type or a member, `Failures.Key` for every
failure name, `Json` for every JSON shape, `Positions` for every source position. A second implementation of one of
these is a bug to merge.

## Adding a new fact

1. Decide the layer. A fact about what Spoon's model says goes in `model`. A judgement about a reference goes in
   `resolve`. A new key in a row goes in the writer for that file.
2. Write a failing JUnit test first, in the package of the class it exercises. Use `DumpRun` to dump a few sources
   and assert on the rows.
3. Check Spoon's real behaviour, not memory. The signatures are in the jar and the sources are in the sources jar (see
   `SPOON.md`). If the behaviour was a surprise, add an entry to `SPOON.md`.
4. Implement it in the owning class, with a failure counter if the engine answers empty rather than failing.
5. Add the key to `CONTRACT.md` and its schema in `contract/`. A key that changes shape bumps `Contract.CONTRACT`.
6. Run the module tests and check what the dump of the fixture changed.

## Build and test

- Build and test: `mvn -q -f engine-java/pom.xml package`. This needs JDK 17 or later and Maven. It writes
  `engine-java/target/mindmodel-engine.jar` and runs the JUnit tests.
- One test class: `mvn -f engine-java/pom.xml test -Dtest=ReceiverTypesTest`.
- The contract: `ContractSchemaTest` validates every row of the fixtures against `contract/`, and
  `MachineIndependenceTest` checks that one input dumped at two locations gives identical bytes.
- Layer check: list each `import mindmodel.engine.<pkg>.` line per file and confirm no class imports a higher layer.
- The tests write their sources into temporary folders. They never touch the test apps.
