package mindmodel.engine.resolve;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Names;
import mindmodel.engine.model.Positions;

/**
 * The members Lombok generates, computed from the annotations a person wrote. A generated member keeps the position of
 * the annotated element, so a citation points at real code, and is marked {@code generated: "lombok"}. An enum's {@code
 * values()} and {@code valueOf(String)} are the compiler's, not Lombok's: they are marked {@code "compiler"}.
 *
 * Covered: {@code @Getter}, {@code @Setter}, {@code @Data}, {@code @Value}, {@code @Builder}, {@code @SuperBuilder},
 * the three constructors, {@code @ToString}, {@code @EqualsAndHashCode} and the logger annotations. Not covered, on
 * purpose: {@code @Accessors(prefix/fluent)} renaming, {@code @NonNull} behaviour, and the {@code @SuperBuilder} chain
 * across a hierarchy.
 */
public final class Lombok {

    /** One generated member, written exactly like a declared one. */
    public record Item(String owner, String kind, String name, String id, String type, String typeFqn,
            List<String> params, Set<ModifierKind> modifiers, Positions.Pos pos, String from) {

        /** Who wrote the member: the compiler for an enum's `values()` and `valueOf`, Lombok for every other. */
        public String origin() {
            return "enum".equals(from) ? "compiler" : "lombok";
        }
    }

    /**
     * The generated members, by the keys a call or a chain names them with: `owner#name/argc` and, for a name with one
     * shape, `owner#name`; fields by `owner#name`; the builder types the synthesis invents; the generated constructors
     * by `owner#<init>/argc`, and the owners that have any (Spoon's implicit default constructor is not theirs).
     */
    public record Index(Map<String, Item> methods, Map<String, Item> fields, Set<String> builders,
            Map<String, Item> constructors, Set<String> constructed, Set<String> named) {

        /** Indexes the synthesized members by the type they were synthesized for. */
        public static Index of(Map<String, List<Item>> synth) {
            Map<String, Item> methods = new HashMap<>();
            Map<String, Item> fields = new HashMap<>();
            Set<String> builders = new HashSet<>();
            Map<String, Item> constructors = new HashMap<>();
            Set<String> constructed = new HashSet<>();
            Set<String> names = new HashSet<>();
            for (Map.Entry<String, List<Item>> entry : synth.entrySet()) {
                Map<String, List<Item>> byName = new HashMap<>();
                for (Item item : entry.getValue()) {
                    if ("builder".equals(item.name()) && "Builder".equals(item.from())) builders.add(item.typeFqn());
                    if ("constructor".equals(item.kind())) {
                        constructors.putIfAbsent(constructorKey(item.owner(), item.params().size()), item);
                        constructed.add(item.owner());
                    } else if ("field".equals(item.kind())) {
                        fields.put(Names.member(item.owner(), item.name()), item);
                    } else if ("method".equals(item.kind())) {
                        methods.putIfAbsent(Names.member(item.owner(), Names.shape(item.name(), item.params().size())),
                                item);
                        names.add(Names.member(item.owner(), item.name()));
                        byName.computeIfAbsent(item.name(), k -> new ArrayList<>()).add(item);
                    }
                }
                // `Foo.<T>builder()` is written with a type argument Spoon counts as an argument: a generated member
                // whose name has exactly one shape on its owner is also reachable without the count.
                for (Map.Entry<String, List<Item>> named : byName.entrySet())
                    if (named.getValue().size() == 1)
                        methods.putIfAbsent(Names.member(entry.getKey(), named.getKey()), named.getValue().get(0));
            }
            return new Index(methods, fields, builders, constructors, constructed, names);
        }

        /** The generated method a call names: by name and argument count, else by name alone; null when none. */
        public Item method(String owner, String name, int argc) {
            Item item = methods.get(Names.member(owner, Names.shape(name, argc)));
            return item != null ? item : methods.get(Names.member(owner, name));
        }

        /**
         * The generated constructor of that arity, or null. Two generated constructors of one owner never share an
         * arity unless they are the same signature, so the arity names the one a `new` reaches.
         */
        public Item constructor(String owner, int argc) {
            return constructors.get(constructorKey(owner, argc));
        }

        /** The one generated method of this name on the type, when it has exactly one shape; null otherwise. */
        public Item onlyMethod(String owner, String name) {
            return methods.get(Names.member(owner, name));
        }

        /** True when Lombok writes a method of this name on the type, whatever its arity. */
        public boolean named(String owner, String name) {
            return named.contains(Names.member(owner, name));
        }

        /** True when Lombok writes any constructor for the type. */
        public boolean constructed(String owner) {
            return constructed.contains(owner);
        }

        private static String constructorKey(String owner, int argc) {
            return Names.member(owner, Names.shape("<init>", argc));
        }
    }

