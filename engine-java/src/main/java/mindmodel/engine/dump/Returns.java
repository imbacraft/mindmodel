package mindmodel.engine.dump;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.fasterxml.jackson.core.JsonGenerator;

import spoon.reflect.code.CtAbstractSwitch;
import spoon.reflect.code.CtAssignment;
import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtExpression;
import spoon.reflect.code.CtLambda;
import spoon.reflect.code.CtLocalVariable;
import spoon.reflect.code.CtReturn;
import spoon.reflect.code.CtStatement;
import spoon.reflect.code.CtSwitch;
import spoon.reflect.code.CtSwitchExpression;
import spoon.reflect.code.CtVariableWrite;
import spoon.reflect.code.CtYieldStatement;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtExecutable;

/**
 * returns: what a method body hands back, as data.
 *
 * <pre>
 * { "kind": "return", "line": 9, "col": 16, "value": { ...reference... } }
 * { "kind": "switch", "line": 20, "col": 9, "form": "expression", "on": { ...reference... },
 *   "arms": [ { "labels": ["NEW"], "default": false, "value": { ...reference... } } ] }
 * </pre>
 *
 * A switch entry gets a {@code target} when its result is assigned to one local. The
 * arms are the source's arms in source order; an arm whose value cannot be described is {@code unresolved} with a reason.
 *
 * Planned while the body is the current scope of {@link Refs} (so a returned local can still name its source), then
 * written onto the member row.
 */
final class Returns {

    /** One entry, in source order. */
    record Entry(String kind, int line, int col, Refs.Ref value, Refs.Ref on, String form, String target,
                 List<Arm> arms) {
    }

    /**
     * One arm of a switch: its labels (empty for `default`), whether it includes `default` (`case null, default`), its
     * `when` guard as written (null when none) and the value it produces.
     */
    record Arm(List<String> labels, boolean includesDefault, String guard, Refs.Ref value) {
    }

    private Returns() {
    }

    /** The entries of one executable, in source order; empty when its body returns nothing it chose. */
    static List<Entry> plan(CtExecutable<?> executable, Walk.Body body, Refs refs) {
        List<Entry> entries = new ArrayList<>();
        try {
            collect(executable, body, refs, entries);
        } catch (RuntimeException e) {
            // One body Spoon cannot read must not end a 5,000-file dump: the row then simply has no returns, and the
            // run says so.
            refs.failures().count("returns.unreadable");
            return List.of();
        }
        entries.sort(Comparator.comparingInt(Entry::line).thenComparingInt(Entry::col).thenComparing(Entry::kind));
        return entries;
    }

    private static void collect(CtExecutable<?> executable, Walk.Body body, Refs refs, List<Entry> entries) {
        for (CtReturn<?> ret : body.returns()) {
            // A return inside a lambda or an anonymous class returns from that body, not from this method.
            if (ret.getParent(CtExecutable.class) != executable) continue;
            var where = ret.getPosition();
            if (where == null || !where.isValidPosition()) continue;
            if (ret.getReturnedExpression() instanceof CtSwitchExpression<?, ?> choose)
                entries.add(switchEntry(choose, "expression", null, where.getLine(), where.getColumn(), refs));
            else
                entries.add(new Entry("return", where.getLine(), where.getColumn(), refs.of(ret.getReturnedExpression()),
                        null, null, null, List.of()));
        }
        // A switch expression that is not itself returned, and a switch statement that fills one local: its arms are
        // where the value is chosen. Two entities with one status enum are told apart by these, not by source lines.
        for (CtSwitchExpression<?, ?> choose : body.switchExpressions()) {
            if (choose.getParent(CtExecutable.class) != executable) continue;
            if (choose.getParent() instanceof CtReturn<?>) continue;
            var where = choose.getPosition();
            if (where == null || !where.isValidPosition()) continue;
            entries.add(switchEntry(choose, "expression", assignedLocal(choose), where.getLine(), where.getColumn(),
                    refs));
        }
        for (CtSwitch<?> choose : body.switches()) {
            if (choose.getParent(CtExecutable.class) != executable) continue;
            String target = assignedLocal(choose);
            if (target == null) continue; // a switch with side effects is not a chosen value
            var where = choose.getPosition();
            if (where == null || !where.isValidPosition()) continue;
            entries.add(new Entry("switch", where.getLine(), where.getColumn(), null, refs.of(choose.getSelector()),
                    "statement", target, statementArms(choose, target, refs)));
        }
    }

    /** The single local a switch expression's result is written to, or null: `x = switch (...)` and `T x = switch (...)`. */
    private static String assignedLocal(CtSwitchExpression<?, ?> choose) {
        CtElement parent = choose.getParent();
        if (parent instanceof CtLocalVariable<?> local) return local.getSimpleName();
        if (parent instanceof CtAssignment<?, ?> assignment
                && assignment.getAssigned() instanceof CtVariableWrite<?> write)
            return String.valueOf(write.getVariable());
        return null;
    }

