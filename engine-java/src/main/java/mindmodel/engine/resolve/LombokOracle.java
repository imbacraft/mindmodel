package mindmodel.engine.resolve;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtModifiable;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeMember;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtTypeReference;

import mindmodel.engine.model.Delombok;
import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Names;
import mindmodel.engine.model.Positions;
import mindmodel.engine.model.SourceModel;
import mindmodel.engine.model.SourceText;

/**
 * The members Lombok generates, read from delombok's output rather than guessed from the annotations. A member the
 * delomboked source has and the written source lacks is Lombok's: its name, parameters, return type, modifiers and
 * position come from the delomboked declaration, and the annotation that produced it is derived from the annotations
 * the written type carries. The written types keep their ids and positions; only the generated members are added.
 *
 * <p>The run is {@link #run}: the Lombok-using files only, through {@link Delombok}. When it cannot run, the outcome
 * says why, and the hand-written rules in {@link Lombok} answer.
 */
public final class LombokOracle {

    /**
     * What delombok decided. {@code generated} is null when the hand-written rules answer; {@code mode} is {@code
     * delombok}, {@code hand} (delombok could not answer: {@code reason} says why) or {@code none} (no file uses
     * Lombok).
     */
    public record Outcome(Map<String, List<Lombok.Item>> generated, String mode, String reason, int files) {
    }

    /** Where a generated member is written from: the annotation that produced it, and the element it is placed at. */
    private record Source(String from, CtElement at) {
    }

    /** One type's context: the written type its members are placed on, and the names its generated classes go by. */
    private record Scope(CtType<?> annotated, Map<String, String> nested, Positions positions, Failures failures) {
    }

    private LombokOracle() {
    }

    /**
     * Runs delombok over the inputs that mention Lombok and reads the members it generated. A failed run is a hand
     * outcome with its reason, never an exception: the dump answers either way.
     *
     * @param jar the Lombok jar, or null when none was given
     * @param classpath the project's dependency entries, which delombok resolves against
     */
    public static Outcome run(Path root, List<String> inputs, Path jar, List<String> classpath, int compliance,
            List<CtType<?>> types, Positions positions, Failures failures) {
        List<String> using = lombokFiles(root, inputs);
        if (using.isEmpty()) return new Outcome(null, "none", null, 0);
        if (jar == null) return hand(using.size(), "no --lombok jar: the hand-written rules answer");
        try (Delombok delombok = Delombok.run(root, using, jar, classpath)) {
            if (delombok.error() != null) return hand(using.size(), delombok.error());
            SourceModel model = SourceModel.build(delombok.out(), using, compliance, List.of(), List.of());
            return new Outcome(generated(types, model, positions, failures), "delombok", null, using.size());
        } catch (IOException | RuntimeException e) {
            return hand(using.size(), Failures.reason(e));
        }
    }

    private static Outcome hand(int files, String reason) {
        return new Outcome(null, "hand", Failures.scrub(reason), files);
    }

    /** The inputs whose text mentions Lombok: the only files Lombok can write members into. */
    static List<String> lombokFiles(Path root, List<String> inputs) {
        List<String> out = new ArrayList<>();
        for (String rel : inputs) {
            String text = SourceText.read(root.resolve(rel));
            if (text != null && text.contains("lombok")) out.add(rel);
        }
        return out;
    }

    /**
     * The generated members of each written type, by the type's name. A member of the delomboked type that the written
     * type lacks by name and parameters is generated; so is every member of a class delombok adds beside the type (a
     * builder), which the written type keeps under its own name.
     */
    public static Map<String, List<Lombok.Item>> generated(List<CtType<?>> types, SourceModel delombok,
            Positions positions, Failures failures) {
        Map<String, CtType<?>> after = new HashMap<>();
        for (CtType<?> t : delombok.allTypes()) after.putIfAbsent(Names.qualified(t), t);
        Map<String, List<Lombok.Item>> out = new LinkedHashMap<>();
        for (CtType<?> original : types) {
            String owner = Names.qualified(original);
            CtType<?> written = after.get(owner);
            if (written == null || original instanceof CtRecord || written instanceof CtRecord) continue;
            Scope scope = new Scope(original, nestedNames(written, original), positions, failures);
            List<Lombok.Item> items = new ArrayList<>();
            Set<String> have = new HashSet<>();
            for (CtElement member : members(original)) have.add(keyOf(member));
            addMembers(written, owner, have, false, scope, items);
            Set<String> knownNested = new HashSet<>();
            for (CtType<?> nested : original.getNestedTypes()) knownNested.add(Names.qualified(nested));
            for (CtType<?> nested : written.getNestedTypes())
                if (!knownNested.contains(Names.qualified(nested))) addGeneratedType(nested, scope, items);
            if (!items.isEmpty()) out.put(owner, items);
        }
        return out;
    }

    /** A class delombok adds beside its type: every member is Lombok's, and so is every class it nests. */
    private static void addGeneratedType(CtType<?> generated, Scope scope, List<Lombok.Item> items) {
        addMembers(generated, Names.qualified(generated), Set.of(), true, scope, items);
        for (CtType<?> inner : generated.getNestedTypes()) addGeneratedType(inner, scope, items);
    }