    /**
     * Each logger annotation and the type of the field it writes. The field is always `log`, whatever the annotation.
     */
    static final Map<String, String> LOGGERS = new LinkedHashMap<>();

    static {
        LOGGERS.put("Slf4j", "org.slf4j.Logger");
        LOGGERS.put("Log4j2", "org.apache.logging.log4j.Logger");
        LOGGERS.put("Log", "java.util.logging.Logger");
        LOGGERS.put("CommonsLog", "org.apache.commons.logging.Log");
        LOGGERS.put("JBossLog", "org.jboss.logging.Logger");
        LOGGERS.put("XSlf4j", "org.slf4j.ext.XLogger");
    }

    private Lombok() {
    }

    /**
     * The synthesized members of every type, keyed by the type's name, in a stable order. The positions and the failure
     * counts are the run's own: a reference a generated member names is judged by the same rule as a declared one.
     *
     * @param delombok the members delombok read, by the type they belong to; null when delombok did not run, and the
     *     hand-written rules answer. The compiler's enum members are the same either way.
     */
    public static Map<String, List<Item>> synthesize(List<CtType<?>> types, Positions positions, Failures failures,
            Map<String, List<Item>> delombok) {
        Map<String, List<Item>> out = new LinkedHashMap<>();
        for (CtType<?> type : types) {
            List<Item> items = new ArrayList<>();
            Sink sink = new Sink(items, positions, failures);
            // A record's members are the compiler's and the dump's own (RecordCtors): no annotation writes them here.
            if (delombok != null) {
                if (type.isEnum()) enumMethods(type, Names.qualified(type), sink);
                items.addAll(delombok.getOrDefault(Names.qualified(type), List.of()));
            } else if (!(type instanceof CtRecord)) {
                itemsOf(type, sink);
            }
            items.sort(Comparator.comparing((Item i) -> i.pos() == null ? "" : i.pos().file())
                    .thenComparingInt(i -> i.pos() == null ? 0 : i.pos().line())
                    .thenComparing(Item::kind).thenComparing(Item::id));
            if (!items.isEmpty()) out.put(Names.qualified(type), items);
        }
        return out;
    }

    /** Where one type's generated members go, and the run's positions and failure counts they are judged with. */
    private record Sink(List<Item> items, Positions positions, Failures failures) {

        void add(String owner, String kind, String name, String type, List<String> params, Set<ModifierKind> modifiers,
                CtElement posOf, String from) {
            String id = Names.member(owner, name + "(" + String.join(",", params) + ")");
            items.add(new Item(owner, kind, name, id, type, typeFqn(posOf, type), params, modifiers,
                    positions.of(posOf), from));
        }

        /**
         * The generated member's type as the compiler names it, for chain typing; the written text stays `type`. A
         * getter's type is the field's type, which Refs names by the one rule for an unresolved type.
         */
        private String typeFqn(CtElement posOf, String written) {
            if (written == null || written.isEmpty()) return null;
            // Checked first: a written `Outer.In` has a dot but is not the dotted name the compiler gives.
            if (posOf instanceof CtField<?> field && field.getType() != null
                    && written.equals(Names.typeText(field.getType())))
                return Refs.joinKey(field.getType(), field, failures);
            // A builder type, the owner it builds, or a name left as written (`String`, `int`): the reader resolves
            // them.
            return written;
        }
    }

