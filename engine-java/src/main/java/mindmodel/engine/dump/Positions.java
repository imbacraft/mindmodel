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

    public static Pos of(CtElement element, Path root) {
        SourcePosition p = element == null ? null : element.getPosition();
        if (p == null || !p.isValidPosition()) return null;
        File file = p.getFile();
        String rel = file == null ? "" : absolute(root).relativize(file.toPath().toAbsolutePath().normalize())
                .toString().replace('\\', '/');
        return new Pos(rel, p.getLine(), p.getColumn(), p.getEndLine(), p.getEndColumn());
    }
}
