package mindmodel.engine.dump;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.JsonGenerator;

import spoon.reflect.code.CtConditional;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtFieldRead;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLiteral;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtParameter;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtTypeParameterReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * One expression as data: the shape every argument, return value, switch arm and field write is written in.
 *
 * <pre>{ "text": "A_COOKIE_NAME", "kind": "constant", "value": "fachverfahren", "type": "java.lang.String" }</pre>
 *
 * {@code kind} is what the expression <em>is</em> — literal, constant, param, local, field, call, lambda, methodRef, new,
 * conditional, other — never what it means. {@code text} is a display string cut at 80 characters and is never a fact.
 * What Spoon cannot type is {@code unresolved} with a {@code reason}.
 *
 * A reference is resolved while the body it belongs to is the current scope: a local's `from` needs that method's writes.
 */
final class Refs {

    /** A resolved reference. Null fields are not written, so each kind writes only what it knows. */
    record Ref(String text, String kind, String type, String reason, String valueKind, Object value, String field,
               String call, String from, Integer index, boolean inLambda, String created, Ref then, Ref otherwise) {

        static Ref plain(String text, String kind, String type) {
            return new Ref(text, kind, type, null, null, null, null, null, null, null, false, null, null, null);
        }
    }

    private final CallIds ids;
    private Map<CtLocalVariable<?>, List<CtExpression<?>>> writes = Map.of();

    Refs(CallIds ids) {
        this.ids = ids;
    }

    /** The writes of the body about to be read: without them a local has no `from`. */
    void scope(Map<CtLocalVariable<?>, List<CtExpression<?>>> writes) {
        this.writes = writes == null ? Map.of() : writes;
    }

    /** One expression, resolved. */
    Ref of(CtExpression<?> expression) {
        String text = textOf(expression);
        if (expression == null)
            return new Ref(text, "unresolved", null, "no-expression", null, null, null, null, null, null, false, null,
                    null, null);
        // A literal is a literal whatever its type: the value is the source's own.
        if (expression instanceof CtLiteral<?>) {
            Values.Value folded = Values.of(expression);
            return new Ref(text, "literal", typeOf(expression), null, folded == null ? null : folded.kind(),
                    folded == null ? null : folded.value(), null, null, null, null, false, null, null, null);
        }
        if (expression instanceof CtLambda<?>) return Ref.plain(text, "lambda", typeOf(expression));
        if (expression instanceof CtExecutableReferenceExpression<?, ?>) {
            String id = ids.id(expression);
            if (id == null)
                return new Ref(text, "methodRef", typeOf(expression), "no-call-row", null, null, null, null, null, null,
                        false, null, null, null);
            return new Ref(text, "methodRef", typeOf(expression), null, null, null, null, id, null, null, false, null,
                    null, null);
        }
        if (expression instanceof CtConstructorCall<?> created) {
            CtTypeReference<?> type = created.getType();
            return new Ref(text, "new", typeOf(expression), null, null, null, null, null, null, null, false,
                    type == null ? null : type.getQualifiedName(), null, null);
        }
        if (expression instanceof CtInvocation<?>) {
            String id = ids.id(expression);
            // A call written outside every method body (a field initialiser) has no row to point at; say so.
            if (id == null)
                return new Ref(text, "call", typeOf(expression), "not-a-call-row", null, null, null, null, null, null,
                        false, null, null, null);
            return new Ref(text, "call", typeOf(expression), null, null, null, null, id, null, null, false, null, null,
                    null);
        }
        if (expression instanceof CtConditional<?> conditional) {
            // `a ? b : c` is structure: two branches, each in this same shape. Spoon leaves the expression's own type
            // off when it is inferred from the branches, so two branches of one type name it.
            String type = typeOf(expression);
            if (type == null) {
                String either = typeOf(conditional.getThenExpression());
                if (either != null && either.equals(typeOf(conditional.getElseExpression()))) type = either;
            }
            return new Ref(text, "conditional", type, null, null, null, null, null, null, null, false, null,
                    of(conditional.getThenExpression()), of(conditional.getElseExpression()));
        }
        if (expression instanceof CtVariableRead<?> read) return read(read, text);
        return Ref.plain(text, "other", typeOf(expression));
    }

    /** A name read: a parameter, a local, a field, a constant. Its declaration is the fact; without one it is unresolved. */
    private Ref read(CtVariableRead<?> read, String text) {
        CtElement declaration = read.getVariable() == null ? null : read.getVariable().getDeclaration();
        CtFieldReference<?> asField = read.getVariable() instanceof CtFieldReference<?> field ? field : null;
        if (declaration instanceof CtParameter<?> parameter) {
            var owner = parameter.getParent(spoon.reflect.declaration.CtExecutable.class);
            int index = owner == null ? -1 : owner.getParameters().indexOf(parameter);
            boolean lambda = owner instanceof CtLambda<?>;
            return new Ref(text, "param", typeOf(read), null, null, null, null, null, null, index, lambda, null, null,
                    null);
        }
        if (declaration instanceof CtLocalVariable<?> local) {
            // `from` only when the local holds one value; a reassigned local is a name, not a value.
            List<CtExpression<?>> values = writes.getOrDefault(local, List.of());
            String from = values.size() == 1 ? from(values.get(0)) : null;
            return new Ref(text, "local", typeOf(read), null, null, null, null, null, from, null, false, null, null,
                    null);
        }
        // A constant is one whose value the compiler could write down; anything else is a field read.
        if (declaration instanceof CtField<?>) {
            String id = fieldId(asField);
            Values.Value folded = Values.of(read);
            return new Ref(text, folded != null ? "constant" : "field", typeOf(read),
                    id == null ? "no-declaring-type" : null, folded == null ? null : folded.kind(),
                    folded == null ? null : folded.value(), id, null, null, null, false, null, null, null);
        }
        // A static member of a type declared outside this checkout (`OrderState.CANCELLED`, `REVISION_PENDING` named by
        // a static import): there is no declaration here, but the source names both the type and the field — the read is
        // on a type access, and Java writes a type's name with a capital. An owner written lowercase is a variable whose
        // declaration is missing (`mystery.port`), which stays unresolved. The reason says the declaration is elsewhere.
        if (asField != null && asField.getDeclaringType() != null
                && read instanceof spoon.reflect.code.CtFieldAccess<?> access
                && access.getTarget() instanceof spoon.reflect.code.CtTypeAccess<?>
                && isTypeName(asField.getDeclaringType().getSimpleName())) {
            String owner = Names.qualified(asField.getDeclaringType());
            String fieldName = asField.getSimpleName();
            if (owner != null && !owner.isEmpty() && fieldName != null && !fieldName.isEmpty())
                return new Ref(text, "field", owner, "declaration-outside-dump", null, null,
                        owner + "#" + fieldName, null, null, null, false, null, null, null);
        }
        return new Ref(text, "unresolved", null, "no-declaration", null, null, null, null, null, null, false, null, null,
                null);
    }

