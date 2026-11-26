# Dump contract

The dump is what the Java engine (`engine-java/`, Spoon 11.5.0) writes from source alone: one ndjson file per section and
a `meta.json`. This document is the contract, at **contract 8**. The JSON Schemas in `contract/` are its machine-readable
form: a row that does not validate against its schema is a bug in the engine or in the schema, and the JUnit test
`ContractSchemaTest` checks every row of the fixtures against them. A consumer reads `meta.json` `contract` first and
refuses any other number.

## Command line

```
mindmodel-engine --version
mindmodel-engine --help
mindmodel-engine dump [--contract N] [--compliance L] [--classpath FILE] [--generated FILE] <root> <file-list> <out-dir>
```

- `--version` prints `mindmodel-engine <version> contract <contract>`, for example `mindmodel-engine 0.7.0 contract 8`.
  The version is the one in `engine-java/pom.xml`, filtered into the jar at build time.
- `--help` prints the usage.
- `dump` writes the dump into `<out-dir>`, which is created. Files of the same names are replaced.
  - `<root>` is the checkout's directory. Paths in the other arguments are relative to it.
  - `<file-list>` names one file per line. Lines that are not `.java` files under `<root>` are ignored.
  - `--contract N` names the contract the caller reads. An engine that speaks another number refuses the run.
  - `--compliance L` is the Java level the sources are read at. Without it, `MINDMODEL_COMPLIANCE` applies when set to two
    digits, else 17.
  - `--classpath FILE` names one jar or class folder per line, in build order. A classpath Spoon cannot read is dropped,
    and the drop is recorded in `meta.json`.
  - `--generated FILE` names annotation-processor output folders, relative to `<root>`. They are read for resolution and
    never written.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success, or `--version` or `--help`. |
| 1 | A failed run: an input could not be read or the dump stopped with an error. `<out-dir>` may hold a partial dump, which a consumer must not read. |
| 2 | A usage error: missing or malformed arguments, a non-numeric value, or a `--contract` number the engine does not speak. |

Any other status is the JVM's own (for example, a kill by the operating system).

## Output

```
<out-dir>/
  meta.json      contract, engine, engineVersion, compliance, classpath, counts        meta.schema.json
  files.ndjson   one row per input file                                                files.schema.json
  types.ndjson   one row per declared type                                             types.schema.json
  members.ndjson one row per field, enum constant, record component, method, ctor      members.schema.json
  calls.ndjson   one row per call site, method reference or new                        calls.schema.json
  fields.ndjson  one row per field read or write inside a body                         fields.schema.json
  library.ndjson one shallow row per classpath type the checkout names                 library.schema.json
```

`returned` has no file: each method or constructor row carries its entries, each checked by `returns.schema.json`.
`common.schema.json` holds the shapes the others share: positions, folded values, annotations, supertypes, expressions
and modifiers. Every schema is draft 2020-12, and every object forbids keys it does not name.

## Guarantees

1. **Complete for the checkout.** Every type, field, method, constructor, enum constant and record component declared in
   a scanned file appears, with its position. Every call site Spoon can see appears.
2. **Sound.** A target id appears only if that declaration is in the dump, or Lombok would generate it. An annotation
   argument appears only if Spoon could evaluate it to a literal. Anything uncertain is `origin: "unresolved"` with a
   `reason`, never a plausible answer.
3. **Deterministic.** Two runs over the same files give byte-identical output. Input file order does not matter.
   **Machine-independent:** the same inputs at any absolute location, under any folder name, give byte-identical output.
   No row or `meta.json` holds a timestamp, a user name, a host name or an absolute path (see Paths and messages).
   Every row is one line of JSON: a value JSON cannot hold (NaN, an infinity) is `unresolved`, and an unpaired UTF-16
   surrogate in a string is written as its `\uXXXX` escape, so no row can stop the file from being written.
4. **Honest provenance.** Every answer carries an origin (see Origins).

A file Spoon cannot parse does not abort the run. It appears in `files.ndjson` with `errors[]`, its types are absent, and
`meta.json` `counts.failedFiles` says how many.

## Conventions

