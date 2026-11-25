# Working with Spoon 11.5.0

Read this before changing the engine. It lists the Spoon behaviour this engine depends on and the traps that have
already caused bugs. Add an entry whenever a bug turns out to be a Spoon surprise.

## Ground truth
- Do not trust memory of the Spoon API. Check the exact version:
  - Signatures: `javap -cp ~/.m2/repository/fr/inria/gforge/spoon/spoon-core/11.5.0/spoon-core-11.5.0.jar <class>`.
  - Source: the sources jar next to it (`spoon-core-11.5.0-sources.jar`); read a class with
    `unzip -p <sources jar> spoon/reflect/code/CtCase.java`.
- Prove behaviour with a JUnit test in `src/test/java/mindmodel/engine/dump/` (use `DumpRun`), not by reasoning.

## Mode
- The engine runs Spoon in noclasspath mode, with optional dependency jars. Unresolved references are normal: a
  reference can exist while `getDeclaration()` is null. Never invent a type or target for it; write it as unresolved
  (fqn null, written text kept) and count it in `Failures`.

## Type hierarchy traps
- `CtWildcardReference` extends `CtTypeParameterReference`. Check for the wildcard first, or its bounds are lost.
- `CtOperatorAssignment` (`+=`, `-=`, ...) extends `CtAssignment`. `getAssignment()` is only the right-hand side.
- `CtCatchVariable` is not a `CtParameter`, `CtLocalVariable` or `CtField`. Handle it on its own.
- Type parameters (`T`, `Value`, `Entity`) are `CtTypeParameterReference`. They are never receiver types.
- A generic member's `getType()` is the declared type variable, not the bound argument: `c.get("a")` on a `Cache<Foo>`
  is typed `Value`. Bind it from the target's `getActualTypeArguments()` at the same position.
- A catch parameter read is a `CtVariableRead` whose declaration is a `CtCatchVariable` (not a local, not a parameter).

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
- Spoon keeps only the first declaration of a duplicate FQN, silently. The engine counts `types.duplicateFqn`.
- A type or record pattern case label (`case String s`, `case Pair(String l, int r)`) is a `CtCasePattern` wrapping the
  `CtTypePattern` or `CtRecordPattern`; the pattern has no source position, so its text is built from its parts.
- `case null, default` is `getIncludesDefault()` true, and `getCaseExpressions()` holds only `null`. A `when` guard is
  `getGuard()`. A type pattern label has no source position: see the `CtCasePattern` entry below.
- An arrow arm's expression position runs on through the `;` that ends the arm: its source text is `compute();`.
- `X.class` is a `CtFieldRead` of a field named `class`, not a field: no Java field has that name.
- The implicit canonical constructor of a record carries its component types as written in the header
  (`java.lang.String`), while the author's constructor may write `String`: compare resolved names.

## Output safety
- JSON cannot hold `NaN` or `Infinity`; write such a value as unresolved.
- Strings may hold lone surrogates (escapes, or text clipped mid-character). Clip on code points, and make sure
  the writer cannot throw on unpaired surrogates.
