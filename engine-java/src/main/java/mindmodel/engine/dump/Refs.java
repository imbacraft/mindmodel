package mindmodel.engine.dump;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.JsonGenerator;

import spoon.reflect.code.CtConditional;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLiteral;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.code.CtCatchVariable;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;
import spoon.reflect.reference.CtWildcardReference;

/**
 * One expression as data: the shape every argument, return value, switch arm and field write is written in.
 *
 * <pre>{ "text": "A_COOKIE_NAME", "kind": "constant", "value": "fachverfahren", "type": "java.lang.String" }</pre>
 *
 * {@code kind} is what the expression <em>is</em> (literal, constant, param, local, field, call, lambda, methodRef, new,
 * conditional, other), never what it means. {@code text} is a display string cut at 80 code points and is never a fact.
 * What Spoon cannot type is {@code unresolved} with a {@code reason}.
 *
 * <p>Type names are join keys: the dotted spelling of types.ndjson, or null. A type Spoon invented (a missing import) has
 * no name the dump may give, so it is null and counted, and the written name stays where the row keeps it (the
 * expression's {@code text}, a member's {@code type}).
 *
 * A reference is resolved while the body it belongs to is the current scope: a local's `from` needs that method's writes.
 */
final class Refs {

    /** The failure key for a type reference the dump could not name: Spoon invented it, or could not read it. */
    static final String UNRESOLVED = "refs.typeUnresolved";

    /** A resolved reference. Null fields are not written, so each kind writes only what it knows. */
    record Ref(String text, String kind, String type, String reason, String valueKind, Object value, String field,
               String call, String from, Integer index, boolean inLambda, String created, Ref then, Ref otherwise) {

        static Ref plain(String text, String kind, String type) {
            return new Ref(text, kind, type, null, null, null, null, null, null, null, false, null, null, null);
        }

        static Ref unresolved(String text, String reason) {
            return new Ref(text, "unresolved", null, reason, null, null, null, null, null, null, false, null, null, null);
        }
    }

    private final CallIds ids;
    private final Failures failures;
    private Map<CtLocalVariable<?>, List<CtExpression<?>>> writes = Map.of();

    Refs(CallIds ids, Failures failures) {
        this.ids = ids;
        this.failures = failures;
    }

    /** The run's failure counts; the readers below count into it rather than failing. */
    Failures failures() {
        return failures;
    }

    /** The writes of the body about to be read: without them a local has no `from`. */
    void scope(Map<CtLocalVariable<?>, List<CtExpression<?>>> writes) {
        this.writes = writes == null ? Map.of() : writes;
    }

    /** One expression, resolved. */
    Ref of(CtExpression<?> expression) {
        String text = textOf(expression);
        if (expression == null) return Ref.unresolved(text, "no-expression");
        String type = typeOf(expression);
        // A literal is a literal whatever its type: the value is the source's own.
        if (expression instanceof CtLiteral<?>) {
            Values.Value folded = Values.of(expression);
            return new Ref(text, "literal", type, null, folded == null ? null : folded.kind(),
                    folded == null ? null : folded.value(), null, null, null, null, false, null, null, null);
        }
        if (expression instanceof CtLambda<?>) return Ref.plain(text, "lambda", type);
        if (expression instanceof CtExecutableReferenceExpression<?, ?>) {
            String id = ids.id(expression);
            return new Ref(text, "methodRef", type, id == null ? "no-call-row" : null, null, null, null, id, null, null,
                    false, null, null, null);
        }
        // The created type is the expression's own type: a `new` expression has no other.
        if (expression instanceof CtConstructorCall<?>) {
            return new Ref(text, "new", type, null, null, null, null, null, null, null, false, type, null, null);
        }
        if (expression instanceof CtInvocation<?>) {
            String id = ids.id(expression);
            // A call written outside every method body (a field initialiser) has no row to point at; say so.
            if (id == null)
                return new Ref(text, "call", type, "not-a-call-row", null, null, null, null, null, null, false, null,
                        null, null);
            return new Ref(text, "call", type, null, null, null, null, id, null, null, false, null, null, null);
        }
        if (expression instanceof CtConditional<?> conditional) return conditional(conditional, text, type);
        if (expression instanceof CtVariableRead<?> read) return read(read, text, type);
        return Ref.plain(text, "other", type);
    }