These hold in every section. `ContractSchemaTest` and `DumpConventionsTest` check them on fixtures that write every row
kind.

**Unknown is null.** A value the dump cannot give is `null`: a type with no name, a name that could not be read, a line
that is not known. A string is never empty, and no sentinel stands in for unknown (`0`, `-1`, `"?"`, `"unknown"`).

**Keys of a row kind.** A key a row kind carries is always written, whatever its value:

- a scalar is its value or `null`;
- an array is written even when empty (`[]`);
- a boolean is `true` or `false`; the exception is a field row's `static`, which is `null` when unknown (see Rules).

A key only some rows of a kind carry is absent on the others. It is never written as `null`, so a reader tests for
presence. These are the optional keys: `reason` (on a row Spoon could not answer, or whose call has no target), `via`
(on a method reference), `guard` (an arm with a `when`), `target` (a switch that assigns a local), `value` on an
expression (a literal or constant, see Rules), `field`, `call`, `from`, `index`, `created`, `then`, `otherwise` on an
expression, `inLambda` on a parameter, `value` on a constant member, `generated` and `generatedBy` (a generated member
only), `finallyLine` and `finallyEndLine` (a try with a finalizer), `importsReason` (an unreadable header).

Members, by kind:

- `field`: kind, owner, name, type, typeFqn, modifiers, ann, pos; optional value, generated, generatedBy.
- `enumConstant`: kind, owner, name, ann, pos, args.
- `recordComponent`: kind, owner, name, type, typeFqn, ann, pos.
- `method` and `constructor`: kind, owner, name, params, id, modifiers, hasBody, anonymous, throws, ann, loops,
  branches, tryBlocks, returned, pos; a method also has returns and isMain, a constructor has neither. Generated ones
  add generated and generatedBy. A row with no body has the body arrays empty.

**Arrays are written, never absent.** `typeArgs`, `targets`, `args`, `ann`, `throws`, `modifiers`, `params`, `imports`,
`errors`, `supers`, `fields`, `methods`, `supertypes`, `typeParams`, `loops`, `branches`, `tryBlocks`, `returned`,
`labels`, `arms` are `[]` when there is nothing in them.

**Type names.** `type` is a type as written: Java's spelling with its generic arguments, from `Names.typeText`.
`typeFqn` is its join key: the dotted name, or `null` when the dump cannot name it (a type variable, a type Spoon
invented, no type). `returns` and a parameter's `type` and `throws` are signature text and carry no join key. A field,
a record component, a supertype, an expression, a receiver and a type argument carry `typeFqn`. A supertype reads
`{kind, type, typeFqn}` in types.ndjson and library.ndjson alike, where `kind` is the relation (`class` or `interface`).

**Position.** Columns are 1-based character offsets in the line, a tab counting as one. A declaration (type, member)
carries `pos` `{file, line, col, endLine, endCol}`, or `null`. A call carries `file`, `line` and `col` at its method
name's token (for `a.b().c()`, the `c`), not at the chain's first token. A method reference or a field access carries its
own first token. A line range (loops, branches, try blocks) is `line` and `endLine`, inclusive, and an annotation's
`line` is the line it is written on.

**Kind.** Every row of calls, fields, types, members and library has `kind`, the kind of that row: a call is `call`,
`methodRef` or `new`; a field access is `access`; a declaration is its declaration kind; a library type is its type kind.
An expression's `kind` is what the expression is (see Rules).

**Error rows.** A row Spoon could not answer has the keys of a readable row of its section, with its unknown values null
and its arrays empty; `origin` is `error` and `reason` is `ExceptionClass: message`. A call error keeps its `kind`,
`name` (`<init>` for a `new`) and position, and its `recv` has every key with null or empty values. A file error is
`{kind, reason, line}`.

**Order.** Every section is sorted by a stated key, and every array inside a row in a stated order. Nothing here takes
its order from a hash map or set.

- types.ndjson: by file, line, column, then fqn.
- members.ndjson: by owner in types.ndjson order; within an owner by position (a row with none last), then kind, name, id.
- calls.ndjson: grouped by body, in declaration order (the constructors and methods of the type as it declares them,
  then `<clinit>`, then `<init>`); within a body in source order. A body's calls are one block.
