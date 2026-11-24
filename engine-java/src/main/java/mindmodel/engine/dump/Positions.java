package mindmodel.engine.dump;

import java.io.File;
import java.nio.file.Path;

import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtElement;

/** Source positions, always project-relative and always the element's own first token. */
public final class Positions {

    private Positions() {
    }

    public record Pos(String file, int line, int col, int endLine, int endCol) {
    }

    private static java.nio.file.Path absolute(Path path) {
        return path.toAbsolutePath().normalize();
    }

    /**
     * Project-relative names by file: one dump reads a million-odd elements of the same few thousand files, and resolving
     * a path each time is the difference between a dump inside its budget and one outside it. Thread-confined.
     */
    private static final java.util.Map<File, String> RELATIVE = new java.util.HashMap<>();

    public static Pos of(CtElement element, Path root) {
        SourcePosition p = element == null ? null : element.getPosition();
        if (p == null || !p.isValidPosition()) return null;
        File file = p.getFile();
        String rel = file == null ? "" : RELATIVE.computeIfAbsent(file, f -> absolute(root)
                .relativize(f.toPath().toAbsolutePath().normalize()).toString().replace('\\', '/'));
        return new Pos(rel, p.getLine(), p.getColumn(), p.getEndLine(), p.getEndColumn());
    }
}
