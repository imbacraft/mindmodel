package mindmodel.engine.dump;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
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

    private Lombok() {
    }

    /** One generated member, written exactly like a declared one. */
    public record Item(String owner, String kind, String name, String id, String type, String typeFqn,
            List<String> params, Set<ModifierKind> modifiers, Positions.Pos pos, String from) {
    }

    private static final Set<String> LOGGERS = Set.of("Slf4j", "Log4j2", "Log", "CommonsLog", "JBossLog", "XSlf4j");

    public static Map<String, List<Item>> synthesize(List<CtType<?>> types, Path root) {
        Map<String, List<Item>> out = new LinkedHashMap<>();
        for (CtType<?> type : types) {
            List<Item> items = new ArrayList<>();
            if (!(type instanceof spoon.reflect.declaration.CtRecord)) {
                itemsOf(type, root, items);
            }
            items.sort(Comparator.comparing((Item i) -> i.pos == null ? "" : i.pos.file())
                    .thenComparingInt(i -> i.pos == null ? 0 : i.pos.line())
                    .thenComparing(Item::kind).thenComparing(Item::id));
            if (!items.isEmpty()) out.put(Names.qualified(type), items);
        }
        return out;
    }

    private static void itemsOf(CtType<?> type, Path root, List<Item> items) {
        String owner = Names.qualified(type);
        // Every enum carries these from the compiler: no source declares them, and the dump reports what is written.
        if (type.isEnum()) enumMethods(type, owner, root, items);
        boolean data = has(type, "Data");
        boolean value = has(type, "Value");
        boolean getters = data || value || has(type, "Getter");
        boolean setters = data || has(type, "Setter");
        accessors(type, owner, value, getters, setters, root, items);
        constructors(type, owner, data, value, root, items);
        if (has(type, "Builder") || has(type, "SuperBuilder")) builder(type, owner, root, items);
        if (data || value || has(type, "ToString")) method(type, owner, "toString", "String", List.of(), root, items);
        if (data || value || has(type, "EqualsAndHashCode")) {
            method(type, owner, "equals", "boolean", List.of("Object"), root, items);
            method(type, owner, "hashCode", "int", List.of(), root, items);
        }
        for (String logger : LOGGERS)
            if (has(type, logger)) {
                String name = logger.startsWith("Slf") ? "log" : logger.toLowerCase();
                item(owner, "field", name, "org.slf4j.Logger", List.of(),
                        Set.of(ModifierKind.PRIVATE, ModifierKind.STATIC, ModifierKind.FINAL), type, logger, root, items);
                break;
            }
    }

    /** The four members javac writes for an enum: `name()`, `ordinal()`, `values()` and `valueOf(String)`. */
    private static void enumMethods(CtType<?> type, String owner, Path root, List<Item> items) {
        Set<ModifierKind> pub = Set.of(ModifierKind.PUBLIC);
        item(owner, "method", "name", "String", List.of(), pub, type, "enum", root, items);
        item(owner, "method", "ordinal", "int", List.of(), pub, type, "enum", root, items);
        item(owner, "method", "values", owner, List.of(), pub, type, "enum", root, items);
        item(owner, "method", "valueOf", owner, List.of("String"), pub, type, "enum", root, items);
    }

    /** Getters for every field, setters for the mutable ones; a field's own annotation adds to the type's. */
    private static void accessors(CtType<?> type, String owner, boolean value, boolean getters, boolean setters,
            Path root, List<Item> items) {
        for (CtField<?> field : type.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            String name = field.getSimpleName();
            String typeText = Names.typeText(field.getType());
            if (getters || has(field, "Getter")) {
                String getter = typeText.equals("boolean") || typeText.equals("Boolean") ? "is" + cap(name)
                        : "get" + cap(name);
                item(owner, "method", getter, typeText, List.of(), Set.of(ModifierKind.PUBLIC), field, "Getter", root,
                        items);
            }
            boolean mutable = !value && !field.getModifiers().contains(ModifierKind.FINAL);
            if ((setters || has(field, "Setter")) && mutable)
                item(owner, "method", "set" + cap(name), "void", List.of(typeText), Set.of(ModifierKind.PUBLIC), field,
                        "Setter", root, items);
        }
    }

    private static void constructors(CtType<?> type, String owner, boolean data, boolean value, Path root,
            List<Item> items) {
        List<String> required = new ArrayList<>();
        List<String> all = new ArrayList<>();
        for (CtField<?> field : type.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            all.add(Names.typeText(field.getType()));
            if (field.getModifiers().contains(ModifierKind.FINAL)) required.add(Names.typeText(field.getType()));
        }
        if (has(type, "NoArgsConstructor"))
            item(owner, "constructor", type.getSimpleName(), null, List.of(), Set.of(ModifierKind.PUBLIC), type,
                    "NoArgsConstructor", root, items);
        if ((has(type, "RequiredArgsConstructor") || data) && !required.isEmpty() && !all.isEmpty())
            item(owner, "constructor", type.getSimpleName(), null, required, Set.of(ModifierKind.PUBLIC), type,
                    "RequiredArgsConstructor", root, items);
        if ((has(type, "AllArgsConstructor") || value) && !all.isEmpty())
            item(owner, "constructor", type.getSimpleName(), null, all, Set.of(ModifierKind.PUBLIC), type,
                    "AllArgsConstructor", root, items);
    }

    /** builder(), Builder.setX(...) and Builder.build(); the builder type is a member owner, not a dumped type. */
    private static void builder(CtType<?> type, String owner, Path root, List<Item> items) {
        String builderFqn = owner + ".Builder";
        item(owner, "method", "builder", builderFqn, List.of(), Set.of(ModifierKind.PUBLIC, ModifierKind.STATIC), type,
                "Builder", root, items);
        for (CtField<?> field : type.getFields()) {
            if (field.getModifiers().contains(ModifierKind.STATIC)) continue;
            item(builderFqn, "method", field.getSimpleName(), builderFqn, List.of(Names.typeText(field.getType())),
                    Set.of(ModifierKind.PUBLIC), field, "Builder", root, items);
        }
        item(builderFqn, "method", "build", owner, List.of(), Set.of(ModifierKind.PUBLIC), type, "Builder", root, items);
    }

    private static void method(CtType<?> type, String owner, String name, String returns, List<String> params,
            Path root, List<Item> items) {
        item(owner, "method", name, returns, params, Set.of(ModifierKind.PUBLIC), type, "EqualsAndHashCode", root,
                items);
    }

    private static void item(String owner, String kind, String name, String type, List<String> params,
            Set<ModifierKind> modifiers, CtElement posOf, String from, Path root, List<Item> items) {
        String id = owner + "#" + name + "(" + String.join(",", params) + ")";
        items.add(new Item(owner, kind, name, id, type, qualified(posOf, type), params, modifiers,
                Positions.of(posOf, root), from));
    }

    /**
     * True when the element carries lombok's annotation of that simple name. Without a classpath Spoon cannot resolve
     * an annotation imported through a wildcard (`import lombok.*`), and gives it the annotated type's own package;
     * the file's imports are then the evidence, and they are as good as the annotation's own name.
     */
    /** The generated member's type as the compiler names it, for chain typing; the written text stays `type`. */
    private static String qualified(CtElement element, String written) {
        if (written == null || written.isEmpty()) return null;
        // Already the compiler's spelling: a builder type, the owner it builds, a fully qualified type.
        if (written.indexOf('.') >= 0) return written;
        // A getter's type is the field's type, written as the author wrote it here.
        if (element instanceof CtField<?> field && field.getType() != null
                && written.equals(Names.typeText(field.getType())))
            return field.getType().getQualifiedName();
        // Anything else (`String`, `int`) is left as written; the reader resolves java.lang and drops primitives.
        return written;
    }

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