    /**
     * `a ? b : c` is structure: two branches, each in this same shape. Spoon leaves the expression's own type off when it
     * is inferred from the branches, so two branches of one type name it.
     */
    private Ref conditional(CtConditional<?> conditional, String text, String type) {
        String named = type;
        if (named == null) {
            String either = typeOf(conditional.getThenExpression());
            if (either != null && either.equals(typeOf(conditional.getElseExpression()))) named = either;
        }
        return new Ref(text, "conditional", named, null, null, null, null, null, null, null, false, null,
                of(conditional.getThenExpression()), of(conditional.getElseExpression()));
    }

    /** A name read: a parameter, a local, a field, a constant. Its declaration is the fact, or it is unresolved. */
    private Ref read(CtVariableRead<?> read, String text, String type) {
        CtElement declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
        CtFieldReference<?> asField = read.getVariable() instanceof CtFieldReference<?> field ? field : null;
        // `X.class` is a class literal Spoon writes as a read of a field named `class`: no field, no declaration.
        if (asField != null && "class".equals(asField.getSimpleName())) return Ref.plain(text, "other", type);
        if (declaration instanceof CtParameter<?> parameter) {
            var owner = parameter.getParent(CtExecutable.class);
            int index = owner == null ? -1 : owner.getParameters().indexOf(parameter);
            boolean lambda = owner instanceof CtLambda<?>;
            return new Ref(text, "param", type, null, null, null, null, null, null, index, lambda, null, null, null);
        }
        if (declaration instanceof CtLocalVariable<?> local) {
            // `from` only when the local holds one value; a reassigned local is a name, not a value.
            List<CtExpression<?>> values = writes.getOrDefault(local, List.of());
            String from = values.size() == 1 ? from(values.get(0)) : null;
            return new Ref(text, "local", type, null, null, null, null, null, from, null, false, null, null, null);
        }
        // A catch parameter is a named local: its value is the thrown exception, which no expression of the body gives.
        if (declaration instanceof CtCatchVariable<?>) return Ref.plain(text, "local", type);
        // A constant is one whose value the compiler could write down; anything else is a field read.
        if (declaration instanceof CtField<?>) {
            String id = fieldId(asField);
            Values.Value folded = Values.of(read);
            return new Ref(text, folded != null ? "constant" : "field", type,
                    id == null ? "no-declaring-type" : null, folded == null ? null : folded.kind(),
                    folded == null ? null : folded.value(), id, null, null, null, false, null, null, null);
        }
        // A static member of a type declared outside this checkout (`OrderState.CANCELLED`, `REVISION_PENDING` named by
        // a static import): there is no declaration here, but the source names both the type and the field. The read is
        // on a type access, and Java writes a type's name with a capital. An owner written lowercase is a variable whose
        // declaration is missing (`mystery.port`), which stays unresolved. The reason says the declaration is elsewhere.
        if (asField != null && read instanceof spoon.reflect.code.CtFieldAccess<?> access
                && access.getTarget() instanceof spoon.reflect.code.CtTypeAccess<?>
                && isTypeName(asField.getDeclaringType() == null ? null : asField.getDeclaringType().getSimpleName())) {
            String owner = joinKey(asField.getDeclaringType(), read, failures);
            if (owner != null)
                return new Ref(text, "field", owner, "declaration-outside-dump", null, null,
                        Names.member(owner, asField.getSimpleName()), null, null, null, false, null, null, null);
        }
        return Ref.unresolved(text, "no-declaration");
    }

    /** Java writes a type's name with a capital: the one convention that tells a type access from a missing variable. */
    private static boolean isTypeName(String simple) {
        return simple != null && !simple.isEmpty() && Character.isUpperCase(simple.charAt(0));
    }

