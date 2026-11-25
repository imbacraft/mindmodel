package mindmodel.engine.write;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.JsonGenerator;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtTypeReference;

import mindmodel.engine.model.Names;
import mindmodel.engine.model.Positions;
import mindmodel.engine.resolve.Anns;
import mindmodel.engine.resolve.Refs;
import mindmodel.engine.resolve.Values;

/**
 * The JSON shapes the rows share, each written one way: a position, a modifier list, a nullable key, a value, an
 * annotation, a reference and a supertype. Every row writer goes through here, so a shape cannot drift between
 * sections.
 */
public final class Json {

    private Json() {
    }

    /** The {@code pos} object of a declaration, or {@code null} when the element has no position. */
    public static void pos(JsonGenerator g, Positions.Pos p) throws IOException {
        if (p == null) {
            g.writeNullField("pos");
            return;
        }
        g.writeObjectFieldStart("pos");
        g.writeStringField("file", p.file());
        g.writeNumberField("line", p.line());
        g.writeNumberField("col", p.col());
        g.writeNumberField("endLine", p.endLine());
        g.writeNumberField("endCol", p.endCol());
        g.writeEndObject();
    }

    /** The {@code modifiers} array: Java's spelling, sorted, since an immutable set's order is salted per JVM. */
    public static void modifiers(JsonGenerator g, Collection<ModifierKind> modifiers) throws IOException {
        List<String> names = new ArrayList<>();
        for (ModifierKind m : modifiers) names.add(modifierName(m));
        Collections.sort(names);
        g.writeArrayFieldStart("modifiers");
        for (String m : names) g.writeString(m);
        g.writeEndArray();
    }

    /**
     * The one spelling of a modifier: Java's own (`non-sealed`), never a case-folded enum name, which is
     * locale-dependent and folds `NON_SEALED` to `non_sealed`.
     */
    static String modifierName(ModifierKind modifier) {
        return modifier.toString();
    }

    /** A string-valued key: written as null when the value is unknown, never as an empty string. */
    public static void key(JsonGenerator g, String key, String value) throws IOException {
        if (value == null) g.writeNullField(key);
        else g.writeStringField(key, value);
    }

    /** The {@code ann} array of an element's annotations, in source order. */
    public static void annotations(JsonGenerator g, List<Anns.Ann> annotations) throws IOException {
        g.writeArrayFieldStart("ann");
        for (Anns.Ann a : annotations) {
            g.writeStartObject();
            g.writeStringField("name", a.name());
            key(g, "raw", a.raw());
            if (a.line() == null) g.writeNullField("line");
            else g.writeNumberField("line", a.line());
            g.writeObjectFieldStart("args");
            for (Map.Entry<String, Values.Value> e : a.args().entrySet()) {
                g.writeFieldName(e.getKey());
                value(g, e.getValue());
            }
            g.writeEndObject();
            g.writeEndObject();
        }
        g.writeEndArray();
    }

    /** A folded value as {@code {kind, value}}, or null when there is none. */
    public static void value(JsonGenerator g, Values.Value v) throws IOException {
        if (v == null) {
            g.writeNull();
            return;
        }
        g.writeStartObject();
        g.writeStringField("kind", v.kind());
        g.writeFieldName("value");
        raw(g, v.value());
        g.writeEndObject();
    }

    /**
     * The value of a {@link Values.Value}, in its JSON form: a nested value keeps the same {@code {kind, value}}
     * shape.
     */
    @SuppressWarnings("unchecked")
    static void raw(JsonGenerator g, Object value) throws IOException {
        if (value == null) {
            g.writeNull();
        } else if (value instanceof Values.Value folded) {
            value(g, folded);
        } else if (value instanceof String s) {
            g.writeString(s);
        } else if (value instanceof Boolean b) {
            g.writeBoolean(b);
        } else if (value instanceof Number n) {
            g.writeNumber(n.toString());
        } else if (value instanceof Collection<?> list) {
            g.writeStartArray();
            for (Object item : list) {
                if (item instanceof Values.Value v) value(g, v);
                else raw(g, item);
            }
            g.writeEndArray();
        } else if (value instanceof Map<?, ?> map) {
            g.writeStartObject();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) map).entrySet()) {
                g.writeFieldName(e.getKey());
                raw(g, e.getValue());
            }
            g.writeEndObject();
        } else {
            g.writeString(String.valueOf(value));
        }
    }

    /**
     * One expression as data, written into the object the caller has started: every field it knows, nothing it does
     * not. A reference that is absent is written as an unresolved one, so the keys stay the same.
     */
    public static void ref(JsonGenerator g, Refs.Ref ref) throws IOException {
        Refs.Ref r = ref == null ? Refs.Ref.unresolved(null, "no-expression") : ref;
        key(g, "text", r.text());
        g.writeStringField("kind", r.kind());
        key(g, "typeFqn", r.type());
        // A folded value has the one shape every value has (`{kind, value}`); `kind` here is the expression's own.
        if (r.valueKind() != null) {
            g.writeFieldName("value");
            value(g, new Values.Value(r.valueKind(), r.value()));
        }
        if (r.field() != null) g.writeStringField("field", r.field());
        if (r.call() != null) g.writeStringField("call", r.call());
        if (r.from() != null) g.writeStringField("from", r.from());
        if (r.index() != null) g.writeNumberField("index", r.index());
        // Only a parameter says whether it is a lambda's: every other reference has no such answer and writes none.
        if ("param".equals(r.kind())) g.writeBooleanField("inLambda", r.inLambda());
        if (r.created() != null) g.writeStringField("created", r.created());
        if (r.reason() != null) g.writeStringField("reason", r.reason());
        if (r.then() != null) {
            g.writeObjectFieldStart("then");
            ref(g, r.then());
            g.writeEndObject();
        }
        if (r.otherwise() != null) {
            g.writeObjectFieldStart("otherwise");
            ref(g, r.otherwise());
            g.writeEndObject();
        }
    }

    /**
     * One supertype, the same shape in types.ndjson and library.ndjson: {@code kind} is the relation (`class` or
     * `interface`), {@code type} the type as written, {@code typeFqn} its join key (null when there is none).
     */
    public static void supertype(JsonGenerator g, String kind, CtTypeReference<?> ref, String typeFqn)
            throws IOException {
        g.writeStartObject();
        g.writeStringField("kind", kind);
        g.writeStringField("type", Names.typeText(ref));
        key(g, "typeFqn", typeFqn);
        g.writeEndObject();
    }
}