    /** The one local every case of a switch statement assigns, when there is exactly one; else null. */
    private static String assignedLocal(CtSwitch<?> choose) {
        String found = null;
        for (CtCase<?> arm : choose.getCases()) {
            for (CtStatement statement : arm.getStatements()) {
                if (!(statement instanceof CtAssignment<?, ?> assignment)
                        || !(assignment.getAssigned() instanceof CtVariableWrite<?> write)) continue;
                String name = String.valueOf(write.getVariable());
                if (found != null && !found.equals(name)) return null;
                found = name;
            }
        }
        return found;
    }

    private static Entry switchEntry(CtSwitchExpression<?, ?> choose, String form, String target, int line, int col,
            Refs refs) {
        List<Arm> arms = new ArrayList<>();
        for (CtCase<?> arm : choose.getCases()) arms.add(arm(arm, null, refs));
        return new Entry("switch", line, col, null, refs.of(choose.getSelector()), form, target, arms);
    }

    private static List<Arm> statementArms(CtSwitch<?> choose, String target, Refs refs) {
        List<Arm> arms = new ArrayList<>();
        for (CtCase<?> arm : choose.getCases()) arms.add(arm(arm, target, refs));
        return arms;
    }

    private static Arm arm(CtCase<?> arm, String target, Refs refs) {
        String guard = arm.getGuard() == null ? null : refs.textOf(arm.getGuard());
        return new Arm(labels(arm, refs), arm.getIncludesDefault(), guard, refs.of(armValue(arm, target)));
    }

    /** A case's labels as written; an empty list means `default`. */
    private static List<String> labels(CtCase<?> arm, Refs refs) {
        List<String> out = new ArrayList<>();
        for (CtExpression<?> label : arm.getCaseExpressions()) {
            String text = refs.textOf(label);
            out.add(text == null ? "" : text);
        }
        return out;
    }

    /**
     * The value one arm produces: a `yield`, a `return`, or the assignment to the switch's local. The first of those in
     * source order that belongs to this switch; nothing invented when none matches. A nested switch's yield or return
     * is that switch's, not this arm's.
     */
    private static CtExpression<?> armValue(CtCase<?> arm, String target) {
        CtElement sw = arm.getParent();
        for (CtYieldStatement produce : arm.getElements(
                new spoon.reflect.visitor.filter.TypeFilter<>(CtYieldStatement.class)))
            // A yield answers the nearest switch expression, past any statement switch between them.
            if (produce.getParent(CtSwitchExpression.class) == sw) return produce.getExpression();
        for (CtReturn<?> ret : arm.getElements(new spoon.reflect.visitor.filter.TypeFilter<>(CtReturn.class)))
            if (nearestBody(ret) == sw) return ret.getReturnedExpression();
        for (CtStatement statement : arm.getStatements()) {
            if (target == null || !(statement instanceof CtAssignment<?, ?> assignment)) continue;
            if (!(assignment.getAssigned() instanceof CtVariableWrite<?> write)) continue;
            if (String.valueOf(write.getVariable()).equals(target)) return assignment.getAssignment();
        }
        return null;
    }

    /** The nearest enclosing switch, lambda or method of an element: the body a `return` in it leaves. */
    private static CtElement nearestBody(CtElement element) {
        for (CtElement p = element.getParent(); p != null; p = p.getParent())
            if (p instanceof CtAbstractSwitch<?> || p instanceof CtLambda<?> || p instanceof CtExecutable<?>) return p;
        return null;
    }

    /** Writes the array, or nothing at all when the method returns nothing worth a row. */
    static void write(JsonGenerator g, List<Entry> entries) throws IOException {
        if (entries == null || entries.isEmpty()) return;
        g.writeArrayFieldStart("returned");
        for (Entry entry : entries) {
            g.writeStartObject();
            g.writeStringField("kind", entry.kind());
            g.writeNumberField("line", entry.line());
            g.writeNumberField("col", entry.col());
            if (entry.kind().equals("switch")) {
                g.writeStringField("form", entry.form());
                g.writeObjectFieldStart("on");
                Refs.write(g, entry.on());
                g.writeEndObject();
                if (entry.target() != null) g.writeStringField("target", entry.target());
                g.writeArrayFieldStart("arms");
                for (Arm arm : entry.arms()) {
                    g.writeStartObject();
                    g.writeArrayFieldStart("labels");
                    for (String label : arm.labels()) g.writeString(label);
                    g.writeEndArray();
                    g.writeBooleanField("default", arm.labels().isEmpty() || arm.includesDefault());
                    if (arm.guard() != null) g.writeStringField("guard", arm.guard());
                    g.writeObjectFieldStart("value");
                    Refs.write(g, arm.value());
                    g.writeEndObject();
                    g.writeEndObject();
                }
                g.writeEndArray();
            } else {
                g.writeObjectFieldStart("value");
                Refs.write(g, entry.value());
                g.writeEndObject();
            }
            g.writeEndObject();
        }
        g.writeEndArray();
    }
}
