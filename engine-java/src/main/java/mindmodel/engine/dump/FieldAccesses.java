package mindmodel.engine.dump;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.fasterxml.jackson.core.JsonGenerator;

import spoon.reflect.code.CtAssignment;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldAccess;
import spoon.reflect.code.CtFieldWrite;
import spoon.reflect.code.CtOperatorAssignment;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.declaration.ModifierKind;
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
    record Row(String method, String field, boolean isStatic, String op, Positions.Pos pos, Refs.Ref value,
               List<String> typeArgs) {
    }

    /** Collects the accesses of one body into `rows`; `methodId` is the member the body belongs to. */
    static void collect(List<Row> rows, Walk.Body body, String methodId, Positions positions, Refs refs) {
        for (CtFieldAccess<?> access : body.fields()) {
            Positions.Pos pos = positions.of(access);
            if (pos == null) continue;
            CtFieldReference<?> ref = access.getVariable();
            // `X.class` is a class literal, not a field: no java field is named `class`, so the name says so.
            if (ref != null && "class".equals(ref.getSimpleName())) continue;
            boolean write = access instanceof CtFieldWrite<?>;
            // A write says what the method put there; a read says which field it read.
            Refs.Ref value = write ? writtenValue((CtFieldWrite<?>) access, refs) : refs.of(access);
            // The field's declared type's arguments: `GenericRepo<T>` is [T], and a reader that binds the parameter
            // knows what the field holds at that site.
            rows.add(new Row(methodId, Refs.fieldId(ref), isStatic(access, ref, refs.failures()), write ? "write" : "read",
                    pos, value, refs.typeArgs(ref == null ? null : ref.getType(), access)));
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

    /**
     * What a field write stores. A plain assignment stores its right-hand side. A compound one (`+=`) stores the old
     * value combined with the right-hand side, which no expression here gives: it is unresolved, and its text keeps
     * the operator.
     */
    private static Refs.Ref writtenValue(CtFieldWrite<?> write, Refs refs) {
        // A compound assignment is an assignment too, so it is tested first.
        if (write.getParent() instanceof CtOperatorAssignment<?, ?> compound && compound.getAssigned() == write)
            return Refs.Ref.unresolved(refs.textOf(compound), "compound-assignment");
        if (write.getParent() instanceof CtAssignment<?, ?> assignment && assignment.getAssigned() == write)
            return refs.of(assignment.getAssignment());
        return refs.of(write);
    }

    /**
     * Whether the field is static. A `Type.field` access names a static field only, so a type-named receiver decides it
     * even where Spoon cannot see the declaration (`System.out`). A field whose modifiers Spoon cannot read is not
     * static, and the run counts it.
     */
    private static boolean isStatic(CtFieldAccess<?> access, CtFieldReference<?> ref, Failures failures) {
        if (ref == null) return false;
        if (access.getTarget() instanceof CtTypeAccess<?>) return true;
        try {
            return ref.getModifiers().contains(ModifierKind.STATIC) || importedStatically(access, ref);
        } catch (RuntimeException e) {
            failures.count("fields.modifiersUnreadable");
            return false;
        }
    }

    /**
     * True when the file statically imports the field by name or its owner's members by wildcard, and the access has no
     * receiver written (`PI` after `import static java.lang.Math.PI;`). Without a receiver, the file's imports are the
     * only place the field can come from that is not the class's own.
     */
    private static boolean importedStatically(CtFieldAccess<?> access, CtFieldReference<?> ref) {
        if (access.getTarget() != null || ref.getDeclaringType() == null) return false;
        var position = access.getPosition();
        if (position == null || position.getCompilationUnit() == null) return false;
        String owner = Names.qualified(ref.getDeclaringType());
        String named = "import static " + owner + "." + ref.getSimpleName();
        String all = "import static " + owner + ".*";
        for (var imported : position.getCompilationUnit().getImports()) {
            String text = imported.toString().replaceAll("\\s+", " ").replace(";", "").trim();
            if (text.equals(named) || text.equals(all)) return true;
        }
        return false;
    }

    private static void writeRow(JsonGenerator g, Row row) throws IOException {
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
    static void errorRow(JsonGenerator g, Row row, RuntimeException e) throws IOException {
        head(g, row);
        g.writeStringField("origin", "error");
        g.writeStringField("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
        writeValue(g, Refs.Ref.unresolved(null, "error"));
    }

    private static void writeValue(JsonGenerator g, Refs.Ref value) throws IOException {
        g.writeObjectFieldStart("value");
        Refs.write(g, value);
        g.writeEndObject();
    }

    /** The keys every field row starts with; `field` is null when Spoon could not name the field's owner. */
    private static void head(JsonGenerator g, Row row) throws IOException {
        g.writeStringField("method", row.method());
        if (row.field() == null) g.writeNullField("field");
        else g.writeStringField("field", row.field());
        g.writeBooleanField("static", row.isStatic());
        g.writeStringField("op", row.op());
        g.writeStringField("kind", "access");
        g.writeArrayFieldStart("typeArgs");
        for (String argument : row.typeArgs()) g.writeString(argument);
        g.writeEndArray();
        g.writeStringField("file", row.pos().file());
        g.writeNumberField("line", row.pos().line());
        g.writeNumberField("col", row.pos().col());
    }

    /** A fresh list to collect into. */
    static List<Row> rows() {
        return new ArrayList<>();
    }
}
