# Working with Spoon 11.5.0

Read this before changing the engine. It lists the Spoon behaviour this engine depends on and the traps that have
already caused bugs. Add an entry whenever a bug turns out to be a Spoon surprise.

## Ground truth
- Do not trust memory of the Spoon API. Check the exact version:
  - Signatures: `javap -cp ~/.m2/repository/fr/inria/gforge/spoon/spoon-core/11.5.0/spoon-core-11.5.0.jar <class>`.
  - Source: the sources jar next to it (`spoon-core-11.5.0-sources.jar`); read a class with
    `unzip -p <sources jar> spoon/reflect/code/CtCase.java`.
- Prove behaviour with a JUnit test in `src/test/java/mindmodel/engine/` (the package of the class it exercises, using
  `DumpRun`), not by reasoning.

## Mode
- The engine runs Spoon in noclasspath mode, with optional dependency jars. Unresolved references are normal: a
  reference can exist while `getDeclaration()` is null. Never invent a type or target for it; write it as unresolved
  (fqn null, written text kept) and count it in `Failures`.

## Type hierarchy traps
- `CtWildcardReference` extends `CtTypeParameterReference`. Check for the wildcard first, or its bounds are lost.
- `CtSuperAccess` and `CtThisAccess` extend `CtVariableRead`. Exclude them before treating a read as a name.
- `CtOperatorAssignment` (`+=`, `-=`, ...) extends `CtAssignment`. `getAssignment()` is only the right-hand side.
- `CtCatchVariable` is not a `CtParameter`, `CtLocalVariable` or `CtField`. Handle it on its own.
- Type parameters (`T`, `Value`, `Entity`) are `CtTypeParameterReference`. They are never receiver types.
- A generic member's `getType()` is the declared type variable, not the bound argument: `c.get("a")` on a `Cache<Foo>`
  is typed `Value`. Bind it from the target's `getActualTypeArguments()` at the same position.
- A catch parameter read is a `CtVariableRead` whose declaration is a `CtCatchVariable` (not a local, not a parameter).

## Undeclared names
- An undeclared name (`mystery.call()`, `mystery::call`) is a read whose variable has no declaration and no declaring
  type. Spoon types the read, and the executable reference, as the class the name is written in. That is a guess about
  the receiver, so the engine treats the name as unresolved (`Chains.undeclaredName`, `ReceiverTypesTest`).
- An inherited library field that Spoon cannot see still has a declaring type. That is how it differs from an undeclared
  name: a read with no declaring type is the only case the rule above applies to.

- A class with no `extends` has no superclass reference in noclasspath mode: `getSuperclass()` is null, and `Object`
  is never a written supertype. The library rule in `Calls.inheritsFromLibrary` relies on that
  (`InheritedLibraryCallsTest`).

## Constructors
- `new Base(7) { ... }` and an enum constant with a body create an anonymous class. The call's executable is that
  class's implicit constructor, which is not in the checkout's index. The call reaches the superclass constructor of the
  same arity (`ConstructorTargetsTest`).
- Spoon invents a default constructor for every class that writes none, Lombok annotated or not. Java writes a default
  only when a class has no constructor, and a Lombok constructor counts as one. The dump writes Spoon's invention only
  when Lombok writes no constructor for the type (`LombokTest`).

## Names
- `getQualifiedName()` spells nested types `pkg.Outer$Inner`. The dump spells them dotted (`pkg.Outer.Inner`), so
  every type name goes through `Names`.
- Type text uses Java spelling with single spaces (`Map<K, V>`, `? extends T`), produced by `Names` only.
- `ModifierKind.toString()` gives Java spelling (`non-sealed`). Never use `name().toLowerCase()`; it is
  locale-dependent and spells `non_sealed`.

## Traversal
- `getElements(filter)` is deep: it descends into nested classes, lambdas, anonymous classes and nested switch
  expressions. Filter by the nearest enclosing executable or switch when ownership matters.
- Each body is walked once per run (`Walk`). Do not add per-member `getElements` scans.
- Calls also live outside methods: field initializers, initializer blocks and enum-constant arguments. Their owners
  are `T#<clinit>()` (static) and `T#<init>()` (instance).
- An anonymous class body belongs to its enclosing member for calls and field accesses.

## Semantics
- Overrides: use `CtMethod.isOverriding(...)`, not name and arity.
- Constants (JLS 4.12.4): a `final` variable of primitive or String type with a constant initializer, static or not.
  Fold with Java semantics: integer division, int and long overflow, float stays float.
- Spoon keeps only one declaration of a duplicate FQN, silently. The engine counts `types.duplicateFqn`. Which one it
  keeps depends on the checkout path string, not on the file list order (`DuplicateTypesTest` does not pin it). The
  dump-spec's "first file in sorted order keeps it" is not what Spoon does; this is an open issue.
- A type or record pattern case label (`case String s`, `case Pair(String l, int r)`) is a `CtCasePattern` wrapping the
  `CtTypePattern` or `CtRecordPattern`; the pattern has no source position, so its text is built from its parts.
- `case null, default` is `getIncludesDefault()` true, and `getCaseExpressions()` holds only `null`. A `when` guard is
  `getGuard()`. A type pattern label has no source position: see the `CtCasePattern` entry below.
- An arrow arm's expression position runs on through the `;` that ends the arm: its source text is `compute();`.
- `X.class` is a `CtFieldRead` of a field named `class`, not a field: no Java field has that name.
- A parameter or local read inside a lambda whose target type is not on the classpath can have a null `getType()`,
  while its declaration (`CtParameter`, `CtLocalVariable`) keeps the written type. `Chains.typeOf` reads the
  declaration's type.
- A method reference to a name with one member in the checkout resolves. With several overloads and no library
  signature to choose by, it does not: the declaration is null and `getParameters()` is empty (arity 0), so the arity
  says nothing. The dump gives such a reference no target, and does not guess one.
- The implicit canonical constructor of a record carries its component types as written in the header
  (`java.lang.String`), while the author's constructor may write `String`: compare resolved names.

## Positions
- An invocation starts at its target: `a.b().c()` is one element that starts at `a`, and the method name's token has no
  position of its own. `Positions.ofCall` reads the name from the source: the identifier before the last top-level `(`
  of the span, which is the call's own argument list. Strings, characters, comments and brackets are skipped.
- Spoon's column (`SourcePositionImpl.searchColumnNumber`) is not what the dump writes. It is 0-based on the first
  line, and on the last line a tab counts as the tabulation size (4). `Positions` reads each column from the source
  text: 1-based characters, a tab one. Spoon's line is used as it is.
- A declaration's Spoon line and column are its name's start, not its first token: annotations and modifiers come
  before it (`CompoundSourcePosition.getNameStart`). `Positions` starts a declaration at its name, as Spoon does.
- An unqualified call's receiver is an implicit `this` (`CtThisAccess.isImplicit()`), not a null target.
- Spoon's import list leaves an import of a type not on the classpath `UNRESOLVED` with a null reference, so the static
  imports of a file are read from its header (`Imports.staticImports`).
- `SourcePositionImpl` has a public constructor, `new SourcePositionImpl(unit, start, end,
  unit.getLineSeparatorPositions())`: it gives Spoon's line for any offset of the unit, the only way to get one for a
  sub-range.

## Output safety
- JSON cannot hold `NaN` or `Infinity`; write such a value as unresolved.
- Strings may hold lone surrogates (escapes, or text clipped mid-character). Clip on code points, and make sure
  the writer cannot throw on unpaired surrogates.
