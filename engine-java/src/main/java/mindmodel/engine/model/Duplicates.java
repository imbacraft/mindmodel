package mindmodel.engine.model;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import spoon.reflect.cu.CompilationUnit;
import spoon.reflect.declaration.CtType;

/**
 * Two input files that declare one name. An id is the name, so the file whose relative path sorts first keeps it and
 * the other declaration is dropped. Spoon drops it silently with its unit's type, so the duplicate is found by reading
 * again the files that declare nothing, and counting each name they declare that the model kept.
 */
public final class Duplicates {

    private Duplicates() {
    }

    /** Counts `DUPLICATE_FQN` for each name a unit declares that the model kept from another file. */
    public static void count(SourceModel model, Path root, int compliance, List<String> classpath,
            Failures failures) {
        List<String> silent = unitsWithoutTypes(model);
        if (silent.isEmpty()) return;
        Set<String> kept = declaredNames(model);
        SourceModel again = SourceModel.build(root, silent, compliance, classpath, model.generatedDirs());
        for (String name : declaredNames(again)) if (kept.contains(name)) failures.count(Failures.Key.DUPLICATE_FQN);
    }

    /** The qualified names of the top-level types the input files declare, as Spoon kept them. */
    static Set<String> declaredNames(SourceModel model) {
        Set<String> out = new TreeSet<>();
        for (CompilationUnit unit : model.units().values())
            for (CtType<?> t : unit.getDeclaredTypes()) out.add(Names.qualified(t));
        return out;
    }

    /**
     * Input files whose unit declares no top-level type: a file of comments, or a second declaration of a name another
     * file declares. `package-info.java` declares none by design.
     */
    static List<String> unitsWithoutTypes(SourceModel model) {
        List<String> out = new ArrayList<>();
        for (var unit : model.units().entrySet())
            if (unit.getValue().getDeclaredTypes().isEmpty() && !unit.getKey().endsWith("package-info.java"))
                out.add(unit.getKey());
        Collections.sort(out);
        return out;
    }
}
