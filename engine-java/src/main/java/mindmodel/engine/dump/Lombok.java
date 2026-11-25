package mindmodel.engine.dump;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;

/**
 * The members Lombok generates, computed from the annotations a person wrote. A generated member keeps the position of
 * the annotated element, so a citation points at real code, and is marked {@code generated: "lombok"}.
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
    }

    /**
     * The generated members, by the keys a call or a chain names them with: `owner#name/argc` and, for a name with one
     * shape, `owner#name`; fields by `owner#name`; and the builder types the synthesis invents.
     */
    public record Index(Map<String, Item> methods, Map<String, Item> fields, Set<String> builders) {

        /** Indexes the synthesized members by the type they were synthesized for. */
        public static Index of(Map<String, List<Item>> synth) {
            Map<String, Item> methods = new HashMap<>();
            Map<String, Item> fields = new HashMap<>();
            Set<String> builders = new HashSet<>();
            for (Map.Entry<String, List<Item>> entry : synth.entrySet()) {
                Map<String, List<Item>> byName = new HashMap<>();
                for (Item item : entry.getValue()) {
                    if (item.typeFqn() != null && item.typeFqn().endsWith(".Builder")) builders.add(item.typeFqn());
                    if ("field".equals(item.kind())) {
                        fields.put(Names.member(item.owner(), item.name()), item);
                    } else if ("method".equals(item.kind())) {
                        methods.putIfAbsent(Names.member(item.owner(), Names.shape(item.name(), item.params().size())),
                                item);
                        byName.computeIfAbsent(item.name(), k -> new ArrayList<>()).add(item);
                    }
                }
                // `Foo.<T>builder()` is written with a type argument Spoon counts as an argument: a generated member
                // whose name has exactly one shape on its owner is also reachable without the count.
                for (Map.Entry<String, List<Item>> named : byName.entrySet())
                    if (named.getValue().size() == 1)
                        methods.putIfAbsent(Names.member(entry.getKey(), named.getKey()), named.getValue().get(0));
            }
            return new Index(methods, fields, builders);
        }

        /** The generated method a call names: by name and argument count, else by name alone; null when none. */
        public Item method(String owner, String name, int argc) {
            Item item = methods.get(Names.member(owner, Names.shape(name, argc)));
            return item != null ? item : methods.get(Names.member(owner, name));
        }
    }

    private static final Set<String> LOGGERS = Set.of("Slf4j", "Log4j2", "Log", "CommonsLog", "JBossLog", "XSlf4j");

    private Lombok() {
    }

    /**
     * The synthesized members of every type, keyed by the type's name, in a stable order. The positions and the failure
     * counts are the run's own: a reference a generated member names is judged by the same rule as a declared one.
     */
    public static Map<String, List<Item>> synthesize(List<CtType<?>> types, Positions positions, Failures failures) {
        Map<String, List<Item>> out = new LinkedHashMap<>();
        for (CtType<?> type : types) {
            List<Item> items = new ArrayList<>();
            Sink sink = new Sink(items, positions, failures);
            // A record's members are the compiler's and the dump's own (RecordCtors): no annotation writes them here.
            if (!(type instanceof CtRecord)) itemsOf(type, sink);
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
            // A builder type, the owner it builds, or a name left as written (`String`, `int`): the reader resolves them.
            return written;
        }
    }

    private static void itemsOf(CtType<?> type, Sink sink) {
        String owner = Names.qualified(type);
        // Every enum carries these from the compiler: no source declares them, and the dump reports what is written.
        if (type.isEnum()) enumMethods(type, owner, sink);
        boolean data = has(type, "Data");
        boolean value = has(type, "Value");
        boolean getters = data || value || has(type, "Getter");
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
        for (String logger : LOGGERS)
            if (has(type, logger)) {
                String name = logger.startsWith("Slf") ? "log" : logger.toLowerCase();
                sink.add(owner, "field", name, "org.slf4j.Logger", List.of(),
                        Set.of(ModifierKind.PRIVATE, ModifierKind.STATIC, ModifierKind.FINAL), type, logger);
                break;
            }
    }

    /** The four members javac writes for an enum: `name()`, `ordinal()`, `values()` and `valueOf(String)`. */
    private static void enumMethods(CtType<?> type, String owner, Sink sink) {
        Set<ModifierKind> pub = Set.of(ModifierKind.PUBLIC);
        sink.add(owner, "method", "name", "String", List.of(), pub, type, "enum");
        sink.add(owner, "method", "ordinal", "int", List.of(), pub, type, "enum");
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
            if (getters || has(field, "Getter")) {
                String getter = typeText.equals("boolean") || typeText.equals("Boolean") ? "is" + cap(name)
                        : "get" + cap(name);
                sink.add(owner, "method", getter, typeText, List.of(), Set.of(ModifierKind.PUBLIC), field, "Getter");
            }
            boolean mutable = !value && !field.getModifiers().contains(ModifierKind.FINAL);
            if ((setters || has(field, "Setter")) && mutable)
                sink.add(owner, "method", "set" + cap(name), "void", List.of(typeText), Set.of(ModifierKind.PUBLIC),
                        field, "Setter");
        }
    }

    private static void constructors(CtType<?> type, String owner, boolean data, boolean value, Sink sink) {
        List<String> required = new ArrayList<>();
        List<String> all = new ArrayList<>();
        for (CtField<?> field : type.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            all.add(Names.typeText(field.getType()));
            if (field.getModifiers().contains(ModifierKind.FINAL)) required.add(Names.typeText(field.getType()));
        }
        if (has(type, "NoArgsConstructor"))
            sink.add(owner, "constructor", type.getSimpleName(), null, List.of(), Set.of(ModifierKind.PUBLIC), type,
                    "NoArgsConstructor");
        if ((has(type, "RequiredArgsConstructor") || data) && !required.isEmpty() && !all.isEmpty())
            sink.add(owner, "constructor", type.getSimpleName(), null, required, Set.of(ModifierKind.PUBLIC), type,
                    "RequiredArgsConstructor");
        if ((has(type, "AllArgsConstructor") || value) && !all.isEmpty())
            sink.add(owner, "constructor", type.getSimpleName(), null, all, Set.of(ModifierKind.PUBLIC), type,
                    "AllArgsConstructor");
    }

    /** builder(), Builder.setX(...) and Builder.build(); the builder type is a member owner, not a dumped type. */
    private static void builder(CtType<?> type, String owner, Sink sink) {
        String builderFqn = owner + ".Builder";
        sink.add(owner, "method", "builder", builderFqn, List.of(), Set.of(ModifierKind.PUBLIC, ModifierKind.STATIC),
                type, "Builder");
        for (CtField<?> field : type.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            sink.add(builderFqn, "method", field.getSimpleName(), builderFqn, List.of(Names.typeText(field.getType())),
                    Set.of(ModifierKind.PUBLIC), field, "Builder");
        }
        sink.add(builderFqn, "method", "build", owner, List.of(), Set.of(ModifierKind.PUBLIC), type, "Builder");
    }

    private static void method(CtType<?> type, String owner, String name, String returns, List<String> params,
            String from, Sink sink) {
        sink.add(owner, "method", name, returns, params, Set.of(ModifierKind.PUBLIC), type, from);
    }

    /**
     * True when the element carries lombok's annotation of that simple name. Without a classpath Spoon cannot resolve
     * an annotation imported through a wildcard (`import lombok.*`), and gives it the annotated type's own package;
     * the file's imports are then the evidence, and they are as good as the annotation's own name.
     */
    private static boolean has(CtElement element, String simpleName) {
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

    private static String cap(String name) {
        return name.isEmpty() ? name : Character.toUpperCase(name.charAt(0)) + name.substring(1);
    }
}