    /** The members of {@code written} whose key {@code have} does not hold, each as a generated item. */
    private static void addMembers(CtType<?> written, String owner, Set<String> have, boolean nestedBuilder,
            Scope scope, List<Lombok.Item> items) {
        for (CtElement member : members(written))
            if (!have.contains(keyOf(member))) items.add(item(member, written, owner, nestedBuilder, scope));
    }

    /** The generated classes a written type gets, by the names a return type writes them with. */
    private static Map<String, String> nestedNames(CtType<?> written, CtType<?> original) {
        Set<String> known = new HashSet<>();
        for (CtType<?> nested : original.getNestedTypes()) known.add(Names.qualified(nested));
        Map<String, String> out = new HashMap<>();
        for (CtType<?> nested : written.getNestedTypes()) {
            String fqn = Names.qualified(nested);
            if (known.contains(fqn)) continue;
            out.put(nested.getSimpleName(), fqn);
            out.put(written.getSimpleName() + "." + nested.getSimpleName(), fqn);
        }
        return out;
    }

    /** The members a type declares, minus the ones the compiler adds on its own (Spoon's implicit ones). */
    private static List<CtElement> members(CtType<?> type) {
        List<CtElement> out = new ArrayList<>();
        for (CtField<?> field : type.getFields()) if (!field.isImplicit()) out.add(field);
        for (CtMethod<?> method : type.getMethods()) if (!method.isImplicit()) out.add(method);
        for (CtTypeMember member : type.getTypeMembers())
            if (member instanceof CtConstructor<?> ctor && !ctor.isImplicit()) out.add(ctor);
        return out;
    }

    /** The identity a member is compared by: its kind, name and parameter types, with java.lang spelled as written. */
    static String keyOf(CtElement member) {
        if (member instanceof CtField<?> field) return "field " + field.getSimpleName();
        if (member instanceof CtMethod<?> method)
            return "method " + method.getSimpleName() + "(" + String.join(",", paramTexts(method.getParameters()))
                    + ")";
        CtConstructor<?> ctor = (CtConstructor<?>) member;
        return "constructor(" + String.join(",", paramTexts(ctor.getParameters())) + ")";
    }

    private static List<String> paramTexts(List<CtParameter<?>> params) {
        List<String> out = new ArrayList<>();
        for (CtParameter<?> p : params) out.add(normal(Names.typeText(p.getType())));
        return out;
    }

    /** Lombok writes `java.lang.String` where a written type says `String`: the same type, so one spelling. */
    static String normal(String typeText) {
        return typeText == null ? null : typeText.replaceAll("\\bjava\\.lang\\.(?=[A-Z])", "");
    }

    private static Lombok.Item item(CtElement member, CtType<?> written, String owner, boolean nestedBuilder,
            Scope scope) {
        Set<ModifierKind> modifiers = new LinkedHashSet<>(((CtModifiable) member).getModifiers());
        if (member instanceof CtField<?> field) {
            String name = field.getSimpleName();
            Source source = sourceOf("field", name, 0, nestedBuilder, scope);
            String type = normal(Names.typeText(field.getType()));
            String typeFqn = typeFqn(field.getType(), field, type, source.at(), scope);
            return item(owner, "field", name, type, typeFqn, List.of(), modifiers, source, scope);
        }
        if (member instanceof CtMethod<?> method) {
            String name = method.getSimpleName();
            List<String> params = paramTexts(method.getParameters());
            Source source = sourceOf("method", name, params.size(), nestedBuilder, scope);
            String text = normal(Names.typeText(method.getType()));
            String nested = scope.nested().get(stripTypeArgs(text));
            String type = nested != null ? nested : text;
            String typeFqn = nested != null ? nested : typeFqn(method.getType(), method, text, source.at(), scope);
            return item(owner, "method", name, type, typeFqn, params, modifiers, source, scope);
        }
        CtConstructor<?> ctor = (CtConstructor<?>) member;
        List<String> params = paramTexts(ctor.getParameters());
        Source source = sourceOf("constructor", written.getSimpleName(), params.size(), nestedBuilder, scope);
        return item(owner, "constructor", written.getSimpleName(), null, null, params, modifiers, source, scope);
    }

    /**
     * The dotted name of a generated member's type. A member written with its field's type (a getter's return, a
     * builder's field) takes the field's own reference, which Spoon resolved where the field is declared: the
     * delomboked model holds only the Lombok-using files, so the same spelling may be unknown there.
     */
    private static String typeFqn(CtTypeReference<?> type, CtElement context, String text, CtElement at,
            Scope scope) {
        if (at instanceof CtField<?> field && field.getType() != null
                && text.equals(normal(Names.typeText(field.getType()))))
            return Refs.joinKey(field.getType(), field, scope.failures());
        return Refs.joinKey(type, context, scope.failures());
    }

