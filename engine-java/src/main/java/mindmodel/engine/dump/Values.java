package mindmodel.engine.dump;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.TreeMap;
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
import spoon.reflect.declaration.CtEnumValue;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
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
        // Sorted keys: Spoon hands the elements in hash order, so the same source would otherwise serialise to
        // different bytes on different runs, and the dump would stop being comparable.
        Map<String, Value> out = new TreeMap<>();
        for (Map.Entry<String, CtExpression> e : annotation.getValues().entrySet())
            out.put(e.getKey(), orUnresolved(e.getValue()));
        return out;
    }

    /** The value of an expression, or the unresolved value when Spoon cannot evaluate it: never a guess, never a gap. */
    public static Value orUnresolved(CtExpression<?> expression) {
        Value v = of(expression);
        return v == null ? new Value("unresolved", null) : v;
    }

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
        for (CtExpression<?> element : array.getElements()) items.add(orUnresolved(element));
        return new Value("array", items);
    }

    private static Value classLiteral(CtTypeReference<?> type) {
        return type == null ? null : new Value("class", Names.qualified(type));
    }

    /**
     * An enum constant is a constant. Any other field folds only when it is a constant variable of the language (static
     * and final, every interface field included) and its initializer folds; everything else is a field read.
     */
    private static Value field(CtFieldReference<?> ref) {
        CtTypeReference<?> owner = ref.getDeclaringType();
        CtType<?> type = owner == null ? null : owner.getTypeDeclaration();
        CtField<?> declaration = ref.getFieldDeclaration();
        if (type != null && type.isEnum() && (declaration == null || declaration instanceof CtEnumValue<?>))
            return new Value("enum", Names.dotted(Names.qualified(type), ref.getSimpleName()));
        if (declaration == null || !constantVariable(declaration) || declaration.getDefaultExpression() == null)
            return null;
        return of(declaration.getDefaultExpression());
    }

    private static boolean constantVariable(CtField<?> field) {
        CtType<?> owner = field.getDeclaringType();
        if (owner != null && owner.isInterface()) return true;
        return field.getModifiers().contains(ModifierKind.STATIC) && field.getModifiers().contains(ModifierKind.FINAL);
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
        double x = a.doubleValue();
        double y = b.doubleValue();
        Double result = switch (kind) {
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
     * Java's integer arithmetic: a long if either operand is one, else an int that wraps on overflow. The low 32 bits of
     * a long product are the int product, so an int result is the long result cut to int. Division by zero is no
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