    /** The row a value came from, when that row is a call site or a field. Anything else names no row. */
    private String from(CtExpression<?> source) {
        if (source instanceof CtInvocation<?> call) return ids.id(call);
        if (source instanceof CtFieldRead<?> read) return fieldId(read.getVariable());
        if (source instanceof CtConstructorCall<?> created) {
            String fqn = resolvedFqn(created.getType(), created);
            return fqn == null ? null : "new " + fqn;
        }
        return null;
    }

    /**
     * `owner#name`: the same spelling the members dump uses for a field's identity, but only when the owner is a type
     * declared in this checkout. A library member, and a type Spoon invented, has no identity the dump may claim.
     */
    static String fieldId(CtFieldReference<?> ref) {
        if (ref == null || ref.getDeclaringType() == null) return null;
        CtType<?> owner = ref.getDeclaringType().getTypeDeclaration();
        if (owner == null || owner.getPosition() == null || !owner.getPosition().isValidPosition()) return null;
        return Names.member(Names.qualified(ref.getDeclaringType()), ref.getSimpleName());
    }

    /** The type as the compiler names it, as a join key; null when there is none, and the invention is counted. */
    private String typeOf(CtExpression<?> expression) {
        try {
            return joinKey(expression.getType(), expression, failures);
        } catch (RuntimeException e) {
            failures.count(UNRESOLVED);
            return null;
        }
    }

    /**
     * The join key of a type, counted: the dotted name, or null when the type has no name the dump may give (no type, a
     * type variable, an invented type). An invented type counts once under {@link #UNRESOLVED}.
     */
    static String joinKey(CtTypeReference<?> type, CtElement context, Failures failures) {
        if (isInvented(type, context)) {
            failures.count(UNRESOLVED);
            return null;
        }
        return fqnOf(type, context);
    }

    /** As {@link #joinKey}, without counting: for a name derived from a row that is already counted. */
    private static String resolvedFqn(CtTypeReference<?> type, CtElement context) {
        return isInvented(type, context) ? null : fqnOf(type, context);
    }

    /** The dotted name of a type; null for no type, a type variable, or Spoon's `?`. Says nothing about invention. */
    private static String fqnOf(CtTypeReference<?> type, CtElement context) {
        if (type == null || type instanceof CtTypeParameterReference) return null;
        String qualified = Names.qualified(type);
        return qualified.isEmpty() || "?".equals(qualified) ? null : qualified;
    }

    /**
     * The one rule for an unresolved type: Spoon names a type it cannot find in the package of the file that wrote the
     * reference, and nothing declares it. Arrays are judged by their element; primitives and type variables are never
     * invented.
     */
    static boolean isInvented(CtTypeReference<?> type, CtElement context) {
        CtTypeReference<?> base = Names.elementType(type);
        if (base == null || base.isPrimitive() || base instanceof CtTypeParameterReference) return false;
        if (base.getPackage() == null || !base.getPackage().getQualifiedName().equals(filePackage(context))) return false;
        return base.getTypeDeclaration() == null;
    }

    /**
     * The same rule for a name that arrived as a string (a receiver's type, which a chain of calls derives): a name with
     * no declaration in the checkout whose package is the file's own. `known` says the caller already accounts for it.
     */
    static boolean isInvented(String fqn, boolean known, CtElement context) {
        return !known && fqn != null && Names.packageOf(fqn).equals(filePackage(context));
    }

    /** The package the file of a context element declares: the package of its enclosing type, {@code ""} by default. */
    static String filePackage(CtElement context) {
        CtType<?> type = context instanceof CtType<?> own ? own : context.getParent(CtType.class);
        return type == null || type.getPackage() == null ? "" : type.getPackage().getQualifiedName();
    }

    /**
     * The type arguments of a written type, as names: a project or library type qualified, a type parameter by the
     * letter its author wrote, a wildcard as {@code ?}. Order is the source's. Empty when the type takes none.
     */
    List<String> typeArgs(CtTypeReference<?> type, CtElement context) {
        List<String> out = new ArrayList<>();
        if (type == null) return out;
        try {
            for (CtTypeReference<?> argument : type.getActualTypeArguments()) out.add(typeName(argument, context));
        } catch (RuntimeException e) {
            failures.count("refs.typeArgsUnresolved");
            return new ArrayList<>();
        }
        return out;
    }

