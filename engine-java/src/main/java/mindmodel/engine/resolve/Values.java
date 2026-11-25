package mindmodel.engine.resolve;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import spoon.reflect.code.CtBinaryOperator;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtLiteral;
import spoon.reflect.code.CtNewArray;
import spoon.reflect.code.CtTypeAccess;
import spoon.reflect.code.CtUnaryOperator;
import spoon.reflect.code.CtVariableRead;
import spoon.reflect.declaration.CtAnnotation;
import spoon.reflect.declaration.CtEnumValue;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtFieldReference;
import spoon.reflect.reference.CtTypeReference;

import mindmodel.engine.model.Names;

/**
 * Annotation and constant values, as data. Spoon evaluates what a compiler would fold (literals, string concatenation,
 * constant fields, enum constants, class literals, arrays); anything else is {@code unresolved}, never a guess.
 */
public final class Values {

    /** A value a fact may read: its kind, and the value itself (null for the null literal and for unresolved). */
    public record Value(String kind, Object value) {
    }

    private Values() {
    }

    /** The arguments of an annotation by element name, sorted: Spoon hands them in hash order. */
    public static Map<String, Value> annotationArgs(CtAnnotation<?> annotation) {
        Map<String, Value> out = new TreeMap<>();
        for (Map.Entry<String, CtExpression> e : annotation.getValues().entrySet())
            out.put(e.getKey(), orUnresolved(e.getValue()));
        return out;
    }

    /**
     * The value of an expression, or the unresolved value when Spoon cannot evaluate it: never a guess, never a gap.
     */
    public static Value orUnresolved(CtExpression<?> expression) {
        Value v = of(expression);
        return v == null ? new Value("unresolved", null) : v;
    }

    /** The value of an expression, or null when it is not a constant Spoon can fold. */
    public static Value of(CtExpression<?> expression) {
        if (expression == null) return null;
        if (expression instanceof CtLiteral<?> literal) return literal(literal.getValue());
        if (expression instanceof CtNewArray<?> array) return array(array);
        if (expression instanceof CtAnnotation<?> nested) {
            // An ordered map: `Map.of` iterates in a salted order, and the dump must be byte-identical across runs.
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("name", Names.qualified(nested.getAnnotationType()));
            value.put("args", annotationArgs(nested));
            return new Value("annotation", value);
        }
        if (expression instanceof CtTypeAccess<?> access) return classLiteral(access.getAccessedType());
        // A field read, a static access and an annotation member all come through the variable reference.
        if (expression instanceof CtVariableRead<?> read && read.getVariable() instanceof CtFieldReference<?> ref)
            return field(ref);
        if (expression instanceof CtUnaryOperator<?> op) return unary(op);
        if (expression instanceof CtBinaryOperator<?> op) return binary(op);
        return null;
    }

    /**
     * A literal value. NaN and infinities are no JSON value: they are no value at all, and the caller says unresolved.
     */
    private static Value literal(Object value) {
        if (value == null) return new Value("null", null);
        if (value instanceof String) return new Value("string", value);
        if (value instanceof Boolean) return new Value("bool", value);
        if (value instanceof Character c) return new Value("char", String.valueOf(c));
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte)
            return new Value("int", value);
        if (value instanceof Double d) return Double.isFinite(d) ? new Value("double", d) : null;
        if (value instanceof Float f) return Float.isFinite(f) ? new Value("float", f) : null;
        return null;
    }

    private static Value array(CtNewArray<?> array) {
        List<Value> items = new ArrayList<>();
        for (CtExpression<?> element : array.getElements()) items.add(orUnresolved(element));
        return new Value("array", items);
    }

    private static Value classLiteral(CtTypeReference<?> type) {
        return type == null ? null : new Value("class", Names.qualified(type));
    }

    /**
     * An enum constant is a constant. Any other field folds only when it is a constant variable and its initializer
     * folds; everything else is a field read.
     */
    private static Value field(CtFieldReference<?> ref) {
        CtTypeReference<?> owner = ref.getDeclaringType();
        CtType<?> type = owner == null ? null : owner.getTypeDeclaration();
        CtField<?> declaration = ref.getFieldDeclaration();
        if (type != null && type.isEnum() && (declaration == null || declaration instanceof CtEnumValue<?>))
            return new Value("enum", Names.dotted(Names.qualified(type), ref.getSimpleName()));
        if (declaration == null || !isConstantVariable(declaration) || declaration.getDefaultExpression() == null)
            return null;
        return of(declaration.getDefaultExpression());
    }

    /**
     * JLS 4.12.4: a final variable of primitive or String type, with or without static, whose initializer is a constant
     * expression. Every interface field is final. A final `Object` or `List` is never a constant, whatever its value.
     */
    public static boolean isConstantVariable(CtField<?> field) {
        CtType<?> owner = field.getDeclaringType();
        boolean isFinal = (owner != null && owner.isInterface()) || field.getModifiers().contains(ModifierKind.FINAL);
        CtTypeReference<?> type = field.getType();
        boolean constantType = type != null
                && (type.isPrimitive() || "java.lang.String".equals(Names.qualified(type)));
        return isFinal && constantType;
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
        if (isIntegral(a) && isIntegral(b)) return integral(kind, a, b);
        // Binary numeric promotion: a double if either side is one, else a float if either side is one.
        if (a instanceof Double || b instanceof Double) return floating(kind, a.doubleValue(), b.doubleValue());
        return single(kind, a.floatValue(), b.floatValue());
    }

    private static Value floating(String kind, double x, double y) {
        Double result = switch (kind) {
            case "PLUS" -> x + y;
            case "MINUS" -> x - y;
            case "MUL" -> x * y;
            case "DIV" -> y == 0 ? null : x / y;
            default -> null;
        };
        return result == null ? null : literal(result);
    }

    /** Float arithmetic: `1.1f * 3` is a float, and its float product is what the compiler folds to. */
    private static Value single(String kind, float x, float y) {
        Float result = switch (kind) {
            case "PLUS" -> x + y;
            case "MINUS" -> x - y;
            case "MUL" -> x * y;
            case "DIV" -> y == 0 ? null : x / y;
            default -> null;
        };
        return result == null ? null : literal(result);
    }

    private static boolean isIntegral(Number n) {
        return n instanceof Integer || n instanceof Long || n instanceof Short || n instanceof Byte;
    }

    /**
     * Java's integer arithmetic: a long if either operand is one, else an int that wraps on overflow. The low 32 bits
     * of a long product are the int product, so an int result is the long result cut to int. Division by zero is no
     * constant at all.
     */
    private static Value integral(String kind, Number a, Number b) {
        long x = a.longValue();
        long y = b.longValue();
        Long result = switch (kind) {
            case "PLUS" -> x + y;
            case "MINUS" -> x - y;
            case "MUL" -> x * y;
            case "DIV" -> y == 0 ? null : x / y;
            default -> null;
        };
        if (result == null) return null;
        boolean wide = a instanceof Long || b instanceof Long;
        return wide ? literal(result) : literal((int) (long) result);
    }
}
