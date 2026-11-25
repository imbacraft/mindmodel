package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;

import com.fasterxml.jackson.core.JsonGenerator;

import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtArrayTypeReference;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.reference.CtWildcardReference;

/**
 * library.ndjson: the shallow row of every library type the checkout names directly — a supertype, a field type, a
 * parameter or return type, a receiver — and that the classpath let Spoon read. No positions, no bodies: a reader can
 * see that a holder has a static ThreadLocal field, and can never cite into a jar. One level deep, sorted by name, so
 * the dump stays small and byte-identical for the same jars.
 *
 * <p>Without a classpath every reference stays a bare name and nothing is written: the dump is the same one the engine
 * wrote before, and the extractors keep their `unresolved` answers instead of inventing members.
 *
 * <p>Nothing here initialises a class: Spoon reads the .class bytes, and a static initialiser is never run.
 */
public final class LibraryStubs {

    /** A bound on the whole section; a big build reaches many types, and the dump must stay a dump. */
    private static final int LIMIT = 4000;

    private LibraryStubs() {
    }

    /** Writes the section. Returns how many rows it holds (resolved and unreadable together). */
    public static int write(List<CtType<?>> projectTypes, Collection<CtType<?>> known, Path out)
            throws IOException {
        Set<String> declared = new HashSet<>();
        // A generated source's types are declared here as much as any: naming one is not naming a library.
        for (CtType<?> t : known) declared.add(Names.qualified(t));
        // Every name the project writes down, sorted so the section never depends on Spoon's iteration order.
        TreeMap<String, CtTypeReference<?>> wanted = new TreeMap<>();
        for (CtType<?> t : projectTypes)
            for (CtTypeReference<?> ref : t.getReferencedTypes()) {
                CtTypeReference<?> raw = raw(ref);
                if (raw == null) continue;
                String fqn = Names.qualified(raw);
                if (fqn.isEmpty() || !fqn.contains(".") || declared.contains(fqn)) continue;
                // The JDK is always readable and holds nothing the app wrote: a row per String would be noise.
                if (fqn.startsWith("java.") || fqn.startsWith("javax.lang.model.")) continue;
                wanted.putIfAbsent(fqn, raw);
            }
        int written = 0;
        try (Ndjson w = new Ndjson(out)) {
            for (var entry : wanted.entrySet()) {
                if (written >= LIMIT) break;
                String fqn = entry.getKey();
                CtType<?> decl;
                try {
                    decl = entry.getValue().getTypeDeclaration();
                    if (decl == null || !readable(decl)) continue;
                } catch (Throwable failure) {
                    // A jar built for a newer Java, a truncated entry: one type is unreadable, the dump is not.
                    w.row(g -> unreadable(g, fqn, failure));
                    written++;
                    continue;
                }
                w.row(g -> type(g, fqn, decl));
                written++;
            }
        }
        return written;
    }

    /**
     * A type the classpath supplied: a shadow declaration that carries members. A bare shell — the name-only type
     * Spoon builds when it cannot read the class — carries nothing at all, not even a constructor.
     */
    private static boolean readable(CtType<?> decl) {
        return decl.isShadow() && !decl.getTypeMembers().isEmpty();
    }

    /** The base type a reference names, or null for an array, a type variable, a wildcard or a primitive. */
    private static CtTypeReference<?> raw(CtTypeReference<?> ref) {
        if (ref == null || ref instanceof CtArrayTypeReference<?> || ref instanceof CtTypeParameterReference
                || ref instanceof CtWildcardReference) return null;
        if (ref.isPrimitive() || "void".equals(ref.getSimpleName())) return null;
        return ref;
    }

    /**
     * One library type's row. Its lists are sorted: Spoon reads a class's fields and methods by reflection, whose
     * order the JVM does not promise, and the section must not depend on it. Fields by name; methods by name, then
     * parameter types.
     */
    private static void type(JsonGenerator g, String fqn, CtType<?> t) throws IOException {
        g.writeStringField("fqn", fqn);
        g.writeStringField("kind", Types.kind(t));
        g.writeStringField("origin", "library");
        g.writeArrayFieldStart("supers");
        for (CtTypeReference<?> s : t.getSuperInterfaces()) Types.supertype(g, "interface", s, Names.qualified(s));
        if (t.getSuperclass() != null && !"java.lang.Object".equals(Names.qualified(t.getSuperclass())))
            Types.supertype(g, "class", t.getSuperclass(), Names.qualified(t.getSuperclass()));
        g.writeEndArray();
        List<CtField<?>> fields = new ArrayList<>(t.getFields());
        fields.sort(Comparator.comparing((CtField<?> f) -> f.getSimpleName()));
        g.writeArrayFieldStart("fields");
        for (CtField<?> f : fields) {
            g.writeStartObject();
            g.writeStringField("name", f.getSimpleName());
            // With generic arguments: `java.lang.ThreadLocal<com.acme.Ctx>` is what makes a holder's element readable.
            g.writeStringField("type", Names.typeText(f.getType()));
            // A type variable names no type: a reader would take `Value` for a class, so the join key is null.
            if (f.getType() == null || f.getType() instanceof CtTypeParameterReference) g.writeNullField("typeFqn");
            else g.writeStringField("typeFqn", Names.qualified(f.getType()));
            Ndjson.modifiers(g, f.getModifiers());
            g.writeEndObject();
        }
        g.writeEndArray();
        List<CtMethod<?>> methods = new ArrayList<>(t.getMethods());
        methods.sort(Comparator.comparing((CtMethod<?> m) -> m.getSimpleName())
                .thenComparing(m -> paramTexts(m)));
        g.writeArrayFieldStart("methods");
        for (CtMethod<?> m : methods) {
            g.writeStartObject();
            g.writeStringField("name", m.getSimpleName());
            g.writeStringField("returns", Names.typeText(m.getType()));
            g.writeArrayFieldStart("params");
            for (CtParameter<?> p : m.getParameters()) {
                // A class file keeps no parameter names the dump may give: the name is unknown, not `arg0`.
                g.writeStartObject();
                g.writeStringField("type", Names.typeText(p.getType()));
                g.writeNullField("name");
                g.writeBooleanField("varargs", p.isVarArgs());
                g.writeEndObject();
            }
            g.writeEndArray();
            Ndjson.modifiers(g, m.getModifiers());
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    /** A method's parameter types, comma-joined, as the sort key that tells overloads apart. */
    private static String paramTexts(CtMethod<?> m) {
        List<String> texts = new ArrayList<>();
        for (CtParameter<?> p : m.getParameters()) texts.add(Names.typeText(p.getType()));
        return String.join(",", texts);
    }

    /**
     * A library type Spoon could not read, with the error shape every error row has: `origin: error`, `reason`, and the
     * same keys as a readable row, with the unknown ones null or empty (`kind` is unknown, nothing was read).
     */
    static void unreadable(JsonGenerator g, String fqn, Throwable failure) throws IOException {
        g.writeStringField("fqn", fqn);
        g.writeNullField("kind");
        g.writeStringField("origin", "error");
        String why = failure.getClass().getSimpleName();
        if (failure.getMessage() != null && !failure.getMessage().isBlank()) why += ": " + failure.getMessage();
        g.writeStringField("reason", why.length() > 200 ? why.substring(0, 200) : why);
        g.writeArrayFieldStart("supers");
        g.writeEndArray();
        g.writeArrayFieldStart("fields");
        g.writeEndArray();
        g.writeArrayFieldStart("methods");
        g.writeEndArray();
    }
}
