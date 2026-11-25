package mindmodel.engine.model;

import java.io.File;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtElement;

/**
 * Source positions: project-relative files, and the element's own first token. One instance per dump run, because it
 * owns the checkout's root and the cache of relative names.
 */
public final class Positions {

    /** A position as the dump writes it. */
    public record Pos(String file, int line, int col, int endLine, int endCol) {
    }

    private final Path root;
    /** Project-relative names by file: one dump reads a million-odd elements of the same few thousand files. */
    private final Map<File, String> relative = new HashMap<>();

    /** The checkout the positions are relative to; every path is measured against this canonical root. */
    public Positions(Path root) {
        this.root = root.toAbsolutePath().normalize();
    }

    public Path root() {
        return root;
    }

    /** The element's own first token as a project-relative position, or null when Spoon has none. */
    public Pos of(CtElement element) {
        SourcePosition p = element == null ? null : element.getPosition();
        if (p == null || !p.isValidPosition()) return null;
        File file = p.getFile();
        String rel = file == null ? "" : relative.computeIfAbsent(file,
                f -> root.relativize(f.toPath().toAbsolutePath().normalize()).toString().replace('\\', '/'));
        return new Pos(rel, p.getLine(), p.getColumn(), p.getEndLine(), p.getEndColumn());
    }

    /** The line an element is written on, or null when Spoon has no position for it. */
    public static Integer lineOf(CtElement element) {
        SourcePosition p = element == null ? null : element.getPosition();
        return p == null || !p.isValidPosition() ? null : p.getLine();
    }
}
