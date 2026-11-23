package mindmodel.engine.dump;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import spoon.reflect.code.CtBinaryOperator;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtLiteral;
import spoon.reflect.code.CtNewArray;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.code.CtUnaryOperator;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtType;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtTypeReference;

/**
 * Annotation and constant values as data. Spoon evaluates what a compiler would fold (literals, string concatenation,
 * constant fields, enum constants, class literals, arrays); everything else becomes kind {@code unresolved} rather than
 * a guess.
 */
public final class Values {

    private Values() {
    }

    /** A value that a fact may read. {@code null} means "could not evaluate" and is reported as unresolved. */
    public record Value(String kind, Object value) {
    }

    public static Map<String, Value> annotationArgs(CtAnnotation<?> annotation) {
        Map<String, Value> out = new LinkedHashMap<>();
        for (Map.Entry<String, CtExpression> e : annotation.getValues().entrySet()) {
            Value v = of(e.getValue());
            out.put(e.getKey(), v == null ? new Value("unresolved", null) : v);
        }
        return out;
    }

    public static Value of(CtExpression<?> expression) {
        if (expression == null) return null;
        if (expression instanceof CtLiteral<?> literal) return literal(literal.getValue());
        if (expression instanceof CtNewArray<?> array) return array(array);
        if (expression instanceof CtAnnotation<?> nested) {
            return new Value("annotation", Map.of("name", Names.qualified(nested.getAnnotationType()),
                    "args", annotationArgs(nested)));
        }
        if (expression instanceof CtTypeAccess<?> access) return classLiteral(access.getAccessedType());
        // A field read, a static access and an annotation member all come through the variable reference.
        if (expression instanceof CtVariableRead<?> read && read.getVariable() instanceof CtFieldReference<?> ref)
            return field(ref);
        if (expression instanceof CtUnaryOperator<?> op) return unary(op);
        if (expression instanceof CtBinaryOperator<?> op) return binary(op);
        return null;
    }

    private static Value literal(Object value) {
        if (value == null) return new Value("null", null);
        if (value instanceof String) return new Value("string", value);
        if (value instanceof Boolean) return new Value("bool", value);
        if (value instanceof Character c) return new Value("char", String.valueOf(c));
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte)
            return new Value("int", value);
        if (value instanceof Double) return new Value("double", value);
        if (value instanceof Float) return new Value("float", value);
        return null;
    }

    private static Value array(CtNewArray<?> array) {
        List<Value> items = new ArrayList<>();
        for (CtExpression<?> element : array.getElements()) {
            Value v = of(element);
            items.add(v == null ? new Value("unresolved", null) : v);
        }
        return new Value("array", items);
    }

    private static Value classLiteral(CtTypeReference<?> type) {
        return type == null ? null : new Value("class", Names.qualified(type));
    }

    /** Enum constants are constants; a static final field is worth folding only when Spoon already did. */
    private static Value field(CtFieldReference<?> ref) {
        CtTypeReference<?> owner = ref.getDeclaringType();
        CtType<?> type = owner == null ? null : owner.getTypeDeclaration();
        if (type != null && type.isEnum()) return new Value("enum", Names.qualified(type) + "." + ref.getSimpleName());
        CtField<?> declaration = ref == null ? null : ref.getFieldDeclaration();
        if (declaration != null && declaration.getDefaultExpression() != null) return of(declaration.getDefaultExpression());
        return null;
    }

    private static Value unary(CtUnaryOperator<?> op) {
        Value inner = of(op.getOperand());
        if (inner == null || !"int".equals(inner.kind()) && !"double".equals(inner.kind())) return null;
        String text = op.getKind().name();
        if (!text.equals("MINUS") && !text.equals("PLUS")) return null;
        Number n = (Number) inner.value();
        return literal(text.equals("MINUS") ? negate(n) : n);
    }

    private static Number negate(Number n) {
        if (n instanceof Integer i) return -i;
        if (n instanceof Long l) return -l;
        if (n instanceof Double d) return -d;
        if (n instanceof Float f) return -f;
        return n;
    }

    private static Value binary(CtBinaryOperator<?> op) {
        Value left = of(op.getLeftHandOperand());
        Value right = of(op.getRightHandOperand());
        if (left == null || right == null) return null;
        String kind = op.getKind().name();
        if (kind.equals("PLUS") && ("string".equals(left.kind()) || "string".equals(right.kind()))) {
            return new Value("string", String.valueOf(left.value()) + right.value());
        }
        if (!(left.value() instanceof Number a) || !(right.value() instanceof Number b)) return null;
        double x = a.doubleValue();
        double y = b.doubleValue();
        Double result = switch (kind) {
            case "PLUS" -> x + y;
            case "MINUS" -> x - y;
            case "MUL" -> x * y;
            case "DIV" -> y == 0 ? null : x / y;
            default -> null;
        };
        if (result == null) return null;
        return "int".equals(left.kind()) && "int".equals(right.kind()) && result == Math.rint(result)
                ? literal((int) (double) result) : literal(result);
    }
}
