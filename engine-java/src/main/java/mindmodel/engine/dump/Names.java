package mindmodel.engine.dump;

import java.util.ArrayList;
import java.util.List;

import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtConstructor;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtArrayTypeReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.reference.CtWildcardReference;

/** One spelling of every name: nested types are dotted, method ids are {@code owner#name(paramTypes)}. */
public final class Names {

    private Names() {
    }

    /** {@code a.b.Outer.Inner}: dots, never {@code $}. This is the join key of types.ndjson. */
    public static String qualified(CtType<?> type) {
        if (type.getDeclaringType() != null) return qualified(type.getDeclaringType()) + "." + type.getSimpleName();
        return inPackage(type.getPackage() == null ? "" : type.getPackage().getQualifiedName(), type.getSimpleName());
    }

    /** The same spelling for a reference. An array is its element with {@code []}; never a {@code $}. */
    public static String qualified(CtTypeReference<?> ref) {
        if (ref instanceof CtArrayTypeReference<?> array) return qualified(array.getComponentType()) + "[]";
        if (ref.getDeclaringType() != null) return qualified(ref.getDeclaringType()) + "." + ref.getSimpleName();
        return inPackage(ref.getPackage() == null ? "" : ref.getPackage().getQualifiedName(), ref.getSimpleName());
    }

    /**
     * The name a reader can use for a type: an anonymous class has none of its own and is named by the type it implements
     * or extends, so a call through it names what the program can see, never a synthetic `Outer.1`.
     */
    public static String nameOf(CtType<?> type) {
        if (!type.isAnonymous()) return qualified(type);
        if (!type.getSuperInterfaces().isEmpty()) return qualified(type.getSuperInterfaces().iterator().next());
        if (type instanceof CtClass<?> c && c.getSuperclass() != null) return qualified(c.getSuperclass());
        return "java.lang.Object";
    }

    /** {@link #nameOf(CtType)} for a reference: a reference to an anonymous class is named by its supertype. */
    public static String nameOf(CtTypeReference<?> ref) {
        CtType<?> declaration = ref.getTypeDeclaration();
        return declaration != null && declaration.isAnonymous() ? nameOf(declaration) : qualified(ref);
    }

    private static String inPackage(String pkg, String simple) {
        return pkg.isEmpty() ? simple : pkg + "." + simple;
    }

    /** The package a dotted name is in: {@code ""} for a name with no dot. */
    public static String packageOf(String fqn) {
        int dot = fqn.lastIndexOf('.');
        return dot < 0 ? "" : fqn.substring(0, dot);
    }

    /** The element type of an array reference, or the reference itself: {@code X[][]} is {@code X}. */
    public static CtTypeReference<?> elementType(CtTypeReference<?> ref) {
        CtTypeReference<?> base = ref;
        while (base instanceof CtArrayTypeReference<?> array) base = array.getComponentType();
        return base;
    }

    /** {@code owner#name}: a member's identity, wherever the dump names one. */
    public static String member(String owner, String name) {
        return owner + "#" + name;
    }

    /** {@code owner.name}: a constant's identity, as the enum or type that owns it writes it. */
    public static String dotted(String owner, String name) {
        return owner + "." + name;
    }

    /** {@code name/argc}: a member looked up by its name and argument count. */
    public static String shape(String name, int argc) {
        return name + "/" + argc;
    }

    /** Method id: the same string the Node model uses, so a target is a lookup and never a mapping. */
    public static String methodId(CtType<?> owner, String name, List<CtTypeReference<?>> params) {
        List<String> types = new ArrayList<>();
        for (CtTypeReference<?> p : params) types.add(typeText(p));
        return member(qualified(owner), name + "(" + String.join(",", types) + ")");
    }

    /**
     * The id of a declared constructor or method: a constructor is named after its type, and a record's canonical
     * constructor is identified by its components (see {@link #paramTypes}).
     */
    public static String executableId(CtType<?> owner, CtExecutable<?> executable) {
        String name = executable instanceof CtConstructor<?> ? owner.getSimpleName() : executable.getSimpleName();
        return methodId(owner, name, paramTypes(owner, executable));
    }

