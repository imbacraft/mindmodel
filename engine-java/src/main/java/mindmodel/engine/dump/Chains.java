package mindmodel.engine.dump;

import java.util.Map;
import java.util.Set;

import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.reference.CtTypeReference;

/**
 * The receiver type of an expression, chains included: `jmsContext.createProducer().send(...)` needs the return type of a
 * library call to know what `send` is called on, and `booking.toBuilder().guestName(x).build()` needs the same for the
 * members Lombok writes. A project declaration answers first, the Lombok synthesis second, the library table third;
 * anything else is unknown and stays unknown.
 */
final class Chains {

    /** `owner#name/argc -> return type` for generated members; `owner#name` is the arity-blind fallback. */
    private final Map<String, String> generated;
    /** Builder types the synthesis invents (`Foo.Builder`): not declared, and not a library either. */
    private final Set<String> builders;

    Chains(Map<String, String> generated, Set<String> builders) {
        this.generated = generated;
        this.builders = builders;
    }

    String receiver(CtExpression<?> expression) {
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

    /** A builder type the synthesis invented, rather than something the source declares. */
    boolean isBuilder(String fqn) {
        return fqn != null && builders.contains(fqn);
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
        String fromLombok = generated.get(owner + "#" + ref.getSimpleName() + "/" + argc);
        if (fromLombok == null) fromLombok = generated.get(owner + "#" + ref.getSimpleName());
        return LibraryTypes.raw(fromLombok);
    }
}
