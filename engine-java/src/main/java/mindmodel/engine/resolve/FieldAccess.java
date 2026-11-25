package mindmodel.engine.resolve;

import java.util.List;

import spoon.reflect.code.CtAssignment;
import spoon.reflect.code.CtFieldAccess;
import spoon.reflect.code.CtFieldWrite;
import spoon.reflect.code.CtOperatorAssignment;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtFieldReference;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Names;
import mindmodel.engine.model.Positions;
import mindmodel.engine.model.Walk;

/**
 * One read or write of a field inside a method body, resolved: which field, whether it is static, and the value a write
 * stores. The writer sorts these and writes them; this class only decides what each one is.
 */
public final class FieldAccess {

    /** One access with the value it carried. */
    public record Row(String method, String field, boolean isStatic, String op, Positions.Pos pos, Refs.Ref value,
                      List<String> typeArgs) {
    }

    private FieldAccess() {
    }

    /** Collects the accesses of one body into {@code rows}; {@code methodId} is the member the body belongs to. */
    public static void collect(List<Row> rows, Walk.Body body, String methodId, Positions positions, Refs refs) {
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
            rows.add(new Row(methodId, Refs.fieldId(ref), isStatic(access, ref, refs.failures()),
                    write ? "write" : "read", pos, value, refs.typeArgs(ref == null ? null : ref.getType(), access)));
        }
    }

    /**
     * What a field write stores. A plain assignment stores its right-hand side. A compound one (`+=`) stores the old
     * value combined with the right-hand side, which no expression here gives: it is unresolved, and its text keeps the
     * operator.
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
            failures.count(Failures.Key.MODIFIERS_UNREADABLE);
            return false;
        }
    }

    /**
     * True when the file statically imports the field by name or its owner's members by wildcard, and the access has no
     * receiver written (`PI` after `import static java.lang.Math.PI;`).
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
}
