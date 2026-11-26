package mindmodel.engine.resolve;

import java.util.List;

import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtSuperAccess;
import spoon.reflect.code.CtThisAccess;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtFormalTypeDeclarer;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.CtTypeParameter;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.reference.CtWildcardReference;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Names;

/**
 * The receiver type of an expression, chains included: `jmsContext.createProducer().send(...)` needs the return type of
 * a library call to know what `send` is called on, and `booking.toBuilder().guestName(x).build()` needs the same for
 * the members Lombok writes. A project declaration answers first, the Lombok synthesis second, the library table third;
 * anything else is unknown and stays unknown.
 */
public final class Chains {

    private final Lombok.Index generated;
    private final Failures failures;

    public Chains(Lombok.Index generated, Failures failures) {
        this.generated = generated;
        this.failures = failures;
    }

    /**
     * A name no declaration gives (`mystery.call()`). Spoon types such a read as the class it is written in, so the
     * name has no receiver type the source names. Spoon gives it no declaring type either; a library field it cannot
     * see has one.
     */
    boolean undeclaredName(CtExpression<?> expression) {
        // `super` and `this` are variable reads in Spoon too, with no declaration of their own.
        if (!(expression instanceof CtVariableRead<?> read) || expression instanceof CtSuperAccess<?>
                || expression instanceof CtThisAccess<?>) return false;
        var variable = read.getVariable();
        if (variable == null) return true;
        boolean owned = variable instanceof CtFieldReference<?> field && field.getDeclaringType() != null;
        return variable.getDeclaration() == null && !owned;
    }

    String receiver(CtExpression<?> expression) {
        if (expression == null || undeclaredName(expression)) return null;
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
        // A field read of a type-parameter type (`cache.value`) is bound the way a call's return type is.
        if (expression instanceof CtFieldRead<?> read && read.getVariable() != null
                && read.getVariable().getDeclaration() != null) {
            CtField<?> field = read.getVariable().getDeclaration();
            return declared(field.getType(), null, field.getDeclaringType(), read.getTarget());
        }
        CtTypeReference<?> type = typeOf(expression);
        return type == null ? null : rawType(type);
    }

    /**
     * The type an expression has as the dump names it. A parameter or a local read takes the type its declaration
     * writes: a read inside a lambda can lose its own type when the lambda's target type is not on the classpath. Any
     * other expression has the type Spoon gives it.
     */
    static CtTypeReference<?> typeOf(CtExpression<?> expression) {
        if (expression instanceof CtVariableRead<?> read && read.getVariable() != null) {
            var declaration = read.getVariable().getDeclaration();
            if (declaration instanceof CtParameter<?> parameter && parameter.getType() != null)
                return parameter.getType();
            if (declaration instanceof CtLocalVariable<?> local && !local.isInferred() && local.getType() != null)
                return local.getType();
        }
        return expression.getType();
    }

    /**
     * The receiver a declared type gives. A type parameter names no type of its own: it is the type argument the target
     * was declared with (`Cache<Foo>` makes `Value` into `Foo`), or nothing when the target does not say.
     */
    private String declared(CtTypeReference<?> declared, CtFormalTypeDeclarer scope, CtType<?> owner,
            CtExpression<?> target) {
        if (declared instanceof CtTypeParameterReference)
            return bound((CtTypeParameterReference) declared, scope, owner, target);
        return rawType(declared);
    }

    /**
     * The type argument a target's type gives a parameter of the owner class at the same position. A method's own type
     * parameter, a target of another class (an inherited member) and a raw target all answer nothing.
     */
    private String bound(CtTypeParameterReference param, CtFormalTypeDeclarer scope, CtType<?> owner,
            CtExpression<?> target) {
        if (owner == null || target == null || target.getType() == null) return null;
        if (scope != null && indexOf(scope.getFormalCtTypeParameters(), param) >= 0) return null;
        CtTypeReference<?> held = target.getType();
        if (!Names.qualified(owner).equals(Names.qualified(held))) return null;
        List<CtTypeParameter> formals = owner.getFormalCtTypeParameters();
        List<CtTypeReference<?>> actual = held.getActualTypeArguments();
        int index = indexOf(formals, param);
        if (index < 0 || actual.size() != formals.size()) return null;
        CtTypeReference<?> argument = actual.get(index);
        if (argument instanceof CtWildcardReference wildcard)
            argument = wildcard.isUpper() ? wildcard.getBoundingType() : null;
        return argument == null ? null : rawType(argument);
    }

    /** The position of the parameter with this name among the declared ones, or -1. */
    private static int indexOf(List<CtTypeParameter> formals, CtTypeParameterReference param) {
        for (int i = 0; i < formals.size(); i++)
            if (formals.get(i).getSimpleName().equals(param.getSimpleName())) return i;
        return -1;
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

    /** The receiver name of a type, or null: a type parameter is never a receiver, whatever its name. */
    private String rawType(CtTypeReference<?> type) {
        if (type == null || type instanceof CtTypeParameterReference) return null;
        try {
            return LibraryTypes.raw(Names.qualified(type));
        } catch (RuntimeException e) {
            failures.count(Failures.Key.CHAIN_TYPE_UNRESOLVED);
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
            return declared(method.getType(), method, method.getDeclaringType(), call.getTarget());
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
