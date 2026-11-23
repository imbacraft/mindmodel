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
     * Type text as a person writes it: simple name, generic arguments without spaces, {@code []} kept,
     * wildcards spelled out. Must agree with {@code model/model.mjs}, which reads the same spelling from source.
     */
    public static String typeText(CtTypeReference<?> ref) {
        if (ref == null) return "";
        // What the source wrote is the spelling the Node model has always used (`Type` here, `Outer.Type` there,
        // sometimes a fully qualified name). Read it, and fall back to the computed form for inferred references.
        String written = sourceText(ref);
        // `String...` is the source spelling of an array parameter; the id and the model say `String[]`.
        if (written != null) return written.replace("...", "[]");
        if (ref instanceof CtWildcardReference wildcard) return wildcardText(wildcard);
        // A nested type is written with its enclosing name, exactly as a person writes it in source: Outer.Inner.
        String name = ref.getDeclaringType() == null ? ref.getSimpleName()
                : typeText(ref.getDeclaringType()) + "." + ref.getSimpleName();
        name = name.replace(" ", "");
        List<CtTypeReference<?>> args = ref.getActualTypeArguments();
        if (args.isEmpty()) return name;
        List<String> parts = new ArrayList<>();
        for (CtTypeReference<?> a : args) parts.add(typeText(a));
        return name + "<" + String.join(",", parts) + ">";
    }

    /** The type exactly as written, whitespace removed; null when Spoon inferred it rather than read it. */
    private static String sourceText(CtTypeReference<?> ref) {
        spoon.reflect.cu.SourcePosition p = ref.getPosition();
        if (p == null || !p.isValidPosition() || p.getCompilationUnit() == null) return null;
        String source = p.getCompilationUnit().getOriginalSourceCode();
        int start = p.getSourceStart();
        int end = p.getSourceEnd();
        if (source == null || start < 0 || end < start || end >= source.length()) return null;
        String text = source.substring(start, end + 1).replaceAll("\\s+", "");
        return text.isEmpty() ? null : text;
    }

    private static String wildcardText(CtWildcardReference wildcard) {
        CtTypeReference<?> bound = wildcard.getBoundingType();
        if (bound == null || "Object".equals(bound.getSimpleName())) return "?";
        return (wildcard.isUpper() ? "? extends " : "? super ") + typeText(bound);
    }
}
