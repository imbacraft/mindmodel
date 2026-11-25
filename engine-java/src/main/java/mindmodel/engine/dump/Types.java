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

    public static void write(List<CtType<?>> types, Positions positions, Path out) throws IOException {
        try (Ndjson w = new Ndjson(out)) {
            for (CtType<?> t : types) w.row(g -> writeRow(g, t, positions));
        }
    }

    private static void writeRow(JsonGenerator g, CtType<?> t, Positions positions) throws IOException {
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
        if (superclass != null && !"java.lang.Object".equals(Names.qualified(superclass))) supertype(g, "class", superclass);
        for (CtTypeReference<?> i : t.getSuperInterfaces()) supertype(g, "interface", i);
        g.writeEndArray();
        Anns.write(g, t.getAnnotations());
        Ndjson.pos(g, positions.of(t));
    }

    private static void supertype(JsonGenerator g, String kind, CtTypeReference<?> ref) throws IOException {
        g.writeStartObject();
        g.writeStringField("kind", kind);
        g.writeStringField("text", Names.typeText(ref));
        g.writeStringField("fqn", Names.qualified(ref));
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