    /** Java writes a type's name with a capital: the one convention that tells a type access from a missing variable. */
    private static boolean isTypeName(String simple) {
        return simple != null && !simple.isEmpty() && Character.isUpperCase(simple.charAt(0));
    }

    /** The row a value came from, when that row is a call site or a field. Anything else names no row. */
    private String from(CtExpression<?> source) {
        if (source instanceof CtInvocation<?> call) return ids.id(call);
        if (source instanceof CtFieldRead<?> read) return fieldId(read.getVariable());
        if (source instanceof CtConstructorCall<?> created && created.getType() != null)
            return "new " + created.getType().getQualifiedName();
        return null;
    }

    /**
     * `owner#name`: the same spelling the members dump uses for a field's identity — but only when the owner is a type
     * declared in this checkout. A library member, and a name Spoon invented for a type it could not resolve, has no
     * identity the dump may claim: those are unresolved with a reason, never a made-up owner.
     */
    static String fieldId(CtFieldReference<?> ref) {
        if (ref == null || ref.getDeclaringType() == null) return null;
        CtType<?> owner = ref.getDeclaringType().getTypeDeclaration();
        if (owner == null || owner.getPosition() == null || !owner.getPosition().isValidPosition()) return null;
        return Names.qualified(ref.getDeclaringType()) + "#" + ref.getSimpleName();
    }

    /** The type as the compiler names it; a type variable is unknown, so it is absent rather than a letter. */
    static String typeOf(CtExpression<?> expression) {
        try {
            CtTypeReference<?> type = expression.getType();
            if (type == null || type instanceof CtTypeParameterReference) return null;
            String qualified = type.getQualifiedName();
            return qualified == null || qualified.isEmpty() || "?".equals(qualified) ? null : qualified;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * The type arguments of a written type, as names: a project or library type qualified, a type parameter by the
     * letter its author wrote, a wildcard as {@code ?}. Order is the source's. Empty when the type takes none.
     */
    static List<String> typeArgs(CtTypeReference<?> type) {
        List<String> out = new ArrayList<>();
        if (type == null) return out;
        try {
            for (CtTypeReference<?> argument : type.getActualTypeArguments()) out.add(typeName(argument));
        } catch (RuntimeException e) {
            return new ArrayList<>();
        }
        return out;
    }

    /** One type argument as written: `Voucher`, `T`, `? extends Number`. */
    static String typeName(CtTypeReference<?> type) {
        if (type == null) return "?";
        if (type instanceof CtTypeParameterReference parameter) return parameter.getSimpleName();
        if (type instanceof spoon.reflect.reference.CtWildcardReference wildcard) {
            CtTypeReference<?> bound = wildcard.getBoundingType();
            if (bound == null || "Object".equals(bound.getSimpleName())) return "?";
            return (wildcard.isUpper() ? "? extends " : "? super ") + Names.qualified(bound);
        }
        String qualified = Names.qualified(type);
        return qualified == null || qualified.isEmpty() ? "?" : qualified;
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
     * rather than pretty-printed: a million arguments make the difference between 1 ms and 1 us each the difference
     * between a dump inside its budget and one outside it. An expression with no source position has no text.
     */
    static String textOf(CtExpression<?> expression) {
        if (expression == null) return null;
        try {
            var position = expression.getPosition();
            if (position == null || !position.isValidPosition() || position.getCompilationUnit() == null) return null;
            String source = position.getCompilationUnit().getOriginalSourceCode();
            if (source == null) return null;
            int start = position.getSourceStart();
            int end = position.getSourceEnd();
            if (start < 0 || end < start || end >= source.length()) return null;
            return clip(collapse(source, start, end));
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Runs of whitespace become one space: a lambda or an anonymous body spans lines and is still one name. */
    private static String collapse(String source, int start, int end) {
        StringBuilder out = new StringBuilder(end - start + 1);
        boolean space = false;
        for (int i = start; i <= end && out.length() <= 80; i++) {
            char c = source.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                space = out.length() > 0;
                continue;
            }
            if (space) {
                out.append(' ');
                space = false;
            }
            out.append(c);
        }
        return out.toString();
    }

    private static String clip(String text) {
        return text.length() > 80 ? text.substring(0, 80) : text;
    }
}