    private static Lombok.Item item(String owner, String kind, String name, String type, String typeFqn,
            List<String> params, Set<ModifierKind> modifiers, Source source, Scope scope) {
        String id = Names.member(owner, name + "(" + String.join(",", params) + ")");
        return new Lombok.Item(owner, kind, name, id, type, typeFqn, params, modifiers,
                scope.positions().of(source.at()), source.from());
    }

    /** `Base.BaseBuilder<?, ?>` names `Base.BaseBuilder`: the class, without its type arguments. */
    private static String stripTypeArgs(String text) {
        int at = text == null ? -1 : text.indexOf('<');
        return at < 0 ? text : text.substring(0, at).trim();
    }

    /**
     * The annotation a generated member came from, and where it is placed. An accessor is placed at its field, as the
     * hand-written rules place it; a builder's member at the builder field it mirrors; anything else at the type.
     */
    private static Source sourceOf(String kind, String name, int argc, boolean nestedBuilder, Scope scope) {
        CtType<?> annotated = scope.annotated();
        if (nestedBuilder) {
            CtField<?> mirrored = field(annotated, name);
            return new Source("Builder", mirrored != null ? mirrored : annotated);
        }
        if ("constructor".equals(kind)) return new Source(constructorFrom(argc, annotated), annotated);
        if ("field".equals(kind)) {
            for (var logger : Lombok.LOGGERS.keySet())
                if (Lombok.has(annotated, logger)) return new Source(logger, annotated);
            return new Source("Lombok", annotated);
        }
        CtField<?> accessed = accessorField(name, argc, annotated);
        if (accessed != null) return accessorSource(name, argc, accessed, annotated);
        if ("toString".equals(name)) return new Source(first(annotated, "ToString", "Data", "Value"), annotated);
        if ("equals".equals(name) || "hashCode".equals(name) || "canEqual".equals(name))
            return new Source(first(annotated, "EqualsAndHashCode", "Data", "Value"), annotated);
        if ("builder".equals(name)) return new Source("Builder", annotated);
        return new Source("Lombok", annotated);
    }

    /** The annotation of an accessor: on its field first, then on the type, else the one its shape names. */
    private static Source accessorSource(String name, int argc, CtField<?> field, CtType<?> annotated) {
        String[] candidates = isWither(name, argc, field) ? new String[] {"With"}
                : isSetter(name, argc, field) ? new String[] {"Setter", "Data"}
                : new String[] {"Getter", "Data", "Value"};
        for (String candidate : candidates) if (Lombok.has(field, candidate)) return new Source(candidate, field);
        for (String candidate : candidates) if (Lombok.has(annotated, candidate)) return new Source(candidate, field);
        return new Source(candidates[0], field);
    }

    /** The one annotation of the list the type carries, first in order; `Lombok` when none is found. */
    private static String first(CtType<?> type, String... names) {
        for (String name : names) if (Lombok.has(type, name)) return name;
        return "Lombok";
    }

    /** The constructor Lombok writes for an arity: the annotation that names that constructor's shape. */
    private static String constructorFrom(int argc, CtType<?> annotated) {
        if (argc == 0 && Lombok.has(annotated, "NoArgsConstructor")) return "NoArgsConstructor";
        if (Lombok.has(annotated, "AllArgsConstructor") || Lombok.has(annotated, "Value")) return "AllArgsConstructor";
        if (Lombok.has(annotated, "RequiredArgsConstructor") || Lombok.has(annotated, "Data"))
            return "RequiredArgsConstructor";
        if (Lombok.has(annotated, "Builder") || Lombok.has(annotated, "SuperBuilder")) return "Builder";
        return "Lombok";
    }

    /**
     * The non-static field a getter, setter or wither of this name and arity is written for, or null. A fluent accessor
     * (`name()`, `name(String)`, from `@Accessors(fluent = true)`) is named as the field is.
     */
    private static CtField<?> accessorField(String name, int argc, CtType<?> annotated) {
        for (CtField<?> field : annotated.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            String fieldName = field.getSimpleName();
            String text = normal(Names.typeText(field.getType()));
            boolean getter = argc == 0 && (name.equals(Lombok.getterName(fieldName, text)) || name.equals(fieldName));
            boolean setter = argc == 1 && (name.equals(Lombok.setterName(fieldName, text)) || name.equals(fieldName));
            boolean wither = argc == 1 && name.equals("with" + Lombok.cap(fieldName));
            if (getter || setter || wither) return field;
        }
        return null;
    }

    private static boolean isSetter(String name, int argc, CtField<?> field) {
        return argc == 1 && !isWither(name, argc, field);
    }

    private static boolean isWither(String name, int argc, CtField<?> field) {
        return argc == 1 && name.equals("with" + Lombok.cap(field.getSimpleName()));
    }

    /** The non-static field of this name, or null. */
    private static CtField<?> field(CtType<?> type, String name) {
        for (CtField<?> field : type.getFields())
            if (!field.getModifiers().contains(ModifierKind.STATIC) && field.getSimpleName().equals(name)) return field;
        return null;
    }
}
