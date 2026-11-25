package mindmodel.engine.resolve;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import spoon.reflect.code.CtCase;
import spoon.reflect.code.CtCatch;
import spoon.reflect.code.CtIf;
import spoon.reflect.code.CtLoop;
import spoon.reflect.code.CtStatement;
import spoon.reflect.code.CtTry;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.ModifierKind;
import spoon.reflect.reference.CtArrayTypeReference;
import spoon.reflect.reference.CtTypeReference;

import mindmodel.engine.model.Positions;
import mindmodel.engine.model.Walk;

/**
 * The shape of a body as line ranges: its loops, its decision arms and its try blocks. A reader sees that an effect is
 * conditional, or inside a loop, without re-reading the body. Also the entry-point test for a method.
 */
public final class BodyShape {

    /** One decision arm: the lines its statement occupies, and which decision put it there. */
    public record Branch(int line, int endLine, String kind) {
    }

    /** One `try`: the lines of its block and, when it has one, of its finalizer (0 when it has none). */
    public record TryRange(int line, int endLine, int finallyLine, int finallyEndLine) {
    }

    private BodyShape() {
    }

    /**
     * The decision arms a body writes: an if/else arm's body, a catch's body, a case's statements. Never the condition:
     * a call written in {@code if (repo.exists())} runs on the default path. In source order.
     */
    public static List<Branch> branches(Walk.Body body, Positions positions) {
        List<Branch> arms = new ArrayList<>();
        for (CtIf iff : body.ifs()) {
            arm(arms, iff.getThenStatement(), "if", positions);
            CtStatement otherwise = iff.getElseStatement();
            // An else-if's arms are that nested if's own rows; the else itself has no body to range.
            if (otherwise != null && !(otherwise instanceof CtIf)) arm(arms, otherwise, "else", positions);
        }
        for (CtCatch c : body.catches()) arm(arms, c.getBody(), "catch", positions);
        // A case's statements, not the case: the label and its guard are the decision, not the arm.
        for (CtCase<?> c : body.cases())
            for (CtStatement s : c.getStatements()) arm(arms, s, "case", positions);
        arms.sort(Comparator.comparingInt(Branch::line).thenComparingInt(Branch::endLine).thenComparing(Branch::kind));
        return arms;
    }

    private static void arm(List<Branch> arms, CtStatement statement, String kind, Positions positions) {
        Positions.Pos p = positions.of(statement);
        if (p != null) arms.add(new Branch(p.line(), p.endLine(), kind));
    }

    /**
     * The `try` blocks of a body, as line ranges, in source order. A try body always runs, so these are never arms: an
     * effect written in one is not conditional.
     */
    public static List<TryRange> tries(Walk.Body body, Positions positions) {
        List<TryRange> blocks = new ArrayList<>();
        for (CtTry t : body.tries()) {
            Positions.Pos block = positions.of(t.getBody());
            if (block == null) block = positions.of(t);
            if (block == null) continue;
            Positions.Pos fin = positions.of(t.getFinalizer());
            blocks.add(new TryRange(block.line(), block.endLine(),
                    fin == null ? 0 : fin.line(), fin == null ? 0 : fin.endLine()));
        }
        blocks.sort(Comparator.comparingInt(TryRange::line).thenComparingInt(TryRange::endLine));
        return blocks;
    }

    /** The loops of a body, as the position of each. */
    public static List<Positions.Pos> loops(Walk.Body body, Positions positions) {
        List<Positions.Pos> out = new ArrayList<>();
        for (CtLoop loop : body.loops()) {
            Positions.Pos p = positions.of(loop);
            if (p != null) out.add(p);
        }
        return out;
    }

    /** `public static void main(String[])`, or its varargs spelling. Everything else is not an entry point. */
    public static boolean isMain(CtMethod<?> method) {
        if (!"main".equals(method.getSimpleName())) return false;
        var modifiers = method.getModifiers();
        if (!modifiers.contains(ModifierKind.PUBLIC) || !modifiers.contains(ModifierKind.STATIC)) return false;
        CtTypeReference<?> type = method.getType();
        if (type == null || !"void".equals(type.getQualifiedName())) return false;
        if (method.getParameters().size() != 1) return false;
        CtTypeReference<?> parameter = method.getParameters().get(0).getType();
        if (!(parameter instanceof CtArrayTypeReference<?> array)) return false;
        CtTypeReference<?> component = array.getComponentType();
        return component != null && "java.lang.String".equals(component.getQualifiedName());
    }
}
