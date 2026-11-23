package mindmodel.engine.dump;

import java.io.IOException;
import java.util.Collection;
import java.util.Map;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtType;

/** Annotations with their arguments as evaluated values, inline on the element that carries them. */
public final class Anns {

    private Anns() {
    }

    public static void write(JsonGenerator g, Collection<CtAnnotation<?>> annotations) throws IOException {
        g.writeArrayFieldStart("ann");
        for (CtAnnotation<?> a : annotations) {
            g.writeStartObject();
            g.writeStringField("name", writtenName(a));
            // The argument list as written: the extractors evaluate path strings and role expressions from this text,
            // and a value tree cannot carry `${...}` or a constant reference.
            g.writeStringField("raw", rawArgs(a));
            // The line the annotation is written on: a citation names where the declaration starts, annotations included.
            var where = a.getPosition();
            g.writeNumberField("line", where == null || !where.isValidPosition() ? 0 : where.getLine());
            g.writeObjectFieldStart("args");
            for (Map.Entry<String, Values.Value> e : Values.annotationArgs(a).entrySet()) {
                g.writeFieldName(e.getKey());
                writeValue(g, e.getValue());
            }
            g.writeEndObject();
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    /**
     * The annotation's name as the author wrote it (`Entity`, `jakarta.persistence.Entity`, `Builder.Default`).
     * Without a classpath Spoon cannot resolve an annotation it has no source for, and invents a package for it:
     * writing the source spelling is the only honest answer — Node resolves it against the file's imports.
     */
    private static String writtenName(CtAnnotation<?> a) {
        // A resolved annotation names its own package; one Spoon could not resolve gets the annotated type's own
        // package invented for it. Trust the first, and for the second write what the author wrote.
        CtType<?> owner = a.getParent(CtType.class);
        String ownerPkg = owner == null || owner.getPackage() == null ? "" : owner.getPackage().getQualifiedName();
        String spoon = Names.qualified(a.getAnnotationType());
        if (spoon.contains(".") && !(ownerPkg + ".").equals(spoon.substring(0, spoon.lastIndexOf('.') + 1)))
            return spoon;
        var p = a.getPosition();
        if (p != null && p.isValidPosition() && p.getCompilationUnit() != null) {
            String source = p.getCompilationUnit().getOriginalSourceCode();
            if (source != null && p.getSourceStart() >= 0 && p.getSourceEnd() < source.length()) {
                String text = source.substring(p.getSourceStart(), p.getSourceEnd() + 1);
                int open = text.indexOf('(');
                String name = (open >= 0 ? text.substring(0, open) : text).replace("@", "").replaceAll("\\s+", "");
                if (!name.isEmpty()) return name;
            }
        }
        return a.getAnnotationType().getSimpleName();
    }

    /** The source between the annotation's parentheses, verbatim; empty when it has none. */
    private static String rawArgs(CtAnnotation<?> a) {
        var p = a.getPosition();
        if (p == null || !p.isValidPosition() || p.getCompilationUnit() == null) return "";
        String source = p.getCompilationUnit().getOriginalSourceCode();
        if (source == null) return "";
        int start = p.getSourceStart();
        int end = p.getSourceEnd();
        if (start < 0 || end <= start || end >= source.length()) return "";
        String text = source.substring(start, end + 1);
        int open = text.indexOf('(');
        int close = text.lastIndexOf(')');
        return open >= 0 && close > open ? text.substring(open + 1, close).trim() : "";
    }

    public static void writeValue(JsonGenerator g, Values.Value v) throws IOException {
        if (v == null) {
            g.writeNull();
            return;
        }
        g.writeStartObject();
        g.writeStringField("kind", v.kind());
        g.writeFieldName("value");
        writeRaw(g, v.value());
        g.writeEndObject();
    }

    @SuppressWarnings("unchecked")
    private static void writeRaw(JsonGenerator g, Object value) throws IOException {
        if (value == null) {
            g.writeNull();
        } else if (value instanceof String s) {
            g.writeString(s);
        } else if (value instanceof Boolean b) {
            g.writeBoolean(b);
        } else if (value instanceof Number n) {
            g.writeNumber(n.toString());
        } else if (value instanceof Collection<?> list) {
            g.writeStartArray();
            for (Object item : list) {
                if (item instanceof Values.Value v) writeValue(g, v);
                else writeRaw(g, item);
            }
            g.writeEndArray();
        } else if (value instanceof Map<?, ?> map) {
            g.writeStartObject();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) map).entrySet()) {
                g.writeFieldName(e.getKey());
                if (e.getValue() instanceof Map<?, ?> nested && nested.get("kind") != null) {
                    g.writeStartObject();
                    g.writeStringField("kind", String.valueOf(nested.get("kind")));
                    g.writeFieldName("value");
                    writeRaw(g, nested.get("value"));
                    g.writeEndObject();
                } else writeRaw(g, e.getValue());
            }
            g.writeEndObject();
        } else {
            g.writeString(String.valueOf(value));
        }
    }
}
