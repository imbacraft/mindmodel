package mindmodel.engine.model;

import java.util.ArrayList;
import java.util.List;

import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;

/**
 * Methods written inside an anonymous or local class. They belong to no declared type, but they are body work of the
 * member that writes them; the dump files them under the declaring type with a line-suffixed id, so two anonymous
 * classes in one type keep separate identities.
 */
public final class Anonymous {

    private Anonymous() {
    }

    /**
     * The anonymous and local methods a declared executable writes, out of the methods found in its body: a method
     * declared by the executable's own type is not one of them.
     */
    public static List<CtMethod<?>> within(CtExecutable<?> owner, List<CtMethod<?>> candidates) {
        List<CtMethod<?>> out = new ArrayList<>();
        for (CtMethod<?> method : candidates) {
            CtType<?> declaring = method.getDeclaringType();
            if (declaring == null || declaring == owner.getParent(CtType.class)) continue;
            if (inside(owner, declaring)) out.add(method);
        }
        return out;
    }

    /** The id of one such method: the type's spelling, plus the line that keeps it unique. */
    public static String id(CtType<?> owner, CtMethod<?> method, Positions positions) {
        Positions.Pos pos = positions.of(method);
        return Names.executableId(owner, method) + "@" + (pos == null ? 0 : pos.line());
    }

    /** Written inside `owner`'s body: an anonymous class, or a class declared inside a method, by source position. */
    private static boolean inside(CtExecutable<?> owner, CtType<?> declaring) {
        if (declaring.isAnonymous()) return true;
        if (!(declaring.getParent() instanceof CtExecutable)) return false;
        var outer = owner.getPosition();
        var inner = declaring.getPosition();
        return outer != null && inner != null && outer.isValidPosition() && inner.isValidPosition()
                && outer.getSourceStart() <= inner.getSourceStart() && inner.getSourceEnd() <= outer.getSourceEnd();
    }
}
