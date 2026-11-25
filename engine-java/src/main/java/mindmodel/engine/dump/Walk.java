package mindmodel.engine.dump;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

import spoon.reflect.code.CtAssignment;
import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtCatch;
import spoon.reflect.code.CtConstructorCall;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldAccess;
import spoon.reflect.code.CtIf;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtLoop;
import spoon.reflect.code.CtReturn;
import spoon.reflect.code.CtSwitch;
import spoon.reflect.code.CtSwitchExpression;
import spoon.reflect.code.CtTry;
import spoon.reflect.code.CtVariableWrite;
import spoon.reflect.declaration.CtAnonymousExecutable;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtEnumValue;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtField;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.visitor.Filter;

/**
 * One walk of a method body, bucketed by what each section of the dump asks of it: call sites and method references,
 * returns, switches, field reads and writes, the writes to each local, and the loops, decision arms and try blocks the
 * members section writes as line ranges. Walking once is what keeps the dump inside its time budget: one
 * {@code getElements} pass per body, not one per section.
 *
 * The buckets keep source order, so the call rows are written in source order.
 */
final class Walk {

    /** What one body holds. Order inside a bucket is source order; {@code sites} mixes calls and method references. */
    record Body(List<CtElement> sites, List<CtReturn<?>> returns,
                List<CtSwitchExpression<?, ?>> switchExpressions, List<CtSwitch<?>> switches,
                List<CtFieldAccess<?>> fields, Map<CtLocalVariable<?>, List<CtExpression<?>>> writes,
                List<CtLoop> loops, List<CtIf> ifs, List<CtCatch> catches, List<CtCase<?>> cases,
                List<CtTry> tries, List<CtMethod<?>> methods) {
    }

    /** A method of an anonymous or local class, with the id the dump files it under. */
    record Anon(CtMethod<?> method, String id) {
    }

    private static final Filter<CtElement> ANY = element ->
            element instanceof CtInvocation<?> || element instanceof CtExecutableReferenceExpression<?, ?>
                    || element instanceof CtConstructorCall<?>
                    || element instanceof CtReturn<?> || element instanceof CtSwitchExpression<?, ?>
                    || element instanceof CtSwitch<?> || element instanceof CtFieldAccess<?>
                    || element instanceof CtAssignment<?, ?> || element instanceof CtLocalVariable<?>
                    || element instanceof CtLoop || element instanceof CtIf || element instanceof CtCatch
                    || element instanceof CtCase<?> || element instanceof CtTry || element instanceof CtMethod<?>;

    private Walk() {
    }

    /**
     * Every body the dump reads, each scanned once: a dumped type's own constructors and methods, then the methods of the
     * anonymous and local classes written inside them. Members and calls both read from here, so no body is walked twice.
     */
    static final class Bodies {

        private final Map<CtExecutable<?>, Body> bodies = new IdentityHashMap<>();
        private final Map<CtType<?>, List<Anon>> anonymous = new IdentityHashMap<>();

        Bodies(List<CtType<?>> types, Positions positions) {
            for (CtType<?> type : types) {
                List<Anon> inner = new ArrayList<>();
                for (CtExecutable<?> executable : executables(type)) {
                    Body body = scan(executable);
                    bodies.put(executable, body);
                    for (CtMethod<?> method : Anonymous.within(executable, body.methods())) {
                        bodies.put(method, scan(method));
                        inner.add(new Anon(method, Anonymous.id(type, method, positions)));
                    }
                }
                anonymous.put(type, inner);
            }
        }

        /** The body of a constructor or method this run dumped. */
        Body of(CtExecutable<?> executable) {
            return bodies.get(executable);
        }

        /** The anonymous and local methods written inside a dumped type's members, in source order. */
        List<Anon> anonymous(CtType<?> type) {
            return anonymous.getOrDefault(type, List.of());
        }
    }

    /** A type's constructors and methods, in declaration order: the executables a body belongs to. */
    static List<CtExecutable<?>> executables(CtType<?> type) {
        List<CtExecutable<?>> out = new ArrayList<>();
        for (var member : type.getTypeMembers())
            if (member instanceof spoon.reflect.declaration.CtConstructor<?> ctor) out.add(ctor);
            else if (member instanceof CtMethod<?> method) out.add(method);
        return out;
    }

