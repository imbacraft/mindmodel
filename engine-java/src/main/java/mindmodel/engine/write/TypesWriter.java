package mindmodel.engine.write;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.CtClass;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.reference.CtTypeReference;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Names;
import mindmodel.engine.model.Positions;
import mindmodel.engine.resolve.Anns;
import mindmodel.engine.resolve.Refs;
import mindmodel.engine.resolve.Types;

/** types.ndjson: every declared type with its supertypes, annotations and position. */
public final class TypesWriter {

    private TypesWriter() {
    }

    public static void write(List<CtType<?>> types, Positions positions, Path out, Failures failures)
            throws IOException {
        try (Ndjson w = new Ndjson(out)) {
            for (CtType<?> t : types) w.row(g -> row(g, t, positions, failures));
        }
    }

    private static void row(JsonGenerator g, CtType<?> t, Positions positions, Failures failures) throws IOException {
        g.writeStringField("fqn", Names.qualified(t));
        g.writeStringField("kind", Types.kind(t));
        Json.modifiers(g, t.getModifiers());
        if (t.getDeclaringType() == null) g.writeNullField("enclosing");
        else g.writeStringField("enclosing", Names.qualified(t.getDeclaringType()));
        g.writeArrayFieldStart("typeParams");
        for (CtTypeParameter p : t.getFormalCtTypeParameters()) g.writeString(p.getSimpleName());
        g.writeEndArray();
        g.writeArrayFieldStart("supertypes");
        CtTypeReference<?> superclass = t instanceof CtClass<?> c ? c.getSuperclass() : null;
        if (superclass != null && !"java.lang.Object".equals(Names.qualified(superclass)))
            Json.supertype(g, "class", superclass, Refs.joinKey(superclass, t, failures));
        for (CtTypeReference<?> i : t.getSuperInterfaces())
            Json.supertype(g, "interface", i, Refs.joinKey(i, t, failures));
        g.writeEndArray();
        Json.annotations(g, Anns.of(t.getAnnotations()));
        Json.pos(g, positions.of(t));
    }
}
