package mindmodel.engine.resolve;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;

import spoon.reflect.code.CtAssignment;
import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldAccess;
import spoon.reflect.code.CtFieldWrite;
import spoon.reflect.code.CtOperatorAssignment;
import spoon.reflect.code.CtThisAccess;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtEnum;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtTypeReference;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Names;
import mindmodel.engine.model.Positions;
import mindmodel.engine.model.Walk;

/**
 * One read or write of a field inside a method body, resolved: which field, whether it is static, and the value a write
 * stores. The writer sorts these and writes them; this class only decides what each one is.
 */
public final class FieldAccess {

    /**
     * One access with the value it carried. {@code isStatic} is null when the dump cannot tell (see {@link #isStatic}).
     */
    public record Row(String method, String field, Boolean isStatic, String op, Positions.Pos pos, Refs.Ref value,
                      List<String> typeArgs) {
    }

    /**
     * What the checkout says about a bare name that Spoon cannot declare: the fields Lombok writes (the logger) and the
     * constants of the enums the checkout declares, which a case label names with no receiver.
     */
    public record Known(Lombok.Index generated, Set<String> enumConstants) {

        /** The checkout's enum constants and Lombok's generated fields, read from the declared and known types. */
        public static Known of(List<CtType<?>> types, Lombok.Index generated) {
            Set<String> constants = new HashSet<>();
            for (CtType<?> type : types)
                if (type instanceof CtEnum<?> enumType)
                    for (var constant : enumType.getEnumValues()) constants.add(constant.getSimpleName());
            return new Known(generated, constants);
        }
    }

    private static final Set<String> IGNORED_SUPERTYPES = Set.of("java.lang.Object", "java.lang.Enum",
            "java.lang.Record");

    private FieldAccess() {
    }