- fields.ndjson: by file, line, column, op, then field (a null field first).
- library.ndjson: by fqn. A type's fields by name; its methods by name, then parameter types; its supers in declaration order.
- files.ndjson: by path. Imports by name, then non-wildcard before wildcard, then non-static before static.
- returned: by line, then column. `targets`: the declaration, then each override by subtype name.
- Other arrays: source or declaration order (`typeParams`, `supertypes`, `ann`, `labels`, `arms`, `params`, `typeArgs`,
  `args`). `modifiers` sorted by Java's spelling. Annotation arguments sorted by element name. The failure keys in
  meta.json `counts` sorted by key.

## Rules

- `fqn` is dot-nested (`a.Outer.Inner`), never `$`.
- A method id is `fqn#name(paramTypes)`. Parameter types are joined by `,` with no space between them. Each type is
  written as Java writes it, so generic arguments keep their `, ` (`put(Map<K, V>)`), and `String...` is `String[]`.
- Type text is spaced as Java spaces it: one space after each comma, and none elsewhere.
- A constructor is named after its type: `demo.Foo#Foo(String)`.
- Initialisers have pseudo-member owners: `T#<clinit>()` for static field initialisers and static blocks, and
  `T#<init>()` for instance ones. The calls and field accesses in them are rows of that owner.
- A type the dump cannot name (a missing import that Spoon invented, or one it could not read) has `typeFqn` null and
  keeps its written text in `type` or `text`. Each place that happens counts once under `refs.typeUnresolved`; that
  includes a supertype, which is judged the same way.
- `typeArgs` entries are a type argument's join key (the dotted name), a type variable's letter, or a wildcard as written
  (`?`, `? extends X`, with X's join key). A type argument the dump cannot name is `null`, and the array keeps the
  position of every argument.
- A call's `id` is `<owning method>@<line>:<col>`, with `~2`, `~3` on later sites that start on the same token. An
  argument that is a call names its row by this id.
- `pos` is `{file, line, col, endLine, endCol}` and starts at the element's own first token. A call's `pos` starts at
  its method name instead (see Position).
- Annotation arguments are typed values: `args` maps each element name to `{kind, value}`, sorted by name, carried on the
  annotation. A folded value (a literal or constant expression's `value`, a constant member's `value`) has that same
  `{kind, value}` shape. A value's kinds are `string`, `bool`, `char`, `int`, `double`, `float`, `null`, `array`,
  `annotation`, `class`, `enum` and `unresolved`.
- `recv.kind` is `static`, `super`, `implicit` (this or outer), or `instance`. `recv.how` says how the receiver was
  reached: `static`, `super`, `this`, `implicit`, `field`, `param`, `lambda`, `local`, `chain`, `new` or `expr`.
  `recv.typeFqn` is the static type's join key, and `recv.typeArgs` gives the type arguments the declared type is written
  with. A type variable is never a receiver type: a member declared as `Value` of a `Cache<Foo>` target has `Foo`; a raw
  or unbound target, or a method's own type parameter, has none.
- A constructor call (`new X(..)`) is a call row with `name: "<init>"`, `recv.how: "new"` and `recv.kind: "instance"`.
  Its targets are the constructor it reaches: a declared one, or the Lombok constructor of that arity.
- A call's `targets[]` has `kind: "declared"` (the member Spoon resolved) and `kind: "override"` (each implementation in
  a subtype the receiver's type can reach: the receiver's own type and its subtypes). A sibling branch's override is not
  a target of a call on the receiver. A receiver the checkout does not place under the declaring type keeps every
  subtype. `uniqueImpl` is true only when the declaration has no body and exactly one override. Which targets a reader
  follows is the reader's policy, not the dump's.
- A field write's value is typed like an argument. A compound write (`+=` and the like) stores the old value combined
  with the right-hand side, so its value is `unresolved` with `reason: "compound-assignment"` and the whole assignment as
  its `text`. A write to a field whose declaration is outside the dump has `reason: "declaration-outside-dump"` on the
  value.
