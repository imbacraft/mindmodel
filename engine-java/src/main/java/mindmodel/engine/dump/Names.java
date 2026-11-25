package mindmodel.engine.dump;

import java.util.ArrayList;
import java.util.List;

import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.reference.CtWildcardReference;

/** One spelling of every name: nested types are dotted, method ids are {@code owner#name(paramTypes)}. */
public final class Names {

    private Names() {
    }

    /** {@code a.b.Outer.Inner} — dots, never {@code $}. */
    public static String qualified(CtType<?> type) {
        if (type.getDeclaringType() != null) return qualified(type.getDeclaringType()) + "." + type.getSimpleName();
        String pkg = type.getPackage() == null ? "" : type.getPackage().getQualifiedName();
        return pkg.isEmpty() ? type.getSimpleName() : pkg + "." + type.getSimpleName();
    }

    public static String qualified(CtTypeReference<?> ref) {
        if (ref.getDeclaringType() != null) return qualified(ref.getDeclaringType()) + "." + ref.getSimpleName();
        String pkg = ref.getPackage() == null ? "" : ref.getPackage().getQualifiedName();
        return pkg.isEmpty() ? ref.getSimpleName() : pkg + "." + ref.getSimpleName();
    }

    /** Method id: the same string the Node model uses, so a target is a lookup and never a mapping. */
    public static String methodId(CtType<?> owner, String name, List<CtTypeReference<?>> params) {
        List<String> types = new ArrayList<>();
        for (CtTypeReference<?> p : params) types.add(typeText(p));
        return qualified(owner) + "#" + name + "(" + String.join(",", types) + ")";
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
        if (ref instanceof CtWildcardReference wildcard) return wildcardText(wildcard);
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

    /**
     * The type as written, in the formatter's spelling; null when Spoon inferred it rather than read it. The source is
     * re-spaced, not stripped: `Map<K,V>`, `Map<K, V>` and `Map< K , V >` all become `Map<K, V>`.
     */
    private static String sourceText(CtTypeReference<?> ref) {
        spoon.reflect.cu.SourcePosition p = ref.getPosition();
        if (p == null || !p.isValidPosition() || p.getCompilationUnit() == null) return null;
        String source = p.getCompilationUnit().getOriginalSourceCode();
        int start = p.getSourceStart();
        int end = p.getSourceEnd();
        if (source == null || start < 0 || end < start || end >= source.length()) return null;
        String text = spaced(source.substring(start, end + 1));
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

    /** A wildcard as Java spells it: {@code ?}, {@code ? extends Order}, {@code ? super T}. */
    public static String wildcard(boolean upper, String bound) {
        return bound == null ? "?" : (upper ? "? extends " : "? super ") + bound;
    }

    private static String wildcardText(CtWildcardReference wildcard) {
        CtTypeReference<?> bound = wildcard.getBoundingType();
        if (bound == null || "Object".equals(bound.getSimpleName())) return "?";
        return wildcard(wildcard.isUpper(), typeText(bound));
    }
}
