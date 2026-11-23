package mindmodel.engine.dump;

import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.reference.CtTypeReference;

/**
 * The receiver type of an expression, chains included: `jmsContext.createProducer().send(...)` needs the return type of a
 * library call to know what `send` is called on. A project declaration answers first; the library table answers second;
 * anything else is unknown and stays unknown.
 */
final class Chains {

    private Chains() {
    }

    static String receiver(CtExpression<?> expression) {
        if (expression == null) return null;
        if (expression instanceof CtInvocation<?> call) return result(call);
        if (expression instanceof CtTypeAccess<?> access) return Names.qualified(access.getAccessedType());
        if (expression instanceof spoon.reflect.code.CtThisAccess<?> self) {
            // Inside a lambda Spoon writes the implicit `this`, but its type is the lambda, not the enclosing class.
            var owner = self.getParent(spoon.reflect.declaration.CtType.class);
            if (owner != null) return Names.qualified(owner);
        }
        CtTypeReference<?> type = expression.getType();
        return type == null ? null : LibraryTypes.raw(Names.qualified(type));
    }

    /** The raw type an invocation evaluates to, or null when neither the declaration nor the table can say. */
    static String result(CtInvocation<?> call) {
        var ref = call.getExecutable();
        var declaration = ref == null ? null : ref.getDeclaration();
        if (declaration instanceof CtMethod<?> method && method.getDeclaringType() != null)
            return LibraryTypes.raw(Names.qualified(method.getType()));
        String owner = ref == null || ref.getDeclaringType() == null ? null : Names.qualified(ref.getDeclaringType());
        if (owner == null && ref != null) owner = receiver(call.getTarget());
        if (owner == null || ref == null) return null;
        return LibraryTypes.returnType(owner, ref.getSimpleName(), call.getArguments().size());
    }
}