    private static void itemsOf(CtType<?> type, Sink sink) {
        String owner = Names.qualified(type);
        // Every enum carries these from the compiler: no source declares them, and the dump reports what is written.
        if (type.isEnum()) enumMethods(type, owner, sink);
        boolean data = has(type, "Data");
        boolean value = has(type, "Value");
        boolean getters = data || value || (has(type, "Getter") && !noGetter(type));
        boolean setters = data || has(type, "Setter");
        accessors(type, owner, value, getters, setters, sink);
        constructors(type, owner, data, value, sink);
        if (has(type, "Builder") || has(type, "SuperBuilder")) builder(type, owner, sink);
        if (data || value || has(type, "ToString"))
            method(type, owner, "toString", "String", List.of(), "ToString", sink);
        if (data || value || has(type, "EqualsAndHashCode")) {
            method(type, owner, "equals", "boolean", List.of("Object"), "EqualsAndHashCode", sink);
            method(type, owner, "hashCode", "int", List.of(), "EqualsAndHashCode", sink);
        }
        for (var logger : LOGGERS.entrySet())
            if (has(type, logger.getKey())) {
                sink.add(owner, "field", "log", logger.getValue(), List.of(),
                        Set.of(ModifierKind.PRIVATE, ModifierKind.STATIC, ModifierKind.FINAL), type, logger.getKey());
                break;
            }
    }

    /**
     * The two members javac writes for an enum: `values()` and `valueOf(String)`. `name()`/`ordinal()` are inherited.
     */
    private static void enumMethods(CtType<?> type, String owner, Sink sink) {
        Set<ModifierKind> pub = Set.of(ModifierKind.PUBLIC);
        sink.add(owner, "method", "values", owner, List.of(), pub, type, "enum");
        sink.add(owner, "method", "valueOf", owner, List.of("String"), pub, type, "enum");
    }

    /** Getters for every field, setters for the mutable ones; a field's own annotation adds to the type's. */
    private static void accessors(CtType<?> type, String owner, boolean value, boolean getters, boolean setters,
            Sink sink) {
        for (CtField<?> field : type.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            String name = field.getSimpleName();
            String typeText = Names.typeText(field.getType());
            if ((getters || has(field, "Getter")) && !noGetter(field))
                sink.add(owner, "method", getterName(name, typeText), typeText, List.of(), Set.of(ModifierKind.PUBLIC),
                        field, "Getter");
            boolean mutable = !value && !field.getModifiers().contains(ModifierKind.FINAL);
            if ((setters || has(field, "Setter")) && mutable)
                sink.add(owner, "method", setterName(name, typeText), "void", List.of(typeText),
                        Set.of(ModifierKind.PUBLIC), field, "Setter");
        }
    }

    /**
     * A primitive `boolean isActive` is read as `isActive()`; any other type, `Boolean` included, is `get` plus name.
     */
    static String getterName(String name, String typeText) {
        if (!typeText.equals("boolean")) return "get" + cap(name);
        return isPrefixed(name) ? name : "is" + cap(name);
    }

    /** A primitive `boolean isActive` is written as `setActive`: the `is` is the getter's, not the property's. */
    static String setterName(String name, String typeText) {
        return "set" + cap(typeText.equals("boolean") && isPrefixed(name) ? name.substring(2) : name);
    }

    /** The `is` prefix Lombok strips: `is` followed by a capital (`isActive`, not `issue`). */
    private static boolean isPrefixed(String name) {
        return name.length() > 2 && name.startsWith("is") && Character.isUpperCase(name.charAt(2));
    }

    /** True when a `@Getter` on the element says `AccessLevel.NONE`: no getter is written for it. */
    private static boolean noGetter(CtElement element) {
        for (CtAnnotation<?> a : element.getAnnotations()) {
            boolean getter = a.getAnnotationType().getSimpleName().equals("Getter");
            if (getter && String.valueOf(a).matches("(?s).*\\bNONE\\b.*")) return true;
        }
        return false;
    }

    /**
     * The three constructors Lombok writes. A final field initialised where it is declared takes no argument, static
     * fields take none. A constructor the program already writes with the same parameters is the one that stands, so
     * Lombok writes none beside it; `@Data` writes its required-args constructor only when no constructor is written.
     */
    private static void constructors(CtType<?> type, String owner, boolean data, boolean value, Sink sink) {
        List<String> required = new ArrayList<>();
        List<String> all = new ArrayList<>();
        for (CtField<?> field : type.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            String text = Names.typeText(field.getType());
            all.add(text);
            if (field.getModifiers().contains(ModifierKind.FINAL) && field.getDefaultExpression() == null)
                required.add(text);
        }
        Set<String> explicit = explicitConstructors(type);
        boolean noArgs = has(type, "NoArgsConstructor");
        boolean requiredArgs = has(type, "RequiredArgsConstructor");
        boolean allArgs = has(type, "AllArgsConstructor") || value;
        boolean dataRequired = data && !noArgs && !requiredArgs && !allArgs && explicit.isEmpty();
        if (noArgs) constructor(owner, type, List.of(), "NoArgsConstructor", explicit, sink);
        if (requiredArgs || dataRequired)
            constructor(owner, type, required, "RequiredArgsConstructor", explicit, sink);
        if (allArgs) constructor(owner, type, all, "AllArgsConstructor", explicit, sink);
    }

