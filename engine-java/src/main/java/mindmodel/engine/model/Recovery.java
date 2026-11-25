package mindmodel.engine.model;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import spoon.reflect.cu.CompilationUnit;
import spoon.reflect.declaration.CtType;

/**
 * The shells Spoon leaves behind. A cross-package static import of a type's member makes the reference builder lay a
 * bare shell (a name, no position, no members) before the type's own file is read, so that file parses and its type
 * does not. These queries find the shells, and the files whose static imports laid them.
 */
public final class Recovery {

    private Recovery() {
    }

    /** Files whose declared types Spoon could not read at all. Sorted. */
    public static List<String> unreadFiles(SourceModel model) {
        List<String> out = new ArrayList<>();
        for (var unit : model.units().entrySet()) {
            List<CtType<?>> declared = unit.getValue().getDeclaredTypes();
            if (declared.isEmpty() || declared.stream().anyMatch(Recovery::read)) continue;
            out.add(unit.getKey());
        }
        out.sort(null);
        return out;
    }

    /** The qualified names of the types Spoon built as bare shells: what a static import of their members named. */
    public static Set<String> unreadNames(SourceModel model) {
        Set<String> out = new LinkedHashSet<>();
        for (CompilationUnit unit : model.units().values())
            for (CtType<?> t : unit.getDeclaredTypes())
                if (!read(t)) out.add(Names.qualified(t));
        return out;
    }

    /**
     * The files whose header statically imports a member of one of `fqns`. They are the ones that lay the shell, so a
     * model built without them reads the type itself.
     */
    public static List<String> filesImporting(SourceModel model, Set<String> fqns) {
        List<String> out = new ArrayList<>();
        for (String rel : model.files())
            for (String owner : Imports.staticOwners(model.root(), rel))
                if (fqns.contains(owner)) {
                    out.add(rel);
                    break;
                }
        return out;
    }

    /** A type Spoon read from source has a position; a bare shell has none. */
    private static boolean read(CtType<?> t) {
        return t.getPosition() != null && t.getPosition().isValidPosition();
    }
}
