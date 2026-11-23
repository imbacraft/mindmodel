package mindmodel.engine.dump;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtMethod;
import spoon.reflect.declaration.CtType;
import spoon.reflect.visitor.filter.TypeFilter;

/**
 * Methods written inside an anonymous or local class, which belong to no declared type but are body work of the method
 * that writes them (`new TransactionSynchronization() { public void afterCommit() { … } }`). The dump files them under
 * the declaring type with a line-suffixed id, so two anonymous classes in one type keep separate identities.
 */
final class Anonymous {

    private Anonymous() {
    }

    /** The anonymous and local methods a declared executable writes. */
    static List<CtMethod<?>> methods(CtExecutable<?> owner) {
        List<CtMethod<?>> out = new ArrayList<>();
        for (CtMethod<?> method : owner.getElements(new TypeFilter<>(CtMethod.class))) {
            CtType<?> declaring = method.getDeclaringType();
            if (declaring == null || declaring == owner.getParent(CtType.class)) continue;
            if (inside(owner, declaring)) out.add(method);
        }
        return out;
    }

    /** The id of one such method: the type's spelling, plus the line that keeps it unique. */
    static String id(CtType<?> owner, CtMethod<?> method, Path root) {
        List<spoon.reflect.reference.CtTypeReference<?>> params = new ArrayList<>();
        for (var p : method.getParameters()) params.add(p.getType());
        Positions.Pos pos = Positions.of(method, root);
        return Names.methodId(owner, method.getSimpleName(), params) + "@" + (pos == null ? 0 : pos.line());
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
