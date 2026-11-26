package mindmodel.engine.model;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import spoon.reflect.declaration.CtExecutable;
import spoon.reflect.declaration.CtType;

/**
 * The types the dump declares, in dump order: every type an input file declares, nested ones included, read from the
 * model. A file whose type came out as a bare shell is read again on its own, so each declaration is read from its own
 * source, with the rest of the project still in reach.
 */
public final class Declarations {

    /** The declared types in dump order, and the files whose types stayed bare shells after the second read. */
    public record Declared(List<CtType<?>> types, List<String> unread) {
    }

    /** A type with the position it is ordered by, so the sort reads each position once. */
    private record Row(CtType<?> type, Positions.Pos pos) {
    }

    private static final Comparator<Row> ORDER = Comparator
            .comparing((Row r) -> r.pos() == null ? "" : r.pos().file())
            .thenComparingInt(r -> r.pos() == null ? 0 : r.pos().line())
            .thenComparingInt(r -> r.pos() == null ? 0 : r.pos().col())
            .thenComparing(r -> Names.qualified(r.type()));

    private Declarations() {
    }

    /** Reads the declared types of the model, then the second read of the shells, and orders them by position. */
    public static Declared of(SourceModel model, List<String> inputs, int compliance, List<String> classpath,
            Positions positions) {
        List<Row> rows = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (CtType<?> t : model.topLevelTypes()) collect(model, t, rows, seen, positions);
        List<String> unread = recover(model, inputs, compliance, classpath, rows, seen, positions);
        rows.sort(ORDER);
        List<CtType<?>> types = new ArrayList<>();
        for (Row r : rows) types.add(r.type());
        return new Declared(types, unread);
    }

    /** True for a type the dump declares: not anonymous, and not a local class of a method. */
    public static boolean isDeclared(CtType<?> t) {
        if (t.isAnonymous()) return false;
        return !(t.getDeclaringType() == null && t.getParent(CtExecutable.class) != null);
    }

    /**
     * A type and its nested types. Anonymous and local classes are not types of their own: their calls belong to the
     * member that writes them. A generated type is never one of them: it is in the model for resolution only.
     */
    private static void collect(SourceModel model, CtType<?> t, List<Row> rows, Set<String> seen,
            Positions positions) {
        // A type Spoon resolved but never read has no position: it is a library or a shadow, not a declaration here.
        if (t.getPosition() == null || !t.getPosition().isValidPosition()) return;
        if (!isDeclared(t) || model.isGenerated(t)) return;
        if (seen.add(Names.qualified(t))) rows.add(new Row(t, positions.of(t)));
        for (CtType<?> nested : t.getNestedTypes()) collect(model, nested, rows, seen, positions);
    }

    /**
     * Reads again the files whose declared types Spoon built as bare shells, and adds what they declare to `rows`. The
     * second model holds every input except the files whose static imports name one of those types, the imports that
     * laid the shells.
     *
     * @return the files still unread after that, to be reported rather than filled in.
     */
    private static List<String> recover(SourceModel model, List<String> inputs, int compliance,
            List<String> classpath, List<Row> rows, Set<String> seen, Positions positions) {
        List<String> ghosts = Recovery.unreadFiles(model);
        if (ghosts.isEmpty()) return List.of();
        // The shells carry no position but they do carry their names, which is what the imports were written with.
        Set<String> skip = new HashSet<>(Recovery.filesImporting(model, Recovery.unreadNames(model)));
        List<String> rest = new ArrayList<>(inputs);
        rest.removeAll(skip);
        SourceModel own = SourceModel.build(positions.root(), rest, compliance, classpath, model.generatedDirs());
        for (CtType<?> t : own.topLevelTypes()) collect(own, t, rows, seen, positions);
        return Recovery.unreadFiles(own);
    }
}