    /** One type argument as written: `Voucher`, `T`, `? extends Number`. An invented argument keeps its written name. */
    private String typeName(CtTypeReference<?> type, CtElement context) {
        if (type == null) return "?";
        // A wildcard is a type parameter reference too in Spoon, so it is named before the parameter test can take it.
        if (type instanceof CtWildcardReference wildcard) {
            CtTypeReference<?> bound = Names.wildcardBound(wildcard);
            return bound == null ? "?" : Names.wildcard(wildcard.isUpper(), typeName(bound, context));
        }
        if (type instanceof CtTypeParameterReference parameter) return parameter.getSimpleName();
        String fqn = joinKey(type, context, failures);
        if (fqn != null) return fqn;
        String simple = type.getSimpleName();
        return simple == null || simple.isEmpty() ? "?" : simple;
    }

    /** Writes one reference into the object the caller has started; every field it knows, nothing it does not. */
    static void write(JsonGenerator g, Ref ref) throws IOException {
        if (ref == null) {
            g.writeNullField("text");
            g.writeStringField("kind", "unresolved");
            g.writeNullField("type");
            g.writeStringField("reason", "no-expression");
            return;
        }
        if (ref.text() == null) g.writeNullField("text");
        else g.writeStringField("text", ref.text());
        g.writeStringField("kind", ref.kind());
        if (ref.type() == null) g.writeNullField("type");
        else g.writeStringField("type", ref.type());
        if (ref.valueKind() != null) {
            g.writeStringField("valueKind", ref.valueKind());
            g.writeFieldName("value");
            Anns.writeRaw(g, ref.value());
        }
        if (ref.field() != null) g.writeStringField("field", ref.field());
        if (ref.call() != null) g.writeStringField("call", ref.call());
        if (ref.from() != null) g.writeStringField("from", ref.from());
        if (ref.index() != null) g.writeNumberField("index", ref.index());
        if (ref.inLambda()) g.writeBooleanField("inLambda", true);
        if (ref.created() != null) g.writeStringField("created", ref.created());
        if (ref.reason() != null) g.writeStringField("reason", ref.reason());
        if (ref.then() != null) {
            g.writeObjectFieldStart("then");
            write(g, ref.then());
            g.writeEndObject();
        }
        if (ref.otherwise() != null) {
            g.writeObjectFieldStart("otherwise");
            write(g, ref.otherwise());
            g.writeEndObject();
        }
    }

    /**
     * The expression as the author wrote it, cut at 80 characters for display only. Sliced out of the compilation unit
     * rather than pretty-printed (see {@link Names#sourceOf}). An expression with no source position has no text.
     */
    String textOf(CtExpression<?> expression) {
        if (expression == null) return null;
        try {
            String source = Names.sourceOf(expression);
            return source == null ? null : clip(unterminated(collapse(source)));
        } catch (RuntimeException e) {
            failures.count("refs.textUnresolved");
            return null;
        }
    }

    /** Runs of whitespace become one space: a lambda or an anonymous body spans lines and is still one name. */
    private static String collapse(String source) {
        StringBuilder out = new StringBuilder(source.length());
        boolean space = false;
        int i = 0;
        while (i < source.length() && out.codePointCount(0, out.length()) <= 80) {
            int c = source.codePointAt(i);
            i += Character.charCount(c);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                space = out.length() > 0;
                continue;
            }
            if (space) {
                out.append(' ');
                space = false;
            }
            out.appendCodePoint(c);
        }
        return out.toString();
    }

    /**
     * Spoon's position for an arrow arm's expression runs on through the `;` that ends the arm, so the display text
     * keeps it. No expression ends in a semicolon, so the last one is dropped.
     */
    private static String unterminated(String text) {
        return text.endsWith(";") ? text.substring(0, text.length() - 1).stripTrailing() : text;
    }

    /** At most 80 code points, so a surrogate pair is never cut in half. */
    private static String clip(String text) {
        if (text.codePointCount(0, text.length()) <= 80) return text;
        return text.substring(0, text.offsetByCodePoints(0, 80));
    }
}
