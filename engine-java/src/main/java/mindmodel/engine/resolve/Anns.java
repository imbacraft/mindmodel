package mindmodel.engine.resolve;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;

import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtType;

import mindmodel.engine.model.Names;
import mindmodel.engine.model.Positions;

/**
 * The annotations an element carries, read as data: the name as written, the raw arguments, the line and the values.
 */
public final class Anns {

    /** One annotation. {@code raw} is the argument text between the parentheses (null when there are none). */
    public record Ann(String name, String raw, Integer line, Map<String, Values.Value> args) {
    }

    private Anns() {
    }

    /** The annotations of an element, in source order. */
    public static List<Ann> of(Collection<CtAnnotation<?>> annotations) {
        List<Ann> out = new ArrayList<>();
        for (CtAnnotation<?> a : annotations)
            out.add(new Ann(writtenName(a), rawArgs(a), Positions.lineOf(a), Values.annotationArgs(a)));
        return out;
    }

    /**
     * The annotation's name as the author wrote it (`Entity`, `jakarta.persistence.Entity`, `Builder.Default`). Without
     * a classpath Spoon cannot resolve an annotation it has no source for, and invents a package for it: writing the
     * source spelling is the only honest answer.
     */
    private static String writtenName(CtAnnotation<?> a) {
        // A resolved annotation names its own package; one Spoon could not resolve gets the annotated type's own
        // package invented for it. Trust the first, and for the second write what the author wrote.
        CtType<?> owner = a.getParent(CtType.class);
        String ownerPkg = owner == null || owner.getPackage() == null ? "" : owner.getPackage().getQualifiedName();
        String spoon = Names.qualified(a.getAnnotationType());
        if (spoon.contains(".") && !(ownerPkg + ".").equals(spoon.substring(0, spoon.lastIndexOf('.') + 1)))
            return spoon;
        String source = Names.sourceOf(a);
        if (source != null) {
            int open = source.indexOf('(');
            String name = (open >= 0 ? source.substring(0, open) : source).replace("@", "").replaceAll("\\s+", "");
            if (!name.isEmpty()) return name;
        }
        return a.getAnnotationType().getSimpleName();
    }

    /**
     * The source between the annotation's parentheses, verbatim; null when it writes no arguments (`@Entity`, `@X()`).
     */
    private static String rawArgs(CtAnnotation<?> a) {
        String source = Names.sourceOf(a);
        if (source == null) return null;
        int open = source.indexOf('(');
        int close = source.lastIndexOf(')');
        String inner = open >= 0 && close > open ? source.substring(open + 1, close).trim() : "";
        return inner.isEmpty() ? null : inner;
    }
}