- A field row's `static` is `true` or `false` when the dump can tell, and `null` when it cannot. It is static for
  `Type.field`, for a declared field with the modifiers it declares, for a JDK field read from the JVM, for a Lombok
  logger field (`log`) of an enclosing type, for a static import of the name, and for a case label naming an enum
  constant the checkout declares. An array's `length` is an instance field (`false`). A static import does not decide
  the name when an enclosing type inherits from a type the checkout does not declare, since that type may declare the
  name. Any other access with no declaration (a receiver outside the checkout, a bare name nothing declares, a method
  reference whose qualifier is a type Spoon reads as a field) is `null`, and counts in `fields.modifiersUnreadable`.
- A class literal (`X.class`) is no field access: it has no `fields.ndjson` row. As an expression it is kind `other`.
- A method reference's qualifier that names a type writes no `fields.ndjson` row: an imported type, a nested type of a
  checkout type, or the Lombok builder of one (`X.XBuilder::build`). A qualifier that may be an inherited field of a
  library superclass is left a field row, unknown.
- A variable read names its declaration's type: a parameter's or a local's written type, also inside a lambda (where
  Spoon can leave the read untyped). An import names the type without a classpath.
- A method reference Spoon cannot type (an overloaded name with no library signature) has no target, unless it is the
  argument of a call on a generic receiver with one type argument (`page.map(mapper::toDto)` on a `Page<Booking>`): then
  the qualifier's overload of that name whose one parameter is that type is the target, `origin: "java"`. Several such
  overloads, or none, leave it unresolved. A name with one Lombok getter on the qualifier's type is that getter, with
  `origin: "lombok"` (`Booking::getId`).
- A catch parameter reads as kind `local` (with no `from`: its value is the thrown exception, not an expression).
- A parameter's `inLambda` says whether it is a lambda's parameter, and only a parameter carries it.
- `library.ndjson`: a field whose type is a type variable has `typeFqn: null`; modifiers are Java's spelling. A class
  file keeps no parameter names the dump may give, so a library parameter's `name` is null.
- A type-pattern or record-pattern case label has no source position in Spoon, so its text is built from its parts:
  `String s`, `Pair(String l, int r)`. A guard is `guard`, and `case null, default` has the one label `null`.
- A constant is a constant variable (JLS 4.12.4): a final primitive or `String`, static or not, every interface field
  included. Its value is folded with Java's arithmetic (int and long wrap, float stays float, a double wins over a
  float). A value that folds to NaN or an infinity is `unresolved`.
- `text` is the source as written, cut at 80 code points, never mid-pair, and without the `;` that ends an arrow arm.
- Generated sources (annotation-processor output) take part in resolution, so a call into a generated mapper is typed.
  They have no rows.

## Origins

The `origin` of a call row, a field row, a library row and an import header says what kind of answer it is. A field
row's origin is `java` when the field is declared in this checkout, `unresolved` when Spoon could not name its owner, and
`error` when it could not describe the access.

- `java`: a declaration in this checkout that Spoon matched.
- `arity`: a member in this checkout found by name and argument count, because Spoon could not pick an overload. Only
  a lookup that finds exactly one member answers.
- `lombok`: a member Lombok would generate (`generated: "lombok"` in members.ndjson).
- `compiler`: an enum's `values()` or `valueOf(String)`, which javac writes (`generated: "compiler"`).
- `library`: a type or member outside the checkout, with no declaration here. A call on a project type that names a
  method no project type declares, where a supertype is outside the checkout, is a library call with
  `reason: "library-signature"`. An unqualified call to a name no enclosing type declares, that the file statically
  imports from a library type (a single import of the name, or an on-demand import of the type), is a library call the
  same way.
- `unresolved`: the dump could not answer. `reason` says why.
- `error`: Spoon threw while typing the site. `reason` carries the exception.

## Lombok

Lombok is handled after parsing, not by changing Spoon's model (`Lombok.java`). For each type with a Lombok annotation,
the members Lombok would generate are synthesised: accessors, the three constructors, `@ToString`, `@EqualsAndHashCode`,
builders and the logger field. A synthesised member keeps the annotated element's `pos` and is marked
`generated: "lombok"`. An unresolved call is matched to a synthesised member on its receiver by name and arity, and the
call gets `origin: "lombok"`.

