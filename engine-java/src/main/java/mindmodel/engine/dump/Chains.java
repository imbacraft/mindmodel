package mindmodel.engine.dump;

import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.code.CtThisAccess;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * The receiver type of an expression, chains included: `jmsContext.createProducer().send(...)` needs the return type of a
 * library call to know what `send` is called on, and `booking.toBuilder().guestName(x).build()` needs the same for the
 * members Lombok writes. A project declaration answers first, the Lombok synthesis second, the library table third;
 * anything else is unknown and stays unknown.
 */
final class Chains {

    private final Lombok.Index generated;
    private final Failures failures;

    Chains(Lombok.Index generated, Failures failures) {
        this.generated = generated;
        this.failures = failures;
    }

    String receiver(CtExpression<?> expression) {
        if (expression == null) return null;
        if (expression instanceof CtInvocation<?> call) return result(call);
        if (expression instanceof CtTypeAccess<?> access) return Names.qualified(access.getAccessedType());
        if (expression instanceof CtThisAccess<?> self) {
            // Inside a lambda Spoon writes the implicit `this`, but its type is the lambda, not the enclosing class.
            var owner = self.getParent(CtType.class);
            if (owner != null) return Names.nameOf(owner);
        }
        // `var x = ...`: Spoon 11.5 leaves some locals typed Object, but the initializer it inferred from is still
        // there. A receiver keeps the local's own type when Spoon resolved one, is typed from the initializer when it
        // did not, and stays unresolved when neither source can say — never Object by default.
        if (expression instanceof CtVariableRead<?> read) {
            var declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
            if (declaration instanceof CtLocalVariable<?> local && local.isInferred()) {
                String own = rawType(local.getType());
                return known(own) ? own : inferred(local);
            }
        }
        CtTypeReference<?> type = expression.getType();
        return type == null ? null : LibraryTypes.raw(Names.qualified(type));
    }

    /** The type a `var` local's initializer gives it, or null when no source in the dump can say. */
    private String inferred(CtLocalVariable<?> local) {
        CtExpression<?> initializer = local.getDefaultExpression() != null ? local.getDefaultExpression()
                : local.getAssignment();
        if (initializer == null) return null;
        String direct = rawType(initializer.getType());
        if (known(direct)) return direct;
        // A chain (`repo.find(id).orElse(null)`) is typed the way every other chain is: from its own call rows.
        if (initializer instanceof CtInvocation<?> call) {
            String chained = result(call);
            return known(chained) ? chained : null;
        }
        return null;
    }

    /** True for a receiver type a source in the dump actually named; `Object` is what Spoon writes when it gave up. */
    private static boolean known(String type) {
        return type != null && !"java.lang.Object".equals(type) && !"?".equals(type);
    }

    private String rawType(CtTypeReference<?> type) {
        if (type == null || type instanceof CtTypeParameterReference) return null;
        try {
            return LibraryTypes.raw(Names.qualified(type));
        } catch (RuntimeException e) {
            failures.count("chains.typeUnresolved");
            return null;
        }
    }

    /** A builder type the synthesis invented, rather than something the source declares. */
    boolean isBuilder(String fqn) {
        return fqn != null && generated.builders().contains(fqn);
    }

    /** The raw type an invocation evaluates to, or null when no source of truth can say. */
    String result(CtInvocation<?> call) {
        var ref = call.getExecutable();
        var declaration = ref == null ? null : ref.getDeclaration();
        if (declaration instanceof CtMethod<?> method && method.getDeclaringType() != null)
            return LibraryTypes.raw(Names.qualified(method.getType()));
        String owner = ref == null || ref.getDeclaringType() == null ? null : Names.qualified(ref.getDeclaringType());
        if (owner == null && ref != null) owner = receiver(call.getTarget());
        if (owner == null || ref == null) return null;
        int argc = call.getArguments().size();
        String fromLibrary = LibraryTypes.returnType(owner, ref.getSimpleName(), argc);
        if (fromLibrary != null) return fromLibrary;
        Lombok.Item item = generated.method(owner, ref.getSimpleName(), argc);
        return item == null ? null : LibraryTypes.raw(item.typeFqn());
    }
}
