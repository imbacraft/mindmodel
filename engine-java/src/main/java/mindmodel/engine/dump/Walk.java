package mindmodel.engine.dump;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

import spoon.reflect.code.CtAssignment;
import spoon.reflect.code.CtExecutableReferenceExpression;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtFieldAccess;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtReturn;
import spoon.reflect.code.CtSwitch;
import spoon.reflect.code.CtSwitchExpression;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.visitor.Filter;

/**
 * One walk of a method body, bucketed by what each section of the dump asks of it: call sites and method references,
 * returns, switches, field reads and writes, and the writes to each local. Walking once is what keeps the contract-2
 * dump inside its time budget: five separate {@code getElements} passes per body would double the dump's cost.
 *
 * The buckets keep source order, so the call rows are written in the order the old single pass wrote them.
 */
final class Walk {

    /** What one body holds. Order inside a bucket is source order; {@code sites} mixes calls and method references. */
    record Body(List<CtElement> sites, List<CtReturn<?>> returns,
                List<CtSwitchExpression<?, ?>> switchExpressions, List<CtSwitch<?>> switches,
                List<CtFieldAccess<?>> fields, Map<CtLocalVariable<?>, List<CtExpression<?>>> writes) {
    }

    private static final Filter<CtElement> ANY = element ->
            element instanceof CtInvocation<?> || element instanceof CtExecutableReferenceExpression<?, ?>
                    || element instanceof CtReturn<?> || element instanceof CtSwitchExpression<?, ?>
                    || element instanceof CtSwitch<?> || element instanceof CtFieldAccess<?>
                    || element instanceof CtAssignment<?, ?> || element instanceof CtLocalVariable<?>;

    private Walk() {
    }

    @SuppressWarnings("unchecked")
    static Body scan(CtExecutable<?> executable) {
        List<CtElement> sites = new ArrayList<>();
        List<CtReturn<?>> returns = new ArrayList<>();
        List<CtSwitchExpression<?, ?>> switchExpressions = new ArrayList<>();
        List<CtSwitch<?>> switches = new ArrayList<>();
        List<CtFieldAccess<?>> fields = new ArrayList<>();
        Map<CtLocalVariable<?>, List<CtExpression<?>>> writes = new IdentityHashMap<>();
        for (CtElement element : executable.getElements(ANY)) {
            if (element instanceof CtInvocation<?> || element instanceof CtExecutableReferenceExpression<?, ?>) {
                sites.add(element);
            } else if (element instanceof CtReturn<?> ret) {
                returns.add(ret);
            } else if (element instanceof CtSwitchExpression<?, ?> expression) {
                switchExpressions.add(expression);
            } else if (element instanceof CtSwitch<?> choose) {
                switches.add(choose);
            } else if (element instanceof CtFieldAccess<?> access) {
                fields.add(access);
            } else if (element instanceof CtLocalVariable<?> local) {
                // `String x = ...` is both the declaration and the local's first value.
                List<CtExpression<?>> values = new ArrayList<>(1);
                if (local.getDefaultExpression() != null) values.add(local.getDefaultExpression());
                writes.put(local, values);
            } else if (element instanceof CtAssignment<?, ?> assignment) {
                // `x = ...`: the assignment names the local on the left and the value on the right.
                if (!(assignment.getAssigned() instanceof spoon.reflect.code.CtVariableWrite<?> write)) continue;
                if (write.getVariable() == null) continue;
                if (!(write.getVariable().getDeclaration() instanceof CtLocalVariable<?> local)) continue;
                List<CtExpression<?>> values = writes.computeIfAbsent(local, k -> new ArrayList<>(1));
                if (assignment.getAssignment() != null) values.add(assignment.getAssignment());
            }
        }
        return new Body(sites, returns, switchExpressions, switches, fields, writes);
    }
}