A `new` of a class with generated constructors targets the generated constructor of that arity. Spoon also invents a
default constructor for a class that writes none. That one answers only a call with no arguments, and only for a class
Lombok writes no constructor for. A call with arguments is never answered by it. A record's canonical constructor is not
that default, and its own declaration always answers.

The builder class is `<Type>Builder`, nested in the type it builds; `@Builder(builderClassName = "X")` names it `X`. A
chain on the builder is typed as that class.

An enum's `values()` and `valueOf(String)` are the compiler's. They are synthesised with `generated: "compiler"` and
their calls have `origin: "compiler"`. `name()` and `ordinal()` are inherited from `java.lang.Enum`: a call to one of
Enum's public methods on a project enum has no target (no declaration is in the checkout) and `origin: "library"`.

Not covered: `@Accessors` renaming, fluent accessors, `@NonNull` behaviour, the `@SuperBuilder` chain across a hierarchy,
and the all-arguments constructor `@Builder` writes when the class has no other constructor. A call to that constructor
stays unresolved with a reason.

## Returns

A method or constructor row always carries `returned`, the values its body hands back, in source order (`[]` when it
hands back nothing it chose). Each entry is a `return` with its `value`, or a `switch` with `form` (`expression` or
`statement`), its `on` selector, an optional `target` (the local the switch assigns), and `arms`. Each arm has its
`labels` (empty for `default`), its `value`, `default` (true for a `default` arm and for `case null, default`, whose
labels then hold only the null) and `guard` (the `when` text, when there is one). An arm's value is the first of its own
yield (the yield of its nearest switch expression), its return, or its assignment to the target local. A switch nested
inside an arm answers for itself, not for the arm that contains it.

## Paths and messages

No output names a host. Paths are relative to `<root>`: `file`, `path`, and the file of every `pos`. An exception message
that a reason or `dropped` carries has each absolute path replaced by `<path>`, so a reason says what failed and not where
the checkout or a jar lives. Known limit: a path with a space in it keeps the part after the space. A classpath entry is named in the digest by its file name and size, never its path.

## meta.json

- `contract`: the contract number (8).
- `engine`: the parser, `spoon-<version>`.
- `engineVersion`: the engine's version, as `--version` prints it.
- `compliance`: the Java level the sources were read at.
- `classpath`: `entries` (the classpath lines read), `sha256` (over each entry's file name and size, in order),
  `generatedDirs`, `generatedFiles` (read for resolution, never written), `libraryTypes`, and `dropped` when a classpath
  was dropped: the message of the failure that dropped it.
- `counts`: `files`, `types`, `fields`, `methods`, `failedFiles`, and one key per failure counter that is non-zero.

A clean run has no failure counter. The counters are:

- `types.duplicateFqn`: two input files declare the same name. The first file in sorted order keeps it, and the other
  declaration is dropped. Known gap: Spoon keeps one declaration by checkout path, not by this order (see SPOON.md).
- `refs.typeUnresolved`: a type reference the dump could not name (see Rules).
- `refs.typeArgsUnresolved`: a type's arguments could not be read, so it lists none.
- `refs.textUnresolved`: an expression's source text could not be read, so its `text` is null.
- `chains.typeUnresolved`: a receiver's classpath type could not be read, so the chain has no type.
- `sites.bindingsUnresolved`: a supertype's type arguments could not be bound, so its parameters stay open.
- `sites.nameUnresolved`: an error row's call name could not be read, so the row's `name` is null.
- `returns.unreadable`: a body's returns could not be read, so its member's `returned` is `[]`.
- `fields.modifiersUnreadable`: a field access's `static` could not be decided from its declaration or the source, so it is
  `null`. Each one is a field the dump cannot name, or a receiver outside the checkout.
- `files.importsUnreadable`: a file's imports could not be read, so its `importsOrigin` is `unresolved`.

## Changing the contract

A key that changes shape bumps the contract number in `Contract.java`, and the schema in `contract/` changes with it (its
`contract` constant is 8 for now). The schemas, this document and the writers must agree: a change to one is a change to
all three, and `ContractSchemaTest` fails until they do.
