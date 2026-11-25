package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtRecord;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.reference.CtTypeReference;

/** types.ndjson: every declared type with its supertypes, annotations and position. */
public final class Types {

    private Types() {
    }

    public static void write(List<CtType<?>> types, Positions positions, Path out, Failures failures)
            throws IOException {
        try (Ndjson w = new Ndjson(out)) {
            for (CtType<?> t : types) w.row(g -> writeRow(g, t, positions, failures));
        }
    }

    private static void writeRow(JsonGenerator g, CtType<?> t, Positions positions, Failures failures)
            throws IOException {
        g.writeStringField("fqn", Names.qualified(t));
        g.writeStringField("kind", kind(t));
        Ndjson.modifiers(g, t.getModifiers());
        if (t.getDeclaringType() == null) g.writeNullField("enclosing");
        else g.writeStringField("enclosing", Names.qualified(t.getDeclaringType()));
        g.writeArrayFieldStart("typeParams");
        for (CtTypeParameter p : t.getFormalCtTypeParameters()) g.writeString(p.getSimpleName());
        g.writeEndArray();
        g.writeArrayFieldStart("supertypes");
        CtTypeReference<?> superclass = t instanceof CtClass<?> c ? c.getSuperclass() : null;
        if (superclass != null && !"java.lang.Object".equals(Names.qualified(superclass)))
            supertype(g, "class", superclass, Refs.joinKey(superclass, t, failures));
        for (CtTypeReference<?> i : t.getSuperInterfaces())
            supertype(g, "interface", i, Refs.joinKey(i, t, failures));
        g.writeEndArray();
        Anns.write(g, t.getAnnotations());
        Ndjson.pos(g, positions.of(t));
    }

    /**
     * One supertype, the same shape in types.ndjson and library.ndjson: `kind` is the relation (`class` or `interface`),
     * `type` the type as written, `typeFqn` its join key (null when the type has no name the dump may give).
     */
    static void supertype(JsonGenerator g, String kind, CtTypeReference<?> ref, String typeFqn) throws IOException {
        g.writeStartObject();
        g.writeStringField("kind", kind);
        g.writeStringField("type", Names.typeText(ref));
        if (typeFqn == null) g.writeNullField("typeFqn");
        else g.writeStringField("typeFqn", typeFqn);
        g.writeEndObject();
    }

    public static String kind(CtType<?> t) {
        if (t.isAnnotationType()) return "annotation";
        if (t.isInterface()) return "interface";
        if (t.isEnum()) return "enum";
        if (t instanceof CtRecord) return "record";
        return "class";
    }
}
