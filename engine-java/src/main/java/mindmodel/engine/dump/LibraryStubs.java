package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;

import com.fasterxml.jackson.core.JsonGenerator;

import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
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
    public static int write(List<CtType<?>> projectTypes, java.util.Collection<CtType<?>> known, Path out)
            throws IOException {
        Set<String> declared = new java.util.HashSet<>();
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

    private static void type(JsonGenerator g, String fqn, CtType<?> t) throws IOException {
        g.writeStringField("fqn", fqn);
        g.writeStringField("kind", kind(t));
        g.writeStringField("origin", "library");
        g.writeArrayFieldStart("supers");
        for (CtTypeReference<?> s : t.getSuperInterfaces()) g.writeString(Names.qualified(s));
        if (t.getSuperclass() != null && !"java.lang.Object".equals(Names.qualified(t.getSuperclass())))
            g.writeString(Names.qualified(t.getSuperclass()));
        g.writeEndArray();
        g.writeArrayFieldStart("fields");
        for (CtField<?> f : t.getFields()) {
            g.writeStartObject();
            g.writeStringField("name", f.getSimpleName());
            // With generic arguments: `java.lang.ThreadLocal<com.acme.Ctx>` is what makes a holder's element readable.
            g.writeStringField("type", Names.typeText(f.getType()));
            g.writeStringField("typeFqn", rawName(f.getType()));
            g.writeArrayFieldStart("modifiers");
            for (ModifierKind m : f.getModifiers()) g.writeString(m.name().toLowerCase());
            g.writeEndArray();
            g.writeEndObject();
        }
        g.writeEndArray();
        g.writeArrayFieldStart("methods");
        for (CtMethod<?> m : t.getMethods()) {
            g.writeStartObject();
            g.writeStringField("name", m.getSimpleName());
            g.writeStringField("returns", Names.typeText(m.getType()));
            g.writeArrayFieldStart("params");
            List<String> types = new ArrayList<>();
            for (CtParameter<?> p : m.getParameters()) types.add(Names.typeText(p.getType()));
            for (String type : types) g.writeString(type);
            g.writeEndArray();
            g.writeArrayFieldStart("modifiers");
            for (ModifierKind kind : m.getModifiers()) g.writeString(kind.name().toLowerCase());
            g.writeEndArray();
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    private static void unreadable(JsonGenerator g, String fqn, Throwable failure) throws IOException {
        g.writeStringField("fqn", fqn);
        g.writeStringField("origin", "library");
        g.writeStringField("unresolved", "library-class-unreadable");
        String why = failure.getClass().getSimpleName();
        if (failure.getMessage() != null && !failure.getMessage().isBlank()) why += ": " + failure.getMessage();
        g.writeStringField("reason", why.length() > 200 ? why.substring(0, 200) : why);
    }

    private static String rawName(CtTypeReference<?> ref) {
        if (ref == null) return "";
        String fqn = Names.qualified(ref);
        return fqn.replaceAll("<.*", "");
    }

    private static String kind(CtType<?> t) {
        if (t.isInterface()) return "interface";
        if (t.isEnum()) return "enum";
        if (t.isAnnotationType()) return "annotation";
        return "class";
    }
}
