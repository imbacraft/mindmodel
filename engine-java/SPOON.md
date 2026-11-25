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
- `CtCase.getIncludesDefault()` marks `case null, default`; `getGuard()` holds a `when` guard.
- Spoon keeps only the first declaration of a duplicate FQN, silently. The engine counts `types.duplicateFqn`.

## Output safety
- JSON cannot hold `NaN` or `Infinity`; write such a value as unresolved.
- Strings may hold lone surrogates (escapes, or text clipped mid-character). Clip on code points, and make sure
  the writer cannot throw on unpaired surrogates.