    static Body scan(CtExecutable<?> executable) {
        Buckets buckets = new Buckets();
        for (CtElement element : executable.getElements(ANY)) buckets.add(element);
        return buckets.body();
    }

    /**
     * The code a type runs outside its methods: field initialisers and initializer blocks, static ones (`statik`) or per
     * instance. Only the call sites are read from them; an enum constant's arguments are a static field's initialiser.
     */
    static Body initializers(CtType<?> type, boolean statik) {
        Buckets buckets = new Buckets();
        for (CtField<?> field : type.getFields())
            if (isStatic(field) == statik && field.getDefaultExpression() != null)
                for (CtElement element : field.getDefaultExpression().getElements(ANY)) buckets.add(element);
        for (var member : type.getTypeMembers())
            if (member instanceof CtAnonymousExecutable block
                    && block.getModifiers().contains(ModifierKind.STATIC) == statik)
                for (CtElement element : block.getElements(ANY)) buckets.add(element);
        return buckets.body();
    }

    /** A static field, an enum constant, or any field of an interface (which is static whatever it says). */
    private static boolean isStatic(CtField<?> field) {
        return field instanceof CtEnumValue<?> || field.getModifiers().contains(ModifierKind.STATIC)
                || field.getDeclaringType() != null && field.getDeclaringType().isInterface();
    }

    /** The buckets one walk fills, filled element by element. */
    private static final class Buckets {
        private final List<CtElement> sites = new ArrayList<>();
        private final List<CtReturn<?>> returns = new ArrayList<>();
        private final List<CtSwitchExpression<?, ?>> switchExpressions = new ArrayList<>();
        private final List<CtSwitch<?>> switches = new ArrayList<>();
        private final List<CtFieldAccess<?>> fields = new ArrayList<>();
        private final Map<CtLocalVariable<?>, List<CtExpression<?>>> writes = new IdentityHashMap<>();
        private final List<CtLoop> loops = new ArrayList<>();
        private final List<CtIf> ifs = new ArrayList<>();
        private final List<CtCatch> catches = new ArrayList<>();
        private final List<CtCase<?>> cases = new ArrayList<>();
        private final List<CtTry> tries = new ArrayList<>();
        private final List<CtMethod<?>> methods = new ArrayList<>();

        void add(CtElement element) {
            if (element instanceof CtInvocation<?> || element instanceof CtExecutableReferenceExpression<?, ?>
                    || element instanceof CtConstructorCall<?>)
                sites.add(element);
            else if (element instanceof CtReturn<?> ret) returns.add(ret);
            else if (element instanceof CtSwitchExpression<?, ?> expression) switchExpressions.add(expression);
            else if (element instanceof CtSwitch<?> choose) switches.add(choose);
            else if (element instanceof CtFieldAccess<?> access) fields.add(access);
            else if (element instanceof CtLocalVariable<?> local) addDeclaration(local);
            else if (element instanceof CtAssignment<?, ?> assignment) addAssignment(assignment);
            else if (element instanceof CtLoop loop) loops.add(loop);
            else if (element instanceof CtIf iff) ifs.add(iff);
            else if (element instanceof CtCatch catching) catches.add(catching);
            else if (element instanceof CtCase<?> arm) cases.add(arm);
            else if (element instanceof CtTry attempt) tries.add(attempt);
            else if (element instanceof CtMethod<?> method) methods.add(method);
        }

        /** `String x = ...` is both the declaration and the local's first value. */
        private void addDeclaration(CtLocalVariable<?> local) {
            List<CtExpression<?>> values = new ArrayList<>(1);
            if (local.getDefaultExpression() != null) values.add(local.getDefaultExpression());
            writes.put(local, values);
        }

        /** `x = ...`: the assignment names the local on the left and the value on the right. */
        private void addAssignment(CtAssignment<?, ?> assignment) {
            if (!(assignment.getAssigned() instanceof CtVariableWrite<?> write)) return;
            if (write.getVariable() == null) return;
            if (!(write.getVariable().getDeclaration() instanceof CtLocalVariable<?> local)) return;
            List<CtExpression<?>> values = writes.computeIfAbsent(local, k -> new ArrayList<>(1));
            if (assignment.getAssignment() != null) values.add(assignment.getAssignment());
        }

        Body body() {
            return new Body(sites, returns, switchExpressions, switches, fields, writes, loops, ifs, catches, cases,
                    tries, methods);
        }
    }
}
