package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.fasterxml.jackson.core.JsonGenerator;

import spoon.reflect.code.CtFieldAccess;
import spoon.reflect.code.CtFieldWrite;
import spoon.reflect.reference.CtFieldReference;

/**
 * fields.ndjson: every read and write of a field inside a method body.
 *
 * <pre>{ "method": "<id>", "field": "<owner fqn>#<name>", "static": true, "op": "write", "file": "...", "line": 42,
 *        "col": 9, "value": { ...reference... } }</pre>
 *
 * Which methods set the static ThreadLocal of a type is this file filtered by field and op — a fact about the code, not
 * a conclusion about what the field means. A write whose value Spoon cannot describe carries an unresolved reference.
 *
 * Rows are collected while the body is the current scope of {@link Refs}, then sorted by file and position and written.
 */
final class FieldAccesses {

    private FieldAccesses() {
    }

    /** One access with the value it carried, already resolved. */
    record Row(String method, String field, boolean isStatic, String op, Positions.Pos pos, Refs.Ref value) {
    }

    /** Collects the accesses of one body into `rows`; `methodId` is the member the body belongs to. */
    static void collect(List<Row> rows, Walk.Body body, String methodId, Path root, Refs refs) {
        for (CtFieldAccess<?> access : body.fields()) {
            Positions.Pos pos = Positions.of(access, root);
            if (pos == null) continue;
            CtFieldReference<?> ref = access.getVariable();
            String field = Refs.fieldId(ref);
            String op = access instanceof CtFieldWrite<?> ? "write" : "read";
            // A write says what the method put there; a read says which field it read.
            Refs.Ref value = access instanceof CtFieldWrite<?> write ? refs.of(valueOf(write)) : refs.of(access);
            rows.add(new Row(methodId, field, isStatic(ref), op, pos, value));
        }
    }

    static void write(List<Row> rows, Path out) throws IOException {
        // Sorted by file, position, operation and field: byte-identical across runs, and a reader can scan it. A field
        // Spoon could not name sorts first, where every other unresolved row sits.
        rows.sort(Comparator.comparing((Row r) -> r.pos().file())
                .thenComparingInt(r -> r.pos().line())
                .thenComparingInt(r -> r.pos().col())
                .thenComparing(Row::op)
                .thenComparing(Row::field, Comparator.nullsFirst(Comparator.naturalOrder())));
        try (Ndjson w = new Ndjson(out)) {
            for (Row row : rows) {
                try {
                    w.row(g -> writeRow(g, row));
                } catch (RuntimeException e) {
                    // The access is real even when Spoon cannot describe it; the row says which and why.
                    w.row(g -> errorRow(g, row, e));
                }
            }
        }
    }

    /** The value an assignment gives a field write, or the write itself when it is not a plain assignment. */
    private static spoon.reflect.code.CtExpression<?> valueOf(CtFieldWrite<?> write) {
        if (write.getParent() instanceof spoon.reflect.code.CtAssignment<?, ?> assignment
                && assignment.getAssigned() == write)
            return assignment.getAssignment();
        return write;
    }

    private static boolean isStatic(CtFieldReference<?> ref) {
        if (ref == null) return false;
        try {
            return ref.getModifiers().contains(spoon.reflect.declaration.ModifierKind.STATIC);
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static void writeRow(JsonGenerator g, Row row) throws IOException {
        head(g, row);
        if (row.field() == null) {
            // A field written through a type Spoon could not name: the access is real, its identity is not.
            g.writeStringField("origin", "unresolved");
            g.writeStringField("reason", "no-declaring-type");
        }
        g.writeObjectFieldStart("value");
        Refs.write(g, row.value());
        g.writeEndObject();
    }

    private static void errorRow(JsonGenerator g, Row row, RuntimeException e) throws IOException {
        head(g, row);
        g.writeStringField("origin", "error");
        g.writeStringField("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
    }

    private static void head(JsonGenerator g, Row row) throws IOException {
        g.writeStringField("method", row.method());
        if (row.field() == null) g.writeNullField("field");
        else g.writeStringField("field", row.field());
        g.writeBooleanField("static", row.isStatic());
        g.writeStringField("op", row.op());
        g.writeStringField("file", row.pos().file());
        g.writeNumberField("line", row.pos().line());
        g.writeNumberField("col", row.pos().col());
    }

    /** A fresh list to collect into. */
    static List<Row> rows() {
        return new ArrayList<>();
    }
}
