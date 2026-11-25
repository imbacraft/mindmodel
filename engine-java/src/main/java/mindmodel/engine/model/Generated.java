package mindmodel.engine.model;

import java.io.File;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import spoon.reflect.declaration.CtElement;

/**
 * The generated-source roots (annotation-processor output). They are read so a project call into one resolves, and no
 * row about them is written: the map describes the project's own code only.
 */
public final class Generated {

    private final List<String> dirs;
    /** Whether each file is generated: asked once per file, however many elements the file holds. */
    private final Map<File, Boolean> byFile = new HashMap<>();

    /** The roots as the model read them: real paths, in the order given. */
    public Generated(List<String> dirs) {
        this.dirs = dirs;
    }

    public List<String> dirs() {
        return dirs;
    }

    /** True when Spoon read this element from a generated source. */
    public boolean isElement(CtElement element) {
        if (element == null || element.getPosition() == null || !element.getPosition().isValidPosition()) return false;
        File file = element.getPosition().getFile();
        return file != null && byFile.computeIfAbsent(file, f -> isFile(f.toPath()));
    }

    /** True when a file was read from a generated root rather than as project source. */
    public boolean isFile(Path file) {
        if (dirs.isEmpty() || file == null) return false;
        String at = SourceModel.realPath(file).toString();
        for (String dir : dirs) if (at.startsWith(dir + File.separator) || at.equals(dir)) return true;
        return false;
    }
}