    /** Collects the accesses of one body into {@code rows}; {@code methodId} is the member the body belongs to. */
    public static void collect(List<Row> rows, Walk.Body body, String methodId, Positions positions, Refs refs,
            Known known) {
        for (CtFieldAccess<?> access : body.fields()) {
            Positions.Pos pos = positions.of(access);
            if (pos == null) continue;
            CtFieldReference<?> ref = access.getVariable();
            // `X.class` is a class literal, not a field: no java field is named `class`, so the name says so.
            if (ref != null && "class".equals(ref.getSimpleName())) continue;
            // A method reference's qualifier that names a type is no field, so it writes no row, as `X.class` does.
            if (isTypeQualifierLink(access)) continue;
            boolean write = access instanceof CtFieldWrite<?>;
            // A write says what the method put there; a read says which field it read.
            Refs.Ref value = write ? writtenValue((CtFieldWrite<?>) access, refs) : refs.of(access);
            // The field's declared type's arguments: `GenericRepo<T>` is [T], and a reader that binds the parameter
            // knows what the field holds at that site.
            rows.add(new Row(methodId, Refs.fieldId(ref), isStatic(access, ref, known, refs.failures()),
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
     * Whether the field is static, or null when the dump cannot tell. In order: a `Type.field` access names a static
     * field only; an array's `length` is the array's own instance field; a declared field has the modifiers it
     * declares; a JDK field is read from the JVM. Otherwise the name is judged by what the source says about a bare
     * name (see {@link #namedStatic}), and when nothing says, the answer is unknown and the run counts it.
     */
    private static Boolean isStatic(CtFieldAccess<?> access, CtFieldReference<?> ref, Known known, Failures failures) {
        if (ref == null) {
            failures.count(Failures.Key.MODIFIERS_UNREADABLE);
            return null;
        }
        if (access.getTarget() instanceof CtTypeAccess<?>) return true;
        if (isArrayLength(access, ref)) return false;
        try {
            CtField<?> declared = ref.getDeclaration();
            if (declared != null) return declared.getModifiers().contains(ModifierKind.STATIC);
            // Spoon reads a field of a JDK class from the JVM; an empty answer is a field it cannot see, so not a fact.
            var jvm = ref.getModifiers();
            if (!jvm.isEmpty()) return jvm.contains(ModifierKind.STATIC);
        } catch (RuntimeException e) {
            // Spoon throws when the field's owner has no declaring type, or the JVM class has no such field.
        }
        Boolean named = namedStatic(access, ref, known);
        if (named == null) failures.count(Failures.Key.MODIFIERS_UNREADABLE);
        return named;
    }

    /**
     * What a bare name with no declaration is, from the source: a Lombok logger field of an enclosing type (static), a
     * static import of the name (static), or a case label naming an enum constant (static). Null when nothing says.
     * A receiver names its own members, which the dump cannot see, so only a bare name is judged here.
     */
    private static Boolean namedStatic(CtFieldAccess<?> access, CtFieldReference<?> ref, Known known) {
        if (access.getTarget() != null) return null;
        String name = ref.getSimpleName();
        Boolean generated = generatedStatic(access, name, known.generated());
        if (generated != null) return generated;
        if (access.getParent() instanceof CtCase<?> && known.enumConstants().contains(name)) return true;
        if (staticallyImported(access, name) && !libraryAncestor(access)) return true;
        return null;
    }

    /**
     * The modifiers of the Lombok field the nearest enclosing type writes under this name, or null when none does.
     * Lombok writes its logger as `private static final`, so the field is static, though no declaration says so here.
     */
    private static Boolean generatedStatic(CtFieldAccess<?> access, String name, Lombok.Index generated) {
        for (CtType<?> type = access.getParent(CtType.class); type != null; type = type.getParent(CtType.class)) {
            Lombok.Item field = generated.fields().get(Names.member(Names.qualified(type), name));
            if (field != null) return field.modifiers().contains(ModifierKind.STATIC);
        }
        return null;
    }

    /**
     * `arr.length`: the one field every array has, public and final and not static (JLS 10.7). Spoon gives it no
     * declaring type when the array's own type is unknown, so the array-ness is read from the receiver as well.
     */
    private static boolean isArrayLength(CtFieldAccess<?> access, CtFieldReference<?> ref) {
        if (!"length".equals(ref.getSimpleName())) return false;
        CtTypeReference<?> owner = ref.getDeclaringType();
        if (owner != null && owner.isArray()) return true;
        CtExpression<?> target = access.getTarget();
        return target != null && target.getType() != null && target.getType().isArray();
    }

    /**
     * True when an enclosing type inherits from a type the checkout does not declare: that type may declare a field of
     * the same name, which would shadow a static import. Object, Enum and Record declare no field a name can reach.
     */
    private static boolean libraryAncestor(CtFieldAccess<?> access) {
        for (CtType<?> type = access.getParent(CtType.class); type != null; type = type.getParent(CtType.class))
            if (inheritsFromLibrary(type, Collections.newSetFromMap(new IdentityHashMap<>()))) return true;
        return false;
    }

    private static boolean inheritsFromLibrary(CtType<?> type, Set<CtType<?>> seen) {
        try {
            List<CtTypeReference<?>> supers = new ArrayList<>(type.getSuperInterfaces());
            if (type.getSuperclass() != null) supers.add(type.getSuperclass());
            for (CtTypeReference<?> sup : supers) {
                if (IGNORED_SUPERTYPES.contains(Names.qualified(sup))) continue;
                CtType<?> declared = sup.getTypeDeclaration();
                if (declared == null) return true;
                if (seen.add(declared) && inheritsFromLibrary(declared, seen)) return true;
            }
            return false;
        } catch (RuntimeException e) {
            return true;
        }
    }

    /**
     * True when the access is a link of a method reference's qualifier and names a type (see {@link #namesType}). The
     * qualifier may be a chain (`Outer.Inner::build`), so the access is climbed to the whole qualifier first.
     */
    private static boolean isTypeQualifierLink(CtFieldAccess<?> access) {
        CtElement top = access;
        while (top.getParent() instanceof CtFieldAccess<?> up && up.getTarget() == top) top = up;
        if (!(top.getParent() instanceof CtExecutableReferenceExpression<?, ?> ref) || ref.getTarget() != top)
            return false;
        return namesType(access);
    }

    /**
     * Whether an undeclared name is a type: a simple name a single-type import brings in, or a nested type of a type the
     * checkout declares (or its Lombok builder, which `@Builder` names `<Owner>Builder`). A name that may be an inherited
     * field of a library superclass is left a field: the field would shadow the type.
     */
    private static boolean namesType(CtFieldAccess<?> access) {
        CtFieldReference<?> ref = access.getVariable();
        if (ref == null || ref.getDeclaration() != null) return false;
        String name = ref.getSimpleName();
        CtExpression<?> target = access.getTarget();
        if (target == null) return singleTypeImported(access, name) && !libraryAncestor(access);
        if (target instanceof CtTypeAccess<?> owner) return nestedType(owner.getAccessedType(), name);
        // `Outer.Inner` written inside `Outer` reaches Spoon as an implicit `this`: the qualifier names the class itself.
        return target instanceof CtThisAccess<?> self && self.isImplicit() && nestedType(self.getType(), name);
    }

    /** True when the checkout declares the type's nested type of this name, or the Lombok builder Lombok names for it. */
    private static boolean nestedType(CtTypeReference<?> owner, String name) {
        CtType<?> declared = owner.getTypeDeclaration();
        if (declared == null) return false;
        if (declared.getNestedType(name) != null) return true;
        boolean builder = declared.getAnnotations().stream().map(a -> a.getAnnotationType().getSimpleName())
                .anyMatch(n -> n.equals("Builder") || n.equals("SuperBuilder"));
        return builder && name.equals(declared.getSimpleName() + "Builder");
    }

    /** True when a non-static single-type import of the file ends in this simple name. */
    private static boolean singleTypeImported(CtFieldAccess<?> access, String name) {
        var position = access.getPosition();
        if (position == null || position.getCompilationUnit() == null) return false;
        for (var imported : position.getCompilationUnit().getImports()) {
            String text = imported.toString().replaceAll("\\s+", " ").replace(";", "").trim();
            if (text.startsWith("import ") && !text.startsWith("import static ") && text.endsWith("." + name)) return true;
        }
        return false;
    }

    /**
     * True when the file statically imports the name, singly or on demand. A static import brings in static members
     * only, so the name's field is static even when its owner is not in the checkout.
     */
    private static boolean staticallyImported(CtFieldAccess<?> access, String name) {
        var position = access.getPosition();
        if (position == null || position.getCompilationUnit() == null) return false;
        for (var imported : position.getCompilationUnit().getImports()) {
            String text = imported.toString().replaceAll("\\s+", " ").replace(";", "").trim();
            if (text.startsWith("import static ") && (text.endsWith("." + name) || text.endsWith(".*"))) return true;
        }
        return false;
    }
}
