package mindmodel.engine.write;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;

import com.fasterxml.jackson.core.JsonGenerator;

import mindmodel.engine.model.Failures;
import mindmodel.engine.resolve.FieldAccess;
import mindmodel.engine.resolve.Refs;

/**
 * fields.ndjson: every read and write of a field inside a method body, sorted by file, position, operation and field. A
 * field Spoon could not name sorts first; a write whose value Spoon cannot describe carries an unresolved reference.
 */
public final class FieldsWriter {

    private FieldsWriter() {
    }

    public static void write(List<FieldAccess.Row> rows, Path out) throws IOException {
        // Sorted by file, position, operation and field: byte-identical across runs, and a reader can scan it. A field
        // Spoon could not name sorts first, where every other unresolved row sits.
        rows.sort(Comparator.comparing((FieldAccess.Row r) -> r.pos().file())
                .thenComparingInt(r -> r.pos().line())
                .thenComparingInt(r -> r.pos().col())
                .thenComparing(FieldAccess.Row::op)
                .thenComparing(FieldAccess.Row::field, Comparator.nullsFirst(Comparator.naturalOrder())));
        try (Ndjson w = new Ndjson(out)) {
            for (FieldAccess.Row row : rows) {
                try {
                    w.row(g -> writeRow(g, row));
                } catch (RuntimeException e) {
                    // The access is real even when Spoon cannot describe it; the row says which and why.
                    w.row(g -> errorRow(g, row, e));
                }
            }
        }
    }

    private static void writeRow(JsonGenerator g, FieldAccess.Row row) throws IOException {
        head(g, row);
        if (row.field() == null) {
            // A field written through a type Spoon could not name: the access is real, its identity is not.
            g.writeStringField("origin", "unresolved");
            g.writeStringField("reason", "no-declaring-type");
        } else {
            g.writeStringField("origin", "java");
        }
        writeValue(g, row.value());
    }

    /** An access Spoon could not describe: the row's keys, a null field and value, `origin: error` and the reason. */
    public static void errorRow(JsonGenerator g, FieldAccess.Row row, RuntimeException e) throws IOException {
        head(g, row);
        g.writeStringField("origin", "error");
        g.writeStringField("reason", Failures.reason(e));
        writeValue(g, Refs.Ref.unresolved(null, "error"));
    }

    private static void writeValue(JsonGenerator g, Refs.Ref value) throws IOException {
        g.writeObjectFieldStart("value");
        Json.ref(g, value);
        g.writeEndObject();
    }

    /** The keys every field row starts with; {@code field} is null when Spoon could not name the field's owner. */
    private static void head(JsonGenerator g, FieldAccess.Row row) throws IOException {
        g.writeStringField("method", row.method());
        Json.key(g, "field", row.field());
        // Unknown is null: a field whose static flag the dump cannot tell is written as null, never as false.
        if (row.isStatic() == null) g.writeNullField("static");
        else g.writeBooleanField("static", row.isStatic());
        g.writeStringField("op", row.op());
        g.writeStringField("kind", "access");
        g.writeArrayFieldStart("typeArgs");
        for (String argument : row.typeArgs()) g.writeString(argument);
        g.writeEndArray();
        g.writeStringField("file", row.pos().file());
        g.writeNumberField("line", row.pos().line());
        g.writeNumberField("col", row.pos().col());
    }
}