    /**
     * The parameter types an executable's id is written with. A record's canonical constructor takes its components in
     * declaration order: Spoon lists them in another order, and a row written under that order would not match the
     * member the dump declares.
     */
    public static List<CtTypeReference<?>> paramTypes(CtType<?> owner, CtExecutable<?> executable) {
        if (owner instanceof CtRecord record && executable instanceof CtConstructor<?> ctor
                && RecordCtors.isCanonical(record, ctor)) return RecordCtors.componentTypes(record);
        List<CtTypeReference<?>> out = new ArrayList<>();
        for (var p : executable.getParameters()) out.add(p.getType());
        return out;
    }

    /**
     * The one spelling of a type's text, as Java writes it: simple name as the author wrote it, generic arguments
     * separated by {@code ", "}, {@code []} kept, wildcards as {@code ? extends B} and {@code ? super B}. Every type
     * text (params, returns, fields, supertypes, method ids) goes through here. Agrees with {@code model/model.mjs}.
     */
    public static String typeText(CtTypeReference<?> ref) {
        if (ref == null) return "";
        // What the source wrote is the spelling the Node model has always used (`Type` here, `Outer.Type` there,
        // sometimes a fully qualified name). Read it, and fall back to the computed form for inferred references.
        String written = sourceText(ref);
        if (written != null) return written;
        if (ref instanceof CtWildcardReference wildcard) {
            CtTypeReference<?> bound = wildcardBound(wildcard);
            return bound == null ? "?" : wildcard(wildcard.isUpper(), typeText(bound));
        }
        // A nested type is written with its enclosing name, exactly as a person writes it in source: Outer.Inner.
        String name = ref.getDeclaringType() == null ? ref.getSimpleName()
                : typeText(ref.getDeclaringType()) + "." + ref.getSimpleName();
        name = name.replace(" ", "");
        List<CtTypeReference<?>> args = ref.getActualTypeArguments();
        if (args.isEmpty()) return name;
        List<String> parts = new ArrayList<>();
        for (CtTypeReference<?> a : args) parts.add(typeText(a));
        return name + "<" + String.join(", ", parts) + ">";
    }

    /** A wildcard's bound, or null when it has none or it is {@code Object}: the unbounded {@code ?}. */
    public static CtTypeReference<?> wildcardBound(CtWildcardReference wildcard) {
        CtTypeReference<?> bound = wildcard.getBoundingType();
        return bound == null || "Object".equals(bound.getSimpleName()) ? null : bound;
    }

    /** A wildcard as Java spells it: {@code ?}, {@code ? extends Order}, {@code ? super T}. */
    public static String wildcard(boolean upper, String bound) {
        return bound == null ? "?" : (upper ? "? extends " : "? super ") + bound;
    }

    /**
     * The source text an element was written as, sliced from its compilation unit; null when Spoon has no position
     * for it. Sliced rather than pretty-printed: a million arguments make that the difference the dump's budget turns on.
     */
    public static String sourceOf(CtElement element) {
        SourcePosition p = element == null ? null : element.getPosition();
        if (p == null || !p.isValidPosition() || p.getCompilationUnit() == null) return null;
        String source = p.getCompilationUnit().getOriginalSourceCode();
        int start = p.getSourceStart();
        int end = p.getSourceEnd();
        if (source == null || start < 0 || end < start || end >= source.length()) return null;
        return source.substring(start, end + 1);
    }

    /**
     * The type as written, in the formatter's spelling; null when Spoon inferred it rather than read it. The source is
     * re-spaced, not stripped: `Map<K,V>`, `Map<K, V>` and `Map< K , V >` all become `Map<K, V>`.
     */
    private static String sourceText(CtTypeReference<?> ref) {
        String source = sourceOf(ref);
        if (source == null) return null;
        String text = spaced(source);
        return text.isEmpty() ? null : text;
    }

    /**
     * Java's spacing for a written type: one space after each comma and around {@code ? extends} and {@code ? super},
     * none elsewhere.
     */
    static String spaced(String written) {
        return written.trim()
                .replaceAll("\\s+", " ")
                .replaceAll("\\s*\\.\\.\\.", "[]")       // `String...` is the array the parameter is
                .replaceAll("\\s*\\.\\s*", ".")            // `Outer . Inner`
                .replaceAll("\\s*([<>\\[\\],])\\s*", "$1")
                .replace(",", ", ")
                .replaceAll("\\?\\s*(extends|super)\\s+", "? $1 ");
    }
}