    private static void constructor(String owner, CtType<?> type, List<String> params, String from,
            Set<String> explicit, Sink sink) {
        if (explicit.contains(String.join(",", params))) return;
        sink.add(owner, "constructor", type.getSimpleName(), null, params, Set.of(ModifierKind.PUBLIC), type, from);
    }

    /** The parameter lists of the constructors the program writes, joined the way a generated id joins them. */
    private static Set<String> explicitConstructors(CtType<?> type) {
        Set<String> out = new HashSet<>();
        for (var member : type.getTypeMembers()) {
            if (!(member instanceof CtConstructor<?> ctor) || ctor.isImplicit()) continue;
            List<String> params = new ArrayList<>();
            for (CtParameter<?> p : ctor.getParameters()) params.add(Names.typeText(p.getType()));
            out.add(String.join(",", params));
        }
        return out;
    }

    /** builder(), Builder.setX(...) and Builder.build(); the builder type is a member owner, not a dumped type. */
    private static void builder(CtType<?> type, String owner, Sink sink) {
        String builderFqn = owner + "." + builderName(type);
        sink.add(owner, "method", "builder", builderFqn, List.of(), Set.of(ModifierKind.PUBLIC, ModifierKind.STATIC),
                type, "Builder");
        for (CtField<?> field : type.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            sink.add(builderFqn, "method", field.getSimpleName(), builderFqn, List.of(Names.typeText(field.getType())),
                    Set.of(ModifierKind.PUBLIC), field, "Builder");
        }
        sink.add(builderFqn, "method", "build", owner, List.of(), Set.of(ModifierKind.PUBLIC), type, "Builder");
    }

    /**
     * The simple name of the builder class: the {@code builderClassName} the annotation writes as a string, else
     * Lombok's default {@code <Type>Builder}. Lombok nests the class in the type it builds.
     */
    static String builderName(CtType<?> type) {
        for (CtAnnotation<?> a : type.getAnnotations()) {
            if (!"Builder".equals(a.getAnnotationType().getSimpleName())
                    && !"SuperBuilder".equals(a.getAnnotationType().getSimpleName())) continue;
            Values.Value written = Values.annotationArgs(a).get("builderClassName");
            if (written != null && written.value() instanceof String name && !name.isEmpty()) return name;
        }
        return type.getSimpleName() + "Builder";
    }

    private static void method(CtType<?> type, String owner, String name, String returns, List<String> params,
            String from, Sink sink) {
        sink.add(owner, "method", name, returns, params, Set.of(ModifierKind.PUBLIC), type, from);
    }

    /**
     * True when the element carries lombok's annotation of that simple name. Without a classpath Spoon cannot resolve
     * an annotation imported through a wildcard (`import lombok.*`), and gives it the annotated type's own package; the
     * file's imports are then the evidence, and they are as good as the annotation's own name.
     */
    static boolean has(CtElement element, String simpleName) {
        for (CtAnnotation<?> a : element.getAnnotations()) {
            if (!a.getAnnotationType().getSimpleName().equals(simpleName)) continue;
            String pkg = a.getAnnotationType().getPackage() == null ? ""
                    : a.getAnnotationType().getPackage().getQualifiedName();
            if (pkg.isEmpty() || pkg.startsWith("lombok")) return true;
            if (importsLombok(element, simpleName)) return true;
        }
        return false;
    }

    /** `import lombok.Data;` or `import lombok.*;` in the file that declares the element. */
    private static boolean importsLombok(CtElement element, String simpleName) {
        var position = element.getPosition();
        if (position == null || position.getCompilationUnit() == null) return false;
        for (var imported : position.getCompilationUnit().getImports()) {
            // A wildcard import (`lombok.*`) carries no reference at all in no-classpath mode; its text does.
            String text = imported.toString().replace("import ", "").replace("static ", "").replace(";", "").trim();
            if (text.equals("lombok.*") || text.equals("lombok." + simpleName)) return true;
        }
        return false;
    }

    static String cap(String name) {
        return name.isEmpty() ? name : Character.toUpperCase(name.charAt(0)) + name.substring(1);
    }
}
